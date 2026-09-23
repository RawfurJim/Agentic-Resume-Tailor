#!/usr/bin/env python3
"""
match_jobs.py - score every job in a new-jobs csv against Jim's CV with DeepSeek.

    python match_job/match_jobs.py data/new-data/new-jobs-2026-09-22-101500.csv
    python match_job/match_jobs.py <csv> --dry-run        # list what would be sent, call nothing
    python match_job/match_jobs.py <csv> --limit 3        # only the first 3 unscored rows (cheap check)
    python match_job/match_jobs.py <csv> --cv other.txt   # a different CV file

Adds one column to the csv, in place:
    Match status              top match | medium match | low match | no description | error: ...

Rows that already have a status are left alone, so re-running the same file
costs nothing; rows marked `error: ...` are retried. Rows with an empty
Description get `no description` without an API call.

Standard library only: no pandas, no LangChain. DeepSeek speaks the OpenAI
chat-completions protocol, so a plain HTTPS POST is all that is needed.
Reads DEEPSEEK_API_KEY (required), DEEPSEEK_MODEL (default deepseek-flash) and
DEEPSEEK_BASE_URL (default https://api.deepseek.com) from the scraper's .env.

Each call costs money: the pipeline (run-all.mjs) only ever passes it the
csv of jobs that are new this run, and never the same row twice.
"""

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRAPER_ROOT = HERE.parent
DEFAULT_CV = HERE / "cv.txt"
DEFAULT_ENV_FILE = SCRAPER_ROOT / ".env"
DEFAULT_MODEL = "deepseek-flash"
DEFAULT_BASE_URL = "https://api.deepseek.com"

STATUS_COL = "Match status"
NEW_COLUMNS = [STATUS_COL]

ALLOWED_STATUSES = {"top match", "medium match", "low match"}
NO_DESCRIPTION = "no description"
SAVE_EVERY = 10          # rows between checkpoints, so Ctrl+C loses little

# The evaluator prompt from match_job/creaet_pipeline.ipynb; since round 7 (2026-09-23)
# the JSON asks for the status only (Jim: "I only want top / medium / low"). Filled
# with str.replace, not str.format, so braces inside a job description are safe.
CV_EVALUATOR_PROMPT = """
You are an expert technical recruiter and resume screener. Your task is to analyze a candidate's CV against a provided Job Description and output a strictly valid JSON object detailing how well they match.

CRITICAL EVALUATION RULES:
1. Skills First: A "top match" requires strong alignment between the candidate's actual technical skills/tools and those requested in the job description.
2. Flexible Experience Threshold: Do not strictly penalize a candidate for falling slightly short on "years of experience" if their skills align. Specifically, if the candidate has around 2.5 to 3 years of experience (e.g., 2.8 years), you MUST consider their experience level a "top match" for roles asking for 0-3 years, and ALSO for roles asking for up to 4 years of experience.

You must output your analysis strictly as a valid JSON string matching the exact structure below. Do not include markdown formatting (like ```json), conversational text, or anything outside the curly braces.

JSON Structure:
{
  "status": "[Select exactly one: 'top match', 'medium match', or 'low match'. Use 'top match' if the skills align well and experience fits within the flexible threshold above. Use 'medium match' if some core skills are present but major domain experience is missing. Use 'low match' if the candidate is in the wrong field or lacks the majority of mandatory skills.]"
}

Job description:

{job_description}

Candidate CV:

{cv}
"""


# ------------------------------------------------------------------ env ----

def load_env(path=DEFAULT_ENV_FILE):
    """KEY=VALUE lines of a .env file into os.environ, never overriding what is already set."""
    path = Path(path)
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


# --------------------------------------------------------------- prompt ----

def build_prompt(job_description, cv):
    return CV_EVALUATOR_PROMPT.replace("{job_description}", job_description).replace("{cv}", cv)


