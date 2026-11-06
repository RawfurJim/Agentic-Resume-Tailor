# CV Optimiser

**Find new UK AI jobs, rank them against my CV, and write a tailored CV for each good match, all from one click.**

```
Scrape jobs  →  Filter  →  Match with my CV  →  Rewrite CV  →  Download .docx / .zip
```

---

## 1. Scraper: getting the jobs

The scraper (`scraper/`, Node.js) collects jobs from three kinds of source:

- **Company career sites.** It checks 133 companies on every run, including Google DeepMind, Microsoft, OpenAI, Anthropic, Amazon, NVIDIA, Databricks, Wayve and Mistral. It reads them through their public job APIs (Greenhouse, Ashby, Lever, Workday and others).
- **Job boards.** Adzuna, Reed, Jobicy, Remotive, Himalayas and others.
- **Indeed.** I paste Indeed links on the page. A real Chrome window opens each one and saves the job. The parser has four ways to read a page, so a small layout change doesn't break it.

**Full descriptions.** Adzuna and Reed only send a short preview of each job. The scraper fetches the full posting, and for agency ads it opens a headless browser to get the text (at most 40 per run).

**How much data:**

| | |
|---|---|
| Postings checked per scan | ~20,000 |
| Postings checked across 39 scans | ~616,000 |
| UK AI jobs kept so far | **3,453** (`data/exports/uk-ai-jobs.csv` + `.xlsx`) |

## 2. Filtering: from 20,000 to a short list

Each scan cuts the list down step by step:

1. **Title.** Only AI, ML, LLM, GenAI, Data Scientist and Forward Deployed Engineer roles stay (about 18,000 dropped per scan).
2. **Location.** Only UK and Ireland, either on-site, hybrid or UK-eligible remote (about 1,500 dropped).
3. **Age.** Only jobs posted in the last 5 days.
4. **Duplicates and blacklist.** Jobs it has seen before, reposts and blacklisted companies are removed. The same role posted in several cities appears once.
5. **Only new.** Each run writes `new-jobs-<date>.csv` with only the jobs I have **never seen before**. The scraper remembers every job it has handed out.

## 3. Matching: does this job fit my CV?

`match_job/match_jobs.py` sends each new job and my CV to **DeepSeek**, which labels it:

- 🟢 **top match**: the skills line up and the experience fits (with some flexibility on years)
- 🟡 **medium match**: some core skills, but missing domain experience
- 🔴 **low match**: wrong field

Each job is scored only once, so re-running costs nothing.
**So far: 1,218 new jobs matched → 598 top, 474 medium, 91 low.**

## 4. CV generator: rewriting the CV for each job

Each CV takes 4 LLM calls (DeepSeek by default, Gemini optional):

1. **Read the job** (`src/job_info.py`). Pulls out the exact job title, every hard skill or tool, and the top soft skills, the same way an ATS would.
2. **Rewrite the CV content** (`src/update_cv.py`). Updates the title, profile summary, skills, role and project bullet points to fit the job, in plain UK English. It **never invents experience**: it only re-frames what is already in `cv_map.json`, `profile.md` and `profile_experience.md`.
3. **Write the Word file** (`src/rewrite_cv.py`). Puts the new text into my master `.docx` template and keeps all of its formatting. The template itself is never changed.

The prompts are in `prompts/`.

## 5. One click: the whole pipeline

Run `.venv/bin/uvicorn app.main:app` and open **http://127.0.0.1:8000/scrape**:

1. Paste any Indeed links (optional) and click **Start**.
2. The app runs the scraper → filter → match in the background, and the page shows the live log.
3. It **writes CVs for the top matches automatically** (up to a limit, default 15).
4. Medium matches get a **Generate CV** button.
5. Download each CV, or all of them as one **zip**.

There are two other pages:

- **`/`**: paste a single job description and get one tailored CV.
- **`/batch`**: upload a CSV or Excel file of jobs and get one CV per row, plus a zip.

**Safety:** the API key is used only for that request. It is never saved, logged or stored in the browser.
**Cost control:** use "Match at most N" and the CV limit when testing, or tick "reuse newest CSV" to skip scraping.

---

### Setup

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
cd scraper && npm install && pip install -r indeed_scrapper/requirements.txt && playwright install chromium
# put DEEPSEEK_API_KEY in .env and scraper/.env
.venv/bin/pytest -m "not integration" -q     # offline tests, free
```

**Stack:** Python · FastAPI · LangChain · DeepSeek / Gemini · python-docx · Node.js · Playwright
