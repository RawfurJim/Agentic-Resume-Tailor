"""
app/scrape_pipeline.py
----------------------
Part 1 of the scraped-jobs feature (see PLAN_SCRAPE.md): plain Python, no web code.
The bridge between the Node scraper in scraper/ and the CV pipeline in app/pipeline.py.

    run_scraper(indeed_links, log, match_limit)  -> path of the new-jobs csv the scraper wrote,
                                                    None when nothing new, ScrapeError on failure
    newest_csv()                                 -> newest scraper/data/new-data/new-jobs-*.csv
    load_matched_rows(csv_path)                  -> one dict per job, sorted top/medium/low/none
    generate_row(row, config, out_dir)           -> run the CV pipeline for ONE row (in place)

Nothing under scraper/ is modified by this module except indeed_scrapper/links.txt, which is
the Indeed script's own input file. The scraper runs as a child process, exactly like
`npm run scan:uk` in a terminal; its output lines are collected in `log` for the page.

Row dict keys (from load_matched_rows):
    company, title, link, description, location, posted, source   from the csv
    match        "top" | "medium" | "low" | "none"   (none = no description / unscored / error)
    match_note   the raw "Match status" cell
    filename     the docx name inside the job folder (unique, company based)
    status       "pending" -> "running" -> "done" | "failed"     (generate_row)
    error, job_title
"""

