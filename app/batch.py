"""
app/batch.py
------------
Part 2 of the batch feature (see PLAN_BATCH.md): the job API on top of app/batch_pipeline.py.

    GET  /batch                            -> static/batch.html (the second page)
    POST /api/batch                        -> upload a CSV/xlsx, start a job, return its status
    GET  /api/batch/{id}                   -> job status (the page polls this)
    GET  /api/batch/{id}/files/{index}     -> the docx of one finished row
    GET  /api/batch/{id}/download          -> zip of all finished rows

Jobs live in memory (JOBS dict) and the docx files in batch_output/<job id>/.
Restarting the server forgets the jobs; the files stay on disk.
Only one job runs at a time, and inside a job the rows run one after another.
The API key is kept only in job["config"] while the job runs and is dropped afterwards;
the status JSON never contains it.
"""

import logging
import os
import sys
import threading
import uuid
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(APP_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from app.llm_factory import ConfigError, resolve_config                        # noqa: E402
from app import batch_pipeline                                                  # noqa: E402

logger = logging.getLogger("cv_optimiser.batch")

BATCH_HTML = os.path.join(PROJECT_ROOT, "static", "batch.html")
BATCH_OUTPUT_DIR = os.path.join(PROJECT_ROOT, "batch_output")
DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
ZIP_NAME = "Md_Rawfur_Monzur_Jim_CV_batch.zip"

RUN_INLINE = False          # tests set True: the batch runs inside the POST instead of a thread
JOBS: dict[str, dict] = {}  # job id -> {"id", "state", "dir", "rows", "config"}

router = APIRouter()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def job_status(job: dict) -> dict:
    """The JSON the page polls. Never includes job['config'] (it holds the key)."""
    done = job["state"] == "done"
    rows = []
    for i, row in enumerate(job["rows"]):
        status = row.get("status", "pending")
        rows.append({
            "index": i,
            "title": row.get("title", ""),
            "company": row.get("company", ""),
            "link": row.get("link", ""),
            "status": status,
            "error": row.get("error", ""),
            "job_title": row.get("job_title", ""),
            "download_url": f"/api/batch/{job['id']}/files/{i}" if status == "done" else None,
        })
    return {
        "id": job["id"],
        "state": job["state"],
        "rows": rows,
        "zip_url": f"/api/batch/{job['id']}/download" if done else None,
    }


def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail="Batch job not found. The server may have restarted; please start the batch again.",
        )
    return job


def run_job(job: dict) -> None:
    """Worker: run every row one at a time, then forget the config (and the key)."""
    try:
        batch_pipeline.run_batch(job["rows"], job["config"], job["dir"])
    except Exception:
        logger.exception("Batch job %s crashed", job["id"])
    finally:
        job["config"] = None
        job["state"] = "done"


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------
@router.get("/batch", include_in_schema=False)
def batch_page() -> FileResponse:
    return FileResponse(BATCH_HTML, media_type="text/html")


@router.post("/api/batch")
def start_batch(
    file: UploadFile = File(...),
    provider: Literal["deepseek", "gemini"] = Form("deepseek"),
    model: str | None = Form(None),
    api_key: str | None = Form(None),
) -> dict:
    if any(job["state"] == "running" for job in JOBS.values()):
        raise HTTPException(status_code=409, detail="A batch is already running. Wait for it to finish.")

    try:
        config = resolve_config(provider, model, api_key)
    except ConfigError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        rows = batch_pipeline.read_rows(file.file.read(), file.filename or "")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "state": "running",
        "dir": os.path.join(BATCH_OUTPUT_DIR, job_id),
        "rows": rows,
        "config": config,
    }
    os.makedirs(job["dir"], exist_ok=True)
    JOBS[job_id] = job

    if RUN_INLINE:
        run_job(job)
    else:
        threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return job_status(job)


@router.get("/api/batch/{job_id}")
def get_batch(job_id: str) -> dict:
    return job_status(get_job(job_id))


@router.get("/api/batch/{job_id}/files/{index}")
def download_row(job_id: str, index: int) -> FileResponse:
    job = get_job(job_id)
    if not 0 <= index < len(job["rows"]):
        raise HTTPException(status_code=404, detail="No such row.")
    row = job["rows"][index]
    if row.get("status") != "done":
        raise HTTPException(status_code=404, detail=row.get("error") or "This CV is not ready.")
    return FileResponse(os.path.join(job["dir"], row["filename"]),
                        media_type=DOCX_MEDIA_TYPE, filename=row["filename"])


@router.get("/api/batch/{job_id}/download")
def download_zip(job_id: str) -> FileResponse:
    job = get_job(job_id)
    if job["state"] != "done":
        raise HTTPException(status_code=409, detail="The batch is still running.")
    zip_path = batch_pipeline.make_zip(job["rows"], job["dir"], os.path.join(job["dir"], ZIP_NAME))
    return FileResponse(zip_path, media_type="application/zip", filename=ZIP_NAME)
