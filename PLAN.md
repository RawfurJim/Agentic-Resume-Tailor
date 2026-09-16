# CV Optimiser Web App – Implementation Plan

## 1. Goal

Turn the existing three-script pipeline into a small web app:

1. Paste a job description into a web page.
2. Optionally choose an LLM provider (DeepSeek or Gemini), a model name and an API key.
3. Click **Generate**.
4. Download a tailored `.docx` CV.

The current scripts keep working exactly as they do today from the command line.

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Backend | FastAPI (Python) |
| Frontend | Plain HTML, CSS and JavaScript, no framework, no build step |
| Providers | DeepSeek (default) and Gemini |
| Default models | DeepSeek `deepseek-flash` for job extraction, `deepseek-reasoner` for CV rewrite, key read from `.env` |
| Gemini | One model name used for **both** stages. Model defaults to `gemini-2.5-flash` if left blank. API key is **required**; no `.env` fallback. Missing key returns a clear error |
| Testing | Real DeepSeek calls with the `.env` key, no fake LLMs. Gemini tested manually |
| Two-model structure | Kept. The pipeline has two slots (extract model, rewrite model). DeepSeek fills them differently, Gemini fills both with the same model |
| Output file | One fixed file on disk, `Md_Rawfur_Monzur_Jim_CV_new.docx`, overwritten on every run. The master `Md_Rawfur_Monzur_Jim_CV.docx` is never touched |
| Download name | Includes the job title, e.g. `Md_Rawfur_Monzur_Jim_CV_Senior_AI_Engineer.docx` |
| API keys from the browser | Held in memory for that one request only. Never logged, never written to disk |
| Request style | One synchronous HTTP request with a spinner in the browser. Background jobs are out of scope for v1 |
| CV template and profile files | Stay as fixed project files. No upload feature |

## 3. How a request flows

```
Browser (static/index.html + app.js)
   │  POST /api/generate  { job_description, provider, model, api_key }
   ▼
FastAPI (app/main.py)
   │  validates input, builds a ModelConfig
   ▼
app/llm_factory.py         make_llm(provider, model, api_key)  ->  LangChain chat model
   │
   ▼
app/pipeline.py            run_pipeline(job_description, config)
   │  1. ExtractJobInfo(llm=extract_llm).process(job_text)      -> job_info dict
   │  2. UpdateCv(llm=rewrite_llm).process(job_info)            -> updated_cv dict
   │  3. write updated_cv to a temp JSON, CVRewriter(...).rewrite() -> temp docx
   │  4. move temp docx over Md_Rawfur_Monzur_Jim_CV_new.docx
   ▼
FastAPI returns the docx as a file download, filename contains the job title
```

## 4. Target folder structure

```
create cv optimised app/
├── .env                              DEEPSEEK_API_KEY=...          (unchanged, git-ignored)
├── .gitignore                        add: __pycache__/, *.pyc, output/, .venv/
├── requirements.txt                  NEW  all Python dependencies
├── PLAN.md                           this file
├── CLAUDE.md                         NEW  short standing notes for Claude about this project
├── Md_Rawfur_Monzur_Jim_CV.docx      master template (read-only, never modified)
├── Md_Rawfur_Monzur_Jim_CV_new.docx  output, overwritten each run
├── cv_map.json                       current CV content (unchanged)
├── profile.md                        background context (unchanged)
├── profile_experience.md             project write-ups (unchanged)
├── prompts/                          four prompt files (unchanged)
├── src/                              existing pipeline, small edits only
│   ├── job_info.py                   EDIT  accept an optional `llm` argument
│   ├── update_cv.py                  EDIT  accept an optional `llm` argument
│   └── rewrite_cv.py                 no change (already takes paths as arguments)
├── app/                              NEW  the web backend
│   ├── __init__.py
│   ├── main.py                       FastAPI app, request model, routes, serves the static frontend
│   ├── llm_factory.py                provider -> LangChain chat model
│   └── pipeline.py                   glue: runs the 3 stages, handles temp files
├── static/                           NEW  the frontend
│   ├── index.html                    the single page
│   ├── style.css                     styling
│   └── app.js                        form handling, fetch, download, error display
└── tests/                            NEW  (real DeepSeek calls, key from .env)
    ├── test_llm_factory.py           config resolution and provider selection (no network)
    ├── test_pipeline.py              full 3-stage run against DeepSeek, checks the docx
    └── test_api.py                   POST /api/generate returns a downloadable docx
```