import csv
import os
import shutil
import subprocess
import sys
import threading
from collections import deque

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(APP_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from app import batch_pipeline                                   # noqa: E402

SCRAPER_DIR = os.path.join(PROJECT_ROOT, "scraper")
RUN_ALL = os.path.join(SCRAPER_DIR, "run-all.mjs")
LINKS_FILE = os.path.join(SCRAPER_DIR, "indeed_scrapper", "links.txt")
NEW_DATA_DIR = os.path.join(SCRAPER_DIR, "data", "new-data")

NODE = os.environ.get("SCRAPER_NODE", "node")                    # override when node is not on PATH
TIMEOUT_S = int(os.environ.get("SCRAPER_TIMEOUT_S", str(4 * 3600)))   # Indeed is ~1 min/link, scan 10-20 min

MATCH_ORDER = ("top", "medium", "low", "none")
NEW_JOBS_PREFIX, NEW_JOBS_SUFFIX = "new-jobs-", ".csv"

# csv header -> row key
COLUMN_MAP = {
    "Company": "company", "Title": "title", "URL": "link", "Description": "description",
    "Location": "location", "Posted": "posted", "Source": "source",
}


class ScrapeError(Exception):
    """The scraper could not produce a new-jobs csv. The message is safe to show on the page."""


# ---------------------------------------------------------------------------
# running child processes
# ---------------------------------------------------------------------------
def run_command(cmd: list[str], cwd: str, env: dict, log, timeout: int) -> int:
    """
    Run `cmd`, streaming every output line into `log` (a deque / list). Returns the exit code.

    stdin is /dev/null on purpose: indeed_grab.py asks for Enter when stdin is a terminal,
    which under uvicorn would hang the job forever. With no terminal it skips instead.
    A child that outlives `timeout` seconds is killed (exit code -1 reported).
    """
    proc = subprocess.Popen(
        cmd, cwd=cwd, env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )

    def pump():
        for line in proc.stdout:
            line = line.rstrip()
            if line:
                log.append(line)

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        log.append(f"Timed out after {timeout} s; the scraper was stopped.")
        code = -1
    reader.join(timeout=5)
    return code


def _new_jobs_files() -> set[str]:
    if not os.path.isdir(NEW_DATA_DIR):
        return set()
    return {f for f in os.listdir(NEW_DATA_DIR)
            if f.startswith(NEW_JOBS_PREFIX) and f.endswith(NEW_JOBS_SUFFIX)}


def run_scraper(indeed_links: list[str], log, match_limit: int | None = None,
                runner=run_command) -> str | None:
    """
    Run `node run-all.mjs` (Indeed -> boards scan -> export -> DeepSeek match) and return the
    path of the new-jobs csv it wrote. None means the run was fine but found nothing new.
    Raises ScrapeError when the run failed without writing a csv. A failed matcher (exit != 0
    but a csv was written) still returns the csv: the rows just come back unscored.
    """
    node = shutil.which(NODE)
    if not node:
        raise ScrapeError(
            f"'{NODE}' (Node.js) was not found on PATH. Install Node or set SCRAPER_NODE to its full path."
        )

    links = [l.strip() for l in indeed_links if l and l.strip()]
    if links:
        os.makedirs(os.path.dirname(LINKS_FILE), exist_ok=True)
        with open(LINKS_FILE, "w", encoding="utf-8") as f:
            f.write("\n".join(links) + "\n")
        steps = "indeed,scan,export,match"
    else:
        steps = "scan,export,match"

    cmd = [node, RUN_ALL, "--steps", steps]
    if match_limit:
        cmd += ["--", "--limit", str(int(match_limit))]     # forwarded to match_jobs.py untouched

    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    before = _new_jobs_files()
    code = runner(cmd, cwd=SCRAPER_DIR, env=env, log=log, timeout=TIMEOUT_S)
    created = sorted(_new_jobs_files() - before)

    if created:
        return os.path.join(NEW_DATA_DIR, created[-1])
    if code == 0:
        return None
    last = list(log)[-1] if len(log) else "no output"
    raise ScrapeError(f"The scraper failed (exit {code}). Last line: {last}")


def newest_csv() -> str | None:
    """The most recent new-jobs csv (names sort chronologically), or None."""
    files = sorted(_new_jobs_files())
    return os.path.join(NEW_DATA_DIR, files[-1]) if files else None


# ---------------------------------------------------------------------------
# reading the matched csv
# ---------------------------------------------------------------------------
def _match_category(note: str, description: str) -> str:
    if not description.strip():
        return "none"
    note = note.strip().lower()
    for category in ("top", "medium", "low"):
        if note.startswith(category):
            return category
    return "none"


def load_matched_rows(csv_path: str) -> list[dict]:
    """
    The scraper's new-jobs csv -> row dicts, sorted top, medium, low, none (stable inside each).
    Every row gets a unique docx filename now, so a row generated later can never overwrite
    another row's file.
    """
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        raw_rows = list(csv.DictReader(f))

    rows = []
    for raw in raw_rows:
        row = {key: (raw.get(column) or "").strip() for column, key in COLUMN_MAP.items()}
        row["match_note"] = (raw.get("Match status") or "").strip()
        row["match"] = _match_category(row["match_note"], row["description"])
        rows.append(row)

    rows.sort(key=lambda r: MATCH_ORDER.index(r["match"]))
    for row, filename in zip(rows, batch_pipeline.make_filenames(rows)):
        row["filename"] = filename
        row["status"] = "pending"
        row["error"] = ""
        row["job_title"] = ""
    return rows


# ---------------------------------------------------------------------------
# one CV
# ---------------------------------------------------------------------------
def generate_row(row: dict, config, out_dir: str, pipeline=None) -> dict:
    """
    Run the CV pipeline for one row and record the outcome in the row (same fields as
    batch_pipeline.run_batch). `pipeline` defaults to run_pipeline, looked up now so tests
    can monkeypatch app.batch_pipeline.run_pipeline.
    """
    pipeline = pipeline or batch_pipeline.run_pipeline
    os.makedirs(out_dir, exist_ok=True)
    row["status"] = "running"
    try:
        result = pipeline(row["description"], config, output_path=os.path.join(out_dir, row["filename"]))
        row["status"] = "done"
        row["job_title"] = result.job_title
        row["error"] = ""
    except Exception as e:                           # PipelineError or anything unexpected
        row["status"] = "failed"
        row["error"] = str(e) or "Unknown error"
    return row
