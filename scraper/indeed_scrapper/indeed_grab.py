#!/usr/bin/env python3
"""
indeed_grab.py - paste Indeed job links into links.txt, get the job descriptions in jobs.csv.

    pip install -r requirements.txt
    playwright install chromium      # one-off, downloads the browser
    python indeed_grab.py            # reads links.txt, writes jobs.csv
    python indeed_grab.py other.txt  # use a different links file

Indeed blocks plain HTTP requests, so every job is fetched through a real Chrome window.
Cookies live in browser_profile/ between runs, so the bot-check usually only shows up once.
If a job still does not appear, the script pauses and asks you to sort the Chrome window out
(click the box, reload, log in) and press Enter; a job that fails twice is saved to debug/
as .html + .png so the failure can be looked at.

Columns: link (exactly as you pasted it), title, company, description, date.
The description cell repeats the title, company, location, date and link at the top, so
every row carries its own context.

Each run also writes new_jobs_<date>_<time>.csv holding only that run's jobs - a fresh
sheet to process. Waits about a minute between jobs. Re-running skips jobs already saved.
"""

import csv
import json
import os
import random
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit("missing packages - run:  pip install -r requirements.txt")

try:
    import lxml  # noqa: F401
    PARSER = "lxml"
except ImportError:
    PARSER = "html.parser"

# Everything lives next to this script, wherever it is run from (the Node
# orchestrator run-all.mjs starts it from the scraper root).
HERE = Path(__file__).resolve().parent
LINKS_FILE = str(HERE / "links.txt")
OUT_FILE = str(HERE / "jobs.csv")
PROFILE_DIR = str(HERE / "browser_profile")
DEBUG_DIR = HERE / "debug"       # the page + a screenshot of every failed fetch, so a failure can be explained

# Any of these means the job is on screen. Indeed renames things now and then, so
# several spellings are accepted; the embedded JSON is checked as well (see fetch()).
JOB_READY_SELECTORS = ", ".join([
    "#jobDescriptionText",                                   # layout until Sep 2026
    ".simple-job-description-html",                          # layout from Sep 2026 (React Native web)
    "[data-testid='vj-job-description-heading']",
    "[data-testid='jobsearch-JobComponent-description']",
    ".jobsearch-JobComponent-description",
    "[data-testid='jobsearch-JobInfoHeader-title']",
    "h1.jobsearch-JobInfoHeader-title",
])
# Cloudflare / Indeed bot-check pages, lower-cased fragments of their text or markup.
BLOCK_MARKERS = ("just a moment", "verification required", "verify you are human", "access denied",
                 "additional verification", "security check", "are you a human", "unusual traffic",
                 "cf-chl", "challenge-platform", "cf_chl", "captcha", "blocked")
WAIT_SECONDS = (45, 75)          # random pause between jobs, in seconds
COLUMNS = ["link", "title", "company", "description", "date"]


# ---------------------------------------------------------------- links ----

def read_links(path):
    """Every http(s) URL in the file, in order, without duplicates. Numbering / other text is ignored."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    urls, seen = [], set()
    for url in re.findall(r"https?://[^\s'\"<>]+", text):
        url = url.rstrip(".,;:)]")
        if url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


def job_key(url):
    """(job_key, clean_job_page_url) from any Indeed link, or None if it isn't one."""
    p = urlparse(url)
    host = p.netloc.lower().split(":")[0]
    if "indeed." not in host:
        return None
    qs = parse_qs(p.query)
    jk = next((qs[k][0] for k in ("vjk", "jk") if qs.get(k)), None)
    if not jk or not re.fullmatch(r"\w{8,32}", jk):
        return None
    if host.count(".") < 2:                 # bare indeed.com -> www.indeed.com; uk.indeed.com stays
        host = "www.indeed.com"
    return jk, f"https://{host}/viewjob?jk={jk}"


# -------------------------------------------------------------- parsing ----

def walk(obj):
    """Every dict inside a nested JSON structure."""
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            yield cur
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)


def find(obj, key, types=(str,)):
    """First non-empty value for `key` anywhere in obj."""
    for d in walk(obj):
        v = d.get(key)
        if isinstance(v, types) and v:
            return v
    return None


def json_after(html, pattern):
    """The JSON object that follows e.g. `window._initialData =` in the page's scripts."""
    m = re.search(pattern, html)
    if not m:
        return None
    start = html.find("{", m.end())
    if start < 0:
        return None
    try:
        return json.JSONDecoder().raw_decode(html, start)[0]
    except ValueError:
        return None