## 5. What each new or edited file does

### `requirements.txt` (new)

Pins everything the project needs in one place so `pip install -r requirements.txt` sets up a fresh machine:

- `fastapi`, `uvicorn[standard]`, `python-multipart`
- `langchain-core`, `langchain-deepseek`, `langchain-google-genai`
- `python-docx`, `python-dotenv`
- `pytest`, `httpx` (for tests; tests hit the real DeepSeek API)

### `src/job_info.py` and `src/update_cv.py` (edit)

Today both classes build `ChatDeepSeek` inside `__init__`. The change is minimal:

```python
def __init__(self, model_name="deepseek-flash", temperature=0, api_key=None, llm=None, ...):
    if llm is not None:
        self.llm = llm                      # injected by the web app
    else:
        ...existing DeepSeek code, unchanged...
```

Running `python src/job_info.py` still behaves exactly as before. Nothing else in these files changes.

### `app/llm_factory.py` (new)

The only file that knows about provider differences.

- `ModelConfig` dataclass: `provider`, `extract_model`, `rewrite_model`, `api_key`.
- `resolve_config(provider, model, api_key) -> ModelConfig`: applies the rules from section 2.
  - `deepseek` or blank: flash + reasoner, key from argument or `.env`, error if neither.
  - `gemini`: both slots = given model or `gemini-2.5-flash`, error if no key.
  - anything else: error "unknown provider".
- `make_llm(provider, model, api_key, temperature=0)`: returns `ChatDeepSeek` or `ChatGoogleGenerativeAI`.

### `app/pipeline.py` (new)

Wires the three existing classes together for one request.

- `run_pipeline(job_description, config) -> PipelineResult(docx_path, job_title)`.
- Builds two LLMs with `make_llm` (one per slot).
- Stage 1: `ExtractJobInfo(llm=...).process(...)`.
- Stage 2: `UpdateCv(llm=...).process(...)`.
- Stage 3: writes the dict to a temp JSON file, runs `CVRewriter(json_path=temp, output_path=temp_docx).rewrite()`.
- The temp folder is created **next to the output file** (not in the system temp dir), because `os.replace` must stay on the same filesystem to be atomic and to avoid cross-device errors.
- Atomically replaces `Md_Rawfur_Monzur_Jim_CV_new.docx` with the temp docx (`os.replace`). If the file is locked (open in Word) the error surfaces as a readable message.
- Cleans up temp files in a `finally` block.
- Defines a small `PipelineError` so the API layer can turn failures into proper HTTP responses.

### `app/main.py` (new)

- Creates the FastAPI app.
- Defines the request model at the top of the file (no separate schemas file):
  `GenerateRequest` with `job_description: str` (required, non-empty), `provider: "deepseek" | "gemini" = "deepseek"`, `model: str | None`, `api_key: str | None`.
- `GET /` serves `static/index.html`; `/static/*` serves the other assets.
- `GET /api/health` returns `{"status": "ok"}` for a quick liveness check.
- `GET /api/defaults` returns the default provider and model names so the frontend can show placeholders without hard-coding them twice.
- `POST /api/generate` validates the body, calls `run_pipeline`, returns a `FileResponse` with `Content-Disposition: attachment; filename=Md_Rawfur_Monzur_Jim_CV_<Job_Title>.docx`.
- Error mapping: validation → 422, missing key / unknown provider → 400, LLM or parsing failure → 502, file locked → 409, anything else → 500. The API key is stripped from any log line.

### `static/index.html`, `static/style.css`, `static/app.js` (new)

One page with:

- A large textarea for the job description.
- A **provider** select (DeepSeek, Gemini).
- A **model** text input with a placeholder that changes with the provider.
- An **API key** password input. Helper text: "Optional for DeepSeek (uses server key). Required for Gemini."
- A **Generate CV** button that disables itself and shows a spinner while the request runs (the reasoner stage can take 1–3 minutes).
- A status area for progress text and error messages returned by the API.
- On success the JS reads the filename from the `Content-Disposition` header, creates a blob URL and triggers the download.

