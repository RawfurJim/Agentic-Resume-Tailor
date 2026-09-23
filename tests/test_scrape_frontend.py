"""
Part 3 tests: the scraped-jobs page  (see PLAN_SCRAPE.md, Part 3).

No browser is available, so these only check that the page is served, wired to its script,
that the script uses element ids that really exist in the HTML, that the other two pages link
to it, and that the script never stores the API key.
"""

import os
import re

import pytest
from fastapi.testclient import TestClient

import app.main as main

pytest.importorskip("app.scrape", reason="Part 2 not implemented yet")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(PROJECT_ROOT, "static")
SCRAPE_HTML = os.path.join(STATIC_DIR, "scrape.html")
SCRAPE_JS = os.path.join(STATIC_DIR, "scrape.js")

if not os.path.exists(SCRAPE_HTML) or not os.path.exists(SCRAPE_JS):
    pytest.skip("Part 3 not implemented yet", allow_module_level=True)

client = TestClient(main.app)

REQUIRED_IDS = ["scrape-form", "indeed_link", "add_link", "indeed_list", "indeed_count", "top_cap",
                "match_limit", "reuse_latest", "provider", "model", "api_key", "toggle_key", "start",
                "status", "status_text", "elapsed", "log", "error", "results", "progress_text",
                "zip_link", "rows"]


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def test_scrape_page_is_served():
    resp = client.get("/scrape")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert 'id="scrape-form"' in resp.text
    assert "/static/scrape.js" in resp.text
    assert "/static/style.css" in resp.text


def test_scrape_script_is_served():
    resp = client.get("/static/scrape.js")
    assert resp.status_code == 200
    assert "/api/scrape" in resp.text
    assert "indeed_links" in resp.text


def test_pages_link_to_each_other():
    index = client.get("/").text
    batch = client.get("/batch").text
    page = client.get("/scrape").text
    assert 'href="/scrape"' in index
    assert 'href="/scrape"' in batch
    assert 'href="/"' in page and 'href="/batch"' in page


def test_required_ids_exist_in_scrape_html():
    html = _read(SCRAPE_HTML)
    missing = [i for i in REQUIRED_IDS if f'id="{i}"' not in html]
    assert missing == [], f"missing ids in scrape.html: {missing}"


def test_every_id_used_in_scrape_js_exists_in_scrape_html():
    js = _read(SCRAPE_JS)
    html = _read(SCRAPE_HTML)
    ids = set(re.findall(r"getElementById\(\s*['\"]([^'\"]+)['\"]\s*\)", js))
    assert ids, "scrape.js uses no element ids?"
    missing = sorted(i for i in ids if f'id="{i}"' not in html)
    assert missing == [], f"ids used in scrape.js but missing from scrape.html: {missing}"


def test_scrape_js_never_stores_the_key_or_uses_innerhtml():
    js = _read(SCRAPE_JS)
    for forbidden in ("localStorage", "sessionStorage", "document.cookie", "innerHTML"):
        assert forbidden not in js, f"scrape.js must not use {forbidden}"


def test_indeed_link_input_and_controls():
    html = _read(SCRAPE_HTML)
    assert re.search(r'<input[^>]*id="indeed_link"', html)
    assert re.search(r'<input[^>]*id="top_cap"[^>]*type="number"', html)
    assert re.search(r'<input[^>]*id="match_limit"[^>]*type="number"', html)
    assert re.search(r'<input[^>]*id="reuse_latest"[^>]*type="checkbox"', html)
    assert re.search(r'<input[^>]*id="api_key"[^>]*type="password"', html)


def test_scrape_js_only_accepts_indeed_job_links():
    js = _read(SCRAPE_JS)
    assert "jk=" in js, "scrape.js should check for the jk=/vjk= job key before adding a link"
