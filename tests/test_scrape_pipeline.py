"""
Part 1 tests: app/scrape_pipeline.py  (see PLAN_SCRAPE.md, Part 1).

All offline and free. Node is never started: `run_scraper` gets a fake runner, and the LLM/docx
pipeline is replaced by `fake_pipeline` (copies the master CV, or fails when the description
contains "FAIL"). Only `run_command` is exercised for real, with tiny `python -c` children.
"""

import hashlib
import os
import shutil
import sys
from collections import deque

import pytest

from app.llm_factory import resolve_config
from app.pipeline import MASTER_CV, PipelineError, PipelineResult

sp = pytest.importorskip("app.scrape_pipeline", reason="Part 1 not implemented yet")
bp = pytest.importorskip("app.batch_pipeline")

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_CSV = os.path.join(HERE, "fixtures", "new_jobs_sample.csv")
PREFIX = "Md_Rawfur_Monzur_Jim_CV_"
ROW_KEYS = {"company", "title", "link", "description", "location", "posted", "source",
            "match", "match_note", "filename", "status", "error", "job_title"}


def _sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def fake_pipeline_factory(calls: list):
    def fake_pipeline(job_description, config, output_path=None):
        calls.append((job_description, output_path))
        if "FAIL" in job_description:
            raise PipelineError("The model failed (fake).", kind="llm")
        shutil.copy(MASTER_CV, output_path)
        return PipelineResult(docx_path=output_path, job_title="Engineer")
    return fake_pipeline


# ---------------------------------------------------------------------------
# load_matched_rows
# ---------------------------------------------------------------------------
def test_load_matched_rows_maps_columns_and_sorts_by_match():
    rows = sp.load_matched_rows(FIXTURE_CSV)
    assert len(rows) == 6
    assert all(set(r) >= ROW_KEYS for r in rows)
    assert [r["match"] for r in rows] == ["top", "top", "medium", "low", "none", "none"]
    # stable: file order kept inside each group (Acme AI came before Beta Labs in the file)
    assert [r["company"] for r in rows[:2]] == ["Acme AI", "Beta Labs"]
    assert all(r["status"] == "pending" and r["error"] == "" and r["job_title"] == "" for r in rows)


def test_load_matched_rows_field_values():
    rows = {r["link"]: r for r in sp.load_matched_rows(FIXTURE_CSV)}
    acme = rows["https://job-boards.greenhouse.io/acme/jobs/1"]
    assert acme["company"] == "Acme AI"
    assert acme["title"] == "Senior AI Engineer"
    assert acme["location"] == "London, UK"
    assert acme["posted"] == "2026-09-23"
    assert acme["source"] == "greenhouse-api"
    assert acme["description"].startswith("Acme AI is hiring")
    assert acme["match_note"] == "top match"
    err = rows["https://uk.indeed.com/viewjob?jk=0123456789abcdef"]
    assert err["match"] == "none"
    assert err["match_note"].startswith("error:")
    nodesc = rows["https://job-boards.greenhouse.io/acme/jobs/2"]
    assert nodesc["match"] == "none" and nodesc["description"] == ""


def test_load_matched_rows_filenames_are_unique_and_company_based():
    rows = sp.load_matched_rows(FIXTURE_CSV)
    names = [r["filename"] for r in rows]
    assert len(set(names)) == len(names)
    assert all(n.startswith(PREFIX) and n.endswith(".docx") for n in names)
    acme = sorted(r["filename"] for r in rows if r["company"] == "Acme AI")
    assert acme == [f"{PREFIX}Acme_AI.docx", f"{PREFIX}Acme_AI_1.docx"]


def test_blank_description_is_none_even_when_labelled_top(tmp_path):
    p = tmp_path / "new-jobs-2026-09-23-000001.csv"
    p.write_text("Company,Title,Location,URL,Source,Posted,First seen,Description,Match status\r\n"
                 "Acme,Eng,London,https://x.example/1,greenhouse-api,2026-09-23,2026-09-23,,top match\r\n",
                 encoding="utf-8-sig")
    (row,) = sp.load_matched_rows(str(p))
    assert row["match"] == "none"
    assert row["match_note"] == "top match"


def test_missing_match_status_column_means_all_none(tmp_path):
    p = tmp_path / "new-jobs-2026-09-23-000002.csv"
    p.write_text("Company,Title,Location,URL,Source,Posted,First seen,Description\r\n"
                 "Acme,Eng,London,https://x.example/1,greenhouse-api,2026-09-23,2026-09-23,Build things\r\n"
                 "Beta,ML,Leeds,https://x.example/2,lever-api,2026-09-23,2026-09-23,Train models\r\n",
                 encoding="utf-8-sig")
    rows = sp.load_matched_rows(str(p))
    assert [r["match"] for r in rows] == ["none", "none"]
    assert all(r["match_note"] == "" for r in rows)


