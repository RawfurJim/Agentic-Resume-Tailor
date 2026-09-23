"""
Part 2 tests: app/scrape.py, the scraped-jobs job API  (see PLAN_SCRAPE.md, Part 2).

All offline and free. The scraper is replaced by a fake `run_scraper` that returns the fixture
CSV (Node never starts), the job runs synchronously inside the POST (RUN_INLINE = True), and the
LLM/docx pipeline is replaced by a fake that copies the master CV.

Fixture CSV order after load_matched_rows (top, top, medium, low, none, none):
  0 Acme AI (top)  1 Beta Labs (top)  2 Gamma Ltd (medium)  3 Delta plc (low)
  4 Acme AI (no description)  5 Epsilon (error: …)
"""

import hashlib
import io
import os
import shutil
import zipfile

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.pipeline import MASTER_CV, PipelineError, PipelineResult

scrape = pytest.importorskip("app.scrape", reason="Part 2 not implemented yet")
sp = pytest.importorskip("app.scrape_pipeline", reason="Part 1 not implemented yet")
bp = pytest.importorskip("app.batch_pipeline")

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_CSV = os.path.join(HERE, "fixtures", "new_jobs_sample.csv")
DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
FAKE_KEY = "sk-test-scrape-key"
PREFIX = "Md_Rawfur_Monzur_Jim_CV_"

client = TestClient(main.app)


