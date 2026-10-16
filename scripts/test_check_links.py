#!/usr/bin/env python3
"""Black-box tests for scripts/check_links.py. Run: python3 scripts/test_check_links.py"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CHECKER = REPO / "scripts" / "check_links.py"


def check(*paths, cwd):
    return subprocess.run(
        [sys.executable, str(CHECKER)] + [str(p) for p in paths],
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )


class CheckLinksTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.write("docs/target.md", "# Target\n\n## Same name\n\n## Same name\n\n## 3. One feature, by size (XS, S, M+)\n")

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def assertFails(self, result, *needles):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stdout)

    def test_valid_links_and_anchors_pass(self):
        self.write(
            "docs/a.md",
            "# A\n\nSee [t](target.md), [s](target.md#same-name), [s1](target.md#same-name-1),\n"
            "[size](target.md#3-one-feature-by-size-xs-s-m) and [self](#a).\n",
        )
        result = check("docs/a.md", "docs/target.md", cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("links OK (2 files)", result.stdout)

    def test_missing_file_fails(self):
        self.write("docs/a.md", "# A\n\nline two [x](nope.md)\n")
        self.assertFails(check("docs/a.md", cwd=self.root), "docs/a.md:3:", "broken link nope.md")

    def test_missing_anchor_fails(self):
        self.write("docs/a.md", "# A\n[x](target.md#nope)\n")
        self.assertFails(check("docs/a.md", cwd=self.root), "docs/a.md:2:", "broken anchor target.md#nope")

    def test_missing_self_anchor_fails(self):
        self.write("docs/a.md", "# A\n[x](#nope)\n")
        self.assertFails(check("docs/a.md", cwd=self.root), "docs/a.md:2:", "broken anchor #nope")

    def test_external_links_and_fenced_code_are_ignored(self):
        self.write(
            "docs/a.md",
            "# A\n[w](https://example.com/x.md) [m](mailto:someone@example.com)\n```\n[x](nope.md)\n```\n",
        )
        result = check("docs/a.md", cwd=self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_directory_argument_recurses(self):
        self.write("docs/deep/b.md", "# B\n[x](missing.md)\n")
        self.assertFails(check("docs", cwd=self.root), "docs/deep/b.md:2:", "broken link missing.md")

    def test_missing_argument_fails(self):
        self.assertFails(check("docs/target.md", "docs/none", cwd=self.root), "docs/none: no such file or directory")

    def test_no_arguments_is_a_usage_error(self):
        self.assertEqual(check(cwd=self.root).returncode, 2)


if __name__ == "__main__":
    unittest.main()
