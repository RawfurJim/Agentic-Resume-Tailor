"""
app/scrape.py
-------------
Part 2 of the scraped-jobs feature (see PLAN_SCRAPE.md): the job API on top of
app/scrape_pipeline.py. Same shape as app/batch.py.

    GET  /scrape                                   -> static/scrape.html (the third page)
    POST /api/scrape                               -> start: run the scraper, then auto-generate
                                                      CVs for the first `top_cap` top matches
    GET  /api/scrape/latest                        -> name / row count of the newest scraped csv
    GET  /api/scrape/{id}                          -> job status (the page polls this)
    POST /api/scrape/{id}/rows/{index}/generate    -> make the CV of one more row (top or medium)
    GET  /api/scrape/{id}/files/{index}            -> the docx of one finished row
    GET  /api/scrape/{id}/download                 -> zip of all finished rows

Jobs live in memory (JOBS) and the docx files in scrape_output/<job id>/. Restarting the
server forgets the jobs; the files stay on disk. One scrape job at a time; inside a job the
CVs are made one at a time by a single worker thread fed from a queue.

Job states: "scraping" (Indeed / boards / matcher running), "generating" (a CV is queued or
running), "idle" (nothing running; Generate buttons work), "failed" (no rows could be produced).

The API key is never stored: the auto phase drops its config when it finishes, and every
Generate click sends the key again. Status JSON never contains a key or a job description.
"""

import logging
import os
import queue
import sys
import threading
import uuid
from collections import deque
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(APP_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from app.llm_factory import ConfigError, resolve_config                        # noqa: E402
from app import batch_pipeline, scrape_pipeline                                 # noqa: E402

logger = logging.getLogger("cv_optimiser.scrape")

SCRAPE_HTML = os.path.join(PROJECT_ROOT, "static", "scrape.html")
SCRAPE_OUTPUT_DIR = os.path.join(PROJECT_ROOT, "scrape_output")
DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
ZIP_NAME = "Md_Rawfur_Monzur_Jim_CV_scraped.zip"
LOG_KEEP = 200          # scraper lines kept in memory
LOG_SHOW = 40           # scraper lines sent to the page

RUN_INLINE = False      # tests set True: scraping and generating happen inside the request
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()

router = APIRouter()


# ---------------------------------------------------------------------------
# request bodies
# ---------------------------------------------------------------------------
class ScrapeRequest(BaseModel):
    indeed_links: list[str] = []
    reuse_latest: bool = False
    top_cap: int = Field(15, ge=0, le=200)          # auto-generate CVs for the first N top matches
    match_limit: int | None = Field(None, ge=1)     # score at most N jobs (each is one DeepSeek call)
    provider: Literal["deepseek", "gemini"] = "deepseek"
    model: str | None = None
    api_key: str | None = None


class GenerateRowRequest(BaseModel):
    provider: Literal["deepseek", "gemini"] = "deepseek"
    model: str | None = None
    api_key: str | None = None


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def can_generate(row: dict) -> bool:
    return (row.get("match") in ("top", "medium")
            and bool(row.get("description", "").strip())
            and row.get("status") in ("pending", "failed"))


def job_status(job: dict) -> dict:
    """The JSON the page polls. Never includes a key or a job description."""
    rows_out = []
    counts = {"top": 0, "medium": 0, "low": 0, "none": 0, "done": 0, "failed": 0, "queued": 0}
    for i, row in enumerate(job.get("rows", [])):
        status = row.get("status", "pending")
        counts[row.get("match", "none")] += 1
        if status in counts:
            counts[status] += 1
        rows_out.append({
            "index": i,
            "match": row.get("match", "none"),
            "match_note": row.get("match_note", ""),
            "auto": bool(row.get("auto", False)),
            "title": row.get("title", ""),
            "company": row.get("company", ""),
            "location": row.get("location", ""),
            "posted": row.get("posted", ""),
            "link": row.get("link", ""),
            "status": status,
            "error": row.get("error", ""),
            "job_title": row.get("job_title", ""),
            "download_url": f"/api/scrape/{job['id']}/files/{i}" if status == "done" else None,
            "can_generate": can_generate(row),
        })
    csv_path = job.get("csv_path")
    return {
        "id": job["id"],
        "state": job.get("state", "idle"),
        "phase": job.get("phase", ""),
        "error": job.get("error", ""),
        "csv_name": os.path.basename(csv_path) if csv_path else None,
        "log": list(job.get("log", []))[-LOG_SHOW:],
        "counts": counts,
        "zip_url": (f"/api/scrape/{job['id']}/download"
                    if job.get("state") == "idle" and counts["done"] > 0 else None),
        "rows": rows_out,
    }


def get_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail="Scrape job not found. The server may have restarted; please start again.",
        )
    return job


