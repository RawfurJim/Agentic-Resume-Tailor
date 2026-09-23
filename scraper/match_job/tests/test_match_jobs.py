"""match_jobs.py: add ONE CV-match column (`Match status`: top / medium / low) to a
new-jobs csv. Round 7 (Jim, 2026-09-23): the two "matching / not matching experience"
columns are gone — he only wants the verdict. Every test uses a fake LLM — the real
DeepSeek API is never called from here (Jim: it costs money)."""
import csv
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import match_jobs as mj  # noqa: E402

HEADER = ["Company", "Title", "Location", "URL", "Source", "Posted", "First seen", "Description"]
VERDICT = '{"status": "top match"}'
# What the old prompt produced; the parser must still accept it (extra keys ignored) but never store them.
OLD_VERDICT = '{"status": "top match", "matching_experience": "Python, LLMs", "not_matching_experience": "None"}'


def make_row(company="Acme", title="AI Engineer", description="Build LLM apps.", **extra):
    row = dict(zip(HEADER, [company, title, "Leeds", f"https://x/{company}", "indeed", "2026-09-22", "2026-09-22", description]))
    row.update(extra)
    return row


class FakeLLM:
    """Records prompts; returns scripted answers, or raises when the script says so."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.prompts = []

    def __call__(self, prompt):
        self.prompts.append(prompt)
        a = self.answers.pop(0) if self.answers else VERDICT
        if isinstance(a, Exception):
            raise a
        return a


class ParseVerdict(unittest.TestCase):
    def test_bare_json(self):
        v = mj.parse_verdict(VERDICT)
        self.assertEqual(v, {"status": "top match"})

    def test_old_three_key_reply_still_parses_to_status_only(self):
        self.assertEqual(mj.parse_verdict(OLD_VERDICT), {"status": "top match"})

    def test_contract_is_one_column(self):
        self.assertEqual(mj.NEW_COLUMNS, [mj.STATUS_COL])
        self.assertEqual(mj.STATUS_COL, "Match status")
        self.assertFalse(hasattr(mj, "MATCH_COL"))
        self.assertFalse(hasattr(mj, "MISS_COL"))
        self.assertNotIn("matching_experience", mj.CV_EVALUATOR_PROMPT)
        self.assertNotIn("not_matching_experience", mj.CV_EVALUATOR_PROMPT)
        self.assertIn('"status"', mj.CV_EVALUATOR_PROMPT)
        self.assertIn("top match", mj.CV_EVALUATOR_PROMPT)

    def test_fenced_and_prose(self):
        self.assertEqual(mj.parse_verdict("```json\n" + VERDICT + "\n```")["status"], "top match")
        self.assertEqual(mj.parse_verdict("Here is my analysis:\n" + VERDICT + "\nHope this helps")["status"], "top match")

    def test_status_case_normalised(self):
        self.assertEqual(mj.parse_verdict(VERDICT.replace("top match", "Top Match"))["status"], "top match")

    def test_rejects_bad_status_missing_key_and_non_json(self):
        with self.assertRaises(ValueError):
            mj.parse_verdict(VERDICT.replace("top match", "great match"))
        with self.assertRaises(ValueError):
            mj.parse_verdict('{"verdict": "top match"}')
        with self.assertRaises(ValueError):
            mj.parse_verdict("no json here")


class Evaluate(unittest.TestCase):
    def test_blank_description_skips_the_llm(self):
        llm = FakeLLM()
        out = mj.evaluate("   ", "cv", llm)
        self.assertEqual(out, {mj.STATUS_COL: mj.NO_DESCRIPTION})
        self.assertEqual(llm.prompts, [])

    def test_retries_once_then_succeeds(self):
        llm = FakeLLM(RuntimeError("boom"), VERDICT)
        out = mj.evaluate("Build LLM apps.", "cv", llm)
        self.assertEqual(out, {mj.STATUS_COL: "top match"})
        self.assertEqual(len(llm.prompts), 2)

    def test_two_failures_become_an_error_status(self):
        llm = FakeLLM(RuntimeError("boom"), ValueError("bad json"))
        out = mj.evaluate("Build LLM apps.", "cv", llm)
        self.assertTrue(out[mj.STATUS_COL].startswith("error: ValueError"), out)
        self.assertEqual(len(llm.prompts), 2)

    def test_prompt_contains_cv_and_jd_and_survives_braces(self):
        llm = FakeLLM()
        mj.evaluate("JD with {braces} and {job_description}", "MY CV TEXT", llm)
        p = llm.prompts[0]
        self.assertIn("MY CV TEXT", p)
        self.assertIn("JD with {braces} and {job_description}", p)
        self.assertIn('"status":', p)
        self.assertNotIn("matching_experience", p)
        self.assertNotIn("{cv}", p)


class NeedsEvaluation(unittest.TestCase):
    def test_rules(self):
        self.assertTrue(mj.needs_evaluation(make_row()))
        self.assertTrue(mj.needs_evaluation(make_row(**{mj.STATUS_COL: ""})))
        self.assertTrue(mj.needs_evaluation(make_row(**{mj.STATUS_COL: "error: RuntimeError: boom"})))
        self.assertFalse(mj.needs_evaluation(make_row(**{mj.STATUS_COL: "top match"})))
        self.assertFalse(mj.needs_evaluation(make_row(**{mj.STATUS_COL: mj.NO_DESCRIPTION})))


class MatchRows(unittest.TestCase):
    def test_appends_columns_once_skips_done_retries_errors(self):
        rows = [make_row("A"), make_row("B", **{mj.STATUS_COL: "low match"}),
                make_row("C", **{mj.STATUS_COL: "error: RuntimeError: boom"}), make_row("D", description="")]
        fieldnames = list(HEADER)
        llm = FakeLLM()
        counts = mj.match_rows(rows, fieldnames, "cv", llm, log=lambda *_: None)
        self.assertEqual(fieldnames, HEADER + [mj.STATUS_COL])
        self.assertEqual(counts, {"evaluated": 2, "skipped": 1, "errors": 0, "no_description": 1})
        self.assertEqual(rows[0][mj.STATUS_COL], "top match")
        self.assertEqual(rows[1][mj.STATUS_COL], "low match")          # untouched
        self.assertEqual(rows[2][mj.STATUS_COL], "top match")          # error retried
        self.assertEqual(rows[3][mj.STATUS_COL], mj.NO_DESCRIPTION)
        self.assertEqual(len(llm.prompts), 2)
        mj.match_rows(rows, fieldnames, "cv", llm, log=lambda *_: None)
        self.assertEqual(fieldnames.count(mj.STATUS_COL), 1)

    def test_limit_caps_llm_calls(self):
        rows = [make_row("A"), make_row("B"), make_row("C")]
        llm = FakeLLM()
        counts = mj.match_rows(rows, list(HEADER), "cv", llm, log=lambda *_: None, limit=1)
        self.assertEqual(counts["evaluated"], 1)
        self.assertEqual(len(llm.prompts), 1)
        self.assertEqual(rows[1].get(mj.STATUS_COL, ""), "")

    def test_errors_counted_and_logged(self):
        rows = [make_row("A")]
        llm = FakeLLM(RuntimeError("x"), RuntimeError("y"))
        lines = []
        counts = mj.match_rows(rows, list(HEADER), "cv", llm, log=lines.append)
        self.assertEqual(counts["errors"], 1)
        self.assertTrue(any("A | AI Engineer" in ln for ln in lines), lines)


class CsvRoundTrip(unittest.TestCase):
    def test_bom_crlf_multiline_and_atomic_write(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "new-jobs.csv"
            body = "﻿" + ",".join(HEADER) + "\r\n" + 'Acme,"AI, Engineer",Leeds,https://x/1,indeed,2026-09-22,2026-09-22,"line1\r\nline2 ""quoted"""\r\n'
            p.write_bytes(body.encode("utf-8"))
            fieldnames, rows = mj.read_csv(p)
            self.assertEqual(fieldnames, HEADER)
            self.assertEqual(rows[0]["Title"], "AI, Engineer")
            self.assertEqual(rows[0]["Description"], 'line1\r\nline2 "quoted"')
            rows[0][mj.STATUS_COL] = "top match"
            mj.write_csv_atomic(p, fieldnames + [mj.STATUS_COL], rows)
            raw = p.read_bytes()
            self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "plain UTF-8 like toCsv")
            self.assertTrue(raw.startswith(b"Company,Title,Location,URL,Source,Posted,First seen,Description,Match status\r\n"), raw[:200])
            self.assertEqual(os.listdir(d), ["new-jobs.csv"], "no temp file left behind")
            again_fields, again = mj.read_csv(p)
            self.assertEqual(again[0]["Description"], 'line1\r\nline2 "quoted"')
            self.assertEqual(again[0][mj.STATUS_COL], "top match")
            self.assertEqual(again_fields, HEADER + [mj.STATUS_COL])


