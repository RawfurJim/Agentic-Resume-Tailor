# Scraped jobs → matched → CVs (third page) – plan

## Status

- Step 0 (data reset, scraper added to git, this plan, tests written first): done
- Part 1 (pipeline, `app/scrape_pipeline.py`): done
- Part 2 (backend API, `app/scrape.py` + one line in `app/main.py` + `.gitignore`): done (the `/scrape` page test passes once Part 3 adds the html)
- Part 3 (frontend, `static/scrape.html` + `static/scrape.js` + nav lines + CLAUDE.md): not started

Work on one part per fresh context: read this file and the part's test file, implement, run
`.venv/bin/pytest -m "not integration" -q` until green, update the Status line above, commit, stop.
Never run the integration tests (they call DeepSeek and cost money). The real end-to-end run is
budgeted at 6 DeepSeek calls (see "DeepSeek budget"); do not spend them on anything else.

## Context

Two halves that do not talk to each other yet:

- **CV builder** (Python/FastAPI, `app/`, `static/`): page 1 tailors the CV to one pasted job
  description; page 2 (`/batch`) takes a CSV/xlsx of jobs and makes one docx per row in a
  background thread, with a polled table, per-row download and a zip.
- **Job scraper** (Node, `scraper/`, untracked): `node run-all.mjs` runs `indeed → scan → export →
  match`. Indeed is a Python/Playwright script reading job links from `indeed_scrapper/links.txt`
  through a visible Chrome (about 1 min per link); scan hits ~140 ATS boards (10–20 min); export
  writes `scraper/data/new-data/new-jobs-<date>-<time>.csv` with only jobs never handed out before
  and posted ≤ 5 days ago (nothing new → no CSV); match is a stdlib-only Python script that asks
  DeepSeek once per row for `top match | medium match | low match` (else `no description` /
  `error: …`), supports `--limit N`. CSV header:
  `Company,Title,Location,URL,Source,Posted,First seen,Description,Match status`.
  Last real run: 77 new jobs → 42 top, 24 medium, 6 low, 5 without description.

Goal: a third page `/scrape`. Indeed links are added one at a time (paste, Enter → 1, 2, 3 …);
empty list → Indeed skipped. Start runs the scraper + matcher, then auto-generates CVs for top
matches up to a cap (default 15; remaining top rows get a button), medium rows get a **Generate CV**
button, low rows are listed only, each done row has Download, plus a zip. A "reuse newest CSV"
checkbox skips scraping.

