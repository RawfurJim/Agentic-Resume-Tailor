"""
Full three-stage run against the REAL DeepSeek API (key from .env).
Takes 1-3 minutes because of the reasoner stage and costs a few cents.
"""

import hashlib
import os

import docx
import pytest

from app.llm_factory import resolve_config
from app.pipeline import MASTER_CV, OUTPUT_CV, run_pipeline

SAMPLE_JD = """
Senior Backend Engineer (Python) - Remote, UK

We are looking for a Senior Backend Engineer to design and build REST APIs with FastAPI
and own our PostgreSQL schema and AWS infrastructure. You will ship containerised services
with Docker and Kubernetes through CI/CD pipelines and mentor junior developers.
Requirements: 5+ years of backend experience, strong Python, and experience integrating
LLM APIs into production systems. Familiarity with Agile, cross-functional teams is a plus.
"""


def _sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


@pytest.mark.integration
def test_run_pipeline_end_to_end_with_deepseek():
    assert os.path.exists(MASTER_CV), "master CV template is missing"
    master_hash_before = _sha256(MASTER_CV)

    config = resolve_config(None, None, None)          # deepseek defaults, key from .env
    result = run_pipeline(SAMPLE_JD, config)
    print(f"\njob_title={result.job_title!r}")      # visible with pytest -s

    # the docx was written to the fixed output path
    assert result.docx_path == OUTPUT_CV
    assert os.path.exists(result.docx_path)

    # it opens and has content
    document = docx.Document(result.docx_path)
    texts = [p.text.strip() for p in document.paragraphs if p.text.strip()]
    assert texts, "generated docx has no text paragraphs"

    # job title and CV dict shape
    assert isinstance(result.job_title, str) and result.job_title.strip()
    assert result.job_title != "CV"
    for key in ("title", "profile", "skills", "role", "experience"):
        assert key in result.updated_cv, f"updated_cv is missing {key!r}"
    assert result.updated_cv["title"] and result.updated_cv["profile"]
    assert result.updated_cv["skills"] and result.updated_cv["experience"]

    # job_info from stage 1 is passed through
    assert result.job_info.get("job_description")
    assert "error" not in result.job_info

    # the master template was never touched
    assert _sha256(MASTER_CV) == master_hash_before