def parse_verdict(text):
    """The JSON verdict inside a model reply. Tolerates ```json fences and prose around it."""
    s = str(text or "")
    s = re.sub(r"```(?:json)?", "", s)
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("no JSON object in reply")
    try:
        data = json.loads(s[start:end + 1])
    except json.JSONDecodeError as e:
        raise ValueError(f"reply is not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise ValueError("reply JSON is not an object")
    if "status" not in data:
        raise ValueError("reply JSON lacks status")
    status = " ".join(str(data["status"]).lower().split())
    if status not in ALLOWED_STATUSES:
        raise ValueError(f"unexpected status {data['status']!r}")
    return {"status": status}  # extra keys (older replies) are ignored


# ------------------------------------------------------------- deepseek ----

def make_deepseek_llm(api_key, model=DEFAULT_MODEL, base_url=DEFAULT_BASE_URL, timeout=90):
    """A callable prompt -> reply text, over DeepSeek's OpenAI-compatible endpoint."""
    url = base_url.rstrip("/") + "/chat/completions"

    def call(prompt):
        body = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"DeepSeek HTTP {e.code}: {detail}") from e
        try:
            return payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as e:
            raise RuntimeError(f"unexpected DeepSeek reply shape: {json.dumps(payload)[:300]}") from e

    return call


# ------------------------------------------------------------- matching ----

def evaluate(description, cv, llm, retries=1):
    """The status column value for one job. Never raises: failures become an `error:` status."""
    if not str(description or "").strip():
        return {STATUS_COL: NO_DESCRIPTION}
    prompt = build_prompt(description, cv)
    last = None
    for _ in range(retries + 1):
        try:
            v = parse_verdict(llm(prompt))
            return {STATUS_COL: v["status"]}
        except Exception as e:  # network, HTTP, JSON - all retried once, then recorded
            last = e
    return {STATUS_COL: f"error: {type(last).__name__}: {str(last)[:200]}"}


def needs_evaluation(row):
    status = (row.get(STATUS_COL) or "").strip()
    return status == "" or status.startswith("error")


def ensure_columns(fieldnames):
    for col in NEW_COLUMNS:
        if col not in fieldnames:
            fieldnames.append(col)


def match_rows(rows, fieldnames, cv, llm, log=print, limit=None, checkpoint=None):
    """Fill the status column for every row that needs it. Mutates rows and fieldnames.

    `limit` caps how many rows are sent to the model (unsent rows stay blank).
    `checkpoint(rows)` if given is called every SAVE_EVERY evaluated rows.
    """
    ensure_columns(fieldnames)
    counts = {"evaluated": 0, "skipped": 0, "errors": 0, "no_description": 0}
    todo = [r for r in rows if needs_evaluation(r)]
    counts["skipped"] = len(rows) - len(todo)
    sent = 0
    for i, row in enumerate(todo, 1):
        for col in NEW_COLUMNS:
            row.setdefault(col, "")
        label = f"{row.get('Company', '')} | {row.get('Title', '')}"
        if not str(row.get("Description") or "").strip():
            row.update({STATUS_COL: NO_DESCRIPTION})
            counts["no_description"] += 1
            log(f"[{i}/{len(todo)}] {label} -> {NO_DESCRIPTION}")
            continue
        if limit is not None and sent >= limit:
            continue
        result = evaluate(row["Description"], cv, llm)
        row.update(result)
        sent += 1
        if result[STATUS_COL].startswith("error"):
            counts["errors"] += 1
        else:
            counts["evaluated"] += 1
        log(f"[{i}/{len(todo)}] {label} -> {result[STATUS_COL]}")
        if checkpoint and sent % SAVE_EVERY == 0:
            checkpoint(rows)
    return counts


# ------------------------------------------------------------------ csv ----

