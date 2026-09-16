"""
app/batch_pipeline.py
---------------------
Part 1 of the batch feature (see PLAN_BATCH.md): plain Python, no web code.

    read_rows(data, filename)   -> list of {title, company, link, description} dicts
    make_filenames(rows)        -> one docx filename per row, duplicates get _1, _2, ...
    run_batch(rows, config, out_dir, on_row_done, pipeline)
                                -> runs run_pipeline for each row, ONE AT A TIME
    make_zip(rows, out_dir, zip_path)
                                -> zips the docx files of the rows that finished

Each row dict is updated in place by run_batch:
    row["filename"]   the docx name inside out_dir
    row["status"]     "running" -> "done" | "failed"
    row["error"]      "" or the error message
    row["job_title"]  the title the pipeline found (only when done)
"""

import csv
import io
import os
import sys
import zipfile

APP_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(APP_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from app.pipeline import run_pipeline, safe_filename          # noqa: E402

COLUMNS = ("title", "company", "link", "description")
REQUIRED = ("company", "description")


# ---------------------------------------------------------------------------
# reading the spreadsheet
# ---------------------------------------------------------------------------
def _cell(value) -> str:
    """Any cell value -> stripped string ('' for None)."""
    if value is None:
        return ""
    return str(value).strip()


def _table(data: bytes, filename: str) -> list[list[str]]:
    """The file as a list of rows (lists of strings), header row first."""
    name = filename.lower()
    if name.endswith(".xlsx"):
        import openpyxl
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        sheet = workbook.worksheets[0]
        return [[_cell(v) for v in row] for row in sheet.iter_rows(values_only=True)]

    if name.endswith(".csv"):
        text = data.decode("utf-8-sig")
        return [[_cell(v) for v in row] for row in csv.reader(io.StringIO(text, newline=""))]

    raise ValueError("Please upload a .csv or .xlsx file.")


def read_rows(data: bytes, filename: str) -> list[dict]:
    """
    Spreadsheet bytes -> list of {title, company, link, description}.
    The header row must contain 'company' and 'description' (case and spaces ignored);
    'title' and 'link' are optional. Raises ValueError with a readable message.
    """
    table = [row for row in _table(data, filename) if any(row)]     # drop blank lines
    if not table:
        raise ValueError("The file is empty.")

    header = [h.lower() for h in table[0]]
    for column in REQUIRED:
        if column not in header:
            raise ValueError(
                f"The file needs a '{column}' column. Columns found: {', '.join(table[0]) or 'none'}."
            )
    if len(table) == 1:
        raise ValueError("The file has a header row but no jobs.")

    position = {column: header.index(column) for column in COLUMNS if column in header}
    rows = []
    for cells in table[1:]:
        row = {}
        for column in COLUMNS:
            i = position.get(column)
            row[column] = cells[i] if i is not None and i < len(cells) else ""
        rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# filenames
# ---------------------------------------------------------------------------
def make_filenames(rows: list[dict]) -> list[str]:
    """Md_Rawfur_Monzur_Jim_CV_<Company>.docx per row; repeats become _1, _2, ..."""
    seen: dict[str, int] = {}
    names = []
    for row in rows:
        base = safe_filename(row.get("company", ""))            # ...CV_Acme.docx
        count = seen.get(base, 0)
        seen[base] = count + 1
        if count == 0:
            names.append(base)
        else:
            stem, ext = os.path.splitext(base)
            names.append(f"{stem}_{count}{ext}")                # ...CV_Acme_1.docx
    return names


# ---------------------------------------------------------------------------
# running the rows
# ---------------------------------------------------------------------------
def run_batch(rows: list[dict], config, out_dir: str, on_row_done=None, pipeline=None) -> list[dict]:
    """
    Run the CV pipeline for every row, strictly one after another.
    `pipeline` defaults to run_pipeline (looked up now, so tests can monkeypatch it).
    `on_row_done(row)` is called after each row finishes (done or failed).
    """
    pipeline = pipeline or run_pipeline
    os.makedirs(out_dir, exist_ok=True)

    for row, filename in zip(rows, make_filenames(rows)):
        row["filename"] = filename
        row.setdefault("status", "pending")
        row.setdefault("error", "")

    for row in rows:
        row["status"] = "running"
        try:
            result = pipeline(row["description"], config, output_path=os.path.join(out_dir, row["filename"]))
            row["status"] = "done"
            row["job_title"] = result.job_title
            row["error"] = ""
        except Exception as e:                       # PipelineError or anything unexpected
            row["status"] = "failed"
            row["error"] = str(e) or "Unknown error"
        if on_row_done:
            on_row_done(row)
    return rows


def make_zip(rows: list[dict], out_dir: str, zip_path: str) -> str:
    """Zip the docx of every row with status 'done' (flat, no folders)."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for row in rows:
            if row.get("status") == "done":
                zf.write(os.path.join(out_dir, row["filename"]), arcname=row["filename"])
    return zip_path
