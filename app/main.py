"""
app/main.py
-----------
The FastAPI web backend.

    GET  /               -> static/index.html (the frontend)
    GET  /static/...     -> other frontend files (css, js)
    GET  /api/health     -> {"status": "ok"}
    GET  /api/defaults   -> default provider / model names for the form
    POST /api/generate   -> runs the pipeline, returns the tailored .docx as a download

Run it with:   python -m app.main        (or: uvicorn app.main:app --reload)
then open      http://127.0.0.1:8000

Error responses always look like {"detail": "<human readable message>"}:
    422  bad request body (empty job description, unknown provider, ...)  <- FastAPI/Pydantic
    400  bad config (missing API key, unknown model/provider)
    502  the LLM failed or returned something we could not parse
    409  the output docx is open in Word and cannot be overwritten
    500  anything unexpected
The API key sent by the browser is used for that one request only and is never logged.
"""

import logging
import os
import sys
import unicodedata
from typing import Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

# ---------------------------------------------------------------------------
# PATHS  (worked out from where THIS file lives, so it works from any cwd)
# ---------------------------------------------------------------------------
APP_DIR = os.path.dirname(os.path.abspath(__file__))       # .../project/app
PROJECT_ROOT = os.path.dirname(APP_DIR)                    # .../project
STATIC_DIR = os.path.join(PROJECT_ROOT, "static")
INDEX_HTML = os.path.join(STATIC_DIR, "index.html")

if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from app.llm_factory import DEFAULTS, ConfigError, resolve_config          # noqa: E402
from app.pipeline import PipelineError, run_pipeline, safe_filename        # noqa: E402
from app.batch import router as batch_router                               # noqa: E402

logger = logging.getLogger("cv_optimiser")

DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# PipelineError.kind -> HTTP status code
PIPELINE_STATUS = {
    "config": 400,        # bad key / model / provider
    "llm": 502,           # the provider failed (auth, network, rate limit, ...)
    "parse": 502,         # the model answered but not with usable JSON
    "file_locked": 409,   # Md_Rawfur_Monzur_Jim_CV_new.docx is open in Word
    "other": 500,
}


# ---------------------------------------------------------------------------
# REQUEST MODEL  (what the browser POSTs to /api/generate)
# ---------------------------------------------------------------------------
class GenerateRequest(BaseModel):
    job_description: str
    provider: Literal["deepseek", "gemini"] = "deepseek"
    model: str | None = None        # blank -> provider default(s)
    api_key: str | None = None      # optional for deepseek (.env fallback), required for gemini

    @field_validator("job_description")
    @classmethod
    def _strip_and_require(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Job description is required")
        return value


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------
def ascii_header_value(text: str, limit: int = 200) -> str:
    """
    HTTP header values must be ASCII and single-line.
    'Ingénieur IA / ML' -> 'Ingenieur IA / ML' (accents dropped, anything odd removed).
    """
    text = unicodedata.normalize("NFKD", text or "")
    text = text.encode("ascii", "ignore").decode("ascii")
    text = "".join(ch if ch.isprintable() else " " for ch in text)   # newlines / control chars -> space
    return " ".join(text.split())[:limit]


# ---------------------------------------------------------------------------
# THE APP
# ---------------------------------------------------------------------------
app = FastAPI(title="CV Optimiser")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    """The single-page frontend."""
    return FileResponse(INDEX_HTML, media_type="text/html")


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/defaults")
def defaults() -> dict:
    """Default provider and model names, so the frontend does not hard-code them."""
    return DEFAULTS


# Plain `def`, NOT `async def`: run_pipeline blocks for 1-3 minutes, so FastAPI
# runs it in a worker thread and the server stays responsive meanwhile.
@app.post("/api/generate")
def generate(req: GenerateRequest) -> FileResponse:
    # 1. turn the form values into a ModelConfig (fills in defaults, checks the key)
    try:
        config = resolve_config(req.provider, req.model, req.api_key)
    except ConfigError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # 2. run extract -> rewrite -> docx
    try:
        result = run_pipeline(req.job_description, config)
    except PipelineError as e:
        # Messages from the pipeline are already short and never contain the key.
        raise HTTPException(status_code=PIPELINE_STATUS.get(e.kind, 500), detail=str(e))
    except Exception:
        # Log the traceback for debugging, but never the request body (it may hold a key).
        logger.exception("Unexpected error while generating a CV")
        raise HTTPException(status_code=500, detail="Unexpected server error, see the server log.")

    # 3. send the docx back as a download
    return FileResponse(
        result.docx_path,
        media_type=DOCX_MEDIA_TYPE,
        filename=safe_filename(result.job_title),        # -> Content-Disposition: attachment; filename="..."
        headers={"X-Job-Title": ascii_header_value(result.job_title)},
    )


# Batch feature (CSV -> many CVs), see app/batch.py and PLAN_BATCH.md.
app.include_router(batch_router)

# Everything else under /static/ (style.css, app.js, ...) is served as-is.
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
