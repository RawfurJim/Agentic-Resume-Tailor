# Two-stage plan: clean the repo, then rebuild the scraper

Run **Stage 1** to completion and commit it, then start **Stage 2**. Stage 1 is nothing but
deletions plus two new files, so it is trivial to review and revert; keeping the code rewrite out
of it means a broken scraper can never be confused with a botched cleanup.

Before either stage: copy this file to `plan.md` in the project root so the steps live beside
the code and survive the session.

---

## Context

**The repo.** No `.gitignore` exists, so a 53 MB Chrome profile was committed: **657 of the 670
tracked files are `browser_profile/`**. Alongside it, 10 saved Indeed block pages in `debug/`,
and two notebooks — `scrap_job.ipynb` (16 cells of abandoned approaches: greenhouse API,
`jobspy`, two Selenium attempts) and a 0-byte `etl.ipynb`. All superseded by `indeed_grab.py`.

**The dead code path, confirmed by measurement.** Every job currently runs: plain `requests`
call → `403` → fall back to Chrome → success. Every file in `debug/` is the same ~28 KB Indeed
block page, containing no `_initialData` and no `jobDescriptionText`. Step 1 buys nothing but
two wasted requests per run, and `save_debug()` only ever writes that same useless page.

**The output.** A row's description holds only the description, so it carries no context on its
own; there is no scrape date; and a run gives no handle on the rows it just added.

**Goal.** Four tracked files, and a browser-only scraper whose rows stand alone.

### Where it ends up

```
scrap job/
  indeed_grab.py      rewritten in Stage 2, browser-only
  links.txt           your input, unchanged
  plan.md             this file
  .gitignore          new
  browser_profile/    on disk, gitignored, NOT deleted   <- see note
  jobs.csv            recreated by the first run, gitignored
  new_jobs_*.csv      one per run, gitignored
```

> **Why `browser_profile/` survives.** It holds the cookies that stop Indeed showing the "verify
> you are human" box. Deleting it means clearing that by hand on the next run. Gitignoring it
> gets it out of the repo without throwing away working state. Say so if you'd rather delete it
> outright — it is regenerable, it just costs one click.

---

# Stage 1 — Clean the repo and commit

Deletions only. No code is touched.

### 1.1 Write `.gitignore`

```gitignore
# Chrome profile - runtime cookie store. Must stay on disk, must never be in git.
browser_profile/

# saved pages from failed fetches
debug/

# scraper output
jobs.csv
new_jobs_*.csv

__pycache__/
*.pyc
```

### 1.2 Write `plan.md`

Copy of this file.

### 1.3 Untrack what must stay on disk

```bash
git rm -r --cached browser_profile
```

`--cached` is the critical flag: Git forgets the profile, the files stay exactly where they are.
**Without it, 53 MB of working cookies are destroyed.**

### 1.4 Delete what is genuinely dead

```bash
git rm -r debug jobs.csv scrap_job.ipynb
rm etl.ipynb                                  # untracked, 0 bytes
```

`jobs.csv` goes because you asked to start fresh — the first Stage 2 run recreates it with the
new header. All of this stays recoverable from commit `1681611`.

### 1.5 Commit

```bash
git add .gitignore plan.md
git commit -m "Clean repo: add .gitignore, untrack browser profile, drop notebooks and debug pages"
```

### Stage 1 verification

| Check | Expected |
| --- | --- |
| `git ls-files \| wc -l` | **4** — `.gitignore`, `plan.md`, `indeed_grab.py`, `links.txt` |
| `git status` | clean — `browser_profile/` not even listed as untracked, proving the ignore bites |
| `ls browser_profile/Default/Network/Cookies` | **still present.** The one that matters |
| `ls *.ipynb debug jobs.csv` | all gone |
| `git log --stat -1` | ~669 deletions, 2 additions |

---

# Stage 2 — Rewrite `indeed_grab.py`

A fresh file rather than a patch on the old one.

### 2.1 Keep verbatim

These were never the problem — lift them across unchanged:

| Function | Role |
| --- | --- |
| `read_links()` | every http(s) URL in the file, deduped, order kept |
| `job_key()` | `vjk`/`jk` → `(key, clean viewjob URL)`; host normalisation |
| `walk()`, `find()`, `json_after()` | search Indeed's embedded `window._initialData` |
| `html_to_text()` | HTML → text, keeping paragraph and list breaks |
| `parse_job()` | JSON first, visible HTML as fallback → title / company / description |
| `looks_ok()` | title present **and** description over 80 chars |
| `Browser` | persistent Chrome context, waits for `#jobDescriptionText` |
| `load_done()` | job keys already in `jobs.csv`, so reruns skip them |