Python ↔ JS: the FastAPI app starts Node with `subprocess`, the same way `run-all.mjs` starts the
two Python scripts; the hand-off is the CSV the scraper already writes. **No file under `scraper/`
is edited.** The app only writes `indeed_scrapper/links.txt` (the Indeed script's own input) before
a run.

Existing code is touched in four one-line places only: `app/main.py` (`include_router`),
`static/index.html:12` and `static/batch.html:12` (nav link), `.gitignore` (`scrape_output/`).

## DeepSeek budget: at most 6 calls for the whole test

| Where | Calls | How it is kept small |
|---|---|---|
| pytest suite (`-m "not integration"`) | 0 | `run_pipeline` and the scraper runner are faked; Node is never started |
| matcher during the real run | 2 | page field **"Match at most N jobs"** → `node run-all.mjs … -- --limit 2` (`run-all.mjs:110` forwards args after `--` to `match_jobs.py`); unscored rows stay blank → listed as `none`, no button |
| auto CVs during the real run | 4 | cap = 1 → one CV = 4 LLM calls (`src/job_info.py:90,95`, `src/update_cv.py:126,139`) |
| manual Generate click | 0 | do **not** press it during the budgeted test (each click = 4 calls) |
| integration tests | 0 | never run |

The match-limit field is optional and empty by default (= score every job), so it is a cost control
that stays useful after testing. The matcher's key comes from `scraper/.env` as today.

## Decisions (confirmed with the user)

- Top matches: auto-generate the first N (cap field, default 15); other top rows get the button.
- Generate button: medium rows and uncapped top rows only. Low / none rows: no button.
- "Skip scraping, use newest CSV" checkbox: yes.
- Scraper unchanged; Indeed links entered one by one on the page; two-day data reset before testing.

## Design decisions (from review)

- **Indeed input**: the link list is written to `scraper/indeed_scrapper/links.txt` and the scraper
  runs as one process, `node run-all.mjs --steps indeed,scan,export,match` (or `scan,export,match`
  when the list is empty). This reuses run-all's Python detection (`PYTHON` in `scraper/.env`),
  UTF-8 env, "layout changed" message and continue-on-Indeed-failure. `links.txt` is replaced each
  run; already-fetched links are skipped by `indeed_grab.py` itself (`load_done`, `jobs.csv`).
- **One code path per CV row**: `generate_row(row, config, out_dir)` (10 lines, copy of the loop
  body at `app/batch_pipeline.py:129-140`) for both the auto loop and manual clicks. `run_batch` is
  **not** reused for single rows: it recomputes `make_filenames` on the list it receives and would
  overwrite another row's `..._Acme.docx`. `make_filenames(all_rows)` runs once when the CSV loads.
- **API key never stored**: auto phase resolves config, runs, `config = None` in `finally` (as
  batch). Manual clicks send `{provider, model, api_key}`; the page reads the key from its input at
  click time; `resolve_config` per request. Job dict keeps only `provider`/`model` strings.
- **Concurrency**: module `threading.Lock` around "check running → create job" and "check row →
  mark queued"; one daemon worker per job drains a `queue.Queue` of `(index, config)`; one CV at a
  time per job. Batch and scrape may run at once (`run_pipeline` is thread-safe; `app/batch.py`
  untouched).
- **Subprocess**: `shutil.which("node")` first (override `SCRAPER_NODE`); `Popen(stdin=DEVNULL,
  stdout=PIPE, stderr=STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1,
  cwd=scraper/, env=os.environ + PYTHONUTF8=1)`. `stdin=DEVNULL` is essential: `indeed_grab.py`
  calls `input()` when stdin is a TTY and would hang under uvicorn (`indeed_grab.py:382-389`).
  Hard timeout `SCRAPER_TIMEOUT_S` (default 4 h) → `proc.kill()`. `cwd` does not matter to
  `run-all.mjs` (`__dirname`), pass it anyway with absolute paths.

## Reused as-is (no edits)

- `app/batch_pipeline.py`: `make_filenames`, `make_zip`, `run_pipeline` looked up by attribute.
- `app/pipeline.py`: `run_pipeline`, `PipelineError`. `app/llm_factory.py`: `resolve_config`, `ConfigError`.
- `app/batch.py`: `DOCX_MEDIA_TYPE`. Job/thread/status pattern copied, not imported.
- `static/style.css` classes: `.card.wide`, `.nav`, `.field/.row/.key-row`, `.status/.spinner/
  .elapsed`, `.box.error`, `.progress`, `a.dl`, `table.batch`, `.badge.running/.done/.failed`,
  `.row-error`. Append ~8 lines: `.badge.top/.medium/.low/.none`, `pre.log`, `ol.links`.
- Test patterns from `tests/test_batch_api.py` / `tests/test_batch_frontend.py`.

---

## Step 0a: reset the last two days of scraped data (done 2026-09-23)

The scraper remembers jobs in four files; all four must lose the same jobs or the scan treats them
as already seen (`scan.mjs:1628 loadSeenUrls` reads scan-history **and** pipeline.md;
`export-new-jobs.mjs:48` reads exported-urls.txt; `indeed_grab.py:426 load_done` reads jobs.csv).

State on 2026-09-23: `data/scan-history.tsv` 953 rows (first_seen 09-21: 136, 09-22: 655,
09-23: 162); `data/pipeline.md` 953 Pending lines; `data/new-data/exported-urls.txt` 956 URLs
(951 ledger + 5 Indeed); `indeed_scrapper/jobs.csv` 5 rows (3 dated 09-22, 2 dated 09-17).

One-off script in the scratchpad (not committed), run once:
1. Copy the four files to `scraper/data/backup-2026-09-23/` (convention of `data/backup-2026-09-21/`).
2. `cutoff = 2026-09-22`. `R` = ledger URLs with `first_seen >= cutoff` (817). `I` = jobs.csv links
   with `date >= cutoff` (3).
3. Rewrite `scan-history.tsv` without `R` (header + 136 rows remain).
4. Rewrite `pipeline.md` without Pending lines whose URL is in `R` (`- [ ] <url> | …`).
5. Rewrite `exported-urls.txt` without `R ∪ I` (Indeed URLs there are `https://uk.indeed.com/viewjob?jk=…`,
   same form as jobs.csv `link`).
6. Rewrite `jobs.csv` without `I`.
7. Leave `job-descriptions.jsonl` (description cache), `scan-runs.tsv`, `portal-health.tsv`,
   `data/exports/*` (rebuilt each run) and old `new-jobs-*.csv` files (Jim's results; also what
   "reuse newest" loads) untouched.
8. Print removed counts; expected 817 / 817 / 820 / 3. Verify with `wc -l` before/after.

Effect: the next run re-discovers the 09-22/09-23 jobs; export keeps those posted ≤ 5 days
(likely 100–200 rows); with match limit 2 only two of them are scored. The three Indeed links
removed from jobs.csv (in the backup) are the ones to paste into the page for the Indeed test.

---

## Step 0b: test files (written now, skip until the code exists)

`tests/fixtures/new_jobs_sample.csv` — real 9-column header, 6 anonymised rows:
2 × `top match` (different companies), 1 `medium match`, 1 `low match`, 1 `no description` (blank
Description), 1 `error: TimeoutError: …`; CRLF line endings, UTF-8 BOM (as the matcher writes).

### `tests/test_scrape_pipeline.py` (`importorskip("app.scrape_pipeline")`)
- `load_matched_rows`: 6 rows; keys `company,title,link,description,location,posted,source,
  match,match_note,filename,status,error,job_title`; `match` ∈ top/top/medium/low/none/none;
  order top→medium→low→none; filenames unique (`make_filenames` semantics, `_1` on a repeat
  company); `status == "pending"` everywhere; blank description ⇒ `none` even if note says top.
- Missing `Match status` column (matcher failed) ⇒ every `match == "none"`.
- `newest_csv`: picks the lexicographically last `new-jobs-*.csv`; `None` on empty/missing dir.
- `run_scraper` with a fake `runner(cmd, cwd, env, log, timeout)` and `NEW_DATA_DIR`/`LINKS_FILE`
  monkeypatched to `tmp_path`:
  (a) exit 0 + creates a CSV → returns its path; (b) exit 0, no file → `None`;
  (c) exit 1, no file → `ScrapeError` whose message contains the last log line;
  (d) exit 1 + file → returns the path;
  (e) links `["https://uk.indeed.com/viewjob?jk=abc12345"]` → `links.txt` written with that line and
  `--steps indeed,scan,export,match`; (f) `[]` → no `links.txt`, `--steps scan,export,match`;
  (g) `match_limit=2` → cmd ends with `["--", "--limit", "2"]`; `None` → no `--`;
  (h) `env` has `PYTHONUTF8 == "1"`; `cwd` is the scraper dir; cmd[1] ends with `run-all.mjs`.
- `run_command` (real, tiny): `[sys.executable, "-c", "print('a');import sys;sys.exit(3)"]` →
  returns 3, log has `"a"`; `[sys.executable, "-c", "import sys;print(sys.stdin.isatty())"]` →
  log has `"False"` (stdin is DEVNULL).
- `generate_row` with `fake_pipeline` (copies `MASTER_CV`; raises `PipelineError` when description
  contains `FAIL`): done → `status done`, `job_title`, file exists at `out_dir/filename`; fail →
  `status failed`, `error` text; pipeline looked up at call time (`monkeypatch.setattr(bp,
  "run_pipeline", …)` is enough); master docx sha256 unchanged.

### `tests/test_scrape_api.py` (`importorskip("app.scrape")`)
Fixture `scrape_env`: `scrape.SCRAPE_OUTPUT_DIR → tmp_path`, `scrape.RUN_INLINE = True`,
`scrape_pipeline.run_scraper → fake` (records args; returns fixture CSV path by default),
`scrape_pipeline.newest_csv → fake`, `bp.run_pipeline → fake_pipeline`, `DEEPSEEK_API_KEY=FAKE`,
`scrape.JOBS.clear()` before/after. `post(body)` helper.
- `GET /scrape` 200 html; `GET /api/scrape/latest` → `{"csv_name": null}` / name + row count.
- Start, cap 1, links `[]`: 200; `state == "idle"`; counts `{top:2, medium:1, low:1, none:2,
  done:1, failed:0, queued:0}`; row 0 `done` with `download_url`, `auto true`; row 1 top `pending`,
  `can_generate true`; medium `can_generate true`; low/none `false`; `description` key absent from
  every row; `FAKE` not in `resp.text`; fake runner got `indeed_links == []`, `match_limit is None`.
- Start with links `["…jk=abc12345"]`, `match_limit 2` → runner received them.
- `POST /rows/2/generate` (medium) with key → row `done`; `GET /files/2` 200 docx; `GET /download`
  200 zip containing exactly the 2 done filenames; `FAKE` not in any response.
- `POST /rows/3/generate` (low) → 409; `/rows/4/generate` (blank description) → 409; row already
  `done` → 409; unknown job → 404; bad index → 404.
- Generate with `provider gemini` and no key → 400 (`ConfigError`).
- Start while another scrape job is `scraping` (inject into `scrape.JOBS`) → 409.
- `reuse_latest true`, `newest_csv → None` → `state failed`, error mentions "No scraped file".
- `reuse_latest true`, `newest_csv → fixture` → runner **not** called, rows loaded.
- `run_scraper → None` → `state idle`, `rows == []`, `phase` contains "No new jobs".
- `run_scraper` raises `ScrapeError("boom")` → `state failed`, `error` contains "boom".
- `top_cap 0` → nothing generated, all top rows `can_generate`. `top_cap 201` → 422.
- `GET /download` with zero done rows → 404; while `scraping` → 409.
- `job_status` log is a list of ≤ 40 strings.

### `tests/test_scrape_frontend.py` (no browser)
- `/scrape` 200; `/static/scrape.js` 200 and contains `/api/scrape` and `indeed_links`.
- Every `getElementById('x')` in `scrape.js` exists as `id="x"` in `scrape.html`.
- `scrape.html` has ids `indeed_link`, `add_link`, `indeed_list`, `top_cap`, `match_limit`,
  `reuse_latest`, `provider`, `model`, `api_key`, `start`, `rows`, `zip_link`, `log`.
- `scrape.js` never uses `localStorage`, `sessionStorage`, `document.cookie`, `innerHTML`.
- `index.html` and `batch.html` contain `href="/scrape"`; `scrape.html` links `/` and `/batch`.

---

## Part 1: `app/scrape_pipeline.py` (pure Python, no FastAPI)

Constants: `SCRAPER_DIR = <root>/scraper`, `RUN_ALL`, `LINKS_FILE = SCRAPER_DIR/indeed_scrapper/
links.txt`, `NEW_DATA_DIR = SCRAPER_DIR/data/new-data`, `MATCH_ORDER = ("top","medium","low","none")`,
`class ScrapeError(Exception)`.

- `run_command(cmd, cwd, env, log, timeout) -> int` — Popen as designed above; each stripped line
  appended to `log` (`deque(maxlen=200)`); `TimeoutExpired` → kill, log a line, return -1.
- `run_scraper(indeed_links: list[str], log, match_limit: int | None = None, runner=run_command)
  -> str | None` — write `links.txt` if links; steps; snapshot `new-jobs-*.csv` before; run
  `[node, RUN_ALL, "--steps", steps] + (["--", "--limit", str(n)] if match_limit)`; diff after;
  return new path / `None` / raise `ScrapeError` (exit ≠ 0 and no new file). Exit ≠ 0 **with** a new
  file = matcher failed → return the path (rows come back `none`).
- `newest_csv() -> str | None`.
- `load_matched_rows(csv_path) -> list[dict]` — `utf-8-sig`, `newline=""`; column map; `match`
  normalised; blank description ⇒ `none`; stable sort by `MATCH_ORDER`; then
  `batch_pipeline.make_filenames(rows)`, `status="pending"`, `error=""`, `job_title=""`.
- `generate_row(row, config, out_dir, pipeline=None)` — `pipeline or batch_pipeline.run_pipeline`;
  running → done/failed exactly as `run_batch` does.

Done when `tests/test_scrape_pipeline.py` passes and the batch tests still pass.

## Part 2: `app/scrape.py` + one line in `app/main.py` + `.gitignore`

Module state: `SCRAPE_HTML`, `SCRAPE_OUTPUT_DIR = <root>/scrape_output`, `ZIP_NAME =
"Md_Rawfur_Monzur_Jim_CV_scraped.zip"`, `RUN_INLINE = False`, `JOBS`, `LOCK`.

Job dict: `{id, state: scraping|generating|idle|failed, phase, log: deque, csv_path, error, rows,
dir, provider, model, queue: Queue, busy: int}`. No config kept after the auto phase.

Routes:
- `GET /scrape` → `static/scrape.html`.
- `POST /api/scrape` JSON `ScrapeRequest`: `indeed_links: list[str] = []`, `reuse_latest: bool =
  False`, `top_cap: int = Field(15, ge=0, le=200)`, `match_limit: int | None = Field(None, ge=1)`,
  `provider`, `model`, `api_key` (types as `GenerateRequest`, `app/main.py:68-80`). Under `LOCK`:
  409 if a scrape job is `scraping`/`generating`; `resolve_config` → 400; create job + dir; thread
  (inline when `RUN_INLINE`). Returns `job_status`.
- `run_job(job, req, config)`: `scraping` → (`reuse_latest` ? `newest_csv()` : `run_scraper(links,
  log, match_limit)`) → `None` ⇒ idle + "No new jobs since the last run." → rows =
  `load_matched_rows`; first `top_cap` top rows `auto=True` → `generating`; `generate_row` each auto
  row with `phase="Generating CV i of n"` → `finally: config=None; state=idle; phase=""`. Errors →
  `failed` + `error`. Start the worker thread after.
- `POST /api/scrape/{id}/rows/{index}/generate` JSON `{provider, model, api_key}` → 404s; 409 if
  job `scraping`/`failed`; `resolve_config` → 400; under `LOCK`: 409 unless `can_generate(row)`;
  `status="queued"`, `busy+=1`, enqueue; `state="generating"`. Worker: `generate_row`, `busy-=1`,
  `busy==0 ⇒ idle`. `RUN_INLINE` ⇒ run synchronously.
- `GET /api/scrape/{id}`; `GET /api/scrape/{id}/files/{index}` (copy of `app/batch.py:149-158`);
  `GET /api/scrape/{id}/download` (409 while scraping/generating, 404 if no done row, else
  `make_zip`); `GET /api/scrape/latest`.
- `can_generate(row) = match in (top, medium) and description and status in (pending, failed)`.
- `job_status`: `id, state, phase, error, csv_name, log (last 40), counts {top, medium, low, none,
  done, failed, queued}, zip_url (idle and ≥1 done), rows [{index, match, match_note, auto, title,
  company, location, posted, link, status, error, job_title, download_url, can_generate}]`. Never
  description text, never a key.

`app/main.py`: import + `app.include_router(scrape_router)` beside the batch router
(`app/main.py:151`, before the `/static` mount). `.gitignore`: `scrape_output/`.

Done when `tests/test_scrape_api.py` passes.

## Part 3: `static/scrape.html`, `static/scrape.js`, nav lines, CSS, docs

Skeleton from `static/batch.html`. Nav in all three pages: `Single job · Batch (CSV / Excel) ·
Scraped jobs`. Form `#scrape-form`:
- Indeed links one at a time: `input#indeed_link` (type=url, placeholder "Paste an Indeed job link
  and press Enter") + `button#add_link.ghost` "Add". Enter in that input adds (and prevents form
  submit). Items render in `ol#indeed_list.links` as `1. <link> [✕]` (remove via `data-index`).
  Accept only links containing `jk=`/`vjk=` (`indeed_grab.py:88`); ignore duplicates; `#link_help`
  shows the reason. `#indeed_count`: "3 links" / "No Indeed links — the Indeed step is skipped".
  Help: "Indeed opens a visible Chrome window, about one minute per link; click the 'verify you are
  human' box if it appears. The list replaces scraper/indeed_scrapper/links.txt."
- `input#top_cap` number 0–200, value 15 — "Auto-generate CVs for the first N top matches".
- `input#match_limit` number, empty — "Match at most N jobs (testing; empty = all). Each match is
  one DeepSeek call."
- `input#reuse_latest` checkbox — "Skip scraping, use the newest scraped file" + `#reuse_help` from
  `GET /api/scrape/latest`.
- provider / model / api_key / toggle_key (same ids and hint code as `batch.js`); help says the key
  is also needed for each Generate click and is never stored.
- `button#start` "Scrape and generate".
Status `#status` (`#status_text` = phase, `#elapsed`), `<details><summary>Scraper log</summary>
<pre id="log" class="log"></pre></details>`, `#error.box.error`. Results `#results`: `.progress`
with `#progress_text` ("42 top · 24 medium · 6 low · 5 none — auto CVs: 7 done, 1 failed"),
`a#zip_link.dl`; `table.batch` `# | Match | Title | Company | Location | Link | Status | CV`,
`tbody#rows`. `match` as `.badge.top/.medium/.low/.none`; CV cell = Download when `done`,
`Generate CV` button (`data-index`) when `can_generate` (failed rows keep it as retry + `.row-error`).

`scrape.js`: `batch.js` structure (`POLL_MS = 3000`, chained `setTimeout`, elapsed timer,
`render(job)` rebuilds tbody with `textContent`, no `innerHTML`, no storage). `links = []`,
`addLink()`, `removeLink(i)`, `renderLinks()`. Start → JSON POST; key input **kept** (needed for
Generate clicks); poll while `scraping`/`generating`, stop on `idle`/`failed`; Generate click →
POST `/rows/{i}/generate` with current provider/model/key → restart polling; delegated click
handler on `#rows`; zip link when `zip_url`.

Docs: CLAUDE.md gets a "Scraped-jobs page" section (folder map, `SCRAPER_NODE`, `SCRAPER_TIMEOUT_S`,
`PYTHON` in `scraper/.env` for Indeed, key-per-click rule, match-limit cost control, run uvicorn
without `--reload`). `PLAN_SCRAPE.md` Status updated after each part.

Done when all three new test files pass and `tests/test_batch_frontend.py` still passes.

---

## Verification (end to end, ≤ 6 DeepSeek calls)

1. `.venv/bin/pytest -m "not integration" -q` green after each part (0 API calls).
2. Free: `uvicorn app.main:app` (no `--reload`), `/scrape`, tick "use newest file", cap 0 →
   77 rows of `new-jobs-2026-09-23-120910.csv` grouped top/medium/low; buttons only on top/medium;
   no key in any JSON (browser network tab). 0 calls.
3. Real run (Jim, Windows, after Step 0a): add the three Indeed links from the backup one by one
   (list shows 1, 2, 3), match limit **2**, cap **1**, Start → Chrome opens for Indeed, log streams
   `run-all.mjs`, phase → "Generating CV 1 of 1", table shows 2 matched rows + the rest as `none`,
   one Download link, zip works. **Do not press Generate** (4 more calls). Total: 2 + 4 = 6 calls.
   Check `links.txt` holds the 3 links, `exported-urls.txt` grew, `scrape_output/<id>/` has one docx.
4. Empty-list run right after: no Chrome window, "No new jobs since the last run." 0 calls.

## Notes for Jim

- Indeed needs the Python that has Playwright: set `PYTHON=` in `scraper/.env` if plain `python`
  is not it. The app's `.venv` is not that interpreter and does not need to be.
- Without a console an Indeed page that fails the human check is skipped after 120 s (debug files
  still land in `indeed_scrapper/debug/`).
- Jobs live in memory (refresh loses the table; files stay in `scrape_output/<id>/`), same as batch.
- Unscored rows (match limit or matcher failure) show as `none` with no button; rerun the matcher
  (`npm run match`) and tick "reuse newest" to get buttons for them.
- The scraper is linked to the app at runtime by the subprocess call, independent of git. Being
  in git only means the code is versioned and pushed; `.env` (keys), `node_modules/` and the Chrome
  profile stay local via the ignore files. `scraper/data/*.tsv` and `pipeline.md` change on every
  run and will show up as modified files after each scrape; commit or ignore them as Jim prefers later.

## Step 0 record (2026-09-23)

- Reset done with a one-off script (not kept). Removed: 817 ledger rows, 817 pipeline.md lines,
  819 exported URLs (816 ledger + 3 Indeed by job key; one ledger URL had never been exported),
  3 Indeed rows. Originals in `scraper/data/backup-2026-09-23/` (git-ignored).
- `indeed_scrapper/jobs.csv` stores the original search URL (`…&vjk=<key>`) while
  `exported-urls.txt` stores `https://uk.indeed.com/viewjob?jk=<key>`; match Indeed rows by key.
- The three Indeed links to paste for the Indeed test (from the backup `jobs.csv`) have keys
  `068f1a85882a8031`, `9c80a3599bb17a3d`, `d68095bf9e572e53`, e.g.
  `https://uk.indeed.com/viewjob?jk=068f1a85882a8031`.
- `scraper/.gitignore` added (`.env`, `node_modules/`, `data/backup-*/`); the scraper folder is
  committed with the reset data state.