### `tests/` (new)

Tests that call the real DeepSeek API (key from `.env`) are marked with the `integration` pytest marker (declared in `pytest.ini`). A run costs a few cents and takes 1–3 minutes because of the reasoner stage, so they are deselected by default: run `pytest -m "not integration"` for the free offline suite and `pytest -m integration` only when a real run is wanted. Gemini is **not** tested automatically (no key available); it is tested by hand in the browser.

- `test_llm_factory.py` (no network): default resolves to flash + reasoner; Gemini with a key resolves both slots to the same model; Gemini without a key raises; unknown provider raises.
- `test_pipeline.py` (real DeepSeek): runs `run_pipeline` on a short sample job description and asserts
  - a docx is written to the output path and opens with `python-docx`,
  - the returned job title is non-empty,
  - `Md_Rawfur_Monzur_Jim_CV.docx` is byte-for-byte unchanged.
- `test_api.py` (real DeepSeek via FastAPI `TestClient`): posts a job description to `/api/generate` and asserts
  - status 200,
  - `Content-Type` is the docx MIME type,
  - `Content-Disposition` contains `attachment` and a filename ending in `.docx`,
  - the body is a valid docx.
  Also asserts that provider `gemini` with no key returns 400 (no network needed).

### `CLAUDE.md` (new, short)

Standing notes for future Claude sessions: what the project is, how to run it, how to run tests, where prompts live, and the rule "never modify the master docx".

## 6. Step-by-step build order

Status: all six steps complete (see git log).

Each step ends in something runnable, so problems show up early.

### Step 1 – Dependency injection in the existing classes
- Add the optional `llm` argument to `ExtractJobInfo` and `UpdateCv`.
- Check: `python src/job_info.py` still works unchanged.

### Step 2 – Model factory
- Write `app/llm_factory.py` with `ModelConfig`, `resolve_config`, `make_llm`.
- Write `tests/test_llm_factory.py`.
- Check: `pytest tests/test_llm_factory.py` passes.

### Step 3 – Pipeline glue
- Write `app/pipeline.py` with temp-file handling and atomic replace.
- Write `tests/test_pipeline.py` that runs the real pipeline against DeepSeek.
- Check: `pytest tests/test_pipeline.py` produces a docx that opens; `Md_Rawfur_Monzur_Jim_CV.docx` is byte-for-byte unchanged.

### Step 4 – FastAPI backend
- Write `app/main.py` (request model + routes in one file).
- Write `tests/test_api.py` that posts to `/api/generate` and checks the download headers and docx body.
- Check: `pytest tests/test_api.py` passes; `uvicorn app.main:app --reload` then `curl /api/health` works.

### Step 5 – Frontend
- Write `static/index.html`, `style.css`, `app.js`.
- Check (manual, in the browser): open `http://localhost:8000`, paste a job description, click Generate, the docx downloads and opens in Word. Select Gemini with no key and confirm the error shows on the page. Gemini with a real key is a manual test too.

### Step 6 – Housekeeping
- `requirements.txt`, `.gitignore` additions, `CLAUDE.md`.
- Run the full test suite once more.
- Commit in small steps (one per step above) on the `app_claude` branch.

## 7. Error cases handled

| Situation | What the user sees |
|---|---|
| Empty job description | "Job description is required" (422) |
| Gemini chosen, no API key | "An API key is required for Gemini" (400) |
| DeepSeek chosen, no key in form and none in `.env` | "No DeepSeek API key available" (400) |
| Wrong or expired API key | Provider's authentication error, shortened (502) |
| Model returned text that is not JSON | "The model did not return valid JSON, try again or a different model" (502) |
| Output docx open in Word | "Close Md_Rawfur_Monzur_Jim_CV_new.docx and try again" (409) |

## 8. Out of scope for v1

- Background jobs / progress polling.
- Uploading a different CV template.
- User accounts or saving API keys.
- Multiple output files or history of generated CVs.
- Deployment beyond `uvicorn` on localhost.

## 9. How to run (after the build)

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
# open http://localhost:8000
pytest -m "not integration"      # offline tests
pytest -m integration            # real DeepSeek run, costs money
```
