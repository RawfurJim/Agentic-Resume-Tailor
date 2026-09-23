"""indeed_grab.py parsing, against small fixtures of each Indeed page generation - and
against any real pages saved in indeed_scrapper/debug/ (a fetch that failed twice)."""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import indeed_grab as ig  # noqa: E402

JK = "068f1a85882a8031"
LONG = "<p>" + "We build forms. " * 20 + "</p>"


def page_2026(desc=LONG, title="Staff AI Engineer - EU", company="Typeform", location="Remote"):
    """The layout from Sep 2026: _rootProps JSON, _initialData is a JS object literal, new description class."""
    root = {"url": "x", "preloadedVJData": {"jobInfoHeaderModel": {"jobTitle": title, "companyName": company, "formattedLocation": location},
                                             "sanitizedJobDescription": desc}}
    return f"""<html><head><title>{title} - Indeed.com</title>
<script type="application/ld+json">{json.dumps({"@type": "JobPosting", "title": title, "description": desc,
    "hiringOrganization": {"@type": "Organization", "name": company}, "jobLocationType": "TELECOMMUTE"})}</script>
<script>window._rootProps = {json.dumps(root)};</script>
<script>window._initialData = {{ ssr: true, viewJobClientSideModel: window._rootProps.preloadedVJData }};</script>
</head><body><h4>Full job description</h4><div class="react-native-html-content simple-job-description-html"><style>.x{{}}</style>{desc}</div></body></html>"""


def page_2025(desc=LONG):
    """The older layout: _initialData JSON and #jobDescriptionText."""
    data = {"jobInfoHeaderModel": {"jobTitle": "AI Engineer", "companyName": "Acme"}, "sanitizedJobDescription": desc}
    return f"<html><head><script>window._initialData = {json.dumps(data)};</script></head><body><div id='jobDescriptionText'>{desc}</div></body></html>"


class ParseJob(unittest.TestCase):
    def test_2026_layout_from_rootprops(self):
        job = ig.parse_job(page_2026(), JK)
        self.assertEqual(job["title"], "Staff AI Engineer - EU")
        self.assertEqual(job["company"], "Typeform")
        self.assertEqual(job["location"], "Remote")
        self.assertIn("We build forms.", job["description"])
        self.assertNotIn(".x{", job["description"])
        self.assertTrue(ig.looks_ok(job))

    def test_2026_layout_falls_back_to_ld_json_then_markup(self):
        html = page_2026().replace("window._rootProps", "window._somethingElse")
        job = ig.parse_job(html, JK)
        self.assertEqual(job["company"], "Typeform")
        self.assertEqual(job["location"], "Remote")
        self.assertIn("We build forms.", job["description"])
        html = html.replace('type="application/ld+json"', 'type="text/plain"')
        job = ig.parse_job(html, JK)
        self.assertIn("We build forms.", job["description"], "markup fallback via .simple-job-description-html")

    def test_2025_layout_still_works(self):
        job = ig.parse_job(page_2025(), JK)
        self.assertEqual(job["title"], "AI Engineer")
        self.assertEqual(job["company"], "Acme")
        self.assertIn("We build forms.", job["description"])

    def test_embedded_job_data_prefers_rootprops_and_survives_js_literal(self):
        self.assertIn("preloadedVJData", ig.embedded_job_data(page_2026()))
        self.assertEqual(ig.embedded_job_data("<html>window._initialData = { ssr: true }</html>"), {})

    def test_build_description_header_has_location(self):
        text = ig.build_description("https://uk.indeed.com/viewjob?jk=" + JK, {"title": "T", "company": "C", "location": "London", "description": "body"}, "2026-09-22")
        self.assertTrue(text.startswith("Title: T\nCompany: C\nLocation: London\nDate: 2026-09-22\nLink: "), text)
        text = ig.build_description("l", {"title": "T", "company": "C", "location": None, "description": "body"}, "2026-09-22")
        self.assertNotIn("Location:", text)


class FailureReason(unittest.TestCase):
    def test_reasons_carry_the_page_title(self):
        self.assertIn("bot-check", ig.failure_reason("<title>Just a moment...</title>" + "x" * 3000))
        r = ig.failure_reason("<title>Staff AI Engineer - Indeed.com</title>" + "x" * 3000, "https://uk.indeed.com/viewjob?jk=1")
        self.assertIn("no job description found", r)
        self.assertIn("Staff AI Engineer", r)
        self.assertIn("almost empty", ig.failure_reason("<html></html>"))


class JobKey(unittest.TestCase):
    def test_key_and_clean_url(self):
        self.assertEqual(ig.job_key("https://uk.indeed.com/jobs?q=x&vjk=" + JK), (JK, f"https://uk.indeed.com/viewjob?jk={JK}"))
        self.assertEqual(ig.job_key("https://indeed.com/viewjob?jk=" + JK)[1], f"https://www.indeed.com/viewjob?jk={JK}")
        self.assertIsNone(ig.job_key("https://www.linkedin.com/jobs/view/1"))


