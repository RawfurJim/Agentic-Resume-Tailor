# Batch CVs from a CSV – plan

## Status

- Step 0 (plan + tests written first): done
- Part 1 (pipeline, `app/batch_pipeline.py`): done
- Part 2 (backend API, `app/batch.py`): done
- Part 3 (frontend, `static/batch.html` + `static/batch.js`): not started

Work on one part per fresh context: read this file and the part's test file, implement, run
`.venv/bin/pytest -m "not integration" -q` until green, update the Status line above, commit, stop.
Never run the integration tests (they call DeepSeek and cost money).

## Context

Today: paste one job description, get one `.docx`. New: upload a CSV (20–30 rows) with the columns
`title`, `company`, `link`, `description`; the server makes one CV per row, **one row at a time**, and a
second page shows a table that fills up as each CV is ready: title, company, link, Download button.
At the end there is also a "Download all (zip)" button. A row that fails shows its error and the rest
continue.

Keep it simple: plain code, few edge cases. Existing code is changed as little as possible.
No test calls DeepSeek or Gemini; the LLM step is faked in every test.

## CSV format (fixed, no aliases)

Header row with these exact names (case and surrounding spaces ignored): `title`, `company`, `link`,
`description`. `company` and `description` are required; `title` and `link` may be missing or empty.
Extra columns are ignored. An `.xlsx` file is accepted too (first sheet, first row = header).

Docx name per row: `Md_Rawfur_Monzur_Jim_CV_<Company>.docx` using the existing `safe_filename`.
Duplicate company names get `_1`, `_2`, … appended: `Acme`, `Acme_1`, `Acme_2`.

## Reused as-is

- `app/pipeline.py`: `run_pipeline` (the 3 LLM/docx stages), `write_docx` (already takes an output
  path), `safe_filename`, `PipelineError`, `PipelineResult`, `MASTER_CV`.
- `app/llm_factory.py`: `resolve_config`, `ConfigError`.
- Test pattern from `tests/test_api.py`: `TestClient(main.app)` + `monkeypatch` a fake `run_pipeline`.
- `openpyxl` is already installed in `.venv`; add it to `requirements.txt` in Part 2.

---

## Part 1 – Pipeline  (tests: `tests/test_batch_pipeline.py`)

**Change to existing code (one parameter):** `app/pipeline.py`
`run_pipeline(job_description, config, output_path=None)`; `output_path = output_path or OUTPUT_CV`;
pass it to `write_docx` and to `PipelineResult.docx_path`. Default behaviour unchanged.

**New `app/batch_pipeline.py`** (plain Python, no web):

- `read_rows(data: bytes, filename: str) -> list[dict]`
  CSV: decode `utf-8-sig`, `csv.DictReader`. XLSX: `openpyxl`, first sheet, first row = header.
  Header names are lower-cased and stripped. Raises `ValueError` if `company` or `description` is
  missing, or there are no data rows. Returns dicts `{title, company, link, description}` (missing
  cells → `""`, all values stripped strings).
- `make_filenames(rows) -> list[str]`: `safe_filename(row["company"])` per row; repeats get `_1`,
  `_2`, … inserted before `.docx`.
- `run_batch(rows, config, out_dir, on_row_done=None, pipeline=None)`:
  `pipeline = pipeline or run_pipeline` **looked up at call time** (so tests can monkeypatch
  `app.batch_pipeline.run_pipeline`). Sets `row["filename"]` for every row first, then a plain `for`
  loop: `row["status"] = "running"`, call `pipeline(row["description"], config,
  output_path=os.path.join(out_dir, row["filename"]))`; success → `status="done"`,
  `job_title=result.job_title`; any exception → `status="failed"`, `error=str(e)`.
  Every row also gets `row["error"]` (`""` when fine). `on_row_done(row)` is called after each row.
  One pipeline call at a time, by construction.
- `make_zip(rows, out_dir, zip_path) -> zip_path`: all `done` docx files into one zip (names only,
  no folders).

