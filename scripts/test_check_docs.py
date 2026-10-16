#!/usr/bin/env python3
"""Black-box tests for scripts/check_docs.py. Run: python3 scripts/test_check_docs.py"""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from check_docs import DECISIONS, OPERATOR_SECTIONS

REPO = Path(__file__).resolve().parent.parent
CHECKER = REPO / "scripts" / "check_docs.py"
OPERATOR = "# Operator\n\nCourse M6.1. {}\n\n{}\n".format(" ".join(DECISIONS), "\n\n".join(OPERATOR_SECTIONS))
SECTION = "# Section\n\nCourse lesson M7.7. Uses `/sdlc:alpha`, `/mvp-sdlc:beta`, `gamma`, `delta.py` and `eps`.\n"
README = "# SDLC\n\n- [operator](00-operator.md)\n- [section](01-section.md)\n- [infra](12-infrastructure-references.md)\n"
INFRA = "# Infrastructure references\n\nInternal-only links.\n"


class CheckDocsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        for rel in (
            "plugins/sdlc/skills/alpha/SKILL.md",
            "plugins/sdlc/skills/_shared/size-matrix.md",
            "plugins/mvp-sdlc/skills/beta/SKILL.md",
            "plugins/mvp-sdlc/bin/gamma",
            "plugins/mvp-sdlc/scripts/delta.py",
            "plugins/mvp-sdlc/scripts/test_delta.py",
            "plugins/mvp-sdlc/hooks/eps.sh",
            "plugins/mvp-sdlc/hooks/guards.py",
            "scripts/ci/check.sh",
        ):
            self.write(rel, "x\n")
        self.write("docs/sdlc/README.md", README)
        self.write("docs/sdlc/00-operator.md", OPERATOR)
        self.write("docs/sdlc/01-section.md", SECTION)
        self.write("docs/sdlc/12-infrastructure-references.md", INFRA)

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def append(self, rel, text):
        path = self.root / rel
        path.write_text(path.read_text(encoding="utf-8") + text, encoding="utf-8")

    def check(self):
        return subprocess.run(
            [sys.executable, str(CHECKER), "--repo", str(self.root)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )

    def assertPasses(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def assertFails(self, *needles):
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stdout)

    def test_valid_docs_pass(self):
        self.assertIn("docs OK (4 files)", self.assertPasses().stdout)

    def test_unknown_course_skill_fails(self):
        self.append("docs/sdlc/01-section.md", "Run `/sdlc:nope`.\n")
        self.assertFails("docs/sdlc/01-section.md:4:", "/sdlc:nope")

    def test_unknown_course_skill_dash_form_fails(self):
        self.append("docs/sdlc/01-section.md", "Also /sdlc-nope works.\n")
        self.assertFails("/sdlc-nope")

    def test_unknown_mvp_skill_fails(self):
        self.append("docs/sdlc/01-section.md", "Run /mvp-sdlc:nope.\n")
        self.assertFails("/mvp-sdlc:nope")

    def test_unknown_path_like_tokens_fail(self):
        self.append("docs/sdlc/01-section.md", "Run `bin/nope` and `nope.yml`.\n")
        self.assertFails("unknown reference bin/nope", "unknown reference nope.yml")

    def test_existing_paths_resolve(self):
        self.append(
            "docs/sdlc/01-section.md",
            "Run `bin/gamma`, `scripts/delta.py`, `hooks/guards.py` and `scripts/ci/check.sh docs`.\n",
        )
        self.assertPasses()

    def test_elsewhere_token_passes(self):
        self.append("docs/sdlc/01-section.md", "Prod: `kamal-deploy.yml` or `deploy/rollback.sh prod`.\n")
        self.assertPasses()

    def test_planned_token_needs_planned_and_run_id(self):
        self.append("docs/sdlc/01-section.md", "Then `release-watch` runs.\n")
        self.assertFails("release-watch", "planned", "C4")

    def test_planned_token_without_run_id_fails(self):
        self.append("docs/sdlc/01-section.md", "Then `release-watch` runs (planned).\n")
        self.assertFails("release-watch")

    def test_planned_token_with_planned_and_run_id_passes(self):
        self.append("docs/sdlc/01-section.md", "Then `release-watch` runs (planned, C4).\n")
        self.assertPasses()

    def test_planned_command_prefix_is_caught(self):
        self.append("docs/sdlc/01-section.md", "DNS: `vpnctl project delegate <name>`.\n")
        self.assertFails("vpnctl project delegate")

    def test_planned_in_repo_path_that_exists_fails(self):
        self.write("bin/render-template", "x\n")
        self.append("docs/sdlc/01-section.md", "Render with `bin/render-template` (planned, S4).\n")
        self.assertFails("now exists; update the docs and the registry")

    def test_unregistered_confirm_word_fails(self):
        self.append("docs/sdlc/01-section.md", "Type `confirm=yes`.\n")
        self.assertFails("confirm=yes")

    def test_unregistered_typed_word_fails(self):
        self.append("docs/sdlc/01-section.md", "Type DEPLOY-prod.\n")
        self.assertFails("DEPLOY-prod")

    def test_registered_confirm_words_pass(self):
        self.append(
            "docs/sdlc/01-section.md",
            "Type `confirm=prod` or `confirm=remove-prod`; `DELEGATE-<name>` (planned, P2).\n",
        )
        self.assertPasses()

    def test_planned_confirm_word_needs_planned(self):
        self.append("docs/sdlc/01-section.md", "Type `DELEGATE-<name>`.\n")
        self.assertFails("DELEGATE-<name>")

    def test_cyrillic_fails(self):
        self.append("docs/sdlc/01-section.md", "привіт\n")
        self.assertFails("docs/sdlc/01-section.md:4:", "Cyrillic")

    def test_banned_words_fail(self):
        self.append("docs/sdlc/01-section.md", "On the srv host.\n")
        self.assertFails("srv")

    def test_banned_word_ws2_fails(self):
        self.append("docs/sdlc/01-section.md", "On ws2.\n")
        self.assertFails("ws2")

    def test_readme_must_link_every_file(self):
        self.write("docs/sdlc/02-more.md", "# More\n\nM6.2.\n")
        self.assertFails("does not link 02-more.md")

    def test_operator_section_missing_fails(self):
        self.write("docs/sdlc/00-operator.md", OPERATOR.replace("## 5. Hotfix and rollback\n", ""))
        self.assertFails("## 5. Hotfix and rollback")

    def test_operator_sections_out_of_order_fail(self):
        swapped = OPERATOR.replace("## 1. One-time setup", "## X").replace("## 2. A new project", "## 1. One-time setup")
        self.write("docs/sdlc/00-operator.md", swapped.replace("## X", "## 2. A new project"))
        self.assertFails("00-operator.md")

    def test_numbered_section_without_lesson_fails(self):
        self.write("docs/sdlc/01-section.md", SECTION.replace("Course lesson M7.7. ", ""))
        self.assertFails("01-section.md", "M<n>.<n>")

    def test_infra_references_page_needs_no_lesson(self):
        self.assertPasses()

    def test_every_decision_must_be_mentioned(self):
        self.write("docs/sdlc/00-operator.md", OPERATOR.replace("R-C1 ", "R-C10 "))
        self.assertFails("R-C1 ")

    def test_uncovered_plugin_parts_fail(self):
        self.write("docs/sdlc/01-section.md", "# Section\n\nM7.7. `/sdlc:alpha`, `gamma`, `delta.py`.\n")
        self.assertFails("beta", "eps")

    def test_uncovered_course_skill_fails(self):
        self.write("plugins/sdlc/skills/omega/SKILL.md", "x\n")
        self.assertFails("omega")

    def test_missing_plugin_directory_fails(self):
        shutil.rmtree(str(self.root / "plugins/mvp-sdlc/skills"))
        self.assertFails("plugins/mvp-sdlc/skills: directory missing")

    def test_first_line_must_be_h1(self):
        self.write("docs/sdlc/01-section.md", "Intro\n" + SECTION)
        self.assertFails("01-section.md:1:")

    def test_pr_template_gets_content_rules_only(self):
        self.write("templates/github/pull_request_template.md", "Checklist\n- [ ] `nope.yml`\n")
        self.assertFails("templates/github/pull_request_template.md:2:", "unknown reference nope.yml")

    def test_pr_template_without_h1_passes(self):
        self.write("templates/github/pull_request_template.md", "Checklist\n- [ ] tests\n")
        self.assertIn("docs OK (5 files)", self.assertPasses().stdout)


if __name__ == "__main__":
    unittest.main()
