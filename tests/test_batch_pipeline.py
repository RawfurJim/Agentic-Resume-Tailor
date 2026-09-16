"""
Part 1 tests: app/batch_pipeline.py  (see PLAN_BATCH.md, Part 1).

All offline and free. The LLM/docx pipeline is replaced by `fake_pipeline`, which copies the
master CV to the requested output path (or fails when the description contains "FAIL").
"""

import hashlib
import inspect
import io
import os
import shutil
import zipfile

import pytest

from app.llm_factory import resolve_config
from app.pipeline import MASTER_CV, PipelineError, PipelineResult, run_pipeline

bp = pytest.importorskip("app.batch_pipeline", reason="Part 1 not implemented yet")

PREFIX = "Md_Rawfur_Monzur_Jim_CV_"

CSV_3_ROWS = (
    "Title,Company,Link,Description\n"
    "Senior AI Engineer,Acme,https://acme.example/jobs/1,\"Build LLM features.\nPython and FastAPI.\"\n"
    "Data Scientist,Beta Ltd,,This one will FAIL on purpose\n"
    "ML Engineer,Acme,https://acme.example/jobs/2,Productionise NLP models\n"
).encode("utf-8")


def _sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def fake_pipeline_factory(calls: list):
    """A stand-in for run_pipeline that records its calls and never touches an LLM."""

    def fake_pipeline(job_description, config, output_path=None):
        calls.append((job_description, output_path))
        if "FAIL" in job_description:
            raise PipelineError("The model failed (fake).", kind="llm")
        shutil.copy(MASTER_CV, output_path)
        return PipelineResult(docx_path=output_path, job_title="Engineer")

    return fake_pipeline


# ---------------------------------------------------------------------------
# run_pipeline gained an optional output_path (default None -> old behaviour)
# ---------------------------------------------------------------------------
def test_run_pipeline_has_optional_output_path():
    params = inspect.signature(run_pipeline).parameters
    assert "output_path" in params
    assert params["output_path"].default is None


# ---------------------------------------------------------------------------
# read_rows
# ---------------------------------------------------------------------------
def test_read_rows_csv():
    rows = bp.read_rows(CSV_3_ROWS, "jobs.csv")
    assert len(rows) == 3
    assert rows[0] == {
        "title": "Senior AI Engineer",
        "company": "Acme",
        "link": "https://acme.example/jobs/1",
        "description": "Build LLM features.\nPython and FastAPI.",   # quoted multi-line survives
    }
    assert rows[1]["link"] == ""                                       # empty cell -> ""
    assert rows[2]["company"] == "Acme"


def test_read_rows_header_is_case_and_space_insensitive():
    data = b" TITLE , Company ,LINK, description \nx,Acme,,Some job\n"
    rows = bp.read_rows(data, "jobs.csv")
    assert rows == [{"title": "x", "company": "Acme", "link": "", "description": "Some job"}]


def test_read_rows_title_and_link_columns_are_optional():
    data = b"company,description\nAcme,Some job\n"
    rows = bp.read_rows(data, "jobs.csv")
    assert rows == [{"title": "", "company": "Acme", "link": "", "description": "Some job"}]


def test_read_rows_missing_company_column_is_value_error():
    with pytest.raises(ValueError):
        bp.read_rows(b"title,description\nx,Some job\n", "jobs.csv")


def test_read_rows_missing_description_column_is_value_error():
    with pytest.raises(ValueError):
        bp.read_rows(b"title,company\nx,Acme\n", "jobs.csv")


def test_read_rows_header_only_is_value_error():
    with pytest.raises(ValueError):
        bp.read_rows(b"title,company,link,description\n", "jobs.csv")


def test_read_rows_xlsx():
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["Title", "Company", "Link", "Description"])
    ws.append(["AI Engineer", "Acme", "https://acme.example/1", "Job one"])
    ws.append(["Data Scientist", "Beta Ltd", None, "Job two"])
    buf = io.BytesIO()
    wb.save(buf)

    rows = bp.read_rows(buf.getvalue(), "jobs.xlsx")
    assert rows == [
        {"title": "AI Engineer", "company": "Acme", "link": "https://acme.example/1", "description": "Job one"},
        {"title": "Data Scientist", "company": "Beta Ltd", "link": "", "description": "Job two"},
    ]


# ---------------------------------------------------------------------------
# make_filenames
# ---------------------------------------------------------------------------
def test_make_filenames_adds_suffix_for_duplicates():
    rows = [{"company": c} for c in ["Acme", "Acme", "Beta Ltd", "Acme"]]
    assert bp.make_filenames(rows) == [
        f"{PREFIX}Acme.docx",
        f"{PREFIX}Acme_1.docx",
        f"{PREFIX}Beta_Ltd.docx",
        f"{PREFIX}Acme_2.docx",
    ]


# ---------------------------------------------------------------------------
# run_batch + make_zip with the fake pipeline
# ---------------------------------------------------------------------------
def test_run_batch_processes_rows_one_at_a_time(tmp_path):
    master_before = _sha256(MASTER_CV)
    rows = bp.read_rows(CSV_3_ROWS, "jobs.csv")
    config = resolve_config("deepseek", None, "sk-test")          # no LLM is built here
    calls, finished = [], []

    bp.run_batch(rows, config, str(tmp_path), on_row_done=finished.append,
                 pipeline=fake_pipeline_factory(calls))

    # statuses and errors
    assert [r["status"] for r in rows] == ["done", "failed", "done"]
    assert rows[1]["error"] == "The model failed (fake)."
    assert rows[0]["error"] == "" and rows[2]["error"] == ""
    assert rows[0]["job_title"] == "Engineer"

    # the pipeline was called once per row, in order, with that row's output path
    assert [c[0] for c in calls] == [r["description"] for r in rows]
    assert [c[1] for c in calls] == [os.path.join(str(tmp_path), r["filename"]) for r in rows]
    assert [r["filename"] for r in rows] == [f"{PREFIX}Acme.docx", f"{PREFIX}Beta_Ltd.docx", f"{PREFIX}Acme_1.docx"]

    # files exist only for the done rows; the callback saw every row
    assert (tmp_path / rows[0]["filename"]).exists()
    assert not (tmp_path / rows[1]["filename"]).exists()
    assert (tmp_path / rows[2]["filename"]).exists()
    assert len(finished) == 3

    # zip holds exactly the done docx files
    zip_path = bp.make_zip(rows, str(tmp_path), str(tmp_path / "all.zip"))
    with zipfile.ZipFile(zip_path) as zf:
        assert sorted(zf.namelist()) == sorted([rows[0]["filename"], rows[2]["filename"]])

    assert _sha256(MASTER_CV) == master_before


def test_run_batch_default_pipeline_is_looked_up_at_call_time(tmp_path, monkeypatch):
    """Monkeypatching app.batch_pipeline.run_pipeline must be enough to fake the LLM step."""
    calls = []
    monkeypatch.setattr(bp, "run_pipeline", fake_pipeline_factory(calls))
    rows = [{"title": "", "company": "Acme", "link": "", "description": "Some job"}]
    config = resolve_config("deepseek", None, "sk-test")

    bp.run_batch(rows, config, str(tmp_path))

    assert len(calls) == 1
    assert rows[0]["status"] == "done"
