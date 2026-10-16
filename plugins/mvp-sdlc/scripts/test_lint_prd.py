#!/usr/bin/env python3
"""Black-box tests for scripts/lint-prd.py. Run: python3 scripts/test_lint_prd.py"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
SCRIPT = PLUGIN / "scripts" / "lint-prd.py"
FIXTURES = PLUGIN / "tests" / "fixtures"
DIRTY = FIXTURES / "prd-with-tech-tokens.md"
CLEAN = FIXTURES / "prd-clean.md"


def lint(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT)] + [str(a) for a in args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )


def line_of(path, needle):
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if needle in line and not line.startswith("<!--"):
            return number
    raise AssertionError("{!r} not in {}".format(needle, path))


class LintPrdTest(unittest.TestCase):
    def test_dirty_prd_reports_each_finding(self):
        result = lint(DIRTY)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        findings = set(result.stdout.splitlines())
        expected = {
            (line_of(DIRTY, "POST /api/v1/orders"), "API path"),
            (line_of(DIRTY, "POST /api/v1/orders"), "HTTP verb + path"),
            (line_of(DIRTY, "status 201"), "HTTP code"),
            (line_of(DIRTY, "code is 404"), "HTTP code"),
            (line_of(DIRTY, "runs SELECT"), "SQL keyword"),
            (line_of(DIRTY, "WHERE the owner"), "SQL keyword"),
            (line_of(DIRTY, "`orders` table"), "table name"),
        }
        for number, reason in expected:
            prefix = "{}:{}: {}".format(DIRTY, number, reason)
            self.assertTrue(any(f.startswith(prefix) for f in findings), "{} missing in:\n{}".format(prefix, result.stdout))
        self.assertEqual(len(findings), len(expected), result.stdout)

    def test_comments_fences_and_other_sections_are_ignored(self):
        reported = {int(line.split(":")[1]) for line in lint(DIRTY).stdout.splitlines()}
        text = DIRTY.read_text(encoding="utf-8").splitlines()
        for needle in ("<!-- Skill instruction", "UPDATE inside", "Latency of GET"):
            number = next(i for i, line in enumerate(text, 1) if needle in line)
            self.assertNotIn(number, reported, needle)

    def test_clean_prd_passes(self):
        result = lint(CLEAN)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), "lint-prd: OK")

    def test_sections_before_acceptance_criteria_are_ignored(self):
        clean = CLEAN.read_text(encoding="utf-8")
        before = "## 4. User stories\n\nThe API answers status 404 for POST /api/v1/orders and runs SELECT.\n\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "PRD.md"
            heading = "## 5. Acceptance criteria"
            path.write_text(clean.replace(heading, before + heading, 1), encoding="utf-8")
            result = lint(path)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_prd_without_acceptance_criteria_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "PRD.md"
            path.write_text("# PRD\n\n## 4. User stories\n\nText.\n", encoding="utf-8")
            result = lint(path)
        self.assertEqual(result.returncode, 1)
        self.assertIn("no §5 Acceptance criteria", result.stdout + result.stderr)

    def test_unusable_input_exits_2(self):
        self.assertEqual(lint(FIXTURES / "no-such-prd.md").returncode, 2)
        self.assertEqual(lint().returncode, 2)


if __name__ == "__main__":
    unittest.main()
