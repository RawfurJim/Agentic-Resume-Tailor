# new_plan.md — Round 7 hand-off (written 2026-09-23 for a fresh session)

Jim's build order: plan → breakdown → **tests first** → iterate until green. The tests for every
task below are ALREADY WRITTEN and red on purpose. Your job in the new context: make them green,
in the order A → B → C, then do the docs/memory steps, then `npm test` + the python tests must be
all green. Do not ask Jim questions that this file already answers; he said "next time do not ask".

Work in `scraper/` (this folder). Run node tests with `npm test`; python tests with
`python3 match_job/tests/test_match_jobs.py` (the file inserts its own sys.path; `unittest discover`
does not work here). Inside the sandbox any live HTTP through the project's client needs
`CAREER_OPS_NO_DNS_CACHE=1`. `.env` values are quoted — dotenv handles that; ad-hoc parsers must strip quotes.

**Never edit/clean Jim's data files beyond what a task explicitly says** (he was unhappy when a CSV
was "cleaned" for him on 2026-09-22). Task B below is the one explicitly requested data change.

---

## Where things stand (state of the code on 2026-09-23)

Round 6 (done, all green before round 7 tests were added — 518 node tests, 18 python tests):
- `export-new-jobs.mjs`: feed = jobs never handed out before AND posted ≤ **5 days** ago (posting date only;
  undated → first-seen), **one row per company+title** (`jobKey`/`dedupeByJobKey`, location ignored). Dropped
  duplicates / too-old URLs also go to `data/new-data/exported-urls.txt`.
- `full-description.mjs`: `fetchFullDescription(url, textCap, timeoutMs, { current, detailsPage, followRedirect,
  env, fetchJson, fetchText, fetchResponse, fetchKnownApi })` → `{url, title?, text, via} | null`. Routes:
  Reed → `/api/1.0/jobs/<id>` (Basic key) then public-page JSON-LD; Adzuna → `https://<host>/jobs/details/<id>`
  (robots ALLOWS it) then, only with `followRedirect:true`, plain-HTTP hop following (useless in practice, see C);
  other → `fetchJdViaKnownApi`. Helpers exported: `sourceKind, reedJobId, adzunaAdId, isBetterText,
  extractDescriptionFromHtml, elementInnerHtml, containerText, followToPage`. `providers/_jsonld.mjs` shared.
- Providers adzuna/reed set `job.descriptionTruncated = true` (their search payloads are ~500/450-char teasers).
- `job-descriptions.mjs` `enrichDescriptions(offers, { fetchJd, textCap, timeoutMs, pauseMs, detailsPage })` →
  `{ filled, missing, stillTruncated, byVia }`; fetches when no real description OR `descriptionTruncated`;
  accepts via `shouldStoreDescription` (10% longer rule); keeps the teaser on a miss.
- `scan.mjs` stage 5.6 calls it (flag `--no-jd-fetch` disables); summary line prints `N full text fetched (via
  counts), M teaser only`. `backfill-descriptions.mjs` selects rows with no text or an Adzuna/Reed teaser
  (`TEASER_PORTALS`, `TEASER_MAX_CHARS = 600`), `--source reed,adzuna`, loads `.env` itself. `fetch-jd.mjs`
  = single-URL CLI, loads `.env`.
- Live-verified from the sandbox: Reed detail API (5.8k chars), Adzuna details page for the A&O Shearman ad (4.2k).

Jim's 2026-09-22 17:20 run: 153 new jobs, `91 full text fetched (reed-detail-api 3, adzuna-details 88), 61
teaser only`. The 61: agency ads where Adzuna's own page also has only the snippet (see C).

---

## A. Matcher outputs ONLY the status  — tests: `match_job/tests/test_match_jobs.py` (red: 8 failures, 3 errors)

Jim (2026-09-23): "I only want top / medium / low — not the matching / not-matching experience text."

Edit `match_job/match_jobs.py`:
- `CV_EVALUATOR_PROMPT`: keep the recruiter role and the two CRITICAL EVALUATION RULES verbatim; the JSON
  structure becomes ONLY `{"status": "[Select exactly one: 'top match', 'medium match', or 'low match'. …same
  guidance…]"}`. The strings `matching_experience` / `not_matching_experience` must not appear anywhere in the prompt.