class RealSavedPages(unittest.TestCase):
    """Every page in debug/ is a real failure; the parser must now read all of them."""

    def test_debug_pages_parse(self):
        pages = sorted((HERE.parent / "debug").glob("*.html"))
        if not pages:
            self.skipTest("no saved pages in indeed_scrapper/debug/")
        for page in pages:
            with self.subTest(page=page.name):
                job = ig.parse_job(page.read_text(encoding="utf-8"), page.stem)
                self.assertTrue(ig.looks_ok(job), f"{page.name}: {job['title']!r} / {len(job['description'])} chars")
                self.assertTrue(job["company"], page.name)


if __name__ == "__main__":
    unittest.main()


# ── Layout-proofing (2026-09-22): a last resort that ignores ids/classes, and a
#    diagnosis that says "layout changed" instead of a generic failure. ──────────

def strip_known_anchors(html):
    """A saved page with every anchor the parser knows about removed - what a future redesign looks like."""
    html = html.replace("window._rootProps", "window._x1").replace("window._initialData", "window._x2")
    html = html.replace('type="application/ld+json"', 'type="text/x-gone"')
    html = html.replace("simple-job-description-html", "zz-new-class").replace("jobDescriptionText", "zz-new-id")
    html = html.replace("vj-job-description-heading", "zz-new-testid")
    return html


UNKNOWN_LAYOUT = """<html><head><title>Staff AI Engineer - EU - Remote - Indeed.com</title>
<script>window._whatever = { a: 1 };</script><style>.q{color:red}</style></head>
<body><nav>Find jobs Company reviews Salary guide</nav>
<div class="zz1"><span>Staff AI Engineer - EU</span><span>Typeform</span><span>Remote</span></div>
<div class="zz2"><h4>Full job description</h4>
<div class="zz3"><p>Who we are</p><p>Typeform is a refreshingly different form builder. We help many businesses collect data.</p>
<ul><li>Build LLM features</li><li>Own evaluation</li></ul><p>Apply with your CV.</p></div></div>
<div class="zz4">Report job</div><footer>Hiring Lab · Career advice · Browse jobs · © 2026 Indeed</footer></body></html>"""


class VisibleTextFallback(unittest.TestCase):
    def test_unknown_layout_still_yields_the_job(self):
        job = ig.parse_job(UNKNOWN_LAYOUT, JK)
        self.assertEqual(job["title"], "Staff AI Engineer - EU - Remote", "from <title>, Indeed suffix removed")
        d = job["description"]
        self.assertTrue(d.startswith("Who we are"), d[:80])
        self.assertIn("Build LLM features", d)
        self.assertIn("Apply with your CV.", d)
        self.assertNotIn("Report job", d)
        self.assertNotIn("Hiring Lab", d)
        self.assertNotIn("Find jobs", d)
        self.assertNotIn(".q{", d)
        self.assertTrue(ig.looks_ok(job))

    def test_no_heading_means_no_guess(self):
        html = UNKNOWN_LAYOUT.replace("Full job description", "Something else")
        self.assertEqual(ig.visible_description(html), "")
        self.assertFalse(ig.looks_ok(ig.parse_job(html, JK)))

    def test_heading_variants(self):
        for heading in ("Full Job Description", "Job description", "Full job description:"):
            with self.subTest(heading=heading):
                self.assertIn("Build LLM features", ig.visible_description(UNKNOWN_LAYOUT.replace("Full job description", heading)))

    def test_real_saved_pages_with_every_known_anchor_removed(self):
        pages = sorted((HERE.parent / "debug").glob("*.html"))
        if not pages:
            self.skipTest("no saved pages in indeed_scrapper/debug/")
        for page in pages:
            with self.subTest(page=page.name):
                job = ig.parse_job(strip_known_anchors(page.read_text(encoding="utf-8")), page.stem)
                self.assertTrue(ig.looks_ok(job), f"{page.name}: {job['title']!r} / {len(job['description'])} chars")
                self.assertGreater(len(job["description"]), 1000, page.name)
                self.assertNotIn("Report job", job["description"])


class DiagnoseFailures(unittest.TestCase):
    def test_all_no_description_on_job_pages_means_layout_changed(self):
        reasons = ["page loaded but no job description found (page title: 'Staff AI Engineer - Indeed.com', url: u)",
                   "page loaded but no job description found (page title: 'AI Research Scientist - Indeed.com', url: u)"]
        msg = ig.diagnose_failures(reasons, ok=0)
        self.assertIsNotNone(msg)
        self.assertIn("layout", msg.lower())
        self.assertIn("debug/", msg)

    def test_other_failure_mixes_are_not_called_a_layout_change(self):
        self.assertIsNone(ig.diagnose_failures([], ok=0))
        self.assertIsNone(ig.diagnose_failures(["job has expired (page title: 'x')"], ok=0))
        self.assertIsNone(ig.diagnose_failures(["bot-check page instead of the job (page title: 'Just a moment')"], ok=0))
        self.assertIsNone(ig.diagnose_failures(["page loaded but no job description found (page title: 'x')"], ok=2),
                          "some jobs parsed fine -> not a layout change")
        self.assertEqual(ig.LAYOUT_CHANGED_EXIT, 3)
