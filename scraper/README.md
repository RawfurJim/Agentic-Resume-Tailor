# career-ops scraper

The job-posting scraping layer of [career-ops](../), copied out so it can run on its own. Nothing here scores, matches or edits a CV; these scripts only find postings and write them to `data/`.

Copied verbatim from the parent repo (same relative layout, no code changes). Every script resolves its root from its own file location, so this folder is self-contained.

## Setup

```bash
npm install                                  # also installs Playwright's Chromium
cp templates/portals.example.yml portals.yml # which boards/companies to scan
node validate-portals.mjs                    # sanity-check the config
node scan.mjs                                # run the scanner
```

Optional: `cp config/profile.example.yml config/profile.yml` for cooldown/tier settings, `cp templates/blacklist.example.md data/blacklist.md` for a do-not-scan list, `cp .env.example .env` for `APIFY_TOKEN` / `GEMINI_API_KEY`.

## UK AI jobs quick start

This install is configured for Jim's search: AI Engineer / ML Engineer / LLM & GenAI
Engineer / Data Scientist / Forward Deployed Engineer, full-time, in the United Kingdom
and Ireland (on-site, hybrid or UK-eligible remote). One command scrapes the Indeed links
you pasted, scans every enabled employer, writes the spreadsheets and scores each new job
against your CV:

```bash
npm install                                        # once (Node side)
pip install -r indeed_scrapper/requirements.txt    # once (Python side: playwright, beautifulsoup4, lxml)
playwright install chromium                        # once
cp .env.example .env                               # then put your DEEPSEEK_API_KEY in it
npm run scan:uk                                    # the whole pipeline
```

The two files you edit by hand:

| File | What goes in it |
|---|---|
| `indeed_scrapper/links.txt` | Indeed job links (one per line, straight from the browser address bar). |
| `match_job/cv.txt` | Your CV as plain text — what every job is scored against. |

What `npm run scan:uk` (= `node run-all.mjs`) does, in order:

1. **indeed** — `python indeed_scrapper/indeed_grab.py` opens a visible Chrome and saves each
   new link in `links.txt` to `indeed_scrapper/jobs.csv` (already-saved jobs are skipped; if
   Chrome shows a "verify you are human" box, click it). If this step fails the run says so
   and carries on — the ATS scan does not depend on Indeed. The parser reads the job four
   ways (Indeed's embedded JSON, the schema.org JobPosting block, known markup, then the
   visible text under "Full job description"), so a redesign has to break all four at once;
   a page that still fails is saved to `indeed_scrapper/debug/` and the summary says
   "layout probably changed" when that is the pattern.
2. **scan** — `scan.mjs` reads every `enabled: true` entry in `portals.yml` (Google + DeepMind,
   Microsoft, OpenAI, Anthropic, Amazon UK, NVIDIA, Databricks, Wayve, Graphcore, Salesforce,
   Writer, Mistral, Trainline, ...) plus the job boards (Remotive, Jobicy UK, and — once you add
   the free keys to `.env` — Adzuna and Reed), fetches their public APIs, keeps titles matching
   `title_filter` and locations matching `location_filter`, appends new postings to
   `data/scan-history.tsv` / `data/pipeline.md` and saves their descriptions to
   `data/job-descriptions.jsonl`. Every enabled entry has a provider: the summary line should
   read `0 skipped — no provider matched` (`npm test` enforces it).
3. **export** — rebuilds `data/exports/uk-ai-jobs.csv` + `.xlsx` (**all AI jobs kept so far**,
   Indeed rows included with Source `indeed`; the title filter is not applied to jobs you
   picked yourself) and writes `data/new-data/new-jobs-<date>-<time>.csv` holding **only the
   jobs never handed out before** whose posting date is within the last 5 days (a job with no
   posting date counts from the day the scraper first saw it), **one row per company + title**:
   the same role advertised in several UK locations is written once (the copy with a
   description, else the most recently posted). `exported-urls.txt` is its memory — written,
   too-old and duplicate URLs all land there, so none is re-judged next run; a run with nothing
   new writes no file. A job with no description still appears with its title and link; the
   matcher marks it `no description`.
   **Full descriptions:** Adzuna's and Reed's search APIs only send a ~500-character teaser, so
   during the scan every new Adzuna/Reed job gets its whole posting fetched (Reed: the per-job
   API `/api/1.0/jobs/<id>`, then the public page; Adzuna: Adzuna's own details page
   `/jobs/details/<id>`, which its robots.txt allows — a details page that answers 404 with the
   posting still in it counts too). **Browser fallback (round 7):** for agency ads (Hackajob, Sirius,
   CBSbutler, FDM…) Adzuna's own page holds the same ~400-char snippet; the full text is on the
   employer's page behind the `/jobs/land/ad/` link, which meta-refreshes to a click tracker that
   only a real browser gets past (Cloudflare "Just a moment"). Adzuna's robots.txt disallows that
   link; Jim accepted the trade-off (same as Google Careers), so the scan opens it in headless
   Chromium (`browser-description.mjs`, Playwright) for at most **40 jobs per run** (~10–25 s each,
   ≈13 extra minutes at most); the rest stay teasers and the summary tells you to run
   `npm run backfill:descriptions -- --browser --source adzuna`. `--no-browser-jd` keeps the cheap
   routes but never launches Chromium; `--no-jd-fetch` turns all description fetching off. Nothing
   reachable → the teaser stays and the summary says how many are "teaser only" (Cloudflare may
   still challenge headless Chromium on some trackers, and employer pages that need a login render
   nothing — those keep the teaser). Jobs stored earlier with a teaser are upgraded with
   `npm run backfill:descriptions` (see below; `--browser` is OFF there by default).