- Remove `MATCH_COL`, `MISS_COL`; `NEW_COLUMNS = [STATUS_COL]`.
- `parse_verdict` → returns exactly `{"status": <normalised>}`; requires only `status`; extra keys (old replies) ignored.
- `evaluate` → `{STATUS_COL: …}` only (also for `no description` and `error: …`). `match_rows` unchanged otherwise.
- Module docstring: "Adds one column". `argparse` description likewise.
- Docs: README §"4. match" ("fills three more columns" → "fills one more column, `Match status`"), the sentence
  "The new-jobs csv ends up with 11 columns: … Matching experience, Not matching experience`" → **9 columns**
  ending "`…, Description, Match status`" (the node test `tests/package-scripts.test.mjs` greps for
  `` Description, Match status` `` and `9 columns`, and fails on any remaining "Matching experience" /
  "Not matching experience" in README), the two table rows + Output bullet ("3 match columns" → "Match status"),
  scripts-table row for `match_jobs.py`; `run-all.mjs` header comment line 14.
- [x] python tests green  [x] `tests/package-scripts.test.mjs` green (2026-09-23)

## B. Reset so the next run shows fresh rows  — one-off data step, verify by dry run (no unit test)

Jim wants to SEE the scraper's output in a new-jobs csv; every recent job is already in the memory.
His choice (AskUserQuestion 2026-09-23): **re-issue the jobs posted in the last 2 days; keep the 5-day rule.**
1. Delete `data/new-data/new-jobs-2026-09-22-142419.csv`, `…-160245.csv`, `…-172045.csv` (all three).
2. Rewrite `data/new-data/exported-urls.txt` without the URLs whose ledger row in `data/scan-history.tsv`
   (status `added`, column 9 `posted_at`; when empty, column 2 `first_seen`) is within the last 2 days of the day
   you run it (age ≤ 2). Measured on 2026-09-23: 77 of 796 URLs (Adzuna 44, Reed 16, Workday 5, Ashby 3,
   Greenhouse 3, others 6). URLs not in the ledger (5 Indeed links) stay. Use a throw-away script in the
   scratchpad; print the removed count; **no backup copies in the project**.
3. Verify: `CAREER_OPS_NO_DNS_CACHE=1 node export-new-jobs.mjs --dry-run` lists the re-issued jobs (one per
   company+title, posted ≤ 5 days). Do NOT run it without `--dry-run` — Jim's next `npm run scan:uk` writes the file.
- [x] done 2026-09-23: 77 of 796 URLs removed (719 kept), 3 csv deleted; dry run = 46 jobs / 34 companies

## C. Adzuna teaser-only ads: headless-browser fallback + details-page 404 fix
Tests (all red until done): `tests/browser-description.test.mjs` (new module missing), 4 new tests at the end
of `tests/full-description.test.mjs`, 2 at the end of `tests/job-descriptions.test.mjs`, 1 at the end of
`tests/backfill-descriptions.test.mjs`. Read the tests first — they define the exact interfaces.

### Why
For agency ads (Hackajob, Sirius, CBSbutler, FDM…) Adzuna's details page holds the same ~400-char snippet.
The full text is on the employer page behind `redirect_url` (`/jobs/land/ad/<id>`): that page is **HTTP 200 with
a 5 s `<meta http-equiv=refresh>`** to a click tracker (`click.jobroute.io`, `click.appcast.io`), and the trackers
answer plain HTTP with a **Cloudflare "Just a moment / enable JavaScript" 403**. Only a real browser gets through.
Jim's decisions: follow that link although Adzuna's robots.txt disallows `/jobs/land/ad/` (same trade-off as Google
Careers), via headless Chromium (Playwright 1.62.1 is a dependency; `postinstall` installs Chromium on his PC), accepting
~10–25 s per affected job (~30/day). Also: one details page answered 404 while still containing the posting.

### C1. `full-description.mjs`
- 404-with-body: in `fetchAdzuna`'s details tier `catch (err)`, if `err.body` is a string → `extractDescriptionFromHtml(err.body)`;
  accept via `isBetterText` → `via: 'adzuna-details'`.
- New opts: `browser?: boolean` (default false), `browserFetch?: Function` (default: lazy
  `import('./browser-description.mjs')` → `fetchViaBrowser`; never import Playwright at module load),
  `browserTimeoutMs?: number` (default 30_000). In `fetchAdzuna`, AFTER the details tier and the (opt-in) HTTP
  redirect tier: `if (d.browser && /\/jobs\/land\/ad\//.test(u.pathname))` →
  `await d.browserFetch(u.href, { textCap, timeoutMs: browserTimeoutMs, current, fetchKnownApi })`; return it when
  non-null and `isBetterText(text, current)` (keep `via` from the browser result; set `url: u.href`). Errors → null.
- Docs header: add the browser tier; `via` values now include `browser`, `browser-api`.

### C2. New `browser-description.mjs` (root) — interface fixed by the test file
```
export const CHALLENGE_MARKERS = [/Just a moment/i, /Enable JavaScript and cookies/i, /enable JS and disable/i, …];
export function isTrackerHost(hostname)   // adzuna.* or click.* → true
export function looksLikeChallenge(text)
export function routeDecision(url, resourceType) // 'abort' for rejectPrivateOrInvalid(url) hits, non-http(s), and image/font/media; else 'continue'
export async function fetchViaBrowser(landUrl, { textCap = 20_000, timeoutMs = 30_000, current = '',
  fetchKnownApi = fetchJdViaKnownApi, launcher = defaultLauncher, sleep = realSleep, now = Date.now,
  pollMs = 500, hydrationMs = 2_000 } = {})  → { url: landUrl, finalUrl, title?, text, via: 'browser'|'browser-api' } | null
export async function closeBrowser()       // idempotent
```
- `defaultLauncher = async () => (await import('playwright')).chromium.launch({ headless: true })`.
- ONE shared browser per process (module-level); `getBrowser(launcher)` launches on first use; a failing launch → null result.
- Per call: `browser.newContext(LIVENESS_CONTEXT_OPTIONS)` (liveness-browser.mjs), `context.route('**/*', h)` where `h`
  calls `route.abort('blockedbyclient')` or `route.continue()` per `routeDecision(route.request().url(), route.request().resourceType())`,
  `page.goto(landUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })`.
- Settle loop: `dom = await readDom(page)` (EXPORT `readDom` from browser-extract.mjs — currently a private
  `async function readDom(page)` at ~line 706), `url = page.url()`; settled when `!isTrackerHost(host) && !looksLikeChallenge(dom.text)`;
  otherwise if `now() - start >= timeoutMs` → null, else `await sleep(pollMs)` and loop. (The fake in the test advances
  one page-state per `sleep` and drives `now` from it — do not use `page.waitForTimeout` for the loop.)
- Then `if (hydrationMs > 0) await sleep(hydrationMs)`; re-read `dom`; `finalUrl = page.url()`; `rejectPrivateOrInvalid(finalUrl)` → null.
- `known = await fetchKnownApi(finalUrl, textCap, timeoutMs)` (catch → null); if `known && isBetterText(known.text, current)` →
  `{ url: landUrl, finalUrl, title: known.title, text: cap(known.text), via: 'browser-api' }`.
- Else `text = compactText(dom.text, textCap)` (browser-extract.mjs export) — strip a leading `title` line is NOT required;
  `isBetterText(text, current)` → `{ url: landUrl, finalUrl, title: dom.title, text, via: 'browser' }`, else null.
- `finally { await context.close() }`. Never throw.

### C3. `job-descriptions.mjs` `enrichDescriptions`
- New opts: `browser = true`, `browserCap = DEFAULT_BROWSER_CAP` (export `DEFAULT_BROWSER_CAP = 40`),
  `closeBrowser = lazy import of browser-description closeBrowser` (injectable).
- Pass `{ current, detailsPage, browser: browser && browserUsed < browserCap }` to `fetchJd`. When a result's `via`
  starts with `browser` → `browserUsed++`. `browserCapHit++` when the offer stays truncated, is an Adzuna
  `/jobs/land/ad/` URL, `browser` is on and the cap was already spent when it was fetched.
- Return `{ filled, missing, stillTruncated, byVia, browserUsed, browserCapHit }`; `await closeBrowser()` once at the end (try/catch).

### C4. `scan.mjs`
- Flag `--no-browser-jd` (add wherever `--no-jd-fetch` is declared/validated, ~line 2835 and the usage text) →
  `enrichDescriptions(verifiedOffers, { browser: !noBrowserJd })`.
- Summary (~line 3466): when `browserCapHit > 0` append `, N over the browser cap — run: npm run backfill:descriptions -- --browser --source adzuna`.

### C5. `backfill-descriptions.mjs`
- `runBackfill({ …, browser = false, closeBrowser = lazy })`: pass `{ current: r.current, browser }` to `fetchJd`;
  `closeBrowser()` once in a `finally`. CLI flag `--browser` (KNOWN_FLAGS, USAGE, README). Default OFF (490 stored
  Adzuna teasers × ~20 s is an attended job; Jim runs `--browser --source adzuna --limit 10` first).

### C6. `fetch-jd.mjs` and the `full-description.mjs` CLI: `--browser` flag → `{ browser: true }`; `closeBrowser()` afterwards.

### C7. Docs + memory
- README: full-description paragraph (browser fallback, cap 40, `--no-browser-jd`, backfill `--browser`, timing,
  robots trade-off accepted by Jim), scripts table (`fetch-jd.mjs --browser`).
- Memory file `~/.claude/projects/-c-Users-Jim-Desktop-Automate-Process-scrap-job-scraper/memory/project-uk-scraper-decisions.md`:
  round 7 note (A, B done; C built; land = meta-refresh → Cloudflare-challenged trackers; Jim to confirm Chromium gets through).
  Keep MEMORY.md's one-line index in sync.
- [x] C1 [x] C2 [x] C3 [x] C4 [x] C5 [x] C6 [x] C7 (2026-09-23; 532 node + 20 python tests green; Chromium live check left for Jim)

---

## Test status when this file was written (2026-09-23) — the red ones are the work

`npm test`: 526 tests, **519 pass, 7 fail** (all 7 are round-7 tests, expected red):
- `tests/browser-description.test.mjs` — whole file fails to load: `browser-description.mjs` does not exist yet (C2).
- `tests/full-description.test.mjs` — "details page answers 404 but the HTML still carries the posting" and
  "details page only has the snippet + browser:true → browserFetch(...)" (C1). The other two round-7 tests in that
  file ("browser tier off unless browser:true…", "a full details page never reaches the browser") already pass —
  they guard behaviour that must STAY true.
- `tests/job-descriptions.test.mjs` — the two `enrichDescriptions` browser-cap tests (C3; `DEFAULT_BROWSER_CAP` export missing).
- `tests/backfill-descriptions.test.mjs` — "browser:true is passed to the fetcher…" (C5).
- `tests/package-scripts.test.mjs` — README still documents the 11 columns (A docs).

`python3 match_job/tests/test_match_jobs.py`: 20 tests, **9 pass, 11 fail/error** — all A (`MATCH_COL`/`MISS_COL`
still exist, prompt still asks for the two experience fields, `parse_verdict` still requires them).

Everything else (round 6 and earlier) is green — keep it that way.

## Verification for Jim (his PC; Chromium cannot run in the sandbox)
0. `npm run scan:uk` → a fresh `new-jobs-<date>-<time>.csv` (~50–70 rows) with a single `Match status` column after Description.
1. `node fetch-jd.mjs --browser "https://www.adzuna.co.uk/jobs/land/ad/5893792295?se=2JlbM6C28RG6-LerT6N-jw&utm_medium=api&utm_source=dc96cb17"`
   → several thousand chars, `via browser` on stderr. If `no full description found`: Cloudflare blocked headless
   Chromium → next option is `chromium.launch({ channel: 'chrome' })` or headed mode (decide with Jim then).
2. `npm run backfill:descriptions -- --browser --source adzuna --limit 10`, then `npm run export`.
3. Next scan: summary shows `browser N` in the full-text breakdown and fewer "teaser only".

## Known limits (tell Jim, already agreed)
- Cloudflare may still challenge headless Chromium on some trackers → those stay teasers, counted in the summary.
- Employer pages that render nothing without login → teaser kept.
- ~20 s per browser job; the per-run cap (40) bounds a scan to ~13 extra minutes; the rest go to the backfill.
