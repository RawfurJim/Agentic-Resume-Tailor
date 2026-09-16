"""
app/pipeline.py
---------------
Glue that runs the three existing stages for one request:

    1. ExtractJobInfo(llm=extract_llm).process(job_description) -> job_info dict
    2. UpdateCv(llm=rewrite_llm).process(job_info)              -> updated_cv dict
    3. CVRewriter(...).rewrite()  (temp JSON -> temp docx)
    4. os.replace(temp docx, Md_Rawfur_Monzur_Jim_CV_new.docx)

The master CV (Md_Rawfur_Monzur_Jim_CV.docx) is only ever read.
Failures are raised as PipelineError with a `kind` the API layer can map to
an HTTP status: "config", "llm", "parse", "file_locked", "other".
"""

import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# PATHS  (worked out from where THIS file lives)
# ---------------------------------------------------------------------------
APP_DIR = os.path.dirname(os.path.abspath(__file__))       # .../project/app
PROJECT_ROOT = os.path.dirname(APP_DIR)                    # .../project

# Make `from src.xxx import ...` work no matter which folder we run from.
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from src.job_info import ExtractJobInfo          # noqa: E402
from src.update_cv import UpdateCv               # noqa: E402
from src.rewrite_cv import CVRewriter            # noqa: E402
from app.llm_factory import ModelConfig, ConfigError, build_llms   # noqa: E402

MASTER_CV = os.path.join(PROJECT_ROOT, "Md_Rawfur_Monzur_Jim_CV.docx")
OUTPUT_CV = os.path.join(PROJECT_ROOT, "Md_Rawfur_Monzur_Jim_CV_new.docx")
OUTPUT_CV_NAME = os.path.basename(OUTPUT_CV)

DOWNLOAD_PREFIX = "Md_Rawfur_Monzur_Jim_CV_"
MAX_TITLE_CHARS = 60


# ---------------------------------------------------------------------------
# RESULT / ERROR TYPES
# ---------------------------------------------------------------------------
PIPELINE_ERROR_KINDS = ("config", "llm", "parse", "file_locked", "other")


class PipelineError(Exception):
    """One failure in the pipeline. `kind` tells the API layer which HTTP status to use."""

    def __init__(self, message: str, kind: str = "other"):
        if kind not in PIPELINE_ERROR_KINDS:
            kind = "other"
        super().__init__(message)
        self.kind = kind

    def __str__(self) -> str:
        return self.args[0] if self.args else self.kind


@dataclass
class PipelineResult:
    docx_path: str
    job_title: str
    updated_cv: dict = field(default_factory=dict)
    job_info: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------
def safe_filename(job_title: str) -> str:
    """
    'Senior AI Engineer / ML' -> 'Md_Rawfur_Monzur_Jim_CV_Senior_AI_Engineer_ML.docx'
    Keeps letters, digits, underscores and hyphens; everything else becomes one
    underscore; the title part is capped at MAX_TITLE_CHARS characters.
    """
    title = re.sub(r"[^A-Za-z0-9_-]+", "_", job_title or "")
    title = re.sub(r"_+", "_", title).strip("_-")
    title = title[:MAX_TITLE_CHARS].rstrip("_-") or "CV"
    return f"{DOWNLOAD_PREFIX}{title}.docx"


def _short(exc: BaseException, limit: int = 300) -> str:
    """One-line, shortened version of an exception message (never includes a key)."""
    text = str(exc).strip().replace("\n", " ")
    return text[:limit] + ("..." if len(text) > limit else "")


def write_docx(updated_cv: dict, output_path: str = OUTPUT_CV, master_cv: str = MASTER_CV) -> str:
    """
    updated_cv dict -> temp JSON -> CVRewriter -> temp docx -> os.replace over output_path.

    The temp folder is created NEXT TO the output file (not in the system temp dir)
    so the final os.replace is always on the same filesystem: atomic, and no
    'Invalid cross-device link' when the project lives on another drive/mount.
    """
    out_dir = os.path.dirname(os.path.abspath(output_path)) or "."
    out_name = os.path.basename(output_path)

    with tempfile.TemporaryDirectory(prefix=".cv_pipeline_", dir=out_dir) as tmp:
        temp_json = os.path.join(tmp, "updated_cv.json")
        temp_docx = os.path.join(tmp, out_name)

        with open(temp_json, "w", encoding="utf-8") as f:
            json.dump(updated_cv, f, indent=2, ensure_ascii=False)

        try:
            CVRewriter(cv_path=master_cv, json_path=temp_json, output_path=temp_docx).rewrite()
        except (KeyError, TypeError, IndexError, AttributeError) as e:  # dict shape not what the docx code expects
            raise PipelineError(
                f"The rewritten CV data was incomplete ({_short(e, 100)}), try again.",
                kind="parse",
            ) from e
        except Exception as e:
            raise PipelineError(f"Could not build the docx: {_short(e)}", kind="other") from e

        try:
            os.replace(temp_docx, output_path)
        except PermissionError as e:
            raise PipelineError(f"Close {out_name} and try again.", kind="file_locked") from e
        except OSError as e:
            raise PipelineError(f"Could not save {out_name}: {_short(e)}", kind="other") from e

    return output_path


# ---------------------------------------------------------------------------
# THE PIPELINE
# ---------------------------------------------------------------------------
def run_pipeline(job_description: str, config: ModelConfig,
                 output_path: str | None = None) -> PipelineResult:
    """
    Run extract -> rewrite -> docx for one job description.

    `output_path` is where the docx is written; None (the default) means the usual
    Md_Rawfur_Monzur_Jim_CV_new.docx. The batch feature passes one path per company.
    """
    if not job_description or not job_description.strip():
        raise PipelineError("Job description is required.", kind="config")
    output_path = output_path or OUTPUT_CV

    # --- build the two LLMs ------------------------------------------------
    try:
        extract_llm, rewrite_llm = build_llms(config)
    except ConfigError as e:
        raise PipelineError(str(e), kind="config") from e
    except Exception as e:                                   # bad model name, SDK errors
        raise PipelineError(f"Could not create the language model: {_short(e)}", kind="config") from e

    # --- stage 1: job info -------------------------------------------------
    try:
        job_info = ExtractJobInfo(llm=extract_llm).process(job_description)
    except ValueError as e:                                  # empty text / JSON problems
        raise PipelineError(_short(e), kind="parse") from e
    except Exception as e:                                   # auth, network, provider errors
        raise PipelineError(f"Job extraction failed: {_short(e)}", kind="llm") from e

    if "error" in job_info:
        raise PipelineError(
            "The model did not return valid JSON for the job description, "
            "try again or a different model.",
            kind="parse",
        )

    # --- stage 2: rewrite the CV content ------------------------------------
    try:
        updated_cv = UpdateCv(llm=rewrite_llm).process(job_info)
    except ValueError as e:
        raise PipelineError(
            f"The model did not return valid JSON, try again or a different model. ({_short(e, 150)})",
            kind="parse",
        ) from e
    except Exception as e:
        raise PipelineError(f"CV rewrite failed: {_short(e)}", kind="llm") from e

    # --- stage 3: build the docx in a temp folder, then swap it in ---------
    write_docx(updated_cv, output_path)

    job_title = (job_info.get("title") or "").strip() or "CV"
    return PipelineResult(
        docx_path=output_path,
        job_title=job_title,
        updated_cv=updated_cv,
        job_info=job_info,
    )