---

## Part 2 – Backend API  (tests: `tests/test_batch_api.py`)

**New `app/batch.py`** (FastAPI `APIRouter`):

- Module constants: `BATCH_OUTPUT_DIR = <project>/batch_output`, `RUN_INLINE = False`
  (tests set `True` so the batch runs synchronously inside the POST), `JOBS: dict = {}`.
- A job is a plain dict: `{"id", "state": "running" | "done", "dir", "rows", "config"}`.
  `config` (holds the API key) is set to `None` when the job finishes. One daemon
  `threading.Thread` per job unless `RUN_INLINE`.
- Job status JSON (never includes the key):
  `{"id", "state", "rows": [{"index", "title", "company", "link", "status", "error",
  "job_title", "download_url" | null}], "zip_url" | null}`.
  `download_url = /api/batch/{id}/files/{index}` only when `status == "done"`;
  `zip_url = /api/batch/{id}/download` only when `state == "done"`.
- Routes:

  | Route | Does |
  |---|---|
  | `GET /batch` | serves `static/batch.html` |
  | `POST /api/batch` (multipart: `file`, form `provider`, `model`, `api_key`) | 409 if any job has `state == "running"`; `resolve_config` (400 on `ConfigError`); `read_rows` (400 on `ValueError`); `mkdir batch_output/<id>`; start; return job status |
  | `GET /api/batch/{id}` | job status; 404 if unknown |
  | `GET /api/batch/{id}/files/{index}` | `FileResponse` of that row's docx with `filename=row["filename"]`; 404 if unknown job, bad index, or row not done |
  | `GET /api/batch/{id}/download` | `make_zip` → `FileResponse(zip, media_type="application/zip")`; 409 while still running; 404 unknown |

**Changes to existing files:** `app/main.py` +2 lines (`from app.batch import router as batch_router`
and `app.include_router(batch_router)` before the `/static` mount). `requirements.txt` + `openpyxl==3.1.5`.
`.gitignore` + `batch_output/`.

---

## Part 3 – Frontend  (tests: `tests/test_batch_frontend.py`)

**New `static/batch.html`**: same look as `index.html`; nav (Single job · Batch); form
`id="batch-form"` with file input (`accept=".csv,.xlsx"`), the same provider / model / API key fields,
Start button; status line with spinner; error box; results table (#, Title, Company, Link, Status, CV)
and a hidden "Download all (zip)" link.

**New `static/batch.js`**: copy the provider-hint / key-toggle / error helpers from `app.js`. On submit:
`FormData` → `POST /api/batch`; then poll `GET /api/batch/{id}` every 3 s and redraw the table rows
(DOM `textContent`, link cell as `<a target="_blank" rel="noopener">` when it starts with `http`, CV cell
as a Download link when `status === "done"`, error text when failed). When `state === "done"` stop
polling and show the zip link. Key is never stored (no localStorage, no cookies).

**Changes to existing files:** `static/index.html` +1 nav line (`<a href="/batch">`);
`static/style.css` appended block for nav, table and status badges.
`samples/jobs_sample.csv` (3 rows incl. a duplicate company) is written in Step 0.

---

## Verification (free)

1. `.venv/bin/pip install -r requirements.txt`
2. `.venv/bin/pytest -m "not integration" -q` after each part; all old and new tests pass.
3. After Part 3: start `.venv/bin/uvicorn app.main:app` (no `--reload`, a reload wipes the in-memory
   jobs) and `curl` `/`, `/batch`, `/static/batch.js`, and `POST /api/batch` with a bad CSV
   (expect 400) to prove the wiring.
4. `sha256sum Md_Rawfur_Monzur_Jim_CV.docx` unchanged; `batch_output/` is git-ignored.

Left for Jim (costs money, needs a browser): upload `samples/jobs_sample.csv` with DeepSeek on `/batch`
and watch rows fill one by one, download a CV, click a link, download the zip.