### 2.2 Delete entirely

`requests` and its import guard · `HEADERS` · the session warm-up · the whole "1) plain request"
block · `save_debug()` and both its call sites · the `status` argument to `why_failed()`
(rename it `failure_reason(html)` — browser-only, so there is no status code).

### 2.3 New — columns and date

```python
COLUMNS = ["link", "title", "company", "description", "date"]
```

Your four columns unchanged and in the same order; `date` appended, filled per row with
`datetime.now().strftime("%Y-%m-%d")`.

### 2.4 New — `build_description()`

Puts everything the scraper knows inside the description cell, so a row stands alone. Empty
fields are skipped rather than printed as a bare label:

```python
def build_description(link, job, date):
    """The description cell: a header of everything we extracted, then the job text."""
    fields = [("Title", job.get("title")), ("Company", job.get("company")),
              ("Date", date), ("Link", link)]
    header = "\n".join(f"{k}: {v}" for k, v in fields if v)
    return f"{header}\n\n---\n\n{job.get('description') or ''}"
```

Producing:

```
Title: Senior GenAI Engineer (UK)
Company: Pigment
Date: 2026-09-17
Link: https://uk.indeed.com/viewjob?jk=6a8067c9a670912c

---

Join Pigment: The AI Platform Redefining Business Planning
...(description exactly as parsed today)
```

`title` and `company` keep their own columns as well — this copies them into the text, it does
not move them.

### 2.5 New — a fresh CSV per run

Alongside the growing `jobs.csv`, each run writes `new_jobs_<date>_<time>.csv` holding only that
run's rows — the sheet you can process directly.

```python
run_file = datetime.now().strftime("new_jobs_%Y-%m-%d_%H%M.csv")
```

Each successful row is appended to **both** files as it succeeds, reusing one `save(path, row)`
helper, so an interrupted run leaves both consistent. The per-run file is created lazily on the
first success — a run where everything fails leaves no misleading empty file.

Timestamped rather than a fixed `new_jobs.csv` — **my assumption**, that choice was left open. A
one-line change if your ETL would rather hardcode a path.

### 2.6 New — `main()` flow

1. Read links, resolve job keys, drop ones already in `jobs.csv` and duplicates within the run.
2. Exit early on `nothing new to fetch` — **before** opening Chrome.
3. Open Chrome **once**, up front. If Playwright is missing, exit immediately with the install
   hint rather than looping through jobs that cannot possibly succeed.
4. Per job: fetch → `parse_job()` → `looks_ok()`. On failure, **retry once** with a reload —
   Indeed's interstitial sometimes just needs a second pass. Still failing: print
   `failure_reason(html)` and write nothing.
5. Keep the 45–75 s random pause between jobs.
6. `Ctrl+C` stops cleanly; the browser closes in a `finally`.
7. Summary line names the per-run file so you know what to open.

### 2.7 New — `requirements.txt`

```
playwright
beautifulsoup4
lxml
```

Plus a `playwright install chromium` reminder in the docstring. Drop this file if you consider
it clutter — it is the one item here that is convenience rather than necessity.

### Stage 2 verification

1. `python indeed_grab.py` with the two links already in `links.txt`:
   - Chrome opens straight away; **no** `blocked (HTTP 403)` line anywhere in the output
   - `2 job(s) to fetch`, then `OK  <title> | <company> | <n> chars` twice, ~60 s apart
   - no `debug/` directory is recreated
2. `jobs.csv` — 5 columns, 2 rows, each description opening with its `Title:` block and `---`
   separator, each `date` today's.
3. `new_jobs_<date>_<time>.csv` — header plus exactly those 2 rows.
4. Run again unchanged → `nothing new to fetch`, Chrome never opens, no new per-run file,
   `jobs.csv` untouched. Confirms dedupe survives the added column.
5. Add one fresh link and run → `jobs.csv` grows to 3 rows; the **new** per-run CSV holds exactly
   1 row. This is the behaviour you asked for: a fresh sheet of only what is new.
6. `git status` → only `indeed_grab.py` modified and `requirements.txt` added. No CSVs, no
   profile — proof the Stage 1 ignore rules hold.