def _sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class FakeScraper:
    """Stand-in for scrape_pipeline.run_scraper: records what it was asked, returns a CSV path."""

    def __init__(self):
        self.calls = []
        self.result = FIXTURE_CSV      # a path, None (nothing new) or an Exception to raise
        self.log_lines = 0

    def __call__(self, indeed_links, log, *args, **kwargs):
        match_limit = kwargs.get("match_limit", args[0] if args else None)
        self.calls.append({"indeed_links": list(indeed_links), "match_limit": match_limit})
        for i in range(self.log_lines):
            log.append(f"line {i}")
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def env(tmp_path, monkeypatch):
    calls = []

    def fake_pipeline(job_description, config, output_path=None):
        calls.append((job_description, output_path))
        if "FAIL" in job_description:
            raise PipelineError("The model failed (fake).", kind="llm")
        shutil.copy(MASTER_CV, output_path)
        return PipelineResult(docx_path=output_path, job_title="Engineer")

    scraper = FakeScraper()
    newest = {"path": None}
    monkeypatch.setattr(scrape, "SCRAPE_OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(scrape, "RUN_INLINE", True)
    monkeypatch.setattr(sp, "run_scraper", scraper)
    monkeypatch.setattr(sp, "newest_csv", lambda: newest["path"])
    monkeypatch.setattr(bp, "run_pipeline", fake_pipeline)
    monkeypatch.setenv("DEEPSEEK_API_KEY", FAKE_KEY)
    scrape.JOBS.clear()
    yield {"scraper": scraper, "pipeline_calls": calls, "newest": newest, "dir": tmp_path}
    scrape.JOBS.clear()


def start(**body):
    payload = {"indeed_links": [], "reuse_latest": False, "top_cap": 15, "provider": "deepseek"}
    payload.update(body)
    return client.post("/api/scrape", json=payload)


def generate(job_id, index, **body):
    payload = {"provider": "deepseek"}
    payload.update(body)
    return client.post(f"/api/scrape/{job_id}/rows/{index}/generate", json=payload)


# ---------------------------------------------------------------------------
# pages and helpers
# ---------------------------------------------------------------------------
def test_scrape_page_is_served():
    resp = client.get("/scrape")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")


def test_latest_reports_newest_csv(env):
    resp = client.get("/api/scrape/latest")
    assert resp.status_code == 200
    assert resp.json()["csv_name"] is None
    env["newest"]["path"] = FIXTURE_CSV
    body = client.get("/api/scrape/latest").json()
    assert body["csv_name"] == "new_jobs_sample.csv"
    assert body["rows"] == 6


# ---------------------------------------------------------------------------
# start: scrape + auto-generate top matches up to the cap
# ---------------------------------------------------------------------------
def test_start_with_cap_one_generates_one_top_cv(env):
    resp = start(top_cap=1)
    assert resp.status_code == 200, resp.text
    job = resp.json()
    assert job["state"] == "idle"
    assert job["error"] == ""
    assert job["csv_name"] == "new_jobs_sample.csv"
    assert job["counts"] == {"top": 2, "medium": 1, "low": 1, "none": 2, "done": 1, "failed": 0, "queued": 0}
    rows = job["rows"]
    assert [r["match"] for r in rows] == ["top", "top", "medium", "low", "none", "none"]
    assert [r["index"] for r in rows] == [0, 1, 2, 3, 4, 5]

    assert rows[0]["status"] == "done" and rows[0]["auto"] is True
    assert rows[0]["download_url"] == f"/api/scrape/{job['id']}/files/0"
    assert rows[0]["job_title"] == "Engineer"
    assert rows[0]["can_generate"] is False

    assert rows[1]["status"] == "pending" and rows[1]["auto"] is False
    assert rows[1]["can_generate"] is True and rows[1]["download_url"] is None
    assert rows[2]["can_generate"] is True                 # medium
    assert rows[3]["can_generate"] is False                # low
    assert rows[4]["can_generate"] is False                # no description
    assert rows[5]["can_generate"] is False                # error: …
    assert rows[5]["match_note"].startswith("error:")

    for r in rows:
        assert "description" not in r
        assert {"title", "company", "location", "posted", "link", "status", "error"} <= set(r)
    assert job["zip_url"] == f"/api/scrape/{job['id']}/download"
    assert FAKE_KEY not in resp.text
    assert len(env["pipeline_calls"]) == 1
    assert env["scraper"].calls == [{"indeed_links": [], "match_limit": None}]


def test_start_passes_links_and_match_limit_to_the_scraper(env):
    links = ["https://uk.indeed.com/viewjob?jk=abc12345", "https://uk.indeed.com/jobs?q=ai&vjk=def67890"]
    resp = start(indeed_links=links, match_limit=2, top_cap=0)
    assert resp.status_code == 200, resp.text
    assert env["scraper"].calls == [{"indeed_links": links, "match_limit": 2}]


def test_start_with_cap_zero_generates_nothing(env):
    job = start(top_cap=0).json()
    assert job["counts"]["done"] == 0
    assert all(r["status"] == "pending" for r in job["rows"])
    assert [r["can_generate"] for r in job["rows"]] == [True, True, True, False, False, False]
    assert job["zip_url"] is None
    assert env["pipeline_calls"] == []


def test_start_cap_above_limit_is_rejected(env):
    assert start(top_cap=201).status_code == 422
    assert start(top_cap=-1).status_code == 422
    assert start(match_limit=0).status_code == 422


def test_start_gemini_without_key_is_400(env):
    resp = start(provider="gemini")
    assert resp.status_code == 400
    assert env["scraper"].calls == []


def test_start_while_another_scrape_is_running_is_409(env):
    scrape.JOBS["busy1"] = {"id": "busy1", "state": "scraping", "rows": [], "dir": str(env["dir"])}
    resp = start()
    assert resp.status_code == 409
    assert env["scraper"].calls == []


def test_start_reuse_latest_without_csv_fails_cleanly(env):
    job = start(reuse_latest=True).json()
    assert job["state"] == "failed"
    assert "No scraped file" in job["error"]
    assert env["scraper"].calls == []


def test_start_reuse_latest_skips_the_scraper(env):
    env["newest"]["path"] = FIXTURE_CSV
    job = start(reuse_latest=True, top_cap=0).json()
    assert job["state"] == "idle"
    assert len(job["rows"]) == 6
    assert env["scraper"].calls == []


def test_start_nothing_new(env):
    env["scraper"].result = None
    job = start().json()
    assert job["state"] == "idle"
    assert job["rows"] == []
    assert "No new jobs" in job["phase"]
    assert job["error"] == ""


def test_start_scraper_failure(env):
    env["scraper"].result = sp.ScrapeError("boom: scan.mjs failed (exit 1)")
    job = start().json()
    assert job["state"] == "failed"
    assert "boom" in job["error"]
    assert job["rows"] == []


def test_status_log_is_capped_at_40_lines(env):
    env["scraper"].log_lines = 50
    job = start(top_cap=0).json()
    assert isinstance(job["log"], list)
    assert len(job["log"]) == 40
    assert job["log"][-1] == "line 49"
    again = client.get(f"/api/scrape/{job['id']}").json()
    assert again["log"] == job["log"]


def test_get_unknown_job_is_404(env):
    assert client.get("/api/scrape/nope").status_code == 404
    assert client.get("/api/scrape/nope/files/0").status_code == 404
    assert client.get("/api/scrape/nope/download").status_code == 404
    assert generate("nope", 0).status_code == 404


# ---------------------------------------------------------------------------
# manual Generate CV
# ---------------------------------------------------------------------------
def test_generate_medium_row_then_download_and_zip(env):
    job = start(top_cap=1).json()
    job_id = job["id"]
    before = _sha256(MASTER_CV)

    resp = generate(job_id, 2, api_key=FAKE_KEY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["state"] == "idle"
    row = body["rows"][2]
    assert row["status"] == "done"
    assert row["download_url"] == f"/api/scrape/{job_id}/files/2"
    assert row["can_generate"] is False
    assert body["counts"]["done"] == 2
    assert FAKE_KEY not in resp.text
    assert len(env["pipeline_calls"]) == 2
    assert env["pipeline_calls"][1][0].startswith("Gamma Ltd needs")

    file_resp = client.get(f"/api/scrape/{job_id}/files/2")
    assert file_resp.status_code == 200
    assert file_resp.headers["content-type"].startswith(DOCX_MEDIA_TYPE)
    assert "Gamma_Ltd" in file_resp.headers["content-disposition"]

    zip_resp = client.get(f"/api/scrape/{job_id}/download")
    assert zip_resp.status_code == 200
    assert zip_resp.headers["content-type"].startswith("application/zip")
    names = sorted(zipfile.ZipFile(io.BytesIO(zip_resp.content)).namelist())
    assert names == sorted([f"{PREFIX}Acme_AI.docx", f"{PREFIX}Gamma_Ltd.docx"])
    assert _sha256(MASTER_CV) == before


def test_generate_is_refused_for_low_none_and_done_rows(env):
    job = start(top_cap=1).json()
    job_id = job["id"]
    assert generate(job_id, 3, api_key=FAKE_KEY).status_code == 409   # low
    assert generate(job_id, 4, api_key=FAKE_KEY).status_code == 409   # no description
    assert generate(job_id, 5, api_key=FAKE_KEY).status_code == 409   # error: …
    assert generate(job_id, 0, api_key=FAKE_KEY).status_code == 409   # already done
    assert generate(job_id, 99, api_key=FAKE_KEY).status_code == 404  # no such row
    assert len(env["pipeline_calls"]) == 1


def test_generate_failed_row_can_be_retried(env, monkeypatch):
    job = start(top_cap=0).json()
    job_id = job["id"]
    scrape.JOBS[job_id]["rows"][1]["description"] = "This will FAIL"
    body = generate(job_id, 1, api_key=FAKE_KEY).json()
    assert body["rows"][1]["status"] == "failed"
    assert "fake" in body["rows"][1]["error"]
    assert body["rows"][1]["can_generate"] is True
    assert body["counts"]["failed"] == 1
    scrape.JOBS[job_id]["rows"][1]["description"] = "Fixed description"
    body = generate(job_id, 1, api_key=FAKE_KEY).json()
    assert body["rows"][1]["status"] == "done"


def test_generate_gemini_without_key_is_400(env):
    job = start(top_cap=0).json()
    resp = generate(job["id"], 2, provider="gemini")
    assert resp.status_code == 400
    assert env["pipeline_calls"] == []


def test_generate_while_scraping_is_409(env):
    scrape.JOBS["s1"] = {"id": "s1", "state": "scraping", "rows": [], "dir": str(env["dir"])}
    assert generate("s1", 0, api_key=FAKE_KEY).status_code == 409


def test_generate_on_failed_job_is_409(env):
    env["scraper"].result = sp.ScrapeError("boom")
    job = start().json()
    assert generate(job["id"], 0, api_key=FAKE_KEY).status_code == 409


# ---------------------------------------------------------------------------
# downloads
# ---------------------------------------------------------------------------
def test_download_zip_needs_a_done_row(env):
    job = start(top_cap=0).json()
    assert client.get(f"/api/scrape/{job['id']}/download").status_code == 404
    assert client.get(f"/api/scrape/{job['id']}/files/1").status_code == 404


def test_download_zip_while_scraping_is_409(env):
    scrape.JOBS["s2"] = {"id": "s2", "state": "scraping", "rows": [], "dir": str(env["dir"])}
    assert client.get("/api/scrape/s2/download").status_code == 409


# ---------------------------------------------------------------------------
# hygiene
# ---------------------------------------------------------------------------
def test_no_key_and_no_description_anywhere_in_status(env):
    job = start(top_cap=1, api_key=FAKE_KEY).json()
    text = client.get(f"/api/scrape/{job['id']}").text
    assert FAKE_KEY not in text
    assert "Acme AI is hiring" not in text
    assert "config" not in scrape.JOBS[job["id"]] or scrape.JOBS[job["id"]]["config"] is None


def test_output_dir_is_per_job(env):
    a = start(top_cap=1).json()
    b = start(top_cap=1).json()
    assert a["id"] != b["id"]
    assert os.path.isdir(env["dir"] / a["id"]) and os.path.isdir(env["dir"] / b["id"])
    assert os.listdir(env["dir"] / a["id"]) == [f"{PREFIX}Acme_AI.docx"]