def read_csv(path):
    """(fieldnames, rows) of a csv written by export-jobs.mjs or Excel (BOM tolerated)."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])
    return fieldnames, rows


def write_csv_atomic(path, fieldnames, rows):
    """Write to a sibling temp file then swap it in, so an interrupted write never truncates the csv."""
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, lineterminator="\r\n", extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow({k: row.get(k, "") for k in fieldnames})
    os.replace(tmp, path)


# ----------------------------------------------------------------- main ----

def parse_args(argv):
    p = argparse.ArgumentParser(description="Add one CV-match column (Match status) to a new-jobs csv using DeepSeek.")
    p.add_argument("csv", help="the new-jobs csv to score (edited in place)")
    p.add_argument("--cv", default=str(DEFAULT_CV), help=f"CV text file (default {DEFAULT_CV.name} next to this script)")
    p.add_argument("--limit", type=int, default=None, help="send at most N rows to the model")
    p.add_argument("--dry-run", action="store_true", help="show what would be sent; call nothing, write nothing")
    p.add_argument("--model", default=None, help=f"override DEEPSEEK_MODEL (default {DEFAULT_MODEL})")
    return p.parse_args(argv)


def main(argv=None, stdout=None, llm=None, env_file=DEFAULT_ENV_FILE):
    out = stdout or sys.stdout
    if stdout is None and hasattr(out, "reconfigure"):
        try:
            out.reconfigure(encoding="utf-8", errors="replace")   # Windows consoles vs curly quotes
        except Exception:
            pass
    log = lambda msg: print(msg, file=out)  # noqa: E731

    args = parse_args(sys.argv[1:] if argv is None else argv)
    csv_path = Path(args.csv)
    if not csv_path.exists():
        log(f"csv not found: {csv_path}")
        return 2
    cv_path = Path(args.cv)
    if not cv_path.exists() or not cv_path.read_text(encoding="utf-8").strip():
        log(f"CV file missing or empty: {cv_path} - put your CV text there (see match_job/cv.txt)")
        return 2
    cv = cv_path.read_text(encoding="utf-8").strip()

    fieldnames, rows = read_csv(csv_path)
    todo = [r for r in rows if needs_evaluation(r)]
    to_send = [r for r in todo if str(r.get("Description") or "").strip()]
    if args.limit is not None:
        to_send = to_send[:args.limit]

    if args.dry_run:
        log(f"{csv_path.name}: {len(rows)} row(s), {len(rows) - len(todo)} already scored, "
            f"{len(todo) - len([r for r in todo if str(r.get('Description') or '').strip()])} without a description; "
            f"would evaluate {len(to_send)} (dry run - nothing sent, nothing written)")
        for r in to_send:
            log(f"  ? {r.get('Company', '')} | {r.get('Title', '')}")
        return 0

    if not to_send:
        if todo:
            ensure_columns(fieldnames)
            match_rows(rows, fieldnames, cv, lambda _p: "", log=log, limit=0)   # only marks `no description`
            write_csv_atomic(csv_path, fieldnames, rows)
        log(f"{csv_path.name}: nothing to evaluate ({len(rows) - len(todo)} already scored)")
        return 0

    if llm is None:
        load_env(env_file)
        api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
        if not api_key:
            log(f"DEEPSEEK_API_KEY is not set - add it to {env_file} (nothing was changed)")
            return 2
        model = args.model or os.environ.get("DEEPSEEK_MODEL", "").strip() or DEFAULT_MODEL
        base_url = os.environ.get("DEEPSEEK_BASE_URL", "").strip() or DEFAULT_BASE_URL
        llm = make_deepseek_llm(api_key, model=model, base_url=base_url)
        log(f"{csv_path.name}: evaluating {len(to_send)} of {len(rows)} row(s) with {model}")

    checkpoint = lambda rs: write_csv_atomic(csv_path, fieldnames, rs)  # noqa: E731
    try:
        counts = match_rows(rows, fieldnames, cv, llm, log=log, limit=args.limit, checkpoint=checkpoint)
    except KeyboardInterrupt:
        write_csv_atomic(csv_path, fieldnames, rows)
        log("\nstopped - progress saved; re-run the same command to continue")
        return 130
    write_csv_atomic(csv_path, fieldnames, rows)
    log(f"done: {counts['evaluated']} scored, {counts['errors']} error(s), "
        f"{counts['no_description']} without description, {counts['skipped']} already scored -> {csv_path}")
    if counts["errors"] and not counts["evaluated"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
