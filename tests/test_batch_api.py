"""
Part 2 tests: app/batch.py, the batch job API  (see PLAN_BATCH.md, Part 2).

All offline and free. The batch runs synchronously inside the POST (RUN_INLINE = True) and the
LLM/docx pipeline is replaced by a fake that copies the master CV.
"""

import io
import shutil
import zipfile

import docx
import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.pipeline import MASTER_CV, PipelineError, PipelineResult

batch = pytest.importorskip("app.batch", reason="Part 2 not implemented yet")
bp = pytest.importorskip("app.batch_pipeline", reason="Part 1 not implemented yet")

DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
FAKE_KEY = "sk-test-batch-key"
PREFIX = "Md_Rawfur_Monzur_Jim_CV_"

CSV_3_ROWS = (
    "title,company,link,description\n"
    "Senior AI Engineer,Acme,https://acme.example/jobs/1,Build LLM features\n"
    "Data Scientist,Beta Ltd,,This one will FAIL on purpose\n"
    "ML Engineer,Acme,https://acme.example/jobs/2,Productionise NLP models\n"
).encode("utf-8")

client = TestClient(main.app)


@pytest.fixture
def batch_env(tmp_path, monkeypatch):
    """Run batches inline into tmp_path with a fake pipeline and a fake DeepSeek key."""
    calls = []

    def fake_pipeline(job_description, config, output_path=None):
        calls.append((job_description, output_path))
        if "FAIL" in job_description:
            raise PipelineError("The model failed (fake).", kind="llm")
        shutil.copy(MASTER_CV, output_path)
        return PipelineResult(docx_path=output_path, job_title="Engineer")

    monkeypatch.setattr(batch, "BATCH_OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(batch, "RUN_INLINE", True)
    monkeypatch.setattr(bp, "run_pipeline", fake_pipeline)
    monkeypatch.setenv("DEEPSEEK_API_KEY", FAKE_KEY)
    batch.JOBS.clear()
    yield calls
    batch.JOBS.clear()


def post_csv(data: bytes = CSV_3_ROWS, filename: str = "jobs.csv", **form):
    return client.post("/api/batch", files={"file": (filename, data, "text/csv")}, data=form)


# ---------------------------------------------------------------------------
# the happy path: one POST, three rows, one of them fails
# ---------------------------------------------------------------------------
def test_post_runs_batch_and_returns_status(batch_env):
    resp = post_csv(provider="deepseek")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["state"] == "done"
    assert body["id"]
    rows = body["rows"]
    assert [r["status"] for r in rows] == ["done", "failed", "done"]
    assert [r["company"] for r in rows] == ["Acme", "Beta Ltd", "Acme"]
    assert rows[0]["title"] == "Senior AI Engineer"
    assert rows[0]["link"] == "https://acme.example/jobs/1"
    assert rows[1]["error"] == "The model failed (fake)."
    assert rows[0]["download_url"] == f"/api/batch/{body['id']}/files/0"
    assert rows[1]["download_url"] is None
    assert rows[2]["download_url"] == f"/api/batch/{body['id']}/files/2"
    assert body["zip_url"] == f"/api/batch/{body['id']}/download"

    # the fake pipeline ran once per row, in order
    assert [c[0] for c in batch_env] == ["Build LLM features", "This one will FAIL on purpose", "Productionise NLP models"]

    # the key never appears in the response, and is dropped once the job is done
    assert FAKE_KEY not in resp.text
    assert batch.JOBS[body["id"]]["config"] is None

    # polling the same job returns the same status
    again = client.get(f"/api/batch/{body['id']}")
    assert again.status_code == 200
    assert again.json()["rows"] == rows


def test_row_download_returns_docx_named_after_company(batch_env):
    job_id = post_csv().json()["id"]

    resp = client.get(f"/api/batch/{job_id}/files/2")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == DOCX_MEDIA_TYPE
    assert f"{PREFIX}Acme_1.docx" in resp.headers["content-disposition"]
    document = docx.Document(io.BytesIO(resp.content))
    assert [p for p in document.paragraphs if p.text.strip()]


def test_failed_or_bad_row_download_is_404(batch_env):
    job_id = post_csv().json()["id"]
    assert client.get(f"/api/batch/{job_id}/files/1").status_code == 404     # failed row
    assert client.get(f"/api/batch/{job_id}/files/99").status_code == 404    # no such row


def test_zip_download_contains_only_done_files(batch_env):
    job_id = post_csv().json()["id"]

    resp = client.get(f"/api/batch/{job_id}/download")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        assert sorted(zf.namelist()) == [f"{PREFIX}Acme.docx", f"{PREFIX}Acme_1.docx"]


# ---------------------------------------------------------------------------
# errors
# ---------------------------------------------------------------------------
def test_unknown_job_is_404(batch_env):
    assert client.get("/api/batch/no-such-job").status_code == 404
    assert client.get("/api/batch/no-such-job/files/0").status_code == 404
    assert client.get("/api/batch/no-such-job/download").status_code == 404


def test_csv_without_company_column_is_400(batch_env):
    resp = post_csv(b"title,description\nx,Some job\n")
    assert resp.status_code == 400
    assert "company" in resp.json()["detail"].lower()
    assert batch_env == []                                   # the pipeline never ran


def test_gemini_without_key_is_400(batch_env):
    resp = post_csv(provider="gemini")
    assert resp.status_code == 400
    assert "API key" in resp.json()["detail"]
    assert batch_env == []


def test_missing_file_is_422(batch_env):
    resp = client.post("/api/batch", data={"provider": "deepseek"})
    assert resp.status_code == 422


def test_second_batch_while_one_is_running_is_409(batch_env, tmp_path):
    batch.JOBS["running-job"] = {
        "id": "running-job", "state": "running", "dir": str(tmp_path), "rows": [], "config": None,
    }
    resp = post_csv()
    assert resp.status_code == 409
    assert batch_env == []


def test_zip_while_running_is_409(batch_env, tmp_path):
    batch.JOBS["running-job"] = {
        "id": "running-job", "state": "running", "dir": str(tmp_path), "rows": [], "config": None,
    }
    assert client.get("/api/batch/running-job/download").status_code == 409