def _resolve(provider, model, api_key):
    try:
        return resolve_config(provider, model, api_key)
    except ConfigError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------------------
# the worker: one CV at a time per job
# ---------------------------------------------------------------------------
def _drain(job: dict) -> None:
    """Make the CV of every queued row, one after another, then go idle."""
    try:
        while True:
            try:
                index, config = job["queue"].get_nowait()
            except queue.Empty:
                break
            row = job["rows"][index]
            job["phase"] = f"Generating CV for {row.get('company') or 'job'} ({job['busy']} left)"
            try:
                scrape_pipeline.generate_row(row, config, job["dir"])
            except Exception:                        # generate_row already catches; belt and braces
                logger.exception("Scrape job %s: row %s crashed", job["id"], index)
                row["status"], row["error"] = "failed", "Unexpected error, see the server log."
            finally:
                config = None
                with LOCK:
                    job["busy"] -= 1
    finally:
        with LOCK:
            job["worker_alive"] = False
            if job["busy"] <= 0 and job["state"] == "generating":
                job["busy"] = 0
                job["state"] = "idle"
                job["phase"] = ""


def _enqueue(job: dict, index: int, config) -> None:
    """Queue one row (caller holds LOCK). Starts the worker when none is running."""
    job["rows"][index]["status"] = "queued"
    job["rows"][index]["error"] = ""
    job["busy"] += 1
    job["queue"].put((index, config))
    job["state"] = "generating"


def _ensure_worker(job: dict) -> None:
    with LOCK:
        if job["worker_alive"]:
            return
        job["worker_alive"] = True
    if RUN_INLINE:
        _drain(job)
    else:
        threading.Thread(target=_drain, args=(job,), daemon=True).start()


# ---------------------------------------------------------------------------
# the scrape job
# ---------------------------------------------------------------------------
def run_job(job: dict, req: ScrapeRequest, config) -> None:
    """Worker for one start: scrape (or reuse), load rows, queue the auto rows, drop the key."""
    try:
        if req.reuse_latest:
            job["phase"] = "Loading the newest scraped file…"
            csv_path = scrape_pipeline.newest_csv()
            if not csv_path:
                raise scrape_pipeline.ScrapeError(
                    "No scraped file yet. Untick 'use the newest scraped file' to scrape first."
                )
        else:
            job["phase"] = ("Running the scraper (Indeed, job boards, matching)…" if req.indeed_links
                            else "Running the scraper (job boards, matching)…")
            csv_path = scrape_pipeline.run_scraper(req.indeed_links, job["log"], match_limit=req.match_limit)
            if csv_path is None:
                job["rows"] = []
                job["phase"] = "No new jobs since the last run."
                job["state"] = "idle"
                return

        job["csv_path"] = csv_path
        rows = scrape_pipeline.load_matched_rows(csv_path)
        job["rows"] = rows

        auto_left = req.top_cap
        with LOCK:
            for i, row in enumerate(rows):
                row["auto"] = False
                if auto_left > 0 and row["match"] == "top" and can_generate(row):
                    row["auto"] = True
                    auto_left -= 1
                    _enqueue(job, i, config)
            if job["busy"] == 0:
                job["state"] = "idle"
                job["phase"] = ""
        if job["busy"]:
            _ensure_worker(job)
    except Exception as e:
        logger.exception("Scrape job %s failed", job["id"])
        job["state"] = "failed"
        job["phase"] = ""
        job["error"] = str(e) or "Unexpected error, see the server log."
    finally:
        config = None                                # the key leaves memory with this frame


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------
@router.get("/scrape", include_in_schema=False)
def scrape_page() -> FileResponse:
    return FileResponse(SCRAPE_HTML, media_type="text/html")