class LoadEnv(unittest.TestCase):
    def test_parses_and_does_not_override(self):
        with tempfile.TemporaryDirectory() as d:
            env_file = Path(d) / ".env"
            env_file.write_text("# comment\n\nMJ_TEST_A=one\nMJ_TEST_B = \"two words\"\nexport MJ_TEST_C='three'\nMJ_TEST_D=keep\nbroken line\n", encoding="utf-8")
            os.environ["MJ_TEST_D"] = "already"
            try:
                mj.load_env(env_file)
                self.assertEqual(os.environ["MJ_TEST_A"], "one")
                self.assertEqual(os.environ["MJ_TEST_B"], "two words")
                self.assertEqual(os.environ["MJ_TEST_C"], "three")
                self.assertEqual(os.environ["MJ_TEST_D"], "already")
            finally:
                for k in ("MJ_TEST_A", "MJ_TEST_B", "MJ_TEST_C", "MJ_TEST_D"):
                    os.environ.pop(k, None)
            mj.load_env(Path(d) / "missing.env")  # no error


class Main(unittest.TestCase):
    def _csv(self, d):
        p = Path(d) / "new-jobs.csv"
        with open(p, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=HEADER, lineterminator="\r\n")
            w.writeheader()
            w.writerow(make_row("A"))
            w.writerow(make_row("B", description=""))
        return p

    def _run(self, argv, env=None):
        saved = dict(os.environ)
        os.environ.pop("DEEPSEEK_API_KEY", None)
        os.environ.update(env or {})
        out = io.StringIO()
        try:
            code = mj.main(argv, stdout=out, env_file=Path("/nonexistent/.env"))
        finally:
            os.environ.clear()
            os.environ.update(saved)
        return code, out.getvalue()

    def test_dry_run_needs_no_key_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._csv(d)
            before = p.read_bytes()
            cvp = Path(d) / "cv.txt"
            cvp.write_text("my cv", encoding="utf-8")
            code, out = self._run([str(p), "--dry-run", "--cv", str(cvp)])
            self.assertEqual(code, 0, out)
            self.assertIn("would evaluate 1", out)
            self.assertEqual(p.read_bytes(), before)

    def test_missing_key_exits_2_and_leaves_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._csv(d)
            cvp = Path(d) / "cv.txt"
            cvp.write_text("my cv", encoding="utf-8")
            before = p.read_bytes()
            code, out = self._run([str(p), "--cv", str(cvp)])
            self.assertEqual(code, 2)
            self.assertIn("DEEPSEEK_API_KEY", out)
            self.assertEqual(p.read_bytes(), before)

    def test_missing_csv_or_cv_exits_2(self):
        with tempfile.TemporaryDirectory() as d:
            code, out = self._run([str(Path(d) / "nope.csv"), "--dry-run"])
            self.assertEqual(code, 2)
            p = self._csv(d)
            code, out = self._run([str(p), "--dry-run", "--cv", str(Path(d) / "nope.txt")])
            self.assertEqual(code, 2)

    def test_limit_is_parsed_and_fake_llm_injectable(self):
        with tempfile.TemporaryDirectory() as d:
            p = self._csv(d)
            cvp = Path(d) / "cv.txt"
            cvp.write_text("my cv", encoding="utf-8")
            llm = FakeLLM()
            code = mj.main([str(p), "--cv", str(cvp), "--limit", "1"], stdout=io.StringIO(), llm=llm, env_file=Path("/nonexistent/.env"))
            self.assertEqual(code, 0)
            self.assertEqual(len(llm.prompts), 1)
            _, rows = mj.read_csv(p)
            self.assertEqual(rows[0][mj.STATUS_COL], "top match")
            self.assertEqual(rows[1][mj.STATUS_COL], mj.NO_DESCRIPTION)


if __name__ == "__main__":
    unittest.main()
