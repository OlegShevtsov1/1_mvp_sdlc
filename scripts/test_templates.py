#!/usr/bin/env python3
"""Black-box tests for bin/render-template and scripts/ci/templates-check.sh.

Run: python3 scripts/test_templates.py. The fast-check cases need actionlint and gitleaks on PATH,
which `bash scripts/ci/check.sh templates` provides. Forbidden strings are assembled at runtime so
this file passes the checks it tests.
"""
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RENDERER = REPO / "bin" / "render-template"
FAST_CHECK = REPO / "scripts" / "ci" / "templates-check.sh"
BOARD_LISTS = REPO / "bin" / "board-lists"
BOARD_FLOW = (
    "Backlog",
    "Ready",
    "In Progress",
    "Review",
    "Test",
    "Blocked",
    "Ready to Release",
    "Test after Release",
    "Done",
)

PROJECT_WORD = "pi" + "lot"
GH_EXPR = "$" + "{{ github.sha }}"
WORKFLOW = (
    "name: CI\n"
    "on: push\n"
    "permissions:\n"
    "  contents: read\n"
    "jobs:\n"
    "  build:\n"
    "    runs-on: ubuntu-latest\n"
    "    steps:\n"
    '      - run: echo "{{PROJECT_NAME}} ' + GH_EXPR + '"\n'
)
ALL_PLACEHOLDERS = (
    "name={{PROJECT_NAME}}\n"
    "zone={{PROJECT_ZONE}}\n"
    "module={{APP_MODULE}}\n"
    "be={{REPO_BE}}\n"
    "fe={{REPO_FE}}\n"
    "sdlc={{SDLC_VERSION}}\n"
    "key={{PROJECT_KEY}}\n"
    "secret={{AI_REVIEW_SECRET}}\n"
    "input={{AI_REVIEW_AUTH_INPUT}}\n"
    "model={{AI_REVIEW_MODEL}}\n"
    "auth={{AI_REVIEW_AUTH_CHECKS}}\n"
)
UNTOUCHED = "sha: " + GH_EXPR + "\nnames: docker ps --format '{{.Names}}'\n"


class TemplatesTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.root = self.tmp / "sdlc"
        (self.root / "bin").mkdir(parents=True)
        (self.root / "scripts" / "ci").mkdir(parents=True)
        shutil.copy2(RENDERER, self.root / "bin" / "render-template")
        shutil.copy2(FAST_CHECK, self.root / "scripts" / "ci" / "templates-check.sh")
        for kind in ("be", "fe"):
            self.write(kind, "config/project.env.tmpl", "PROJECT_NAME={{PROJECT_NAME}}\nPROJECT_ZONE={{PROJECT_ZONE}}\n")
            self.write(kind, ".github/workflows/ci.yml", WORKFLOW)
        self.write("be", "values.txt", ALL_PLACEHOLDERS)
        self.write("be", "untouched.yml", UNTOUCHED)
        self.write("be", "bin/run", "#!/bin/sh\necho {{PROJECT_NAME}}\n", mode=0o755)
        self.write_bytes("be", "logo.bin", b"\xff\xfe{{UNKNOWN}}\x00")

    def write(self, kind, rel, text, mode=0o644):
        return self.write_bytes(kind, rel, text.encode("utf-8"), mode)

    def write_bytes(self, kind, rel, data, mode=0o644):
        path = self.root / "templates" / "project-{}".format(kind) / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(mode)
        return path

    def commit(self):
        git = ["git", "-C", str(self.root)]
        if not (self.root / ".git").exists():
            subprocess.run(git + ["init", "-q"], check=True)
        subprocess.run(git + ["add", "-A"], check=True)
        subprocess.run(
            git + ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "fixture", "--allow-empty"],
            check=True,
        )
        return subprocess.run(
            git + ["rev-parse", "--short=12", "HEAD"], check=True, stdout=subprocess.PIPE, universal_newlines=True
        ).stdout.strip()

    def render(self, *args):
        return subprocess.run(
            [str(self.root / "bin" / "render-template")] + [str(a) for a in args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )

    def fast_check(self, env=None):
        return subprocess.run(
            ["bash", "scripts/ci/templates-check.sh"],
            cwd=str(self.root),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
        )

    def snapshot(self, root):
        return {
            str(p.relative_to(root)): (p.read_bytes(), os.access(str(p), os.X_OK))
            for p in sorted(root.rglob("*"))
            if p.is_file() and ".git" not in p.relative_to(root).parts
        }

    def assertExit(self, result, code):
        self.assertEqual(result.returncode, code, result.stdout + (result.stderr or ""))

    # --- rendering ---

    def test_every_placeholder_gets_its_derived_value(self):
        sha = self.commit()
        dest = self.tmp / "out"
        result = self.render("be", "tplcheck", dest)
        self.assertExit(result, 0)
        self.assertIn("rendered be tplcheck into {}".format(dest), result.stdout)
        self.assertEqual(
            (dest / "values.txt").read_text(),
            "name=tplcheck\n"
            "zone=tplcheck.up.km.ua\n"
            "module=Tplcheck\n"
            "be=OlegShevtsov1/1_mvp_tplcheck_be\n"
            "fe=OlegShevtsov1/1_mvp_tplcheck_fe\n"
            "sdlc={}\n"
            "key=TPLCHECK\n"
            "secret=ANTHROPIC_API_KEY\n"
            "input=anthropic_api_key\n"
            "model=claude-sonnet-5\n"
            "auth=on every endpoint that needs them\n".format(sha),
        )

    def write_overrides(self, text):
        path = self.root / "templates" / "projects" / "tplcheck.env"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_project_overrides_replace_the_defaults(self):
        self.write_overrides(
            "# tplcheck overrides\n"
            "\n"
            "AI_REVIEW_SECRET=CLAUDE_CODE_OAUTH_TOKEN\n"
            "AI_REVIEW_MODEL=claude-sonnet-5-5\n"
            "AI_REVIEW_AUTH_CHECKS=(x, y)\n"
        )
        self.commit()
        dest = self.tmp / "out"
        self.assertExit(self.render("be", "tplcheck", dest), 0)
        lines = (dest / "values.txt").read_text().splitlines()
        for line in (
            "key=TPLCHECK",
            "secret=CLAUDE_CODE_OAUTH_TOKEN",
            "input=claude_code_oauth_token",
            "model=claude-sonnet-5-5",
            "auth=(x, y)",
        ):
            self.assertIn(line, lines)
        self.assertEqual(list(dest.rglob("*.env")), [dest / "config" / "project.env"])

    def test_unknown_override_is_refused_and_nothing_written(self):
        self.write_overrides("PROJECT_NAME=x\n")
        self.commit()
        dest = self.tmp / "out"
        result = self.render("be", "tplcheck", dest)
        self.assertExit(result, 2)
        self.assertIn("tplcheck.env:1:", result.stderr)
        self.assertFalse(dest.exists())

    def test_tmpl_suffix_is_dropped(self):
        self.commit()
        dest = self.tmp / "out"
        self.assertExit(self.render("fe", "tplcheck", dest), 0)
        self.assertEqual((dest / "config" / "project.env").read_text(), "PROJECT_NAME=tplcheck\nPROJECT_ZONE=tplcheck.up.km.ua\n")
        self.assertFalse((dest / "config" / "project.env.tmpl").exists())

    def test_executable_bit_is_preserved(self):
        self.commit()
        dest = self.tmp / "out"
        self.assertExit(self.render("be", "tplcheck", dest), 0)
        self.assertTrue(os.access(str(dest / "bin" / "run"), os.X_OK))
        self.assertFalse(os.access(str(dest / "values.txt"), os.X_OK))
        self.assertEqual((dest / "bin" / "run").read_text(), "#!/bin/sh\necho tplcheck\n")

    def test_binary_file_is_copied_byte_for_byte(self):
        self.commit()
        dest = self.tmp / "out"
        self.assertExit(self.render("be", "tplcheck", dest), 0)
        self.assertEqual((dest / "logo.bin").read_bytes(), b"\xff\xfe{{UNKNOWN}}\x00")

    def test_github_expressions_and_docker_formats_are_untouched(self):
        self.commit()
        dest = self.tmp / "out"
        self.assertExit(self.render("be", "tplcheck", dest), 0)
        self.assertEqual((dest / "untouched.yml").read_text(), UNTOUCHED)

    def test_unknown_placeholder_is_refused_and_nothing_written(self):
        self.write("be", "config/deploy.yml", "servers:\n  - {{PROD_VPN_IP}}\n")
        self.commit()
        dest = self.tmp / "out"
        result = self.render("be", "tplcheck", dest)
        self.assertExit(result, 2)
        self.assertIn("config/deploy.yml:2: unknown placeholder {{PROD_VPN_IP}}", result.stderr)
        self.assertFalse(dest.exists())
        self.assertEqual([p.name for p in self.tmp.iterdir()], ["sdlc"])

    def test_tmpl_collision_is_refused(self):
        self.write("fe", "config/project.env", "PROJECT_NAME=x\n")
        self.commit()
        result = self.render("fe", "tplcheck", self.tmp / "out")
        self.assertExit(result, 2)
        self.assertIn("config/project.env", result.stderr)

    def test_symlink_is_refused(self):
        os.symlink("values.txt", str(self.root / "templates" / "project-be" / "link"))
        self.commit()
        result = self.render("be", "tplcheck", self.tmp / "out")
        self.assertExit(result, 2)
        self.assertIn("link", result.stderr)

    def test_invalid_input_is_a_usage_error(self):
        self.commit()
        dest = self.tmp / "out"
        for args in (
            ("be", "Bad", dest),
            ("be", "a", dest),
            ("be", "1abc", dest),
            ("be", "bad-name", dest),
            ("be", "a" * 17, dest),
            ("xx", "tplcheck", dest),
            ("be", "tplcheck"),
            ("be", "tplcheck", dest, "extra"),
        ):
            with self.subTest(args=args):
                self.assertExit(self.render(*args), 2)
                self.assertFalse(dest.exists())

    def test_dest_that_is_a_file_is_a_usage_error(self):
        self.commit()
        dest = self.tmp / "out"
        dest.write_text("x\n")
        self.assertExit(self.render("be", "tplcheck", dest), 2)
        self.assertEqual(dest.read_text(), "x\n")

    def test_not_a_git_checkout_is_refused(self):
        dest = self.tmp / "out"
        result = self.render("be", "tplcheck", dest)
        self.assertExit(result, 2)
        self.assertFalse(dest.exists())

    def test_second_identical_render_is_unchanged(self):
        self.commit()
        dest = self.tmp / "out"
        self.assertExit(self.render("be", "tplcheck", dest), 0)
        before = self.snapshot(dest)
        result = self.render("be", "tplcheck", dest)
        self.assertExit(result, 0)
        self.assertIn("unchanged: {} already holds this render".format(dest), result.stdout)
        self.assertEqual(self.snapshot(dest), before)
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["out", "sdlc"])

    def test_dest_holding_only_git_is_rendered_into(self):
        self.commit()
        dest = self.tmp / "out"
        subprocess.run(["git", "init", "-q", str(dest)], check=True)
        self.assertExit(self.render("fe", "tplcheck", dest), 0)
        self.assertTrue((dest / ".git" / "HEAD").exists())
        self.assertTrue((dest / "config" / "project.env").exists())

    def test_different_dest_is_refused_untouched(self):
        self.commit()
        dest = self.tmp / "out"
        self.assertExit(self.render("be", "tplcheck", dest), 0)
        for change in ("extra", "changed"):
            with self.subTest(change=change):
                if change == "extra":
                    (dest / "mine.txt").write_text("mine\n")
                else:
                    (dest / "mine.txt").unlink()
                    (dest / "values.txt").write_text("edited\n")
                before = self.snapshot(dest)
                result = self.render("be", "tplcheck", dest)
                self.assertExit(result, 1)
                self.assertIn("refused: {} is not empty and differs from this render".format(dest), result.stdout)
                self.assertIn("mine.txt" if change == "extra" else "values.txt", result.stdout)
                self.assertEqual(self.snapshot(dest), before)
                self.assertEqual(sorted(p.name for p in self.tmp.iterdir()), ["out", "sdlc"])

    # --- fast check (needs actionlint and gitleaks) ---

    def test_fast_check_passes_clean_templates(self):
        self.commit()
        result = self.fast_check()
        self.assertExit(result, 0)
        self.assertIn("templates: be and fe clean", result.stdout)

    def test_fast_check_fails_on_the_project_word(self):
        self.write("fe", "README.md", "Built like the {} project.\n".format(PROJECT_WORD.capitalize()))
        self.commit()
        result = self.fast_check()
        self.assertExit(result, 1)
        self.assertIn("::error::templates: fe: no word {} failed".format(PROJECT_WORD), result.stdout)

    def test_fast_check_fails_on_an_unknown_placeholder(self):
        self.write("fe", "README.md", "{{UNKNOWN_THING}}\n")
        self.commit()
        result = self.fast_check()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("::error::templates: fe: render failed", result.stdout)

    def test_fast_check_fails_on_a_secret(self):
        key = "AKIA" + "Q3EGRWNXZ7KPLM4T"
        self.write("be", "config/aws.env", "AWS_ACCESS_KEY_ID={}\n".format(key))
        self.commit()
        result = self.fast_check()
        self.assertExit(result, 1)
        self.assertIn("::error::templates: be: gitleaks failed", result.stdout)
        self.assertNotIn(key, result.stdout)

    def test_fast_check_fails_on_an_actionlint_error(self):
        self.write("be", ".github/workflows/broken.yml", "name: Broken\non: push\n")
        self.commit()
        result = self.fast_check()
        self.assertExit(result, 1)
        self.assertIn("::error::templates: be: actionlint failed", result.stdout)

    def test_fast_check_fails_when_grep_itself_errors(self):
        shims = self.tmp / "shims"
        shims.mkdir()
        grep = shims / "grep"
        grep.write_text("#!/bin/sh\nexit 2\n")
        grep.chmod(0o755)
        self.commit()
        env = dict(os.environ, PATH="{}{}{}".format(shims, os.pathsep, os.environ["PATH"]))
        result = self.fast_check(env)
        self.assertExit(result, 1)
        self.assertIn("::error::templates: be: no placeholder left (grep error 2) failed", result.stdout)
        self.assertIn("::error::templates: be: no word {} (grep error 2) failed".format(PROJECT_WORD), result.stdout)
        self.assertNotIn("clean", result.stdout)

    # --- committed templates ---

    def test_claude_md_stays_within_the_200_line_contract(self):
        for kind in ("be", "fe"):
            path = REPO / "templates" / "project-{}".format(kind) / "CLAUDE.md"
            self.assertLessEqual(len(path.read_text().splitlines()), 200, path)

    def test_board_lists_prints_the_nine_lists_in_order(self):
        result = run([str(BOARD_LISTS)])
        self.assertExit(result, 0)
        self.assertEqual(result.stdout.splitlines(), list(BOARD_FLOW))
        result = run([str(BOARD_LISTS), "extra"])
        self.assertExit(result, 2)
        self.assertIn("usage: bin/board-lists", result.stderr)

    def test_rendered_readme_has_the_board_flow(self):
        link = re.compile(
            r"https://github\.com/OlegShevtsov1/1_mvp_sdlc/blob/[0-9a-f]{12}/docs/sdlc/03-dor-dod\.md#board-flow"
        )
        for kind in ("be", "fe"):
            with self.subTest(kind=kind):
                dest = self.tmp / "render-{}".format(kind)
                self.assertExit(run([str(RENDERER), kind, "tplcheck", str(dest)]), 0)
                text = (dest / "README.md").read_text(encoding="utf-8")
                self.assertIn("## Board flow", text.splitlines())
                section = text.split("## Board flow", 1)[1].split("\n## ", 1)[0]
                positions = [section.find("`{}`".format(name)) for name in BOARD_FLOW]
                self.assertNotIn(-1, positions, section)
                self.assertEqual(positions, sorted(positions))
                self.assertRegex(section, link)

    def test_pilot_render_carries_the_pilot_review_values(self):
        key = PROJECT_WORD.upper()
        for kind in ("be", "fe"):
            with self.subTest(kind=kind):
                dest = self.tmp / "render-{}-{}".format(kind, PROJECT_WORD)
                self.assertExit(run([str(RENDERER), kind, PROJECT_WORD, str(dest)]), 0)
                text = (dest / ".github" / "workflows" / "ai-review.yml").read_text(encoding="utf-8")
                self.assertIn("claude_code_oauth_token: $" + "{{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}", text)
                self.assertIn("--model claude-sonnet-5-5\n", text)
                self.assertIn("feature/{}-<n>-<slug>".format(key), text)
                self.assertNotIn("<KEY>", text)
                if kind == "be":
                    self.assertIn("(CanCanCan checks, the authentication Hard Rule in CLAUDE.md)", text)
                    self.assertIn("archon/task-factory-<n>", text)
                self.assertWorkflowTestPins(dest, kind, "CLAUDE_CODE_OAUTH_TOKEN", "claude-sonnet-5-5", "ANTHROPIC_API_KEY")

                dest = self.tmp / "render-{}-tplcheck".format(kind)
                self.assertExit(run([str(RENDERER), kind, "tplcheck", str(dest)]), 0)
                text = (dest / ".github" / "workflows" / "ai-review.yml").read_text(encoding="utf-8")
                self.assertIn("anthropic_api_key: $" + "{{ secrets.ANTHROPIC_API_KEY }}", text)
                self.assertIn("--model claude-sonnet-5\n", text)
                self.assertIn("feature/TPLCHECK-<n>-<slug>", text)
                self.assertWorkflowTestPins(dest, kind, "ANTHROPIC_API_KEY", "claude-sonnet-5", "CLAUDE_CODE_OAUTH_TOKEN")

    def assertWorkflowTestPins(self, dest, kind, secret, model, other_secret):
        expression = "$" + "{{ secrets." + secret + " }}"
        if kind == "be":
            text = (dest / "spec" / "deploy" / "ai_review_workflow_spec.rb").read_text(encoding="utf-8")
            self.assertIn("'{}' => '{}',".format(secret.lower(), expression), text)
            self.assertIn("'--model {}',".format(model), text)
            self.assertIn("to eq([ '{}' ])".format(secret), text)
        else:
            text = (dest / "tests" / "ai-review-workflow.test.ts").read_text(encoding="utf-8")
            self.assertIn("review.with?.{}).toBe('{}')".format(secret.lower(), expression), text)
            self.assertIn("toBe('secrets.{}')".format(secret), text)
        self.assertNotIn(other_secret, text)

def run(args):
    return subprocess.run(args, cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)


if __name__ == "__main__":
    unittest.main()
