"""
Part 3 tests: the batch page  (see PLAN_BATCH.md, Part 3).

No browser is available, so these only check that the page is served, wired to its script,
and that the script uses element ids that really exist in the HTML.
"""

import os
import re

import pytest
from fastapi.testclient import TestClient

import app.main as main

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(PROJECT_ROOT, "static")
BATCH_HTML = os.path.join(STATIC_DIR, "batch.html")
BATCH_JS = os.path.join(STATIC_DIR, "batch.js")
SAMPLE_CSV = os.path.join(PROJECT_ROOT, "samples", "jobs_sample.csv")

client = TestClient(main.app)


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def test_batch_page_is_served():
    resp = client.get("/batch")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert 'id="batch-form"' in resp.text
    assert "/static/batch.js" in resp.text
    assert "/static/style.css" in resp.text


def test_batch_script_is_served():
    resp = client.get("/static/batch.js")
    assert resp.status_code == 200
    assert "/api/batch" in resp.text


def test_single_job_page_links_to_batch_page():
    resp = client.get("/")
    assert resp.status_code == 200
    assert 'href="/batch"' in resp.text


def test_every_id_used_in_batch_js_exists_in_batch_html():
    js = _read(BATCH_JS)
    html = _read(BATCH_HTML)
    ids = set(re.findall(r"getElementById\(\s*['\"]([^'\"]+)['\"]\s*\)", js))
    assert ids, "batch.js uses no element ids?"
    missing = sorted(i for i in ids if f'id="{i}"' not in html)
    assert missing == [], f"ids used in batch.js but missing from batch.html: {missing}"


def test_batch_js_never_stores_the_key():
    js = _read(BATCH_JS)
    for forbidden in ("localStorage", "sessionStorage", "document.cookie"):
        assert forbidden not in js


def test_batch_html_accepts_csv_and_xlsx():
    html = _read(BATCH_HTML)
    assert 'type="file"' in html
    assert ".csv" in html and ".xlsx" in html


def test_sample_csv_reads_and_names_duplicates():
    bp = pytest.importorskip("app.batch_pipeline", reason="Part 1 not implemented yet")
    with open(SAMPLE_CSV, "rb") as f:
        rows = bp.read_rows(f.read(), "jobs_sample.csv")
    assert [r["company"] for r in rows] == ["Acme", "Beta Ltd", "Acme"]
    assert all(r["description"] for r in rows)
    names = bp.make_filenames(rows)
    assert names[0].endswith("_Acme.docx")
    assert names[2].endswith("_Acme_1.docx")