4. **match** — `python match_job/match_jobs.py <that csv>` sends each new job's description
   plus `cv.txt` to DeepSeek and fills one more column, `Match status`, in the same file. Rows already
   scored are never sent again; rows without a description get `no description`.

The new-jobs csv ends up with 9 columns:
`Company, Title, Location, URL, Source, Posted, First seen, Description, Match status`
— `Match status` is `top match`, `medium match`
or `low match` (or `no description` / `error: …`). `uk-ai-jobs.csv` keeps the first 8.

Two output folders, one purpose each:

| Folder | File | What it holds |
|---|---|---|
| `data/exports/` | `uk-ai-jobs.csv` (+ `.xlsx`) | **All AI jobs kept so far** (ATS + Indeed), rebuilt from scratch every run. |
| `data/new-data/` | `new-jobs-<date>-<time>.csv` | **Only the jobs new since the last run** (posted ≤ 5 days ago, one row per company + title), with the `Match status` column. One file per run; a job appears in exactly one of them, ever. |

Cost note: every new job is one DeepSeek call (a few thousand tokens). To try the matcher
cheaply, cap it: `npm run match -- --csv data/new-data/<file>.csv -- --limit 3`.

Useful variations:

```bash
node run-all.mjs --steps scan,export    # skip Indeed and the matcher (same as the old npm run scan:uk:ats)
node run-all.mjs --dry-run              # print what each step would do, write nothing
node run-all.mjs --strict               # an Indeed failure aborts instead of continuing
npm run indeed                          # only the Indeed links
npm run match -- --csv data/new-data/new-jobs-….csv     # (re)score one csv; add  -- --limit 3  to cap calls
python match_job/match_jobs.py data/new-data/new-jobs-….csv --dry-run   # list what would be sent
node scan.mjs --dry-run                 # preview without writing anything
node scan.mjs --company Google          # one employer only (substring match on name)
node scan.mjs --since 7                 # only postings dated in the last 7 days
node export-jobs.mjs --since 7          # spreadsheet of this week's finds
node export-new-jobs.mjs --dry-run      # preview which jobs the next new-data csv would hold
node export-new-jobs.mjs --max-age-days 14   # widen the "new" window (0 = no age limit)
node fetch-jd.mjs <posting url>          # print the full description one URL would get (Reed, Adzuna, Google Careers, Greenhouse, Lever, Ashby, Workday)
node fetch-jd.mjs --browser <adzuna land url>   # same, but open the land link in headless Chromium when Adzuna only has the snippet (`via browser` on stderr)
npm run backfill:descriptions -- --dry-run            # list stored jobs that have no description or only a teaser
npm run backfill:descriptions -- --limit 5            # fetch a few first (≈1 request per job, 1 s apart)
npm run backfill:descriptions -- --source reed,adzuna # then the rest; re-export afterwards with  npm run export
npm run backfill:descriptions -- --source google       # Google postings: the posting page carries the whole text (a removed posting is a miss)
npm run backfill:descriptions -- --browser --source adzuna --limit 10   # Adzuna teasers through Chromium (~20 s each) — try 10 first, then drop --limit
CAREER_OPS_TITLE_AUDIT=titles.tsv node scan.mjs --dry-run   # every title seen + kept/rejected, to check the keyword lists
npm test                                # 490+ unit tests (providers, filters, blacklist, export, run-all)
npm run test:py                         # Python tests for the matcher (fake LLM — no API calls)
```

Tuning:

- **Add a company** — append to `tracked_companies:` in `portals.yml` with its public
  board URL (Greenhouse / Ashby / Lever / Workday are auto-detected). Check it with
  `node scan.mjs --dry-run --company <name>`. `node discover-ats.mjs <company>` finds the
  board for you.
