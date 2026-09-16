# CV Optimiser – notes for Claude

## What this is
A small local web app that tailors Jim's CV to a job description. Paste the job text,
pick a provider (DeepSeek default, Gemini optional), click Generate, download a `.docx`.
Three LLM/docx stages run in one synchronous request (1–3 minutes). See `PLAN.md` for the design.

## Folder map
- `src/` – the original pipeline: `job_info.py` (extract job info), `update_cv.py` (rewrite CV
  content), `rewrite_cv.py` (write the docx). Each also still runs from the command line.
- `app/` – FastAPI backend: `main.py` (routes), `llm_factory.py` (provider -> LangChain model),
  `pipeline.py` (glue for the three stages, temp files, atomic replace).
- `static/` – the frontend: `index.html`, `style.css`, `app.js`. Plain HTML/CSS/JS, no build step.
- `prompts/` – the four prompt text files used by the pipeline.
- `tests/` – pytest suite (see below).
- Data files at the root: `cv_map.json` (current CV content), `profile.md` (background),
  `profile_experience.md` (project write-ups). `.env` holds `DEEPSEEK_API_KEY` (git-ignored).

## Run
```bash
.venv/bin/uvicorn app.main:app --reload     # then open http://127.0.0.1:8000
```
Fresh machine: `python -m venv .venv && .venv/bin/pip install -r requirements.txt`.

## Tests
```bash
.venv/bin/pytest -m "not integration" -q    # default: fast, offline, free
.venv/bin/pytest -m integration -s          # ONLY when needed
```
Tests marked `integration` call the real DeepSeek API with the key in `.env` and cost money
(and take minutes). Run them only with `-m integration` when needed; default to
`pytest -m 'not integration'`. Never add new tests that hit a real LLM without the marker.

## Rules
- Never modify `Md_Rawfur_Monzur_Jim_CV.docx` (master template). It is only ever read.
  `Md_Rawfur_Monzur_Jim_CV_new.docx` is regenerated output, overwritten on every run.
- API keys entered in the UI are used for that one request only. They are never logged,
  never written to disk, never stored in the browser (no localStorage / cookies).
- Prompts live in `prompts/`. Changing them changes model behaviour; treat edits there as
  behaviour changes and re-check the output docx by hand.
- Temp files are created next to the output file (not the system temp dir) so `os.replace`
  stays on one filesystem. Keep it that way.
- Frontend files are referenced as `/static/style.css` and `/static/app.js`; `GET /` serves
  `static/index.html`.