@router.get("/api/scrape/latest")
def latest_csv() -> dict:
    """What the 'use the newest scraped file' checkbox would load."""
    path = scrape_pipeline.newest_csv()
    if not path:
        return {"csv_name": None}
    try:
        count = len(scrape_pipeline.load_matched_rows(path))
    except Exception:
        count = None
    return {"csv_name": os.path.basename(path), "rows": count}


@router.post("/api/scrape")
def start_scrape(req: ScrapeRequest) -> dict:
    with LOCK:
        if any(j.get("state") in ("scraping", "generating") for j in JOBS.values()):
            raise HTTPException(status_code=409, detail="A scrape is already running. Wait for it to finish.")
        config = _resolve(req.provider, req.model, req.api_key)
        job_id = uuid.uuid4().hex[:12]
        job = {
            "id": job_id,
            "state": "scraping",
            "phase": "Starting…",
            "log": deque(maxlen=LOG_KEEP),
            "csv_path": None,
            "error": "",
            "rows": [],
            "dir": os.path.join(SCRAPE_OUTPUT_DIR, job_id),
            "provider": req.provider,
            "model": req.model,
            "queue": queue.Queue(),
            "busy": 0,
            "worker_alive": False,
        }
        os.makedirs(job["dir"], exist_ok=True)
        JOBS[job_id] = job

    if RUN_INLINE:
        run_job(job, req, config)
    else:
        threading.Thread(target=run_job, args=(job, req, config), daemon=True).start()
    return job_status(job)


@router.get("/api/scrape/{job_id}")
def get_scrape(job_id: str) -> dict:
    return job_status(get_job(job_id))


@router.post("/api/scrape/{job_id}/rows/{index}/generate")
def generate_one(job_id: str, index: int, req: GenerateRowRequest) -> dict:
    job = get_job(job_id)
    if job.get("state") == "scraping":
        raise HTTPException(status_code=409, detail="The scraper is still running. Wait for the table.")
    if job.get("state") == "failed":
        raise HTTPException(status_code=409, detail="This run failed; start again.")
    rows = job.get("rows", [])
    if not 0 <= index < len(rows):
        raise HTTPException(status_code=404, detail="No such row.")
    config = _resolve(req.provider, req.model, req.api_key)
    with LOCK:
        row = rows[index]
        if not can_generate(row):
            reason = {"done": "This CV is already made.", "running": "This CV is being made.",
                      "queued": "This CV is already queued."}.get(row.get("status"))
            if not reason:
                reason = ("This job has no description to work from." if not row.get("description", "").strip()
                          else "Only top and medium matches can be generated.")
            raise HTTPException(status_code=409, detail=reason)
        _enqueue(job, index, config)
    config = None
    _ensure_worker(job)
    return job_status(job)


@router.get("/api/scrape/{job_id}/files/{index}")
def download_row(job_id: str, index: int) -> FileResponse:
    job = get_job(job_id)
    rows = job.get("rows", [])
    if not 0 <= index < len(rows):
        raise HTTPException(status_code=404, detail="No such row.")
    row = rows[index]
    if row.get("status") != "done":
        raise HTTPException(status_code=404, detail=row.get("error") or "This CV is not ready.")
    return FileResponse(os.path.join(job["dir"], row["filename"]),
                        media_type=DOCX_MEDIA_TYPE, filename=row["filename"])


@router.get("/api/scrape/{job_id}/download")
def download_zip(job_id: str) -> FileResponse:
    job = get_job(job_id)
    if job.get("state") in ("scraping", "generating"):
        raise HTTPException(status_code=409, detail="Still working; the zip is ready when everything is idle.")
    rows = job.get("rows", [])
    if not any(r.get("status") == "done" for r in rows):
        raise HTTPException(status_code=404, detail="No finished CV to download yet.")
    zip_path = batch_pipeline.make_zip(rows, job["dir"], os.path.join(job["dir"], ZIP_NAME))
    return FileResponse(zip_path, media_type="application/zip", filename=ZIP_NAME)