- **Widen or narrow titles** — edit `title_filter.positive` / `.negative`. `" + "` joins
  terms that must all appear; `word:` makes a term whole-word only. The positives are
  deliberately broad (any AI signal); the negatives do the real work and are grouped by
  reason: full-time only, researcher roles (Research Scientist, Applied Scientist,
  Researcher — kept out on purpose, Data Scientist stays), and non-engineering roles
  (Sales, Program Manager, UX, Policy, Director/VP/Head of, SRE, Customer Engineer ...).
  To let one of those back in, delete its line. "Research Engineer" is currently kept.
- **AI-native labs** — `title_filter_overrides` lists companies (Anthropic, OpenAI,
  DeepMind, ElevenLabs, ...) where plain "Software Engineer" / "Developer" /
  "Member of Technical Staff" titles also count, because everything they build is AI.
  Bare "Engineer" and "Architect" are deliberately not in that list: a first full run
  showed they let in AV, IT, network, mechanical and pre-sales titles. Add a company's
  name in lowercase to widen the net for it; the negatives still apply there.
- **Human "agents"** — "Agent" is a positive (AI agents), so support / customer-service /
  sales agents are named in the negatives. Robotics Engineer titles are currently out;
  add `Robotics` to the positives if you want them.
- **Locations** — `location_filter.always_allow` is the UK/Ireland list; `block` is the
  foreign-hub list. A posting that names both a UK city and a US city passes. A bare
  "Cambridge" is deliberately NOT allowed (Cambridge, Massachusetts); boards that give
  a country code alongside the city (Lever, Google, Amazon) arrive as "Cambridge, GB"
  and pass.
- **Jim's UK AI companies** — Wayve, Synthesia, ElevenLabs, Speechmatics, Stability AI,
  Faculty, PolyAI, Graphcore, BenevolentAI, Recursion (Exscientia), Healx, Gigaton,
  Darktrace and Antiverse are all tracked. Round 5 (2026-09-22) added the boards probed
  live with UK AI titles: Writer, Sony Interactive (PlayStation), Cognition, Trainline,
  Latent Labs, Bumble, MongoDB, Encord, Prolific, UiPath, Motorway, Together AI, Ocado,
  CuspAI, Poolside, Fractile, Auto Trader, Reddit, Flo Health, Quantexa, and fixed
  Mistral (its Lever board was empty; the live one is on Ashby), Twilio, Salesforce,
  Genesys, Dialpad, Zendesk and Talkdesk (were web-search stubs no provider could scan). Oxa, Dogtooth, Machines With Vision,
  CMR Surgical, Space Intelligence and Charm Therapeutics publish no scrapable board
  (see the comment in `portals.yml`); re-check with `node discover-ats.mjs <company>`.
- **Do-not-scan list** — `data/blacklist.md` names employers to skip whatever board
  they turn up on (finance, insurance and defence today; the same companies are
  also `enabled: false` in `portals.yml`). The run summary prints
  "Blacklisted: N skipped". Delete a row (and re-enable its entry) to let one back in.
  Since 2026-09-23 the two exporters apply the same list, so a name added there (e.g. `eFinancialCareers`,
  the finance job board that Reed/Adzuna report as the company) also disappears from `uk-ai-jobs.csv` and
  the new-jobs feed on the next run — no ledger editing needed.
- **Google** — `www.google.com/robots.txt` disallows the careers results path. The
  `google` provider is enabled here by explicit decision and kept to 5 pages per search
  with a pause between requests. Narrow the search URL rather than raising `max_pages`.
- **Microsoft** — the `microsoft` provider reads the public JSON search behind
  `apply.careers.microsoft.com` (robots.txt allows it). The board is worldwide, so each
  entry is one search: `query=` and `location=` in `careers_url`, or a `microsoft:`
  block with `query:` / `location:`. Add another entry to run another search. Pages
  hold 10 jobs; the default of 10 pages covers a UK search comfortably. The host
  rate-limits bursts (HTTP 429): pages are 1.5 s apart and retried up to 4 times, so a
  page is no longer lost silently. `fetchDetails: true` (set on all three entries) reads
  each job's full description from the job-detail endpoint — the Description column and
  the CV matcher now work for Microsoft rows.