# ---------------------------------------------------------------------------
# newest_csv
# ---------------------------------------------------------------------------
def test_newest_csv_picks_last_name(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "NEW_DATA_DIR", str(tmp_path))
    assert sp.newest_csv() is None
    for name in ("new-jobs-2026-09-21-090000.csv", "new-jobs-2026-09-23-120910.csv",
                 "new-jobs-2026-09-22-101010.csv", "exported-urls.txt", "notes.csv"):
        (tmp_path / name).write_text("x", encoding="utf-8")
    assert os.path.basename(sp.newest_csv()) == "new-jobs-2026-09-23-120910.csv"


def test_newest_csv_missing_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "NEW_DATA_DIR", str(tmp_path / "nope"))
    assert sp.newest_csv() is None


# ---------------------------------------------------------------------------
# run_scraper (fake runner: Node is never started)
# ---------------------------------------------------------------------------
@pytest.fixture
def scraper_dirs(tmp_path, monkeypatch):
    new_dir = tmp_path / "new-data"
    new_dir.mkdir()
    monkeypatch.setattr(sp, "NEW_DATA_DIR", str(new_dir))
    monkeypatch.setattr(sp, "LINKS_FILE", str(tmp_path / "links.txt"))
    # any executable on PATH will do: the fake runner never runs it
    monkeypatch.setattr(sp, "NODE", sys.executable)
    return tmp_path


def make_runner(calls, exit_code=0, write_csv=None, log_lines=()):
    """A stand-in for run_command that records the call and may drop a CSV into NEW_DATA_DIR."""
    def runner(cmd, cwd, env, log, timeout):
        calls.append({"cmd": list(cmd), "cwd": cwd, "env": dict(env), "timeout": timeout})
        for line in log_lines:
            log.append(line)
        if write_csv:
            with open(os.path.join(sp.NEW_DATA_DIR, write_csv), "w", encoding="utf-8-sig") as f:
                f.write("Company,Title,Location,URL,Source,Posted,First seen,Description,Match status\r\n")
        return exit_code
    return runner


def test_run_scraper_returns_new_csv(scraper_dirs):
    (scraper_dirs / "new-data" / "new-jobs-2026-09-21-090000.csv").write_text("old", encoding="utf-8")
    calls = []
    path = sp.run_scraper([], deque(), runner=make_runner(calls, write_csv="new-jobs-2026-09-23-130000.csv"))
    assert os.path.basename(path) == "new-jobs-2026-09-23-130000.csv"
    assert len(calls) == 1


def test_run_scraper_nothing_new_returns_none(scraper_dirs):
    (scraper_dirs / "new-data" / "new-jobs-2026-09-21-090000.csv").write_text("old", encoding="utf-8")
    assert sp.run_scraper([], deque(), runner=make_runner([])) is None


def test_run_scraper_failure_without_csv_raises_with_last_log_line(scraper_dirs):
    log = deque()
    runner = make_runner([], exit_code=1, log_lines=["── step 1/3: scan ──", "scan.mjs failed (exit 1) — stopping"])
    with pytest.raises(sp.ScrapeError) as exc:
        sp.run_scraper([], log, runner=runner)
    assert "scan.mjs failed" in str(exc.value)


def test_run_scraper_matcher_failure_still_returns_csv(scraper_dirs):
    runner = make_runner([], exit_code=1, write_csv="new-jobs-2026-09-23-130000.csv",
                         log_lines=["The new-jobs csv is written but matching failed (exit 1)"])
    path = sp.run_scraper([], deque(), runner=runner)
    assert path and path.endswith("new-jobs-2026-09-23-130000.csv")


def test_run_scraper_with_indeed_links_writes_links_file_and_adds_step(scraper_dirs):
    calls = []
    links = ["https://uk.indeed.com/viewjob?jk=abc12345", "https://uk.indeed.com/jobs?q=ai&vjk=def67890"]
    sp.run_scraper(links, deque(), runner=make_runner(calls))
    with open(sp.LINKS_FILE, encoding="utf-8") as f:
        assert f.read().splitlines() == links
    cmd = calls[0]["cmd"]
    assert cmd[cmd.index("--steps") + 1] == "indeed,scan,export,match"