def html_to_text(fragment):
    """HTML -> plain text, keeping paragraph and list breaks."""
    if not fragment:
        return ""
    soup = BeautifulSoup(str(fragment), PARSER)
    for junk in soup.find_all(["style", "script"]):
        junk.decompose()
    for br in soup.find_all("br"):
        br.replace_with("\n")
    lines = [re.sub(r"[ \t\xa0]+", " ", ln).strip() for ln in soup.get_text("\n").splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def embedded_job_data(html):
    """The JSON blob Indeed embeds in the page, whichever generation of the page this is.

    Until Sep 2026 it was `window._initialData = {...}` (pure JSON). The page then moved
    to `window._rootProps = {..., "preloadedVJData": {...}}` and turned `_initialData`
    into a JavaScript object literal that no JSON parser accepts - so `_rootProps` is
    tried first and `_initialData` kept for older pages.
    """
    for pattern in (r"window\._rootProps\s*=\s*", r"window\._initialData\s*=\s*"):
        data = json_after(html, pattern)
        if isinstance(data, dict) and data:
            return data
    return {}


def job_posting_ld(html):
    """The schema.org JobPosting block (`<script type="application/ld+json">`), if the page has one."""
    for m in re.finditer(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", html, re.I | re.S):
        try:
            data = json.loads(m.group(1))
        except ValueError:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if isinstance(item, dict) and item.get("@type") == "JobPosting":
                return item
    return {}


DESCRIPTION_SELECTORS = ", ".join([
    "#jobDescriptionText",
    ".simple-job-description-html",
    "[data-testid='vj-job-description-heading'] ~ div",
])
TITLE_SELECTORS = "h1.jobsearch-JobInfoHeader-title, [data-testid='jobsearch-JobInfoHeader-title'], [data-testid='vj-title'], h1"
COMPANY_SELECTORS = "[data-testid='inlineHeader-companyName'], [data-company-name], [data-testid='vj-company-name'], a[href*='/cmp/']"


# Last resort, independent of ids and classes: the visible text between the
# "Full job description" heading and Indeed's page footer.
HEADING_RE = re.compile(r"^\s*(full\s+)?job\s+description\s*:?\s*$", re.I)
FOOTER_RE = re.compile(r"^\s*(report job|hiring lab|career advice|browse jobs|browse companies|indeed events|"
                       r"work at indeed|anti-slavery statement|accessibility at indeed|©\s*20\d\d indeed)\s*$", re.I)


def visible_description(html):
    """The job text as a reader sees it: after the "Full job description" heading, before the footer.

    Knows nothing about Indeed's markup, so it survives a redesign as long as the
    heading text does. Returns '' when the heading is not on the page - a guess
    would be worse than a clear failure.
    """
    soup = BeautifulSoup(html or "", PARSER)
    for junk in soup.find_all(["script", "style", "noscript", "nav", "header", "footer", "svg", "iframe"]):
        junk.decompose()
    lines = html_to_text(soup.body or soup).split("\n")
    start = next((i for i, line in enumerate(lines) if HEADING_RE.match(line)), None)
    if start is None:
        return ""
    out = []
    for line in lines[start + 1:]:
        if FOOTER_RE.match(line):
            break
        out.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def title_from_tag(html):
    """`<title>Staff AI Engineer - EU - Remote - Indeed.com</title>` -> 'Staff AI Engineer - EU - Remote'."""
    t = page_title(html)
    t = re.sub(r"\s*[-|]\s*indeed(\.com|\.co\.uk)?\s*$", "", t, flags=re.I)
    return t.strip()


LAYOUT_CHANGED_EXIT = 3


def diagnose_failures(reasons, ok):
    """One sentence explaining a run where nothing worked, when the pattern is unmistakable."""
    if ok or not reasons:
        return None
    if all("no job description found" in r for r in reasons):
        return ("every job page loaded but none had a description the script recognises - Indeed has probably "
                "changed its page layout. The pages are saved in debug/ (.html + .png): send them and the parser "
                "can be updated in minutes.")
    return None


def parse_job(html, jk):
    """Title, company, location and description from an Indeed job page.

    Order of trust: the JSON Indeed embeds (most complete), then the schema.org
    JobPosting block, then the visible HTML by known ids/classes, and finally the
    visible text under the "Full job description" heading.
    """
    soup = BeautifulSoup(html, PARSER)
    data = embedded_job_data(html)
    header = find(data, "jobInfoHeaderModel", (dict,)) or {}
    node = (next((d for d in walk(data) if d.get("key") == jk and "title" in d), None)
            or next((d for d in walk(data) if "title" in d and "description" in d and "employer" in d), {}))
    posting = job_posting_ld(html)

    title = header.get("jobTitle") or node.get("title") or posting.get("title")
    if not title:
        el = soup.select_one(TITLE_SELECTORS)
        title = el.get_text(" ", strip=True) if el else ""
    if not title:
        title = title_from_tag(html)
    title = re.sub(r"\s*-\s*job post\s*$", "", str(title), flags=re.I).strip() or None

    employer = node.get("employer") if isinstance(node.get("employer"), dict) else {}
    org = posting.get("hiringOrganization") if isinstance(posting.get("hiringOrganization"), dict) else {}
    company = header.get("companyName") or employer.get("name") or org.get("name")
    if not company:
        el = soup.select_one(COMPANY_SELECTORS)
        company = el.get_text(" ", strip=True) if el else None

    location = header.get("formattedLocation") or header.get("location")
    if not location:
        loc = posting.get("jobLocation")
        loc = loc[0] if isinstance(loc, list) and loc else loc
        addr = loc.get("address") if isinstance(loc, dict) else None
        if isinstance(addr, dict):
            location = ", ".join(str(addr[k]) for k in ("addressLocality", "addressRegion", "addressCountry") if addr.get(k))
        if not location and posting.get("jobLocationType") == "TELECOMMUTE":
            location = "Remote"

    desc = find(data, "sanitizedJobDescription", (str, dict))
    if isinstance(desc, dict):
        desc = desc.get("content") or desc.get("html")
    if not desc:
        d = node.get("description")
        desc = (d.get("html") or d.get("text")) if isinstance(d, dict) else d
    if not desc:
        desc = posting.get("description")
    if not desc:
        el = soup.select_one(DESCRIPTION_SELECTORS)
        desc = str(el) if el else None
    if desc:
        text = html_to_text(desc)
    else:
        text = visible_description(html)

    return {"title": title, "company": company, "location": (str(location).strip() or None) if location else None,
            "description": text}


def looks_ok(job):
    return bool(job.get("title")) and len(job.get("description") or "") > 80


def page_title(html):
    m = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.I | re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def failure_reason(html, url=""):
    """Why a page we managed to load still didn't give us the job - with what the page was."""
    head = (html or "")[:8000].lower()
    title = page_title(html)
    where = f" (page title: {title!r}" + (f", url: {url}" if url else "") + ")"
    if any(m in head for m in BLOCK_MARKERS):
        return "bot-check page instead of the job" + where
    if re.search(r"job has expired|no longer available|this job is no longer", html or "", re.I):
        return "job has expired" + where
    if len(html or "") < 2000:
        return "page came back almost empty" + where
    return "page loaded but no job description found" + where


def save_debug(jk, html, page=None):
    """Keep the failed page (and a screenshot) so the failure can be looked at afterwards."""
    try:
        DEBUG_DIR.mkdir(exist_ok=True)
        (DEBUG_DIR / f"{jk}.html").write_text(html or "", encoding="utf-8")
        if page is not None:
            try:
                page.screenshot(path=str(DEBUG_DIR / f"{jk}.png"), full_page=False)
            except Exception:
                pass
        print(f"   saved the page for a look: debug/{jk}.html (+ .png)")
    except Exception as e:
        print(f"   could not save debug page: {e.__class__.__name__}")


# -------------------------------------------------------------- browser ----

class Browser:
    """A real, visible Chrome window (Playwright). Cookies are kept in browser_profile/ between runs."""

    def __init__(self):
        from playwright.sync_api import sync_playwright          # ImportError if not installed
        self.pw = sync_playwright().start()
        opts = dict(user_data_dir=PROFILE_DIR, headless=False, no_viewport=True,
                    args=["--disable-blink-features=AutomationControlled"])
        try:
            self.ctx = self.pw.chromium.launch_persistent_context(channel="chrome", **opts)
        except Exception:                                        # no Google Chrome -> bundled Chromium
            self.ctx = self.pw.chromium.launch_persistent_context(**opts)
        self.page = self.ctx.pages[0] if self.ctx.pages else self.ctx.new_page()

    def job_visible(self):
        """Is the job on screen - by markup, or by the JSON Indeed embeds in the page?"""
        try:
            if self.page.query_selector(JOB_READY_SELECTORS):
                return True
            html = self.page.content()
            return "_initialData" in html and ("jobInfoHeaderModel" in html or "sanitizedJobDescription" in html)
        except Exception:
            return False                                         # page mid-navigation, try again

    def wait_for_job(self, timeout, hint=True):
        end, told = time.time() + timeout, False
        while time.time() < end:
            if self.job_visible():
                time.sleep(1.5)
                return True
            if hint and not told:
                print("   if Chrome shows a 'verify you are human' box, click it - the script carries on by itself")
                told = True
            time.sleep(2)
        return False

    def fetch(self, url, timeout=120):
        self.page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        if self.wait_for_job(timeout):
            return self.page.content()
        # The automatic wait ran out. Rather than give up, hand the window to the
        # human: they can click the box, reload, or log in, then tell us to carry on.
        if sys.stdin.isatty():
            print(f"   the job did not appear within {timeout}s. Current page: {page_title(self.page.content())!r}")
            print("   In the Chrome window: click the 'verify you are human' box or reload the page until the job")
            print("   text is visible, then press Enter here (or type s + Enter to skip this job).")
            try:
                answer = input("   > ").strip().lower()
            except EOFError:
                answer = "s"
            if not answer.startswith("s"):
                self.wait_for_job(30, hint=False)
        return self.page.content()

    def close(self):
        try:
            self.ctx.close()
        finally:
            self.pw.stop()


def open_browser():
    """The Chrome window, or stop - there is no other way to reach Indeed."""
    try:
        return Browser()
    except ImportError:
        sys.exit("this needs Playwright - run:  pip install -r requirements.txt"
                 "  then  playwright install chromium")
    except Exception as e:
        sys.exit(f"could not start Chrome: {e.__class__.__name__}: {e}")


# --------------------------------------------------------------- output ----

def build_description(link, job, date):
    """The description cell: a header of everything we extracted, then the job text.

    Repeating the title/company/link inside the cell means a single row is enough
    context on its own, without the neighbouring columns.
    """
    fields = [("Title", job.get("title")), ("Company", job.get("company")),
              ("Location", job.get("location")), ("Date", date), ("Link", link)]
    header = "\n".join(f"{name}: {value}" for name, value in fields if value)
    return f"{header}\n\n---\n\n{job.get('description') or ''}"


def load_done(path):
    """Job keys already saved, so re-running only fetches what's new."""
    done = set()
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                k = job_key(row.get("link") or "")
                if k:
                    done.add(k[0])
    return done


def save(path, row):
    """Append one job, writing the header first if the file is new."""
    new = not os.path.exists(path) or os.path.getsize(path) == 0
    with open(path, "a", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        if new:
            w.writeheader()
        w.writerow({k: row.get(k) or "" for k in COLUMNS})


# ----------------------------------------------------------------- main ----

def collect_todo(links_file, done):
    """The jobs worth fetching: Indeed links, no duplicates, nothing already saved."""
    seen, todo = set(), []
    for link in read_links(links_file):
        key = job_key(link)
        if not key:
            print(f"skip - not an Indeed job link: {link}")
            continue
        jk, page = key
        if jk in seen:
            continue
        seen.add(jk)
        if jk in done:
            print(f"skip - already in {os.path.basename(OUT_FILE)}: {jk}")
            continue
        todo.append((link, jk, page))
    return todo


def fetch_job(browser, page, jk):
    """(job, None) once the page gives us a real job, or (None, reason) after two tries."""
    reason, html = None, ""
    for attempt in (1, 2):
        try:
            html = browser.fetch(page)
        except Exception as e:
            reason = f"browser error: {e.__class__.__name__}: {str(e)[:120]}"
        else:
            job = parse_job(html, jk)
            if looks_ok(job):
                return job, None
            reason = failure_reason(html, browser.page.url)
        if attempt == 1:
            print(f"   {reason} - trying once more")
    save_debug(jk, html, browser.page)
    return None, reason


def main():
    links_file = sys.argv[1] if len(sys.argv) > 1 else LINKS_FILE
    if not os.path.exists(links_file):
        sys.exit(f"{links_file} not found - paste your Indeed job links into it and run again")

    todo = collect_todo(links_file, load_done(OUT_FILE))
    if not todo:
        print("nothing new to fetch")
        return
    print(f"{len(todo)} job(s) to fetch\n")

    today = datetime.now().strftime("%Y-%m-%d")
    run_file = str(HERE / datetime.now().strftime("new_jobs_%Y-%m-%d_%H%M.csv"))
    browser = open_browser()
    ok = failed = 0
    reasons = []

    try:
        for i, (link, jk, page) in enumerate(todo, 1):
            print(f"[{i}/{len(todo)}] {page}")
            job, reason = fetch_job(browser, page, jk)

            if job:
                row = {"link": link, "title": job["title"], "company": job["company"],
                       "description": build_description(link, job, today), "date": today}
                save(OUT_FILE, row)          # the growing master list
                save(run_file, row)          # just this run, ready to process
                ok += 1
                print(f"   OK  {job['title']} | {job['company']} | {len(job['description'])} chars")
            else:
                failed += 1
                reasons.append(reason or "")
                print(f"   FAILED - {reason}")

            if i < len(todo):
                wait = random.uniform(*WAIT_SECONDS)
                print(f"   waiting {wait:.0f}s ...")
                time.sleep(wait)
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        browser.close()

    print(f"\ndone: {ok} saved to {os.path.basename(OUT_FILE)}, {failed} failed")
    if ok:
        print(f"this run's {ok} new job(s): {run_file}")
    verdict = diagnose_failures(reasons, ok)
    if verdict:
        print(f"\n!! {verdict}")
        sys.exit(LAYOUT_CHANGED_EXIT)


if __name__ == "__main__":
    main()