- **Amazon** — one `provider: amazon` entry fetches the WHOLE UK board (about 765
  postings, 8 API pages) and lets `title_filter` choose; the old keyword searches missed
  titles like "Software Development Engineer, Ring Cloud Computer Vision". amazon.jobs
  names the hiring entity ("AWS EMEA SARL (UK Branch)", "Evi Technologies Limited"), so
  the entry's `company_label: Amazon` shows them all as Amazon (the one row scanned before
  round 5 keeps its old entity name). Descriptions come inline from the search JSON.
  AWS Professional Services "Delivery Consultant AI" / "AI/ML Consultant" titles are kept
  (Jim, 2026-09-22) — "Consultant" is no longer a blanket negative, only the sales-side
  consultant titles are. "Applied Scientist" stays out (researcher rule): that is where
  ~10 more Amazon UK ML roles sit if you ever change your mind. The global 60-day cap
  applies to Amazon like everyone else.
- **UK job platforms** — `job_boards:` has `Adzuna (UK)` (aggregates Reed, TotalJobs,
  CV-Library, LinkedIn…) and `Reed.co.uk`. Both need a free key in `.env`
  (`ADZUNA_APP_ID` + `ADZUNA_APP_KEY` from developer.adzuna.com, `REED_API_KEY` from
  reed.co.uk/developers/jobseeker); until then each logs one error and the run continues.
  Edit their `queries:` lists to change what is searched. `Remotive` and `Jobicy (UK
  remote)` need no key.
- **Company entries with no scrapable board** are kept in `portals.yml` as `enabled: false`
  with a one-line reason (CAPTCHA-walled Arm, custom sites like Shopify/Vinted, empty
  boards) so nobody re-adds them blind; `node scan.mjs --dry-run --company <name>` re-checks one.

The tests in `tests/portals-uk.test.mjs` assert the filter against a table of real
titles and locations, so `npm test` tells you immediately if a config edit lets
"Sales" or "San Francisco" through.

## Output

- `data/pipeline.md` — new postings, one `- [ ] url | company | title | location` line each, under `## Pending`
- `data/scan-history.tsv` — every posting ever seen (dedup ledger)
- `data/scan-runs.tsv`, `data/portal-health.tsv` — per-run counters and board health
- `data/job-descriptions.jsonl` — description text per job URL (append-only, last line wins; `source` says where the text came from: the provider, `reed-detail-api`, `reed-page`, `adzuna-details`, `source-api`, `source-page` or `api`)
- `data/exports/uk-ai-jobs.csv` + `.xlsx` — every AI job kept so far (ATS + Indeed), 8 columns incl. Description
- `data/new-data/new-jobs-*.csv` — one file per run, only that run's new jobs (posted ≤ 5 days ago, one per company + title) + the `Match status` column; `exported-urls.txt` is its memory
- `indeed_scrapper/jobs.csv` — every Indeed job scraped from `links.txt` (input to the exports)

## Scripts

| Command | What it does |
|---|---|
| `node run-all.mjs` | The whole pipeline: Indeed → scan → exports → CV match (`--steps`, `--dry-run`, `--strict`) |
| `python indeed_scrapper/indeed_grab.py` | Fetch the Indeed links in `indeed_scrapper/links.txt` into `jobs.csv` |
| `python match_job/match_jobs.py <csv>` | Add the `Match status` column (top / medium / low match) via DeepSeek (`--limit`, `--dry-run`) |
| `node scan.mjs` | Scan every enabled entry in `portals.yml` through `providers/*.mjs` |
| `node scan-ats-full.mjs` | Reverse sweep of full public ATS datasets, filtered by `portals.yml` title/location filters |
| `node scan-interamt.mjs` | Playwright scanner for Interamt.de |
| `node scan-hn.mjs` | Hacker News "Who is hiring" (needs `GEMINI_API_KEY`) |
| `node fetch-jd.mjs [--browser] <url>` | Full job description text: Reed (per-job API / page), Adzuna (details page, then with `--browser` the employer page via headless Chromium), or a known ATS API |
| `node backfill-descriptions.mjs` | Fill `data/job-descriptions.jsonl` for ledger jobs with no description or only an Adzuna/Reed teaser (`--limit`, `--source`, `--browser`, `--dry-run`, `--throttle`) |
| `node browser-extract.mjs <url> --mode jd` | Job description via Playwright fallback |
| `node check-liveness.mjs <url>` | Is a posting still live? |
| `node archive-posting.mjs <url>` | Save a posting as PDF into `jds/` |
| `node verify-portals.mjs` / `audit-portals.mjs` | Board reachability / board content audit |
| `node discover-ats.mjs <company>` | Find a company's ATS board and add it to `portals.yml` |
| `node detect-reposts.mjs` | Roles re-listed repeatedly in `data/scan-history.tsv` |

Providers: see `docs/SUPPORTED_JOB_BOARDS.md`; add one with `providers/ADDING_A_PROVIDER.md`.