def test_run_scraper_without_links_skips_indeed(scraper_dirs):
    calls = []
    sp.run_scraper([], deque(), runner=make_runner(calls))
    assert not os.path.exists(sp.LINKS_FILE)
    cmd = calls[0]["cmd"]
    assert cmd[cmd.index("--steps") + 1] == "scan,export,match"
    assert "--" not in cmd


def test_run_scraper_match_limit_is_forwarded_to_the_matcher(scraper_dirs):
    calls = []
    sp.run_scraper([], deque(), match_limit=2, runner=make_runner(calls))
    assert calls[0]["cmd"][-3:] == ["--", "--limit", "2"]


def test_run_scraper_command_shape(scraper_dirs):
    calls = []
    sp.run_scraper([], deque(), runner=make_runner(calls))
    call = calls[0]
    assert call["cmd"][1].endswith("run-all.mjs")
    assert os.path.isabs(call["cmd"][1])
    assert os.path.normpath(call["cwd"]) == os.path.normpath(sp.SCRAPER_DIR)
    assert call["env"]["PYTHONUTF8"] == "1"
    assert call["timeout"] > 0


def test_run_scraper_missing_node_is_a_clear_error(scraper_dirs, monkeypatch):
    monkeypatch.setattr(sp, "NODE", "definitely-not-a-real-node-binary")
    with pytest.raises(sp.ScrapeError) as exc:
        sp.run_scraper([], deque(), runner=make_runner([]))
    assert "node" in str(exc.value).lower()


# ---------------------------------------------------------------------------
# run_command (real, tiny children)
# ---------------------------------------------------------------------------
def test_run_command_returns_exit_code_and_captures_output(tmp_path):
    log = deque(maxlen=200)
    code = sp.run_command([sys.executable, "-c", "print('hello from child'); import sys; sys.exit(3)"],
                          cwd=str(tmp_path), env=dict(os.environ), log=log, timeout=60)
    assert code == 3
    assert "hello from child" in list(log)


def test_run_command_child_has_no_tty_stdin(tmp_path):
    log = deque(maxlen=200)
    code = sp.run_command([sys.executable, "-c", "import sys; print(sys.stdin.isatty())"],
                          cwd=str(tmp_path), env=dict(os.environ), log=log, timeout=60)
    assert code == 0
    assert "False" in list(log)


def test_run_command_timeout_kills_child(tmp_path):
    log = deque(maxlen=200)
    code = sp.run_command([sys.executable, "-c", "import time; time.sleep(30)"],
                          cwd=str(tmp_path), env=dict(os.environ), log=log, timeout=1)
    assert code != 0
    assert any("time" in line.lower() for line in log)


# ---------------------------------------------------------------------------
# generate_row
# ---------------------------------------------------------------------------
def test_generate_row_done(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(bp, "run_pipeline", fake_pipeline_factory(calls))
    before = _sha256(MASTER_CV)
    config = resolve_config("deepseek", None, "sk-test-key")
    row = {"company": "Acme", "description": "Build LLM features", "filename": f"{PREFIX}Acme.docx",
           "status": "pending", "error": "", "job_title": ""}
    sp.generate_row(row, config, str(tmp_path))
    assert row["status"] == "done"
    assert row["job_title"] == "Engineer"
    assert row["error"] == ""
    assert os.path.exists(tmp_path / f"{PREFIX}Acme.docx")
    assert calls == [("Build LLM features", str(tmp_path / f"{PREFIX}Acme.docx"))]
    assert _sha256(MASTER_CV) == before


def test_generate_row_failed(tmp_path, monkeypatch):
    monkeypatch.setattr(bp, "run_pipeline", fake_pipeline_factory([]))
    config = resolve_config("deepseek", None, "sk-test-key")
    row = {"company": "Beta", "description": "This will FAIL", "filename": f"{PREFIX}Beta.docx",
           "status": "pending", "error": "", "job_title": ""}
    sp.generate_row(row, config, str(tmp_path))
    assert row["status"] == "failed"
    assert "fake" in row["error"]
    assert not os.path.exists(tmp_path / f"{PREFIX}Beta.docx")


def test_generate_row_accepts_explicit_pipeline(tmp_path):
    calls = []
    config = resolve_config("deepseek", None, "sk-test-key")
    row = {"company": "Acme", "description": "x", "filename": f"{PREFIX}Acme.docx",
           "status": "pending", "error": "", "job_title": ""}
    sp.generate_row(row, config, str(tmp_path), pipeline=fake_pipeline_factory(calls))
    assert row["status"] == "done" and len(calls) == 1
