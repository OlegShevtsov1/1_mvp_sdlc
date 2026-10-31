"""bin/task-brief --check-after-merge: the After merge (operator) schema, its validator and deferred-step cards."""
import json
import re
import shutil
import sys

from support import AppRepo, CURL_STUB, PLUGIN, TempTestCase

sys.path.insert(0, str(PLUGIN / "lib"))
import sdlc_common  # noqa: E402

HOST = "trello" + ".com"
BOARD = "b0" * 12
TASK_CARD = "a1" * 12
BACKLOG = "4b" * 12
SOURCE = "after-merge.md"

TOP = "# PILOT-472: sdlc task-brief: validates the After merge section\n\nType: feat\n\n"
SECTION = (
    "## After merge (operator)\n\n"
    "Run on the operator machine; do not start later steps before A0 passes. 🔒 = needs the operator's OK.\n\n"
)
A0 = (
    "### A0 — Preconditions\n"
    "Run:\n"
    "```bash\n"
    "gh auth status\n"
    "### A9 — a comment inside the block, not a step\n"
    "```\n"
    "Expected:\n"
    "- check: gh-pr-merged <this-pr>\n"
    "- manual: both accounts are listed,\n"
    "  the second one as active\n"
    "- check: http-ok https://demo.example.com/up\n\n"
)
A1 = (
    "### A1 🔒 — Deploy the release\n"
    "Read the deploy runbook first.\n"
    "Run:\n"
    "~~~\n"
    "bin/deploy production\n"
    "~~~\n"
    "Expected:\n"
    "- check: workflow-run-success acme/shop ci.yml <merge-sha>\n"
    "- check: url-contains https://demo.example.com/version \"0.7.0 (abc)\"\n"
    "- check: git-tag-at acme/shop v0.7.0 0123abc\n"
    "- check: file-contains config/deploy.yml \"image: shop\"\n"
    "- check: gh-pr-merged https://github.com/acme/shop/pull/7 any\n\n"
)
TAIL = "## Rollback\n\nbin/deploy rollback\n"
VALID = TOP + SECTION + A0 + A1 + TAIL

DEFERRED = (
    "### A1 — Publish the release notes after the release\n"
    "Run:\n"
    "```bash\n"
    "gh release edit v0.7.0 --notes-file notes.md\n"
    "```\n"
    "Expected:\n"
    "- manual: the notes are published\n\n"
)
LATER = (
    "### A2 — Archive the old dashboards\n"
    "Run:\n"
    "```bash\n"
    "# by hand in the dashboard UI\n"
    "```\n"
    "Expected:\n"
    "- manual: no old dashboard is listed\n\n"
)
A3 = A1.replace("### A1 🔒", "### A3 🔒")
BOLD_A0 = (
    "**A0 — Preconditions**\n\n"
    "```bash\n"
    "gh auth status\n"
    "```\n\n"
    "Expected:\n"
    "- check: gh-pr-merged <this-pr>\n"
    "- manual: both accounts are listed\n\n"
)
BOLD_A1 = (
    "**A1 — 🔒 Deploy the release**\n\n"
    "Read the deploy runbook first.\n"
    "Run:\n"
    "```bash\n"
    "bin/deploy production\n"
    "```\n"
    "Expected:\n"
    "- check: http-ok https://demo.example.com/up\n\n"
)
PROSE_A2 = (
    "**A2 — Bookkeeping.**\n\n"
    "- Move the card: `task-card-final PILOT-472`.\n"
    "  Expected: the card is in Done.\n\n"
)
# Pull request bodies as merged, with home paths and Trello links replaced line for line:
# sdlc-77.md is OlegShevtsov1/1_mvp_sdlc#77 (merge 5a12824), fe-91.md is OlegShevtsov1/1_mvp_pilot_fe#91 (merge 7fe5ab9).
FIXTURES = PLUGIN / "tests/fixtures/after-merge"
REAL_BODIES = (("sdlc-77.md", "8 steps (A0, A1, A2, A3, A4, A5, A6, A7)"),
               ("fe-91.md", "7 steps (A0, A1, A2, A3, A4, A5, A6)"))


def step(*expected, title="Deploy the release", run="bin/deploy production"):
    return "### A1 — {}\nRun:\n```\n{}\n```\nExpected:\n{}\n".format(title, run, "".join(e + "\n" for e in expected))


def line_no(text, line, nth=1):
    numbers = [n for n, value in enumerate(text.splitlines(), 1) if value == line]
    return numbers[nth - 1]


class AfterMergeTest(TempTestCase):
    def setUp(self):
        super().setUp()
        self.repo = AppRepo(self.tmp, "feature-demo")
        self.repo.commit("feature")

    def check(self, text, *args):
        self.repo.write(SOURCE, text)
        return self.repo.bin("task-brief", "--check-after-merge", SOURCE, *args)

    def assertProblem(self, text, line, *needles, nth=1, source=SOURCE, result=None):
        result = result or self.check(text)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("task-brief: {}:{}: ".format(source, line_no(text, line, nth)), result.stderr)
        self.assertIn("  | " + line, result.stderr.splitlines())
        for needle in needles:
            self.assertIn(needle, result.stderr)

    def test_valid_section(self):
        result = self.check(VALID)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "task-brief: {}: After merge (operator) OK, 2 steps (A0, A1)\n".format(SOURCE))
        self.assertEqual(result.stderr, "")

    def test_no_section_runs_nothing(self):
        result = self.check(TOP + TAIL)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no After merge (operator) section", result.stdout)

    def test_unclosed_fence_hides_the_section(self):
        text = TOP + "## How it was checked\n```\nbun test\n" + SECTION + "### A1 — Do it\nRun:\nmake x\n"
        self.assertProblem(text, "```", "never closed", "hides the `## After merge (operator)` section")
        result = self.check(TOP + "## How it was checked\n```\nbun test\n" + TAIL)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("no After merge (operator) section", result.stdout)

    def test_heading_must_be_exact(self):
        for heading in ("## After merge", "### After merge (operator)", "## After Merge (Operator)",
                        "# After-merge (operator)"):
            with self.subTest(heading):
                text = VALID.replace("## After merge (operator)", heading)
                self.assertProblem(text, heading, "exactly `## After merge (operator)`")

    def test_two_sections(self):
        text = VALID + "\n" + SECTION + A0
        self.assertProblem(text, "## After merge (operator)", "twice", nth=2)

    def test_step_headers(self):
        for header in ("### A0 — Deploy the release", "### Step 1",
                       "### A1: Deploy the release", "### A1 - Deploy the release", "### A1 —", "#### Notes"):
            with self.subTest(header):
                text = TOP + SECTION + A0 + A1.replace("### A1 🔒 — Deploy the release", header) + TAIL
                self.assertProblem(text, header, nth=1)

    def test_step_numbers_increase(self):
        text = TOP + SECTION + A0.replace("### A0", "### A2") + A1 + TAIL
        self.assertProblem(text, "### A1 🔒 — Deploy the release", "A2")

    def test_gaps_are_allowed(self):
        result = self.check(TOP + SECTION + A0 + A1.replace("### A1", "### A5") + TAIL)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 steps (A0, A5)", result.stdout)

    def test_section_needs_a_step(self):
        self.assertProblem(TOP + SECTION + TAIL, "## After merge (operator)", "no step")

    def test_step_structure(self):
        cases = (
            ("Run without a fence", A1.replace("~~~\nbin/deploy production\n~~~\n", "bin/deploy production\n"),
             "bin/deploy production", 1),
            ("Expected before Run", A1.replace("Run:\n", "Expected:\n- manual: deployed\nRun:\n"), "Expected:", 2),
            ("second Run", A1.replace("~~~\nExpected:", "~~~\nRun:\n```\nmore\n```\nExpected:"), "Run:", 3),
            ("missing Expected", A1[:A1.index("Expected:")] + "\n", "### A1 🔒 — Deploy the release", 1),
            ("empty Expected", A1[:A1.index("Expected:")] + "Expected:\n\n", "Expected:", 2),
            ("prose item", A1.replace("- check: git-tag", "- the site answers\n- check: git-tag"), "- the site answers",
             1),
            ("stray line", A1.replace("any\n\n", "any\nThe deploy takes a minute.\n\n"),
             "The deploy takes a minute.", 1),
            ("empty manual", A1.replace("- check: git-tag", "- manual:\n- check: git-tag"), "- manual:", 1),
            ("unclosed fence", "### A1 — Deploy\nRun:\n```sh\nbin/deploy production\n", "```sh", 1),
            ("fence without Run", A1.replace("Run:\n", ""), "~~~", 1),
        )
        for name, a1, line, nth in cases:
            with self.subTest(name):
                result = self.check(TOP + SECTION + A0 + a1 + TAIL)
                self.assertProblem(TOP + SECTION + A0 + a1 + TAIL, line, nth=nth, result=result)
                self.assertNotIn("deferred", result.stderr)

    def test_problems_are_all_reported(self):
        text = TOP + SECTION + A0.replace("- check: http-ok https", "- check: http-ok ftp") + A1.replace(
            "acme/shop v0.7.0", "acme v0.7.0") + TAIL
        result = self.check(text)
        self.assertProblem(text, "- check: http-ok ftp://demo.example.com/up", result=result)
        self.assertProblem(text, "- check: git-tag-at acme v0.7.0 0123abc", result=result)

    def test_check_kinds(self):
        valid = (
            "gh-pr-merged <this-pr>", "gh-pr-merged acme/shop#7 squash", "gh-pr-merged <this-pr> merge",
            "gh-pr-merged https://github.com/acme/shop/pull/7 any",
            "workflow-run-success acme/shop ci.yml <merge-sha>",
            "workflow-run-success acme/shop \"Plugin CI\" 0123abcdef0123abcdef0123abcdef0123abcdef",
            "url-contains http://demo.example.com/health ok", "url-contains https://demo.example.com 'all good'",
            "http-ok https://demo.example.com/up", "git-tag-at acme/shop v0.7.0 0123abc",
            "git-tag-at acme/shop v0.7.0 <merge-sha>", "file-contains config/app.yml enabled",
            "file-contains ~/.archon/x.yaml \"task-brief --check-after-merge\"",
        )
        for check in valid:
            with self.subTest(check):
                result = self.check(TOP + SECTION + step("- check: " + check) + TAIL)
                self.assertEqual(result.returncode, 0, result.stderr)
        invalid = (
            ("gh-pr-merged", "gh-pr-merged"), ("gh-pr-merged <this-pr> rebase", "rebase"),
            ("gh-pr-merged 7", "gh-pr-merged"), ("gh-pr-merged <this-pr> squash extra", "gh-pr-merged"),
            ("workflow-run-success acme/shop ci.yml", "workflow-run-success"),
            ("workflow-run-success acme/shop ci.yml HEAD", "HEAD"), ("workflow-run-success shop ci.yml 0123abc", "shop"),
            ("url-contains https://demo.example.com", "url-contains"), ("url-contains demo.example.com ok", "url"),
            ("url-contains https://demo.example.com ''", "url-contains"),
            ("http-ok ftp://demo.example.com", "ftp"), ("http-ok", "http-ok"),
            ("http-ok https://a.example.com https://b.example.com", "http-ok"),
            ("git-tag-at acme/shop v0.7.0", "git-tag-at"), ("git-tag-at acme/shop v0.7.0 zzz1234", "zzz1234"),
            ("git-tag-at acme/shop 'v 1' 0123abc", "git-tag-at"),
            ("file-contains config/app.yml", "file-contains"), ("file-contains config/app.yml \"open", "quote"),
            ("deploy-ok production", "unknown check kind"), ("", "kind"),
        )
        for check, needle in invalid:
            with self.subTest(check):
                line = ("- check: " + check).rstrip()
                self.assertProblem(TOP + SECTION + step(line) + TAIL, line, needle)

    def test_deferred_steps_are_refused_with_their_card(self):
        ukrainian = "\u0426\u0435 \u043e\u043a\u0440\u0435\u043c\u0430 \u0437\u0430\u0434\u0430\u0447\u0430."
        cases = (
            ("marker in the title", DEFERRED, "Publish the release notes after the release"),
            ("comment-only Run", LATER.replace("### A2", "### A1"), "Archive the old dashboards"),
            ("empty Run", step("- manual: x", title="Rotate the keys", run="").replace("```\n\n```", "```\n```"),
             "Rotate the keys"),
            ("no Run", "### A1 — Rotate the keys\nThe operator rotates them by hand.\n\n", "Rotate the keys"),
            ("separate task", step("- manual: x", title="Rotate the keys").replace(
                "Run:", "This is a separate task.\nRun:"), "Rotate the keys"),
            ("Ukrainian marker", step("- manual: x", title="Rotate the keys").replace(
                "Run:", ukrainian + "\nRun:"), "Rotate the keys"),
            ("later", step("- manual: x", title="Rotate   the keys later"), "Rotate the keys later"),
        )
        for name, a1, card in cases:
            with self.subTest(name):
                text = TOP + SECTION + A0 + a1 + TAIL
                header = next(line for line in a1.splitlines() if line.startswith("### A1"))
                self.assertProblem(text, header, "A1", "deferred", "Backlog", "PILOT-472", "--create-cards",
                                   "card: " + card)

    def test_markers_outside_title_and_prose_are_not_deferral(self):
        a1 = step("- manual: later steps see the new keys", run="bin/rotate --later")
        result = self.check(TOP + SECTION + A0 + a1 + TAIL)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_pull_request_input(self):
        for ref in ("acme/shop#7", "https://github.com/acme/shop/pull/7"):
            with self.subTest(ref):
                self.repo.stub_gh("[]", pr_view={"body": VALID.replace("\n", "\r\n")})
                result = self.repo.bin("task-brief", "--check-after-merge", ref)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("task-brief: {}: After merge (operator) OK, 2 steps".format(ref), result.stdout)
                self.assertEqual(self.repo.gh_calls(), [["pr", "view", "7", "-R", "acme/shop", "--json", "body"]])

    def test_pull_request_problems_name_body_lines(self):
        body = VALID.replace("### A1 🔒", "### A0 🔒")
        self.repo.stub_gh("[]", pr_view={"body": body})
        result = self.repo.bin("task-brief", "--check-after-merge", "acme/shop#7")
        self.assertProblem(body, "### A0 🔒 — Deploy the release", source="acme/shop#7", result=result)

    def test_pull_request_that_cannot_be_read(self):
        self.repo.stub_gh("[]", pr_view="FAIL")
        result = self.repo.bin("task-brief", "--check-after-merge", "acme/shop#7")
        self.assertEqual(result.returncode, 1)
        self.assertIn("acme/shop#7", result.stderr)

    def test_usage(self):
        self.repo.write(SOURCE, VALID)
        for args in ([], [SOURCE, SOURCE], [SOURCE, "--card"], [SOURCE, "--card", "472"],
                     ["acme/shop#7", "--create-cards"], [SOURCE, "--bogus"], [SOURCE, "--strict", "--strict"]):
            with self.subTest(args=args):
                result = self.repo.bin("task-brief", "--check-after-merge", *args)
                self.assertEqual(result.returncode, 1)
                self.assertTrue(result.stderr.startswith("usage:"), result.stderr)
                self.assertIn("--check-after-merge <file|PR>", result.stderr)
        result = self.repo.bin("task-brief", "--check-after-merge", "--strict", SOURCE, "--card", "PILOT-472",
                               "--create-cards")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_real_bold_bodies_pass(self):
        for name, steps in REAL_BODIES:
            with self.subTest(name):
                shutil.copy(FIXTURES / name, self.repo.path / name)
                result = self.repo.bin("task-brief", "--check-after-merge", name)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("After merge (operator) OK, " + steps, result.stdout)
                self.assertIn("refused with --strict", result.stdout)
                reports = [line for line in result.stderr.splitlines() if line.startswith("task-brief:")]
                self.assertTrue(reports)
                for line in reports:
                    self.assertIn("{}:".format(name), line)
                    self.assertIn(": warning: ", line)

    def test_strict_refuses_prose_expectations(self):
        for name, _ in REAL_BODIES:
            with self.subTest(name):
                shutil.copy(FIXTURES / name, self.repo.path / name)
                result = self.repo.bin("task-brief", "--check-after-merge", name, "--strict")
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertNotIn(": warning: ", result.stderr)
        prose = BOLD_A1.replace("- check: http-ok", "- the site answers\n- check: http-ok")
        text = TOP + SECTION + BOLD_A0 + prose + TAIL
        result = self.check(text)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("task-brief: {}:{}: warning: ".format(SOURCE, line_no(text, "- the site answers")),
                      result.stderr)
        self.assertIn("2 steps (A0, A1); 1 warning, refused with --strict", result.stdout)
        self.assertProblem(text, "- the site answers", "prose expectation", result=self.check(text, "--strict"))
        for args in ((), ("--strict",)):
            with self.subTest(args=args):
                result = self.check(TOP + SECTION + BOLD_A0 + BOLD_A1 + TAIL, *args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                self.assertEqual(result.stdout,
                                 "task-brief: {}: After merge (operator) OK, 2 steps (A0, A1)\n".format(SOURCE))

    def test_bold_steps(self):
        cases = (
            ("Run line and none", BOLD_A0 + BOLD_A1),
            ("lock after the number", BOLD_A0 + BOLD_A1.replace("**A1 — 🔒 Deploy", "**A1 🔒 — Deploy")),
            ("prose step", BOLD_A0 + BOLD_A1 + PROSE_A2),
        )
        for name, steps in cases:
            with self.subTest(name):
                result = self.check(TOP + SECTION + steps + TAIL)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("OK, {} steps (A0, A1".format(steps.count("**A")), result.stdout)
        text = TOP + SECTION + BOLD_A0 + PROSE_A2 + TAIL
        result = self.check(text)
        self.assertIn("task-brief: {}:{}: warning: step A2 is prose".format(
            SOURCE, line_no(text, "**A2 — Bookkeeping.**")), result.stderr)
        self.assertProblem(text, "**A2 — Bookkeeping.**", "step A2 is prose", result=self.check(text, "--strict"))

    def test_prose_step_items(self):
        listed = PROSE_A2 + "Expected:\n- check: http-ok https://example.com\n- manual: the card is in Done\n\n"
        text = TOP + SECTION + BOLD_A0 + listed + TAIL
        result = self.check(text)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("step A2 is prose: its commands are inline code, with no fenced block (", result.stderr)
        for item, needle in (("- check: no-such-kind foo bar", "unknown check kind 'no-such-kind'"),
                             ("- manual:", "`- manual:` needs")):
            with self.subTest(item):
                text = TOP + SECTION + BOLD_A0 + listed.replace("- manual: the card is in Done", item) + TAIL
                self.assertProblem(text, item, needle)

    def test_bold_header_shape(self):
        for header in ("**A1: Deploy the release**", "**A1 - Deploy the release**", "**Step 1 — Deploy the release**",
                       "**3.** Deploy the release", "**A1 —**"):
            with self.subTest(header):
                text = TOP + SECTION + BOLD_A0 + BOLD_A1.replace("**A1 — 🔒 Deploy the release**", header) + TAIL
                self.assertProblem(text, header, "`**A<n> — <title>**`")

    def test_bold_header_trailing_text(self):
        text = TOP + SECTION + BOLD_A0 + BOLD_A1.replace("Deploy the release**", "Deploy the release** (on srv)") + TAIL
        result = self.check(text)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        text = TOP + SECTION + BOLD_A0 + "**A2 — Bookkeeping.** `task-card-final PILOT-472`\n\n" + TAIL
        result = self.check(text)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("warning: step A2 is prose", result.stderr)
        header = "**A2 — Bookkeeping.** (later)"
        self.assertProblem(TOP + SECTION + BOLD_A0 + header + "\n\n" + TAIL, header, "deferred",
                           "card: Bookkeeping.\n")

    def test_bold_prose_expectations_are_warnings(self):
        block = "**A1 — Check**\n\n```bash\ntrue\n```\n\n"
        inline = "**A1 — Check**\n\nRun `true`.\n\n"
        cases = (
            ("inline Expected after the block", block + "Expected: `OK` is printed.\n\n",
             "Expected: `OK` is printed."),
            ("output sample after Expected", inline + "Expected:\n```text\nOK\n```\n\n", "```text"),
            ("prose between the block and Expected",
             block + "Then look at the output.\n\nExpected:\n- the page loads\n\n", "- the page loads"),
        )
        for name, a1, line in cases:
            with self.subTest(name):
                text = TOP + SECTION + BOLD_A0 + a1 + TAIL
                result = self.check(text)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("task-brief: {}:{}: warning: prose expectation".format(SOURCE, line_no(text, line)),
                              result.stderr)
                self.assertProblem(text, line, "prose expectation", result=self.check(text, "--strict"))

    def test_bold_step_needs_expected_items(self):
        a1 = "**A1 — Deploy**\n\n```bash\nbin/deploy\n```\n\n"
        self.assertProblem(TOP + SECTION + BOLD_A0 + a1 + TAIL, "**A1 — Deploy**", "step A1 has no `Expected:` list")
        text = TOP + SECTION + BOLD_A0 + a1 + "Expected:\n\n" + TAIL
        self.assertProblem(text, "Expected:", "`Expected:` lists nothing", nth=2)

    def test_fences_as_post_merge_reads_them(self):
        cases = (
            ("indented under a list item", "1. Run it:\n\n    ```bash\n    # deploy later if it fails\n"
                                           "    bin/deploy\n    ```\n\n"),
            ("closed by a line with an info string", "```bash\nbin/deploy\n```text\n\n"),
        )
        for name, body in cases:
            with self.subTest(name):
                text = TOP + SECTION + BOLD_A0 + "**A1 — Deploy**\n\n" + body + \
                    "Expected:\n- check: http-ok https://x.example/up\n\n" + TAIL
                result = self.check(text)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("2 steps (A0, A1)", result.stdout)

    def test_mixed_forms_are_refused(self):
        text = TOP + SECTION + BOLD_A0 + A1 + TAIL
        self.assertProblem(text, "### A1 🔒 — Deploy the release", "one form")
        text = TOP + SECTION + BOLD_A0 + "#### Notes\n" + BOLD_A1 + TAIL
        self.assertProblem(text, "#### Notes", "one form")

    def test_bold_step_numbers(self):
        for name, first in (("duplicate", "**A1 — Preconditions**"), ("decrease", "**A2 — Preconditions**")):
            with self.subTest(name):
                text = TOP + SECTION + BOLD_A0.replace("**A0 — Preconditions**", first) + BOLD_A1 + TAIL
                self.assertProblem(text, "**A1 — 🔒 Deploy the release**", "must increase")
        result = self.check(TOP + SECTION + BOLD_A0 + BOLD_A1.replace("**A1", "**A5") + TAIL)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 steps (A0, A5)", result.stdout)

    def test_bold_deferred_steps(self):
        cases = (
            ("marker in the prose", PROSE_A2.replace("- Move", "- Later, move"), "**A2 — Bookkeeping.**",
             "Bookkeeping."),
            ("no command", "**A2 — 🔒 Bookkeeping.**\n\nThe operator moves the card by hand.\n\n",
             "**A2 — 🔒 Bookkeeping.**", "Bookkeeping."),
            ("empty block", BOLD_A1.replace("bin/deploy production\n", "").replace("**A1", "**A2"),
             "**A2 — 🔒 Deploy the release**", "Deploy the release"),
        )
        for name, a2, header, card in cases:
            with self.subTest(name):
                text = TOP + SECTION + BOLD_A0 + BOLD_A1 + a2 + TAIL
                self.assertProblem(text, header, "A2", "deferred", "Backlog", "card: " + card + "\n")

    def test_not_a_bold_boundary(self):
        text = TOP + SECTION + A0.replace("Run:", "**host-52393** is the box.\nRun:") + A1 + TAIL
        result = self.check(text)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("2 steps (A0, A1)", result.stdout)

    def test_neither_file_nor_pull_request(self):
        result = self.repo.bin("task-brief", "--check-after-merge", "missing.md")
        self.assertEqual(result.returncode, 1)
        self.assertIn("neither a file nor a pull request", result.stderr)


class GrammarDocTest(TempTestCase):
    """The check-kind table and the deferral markers of skills/task-brief/SKILL.md are the ones task-brief checks."""

    def setUp(self):
        super().setUp()
        self.skill = (PLUGIN / "skills/task-brief/SKILL.md").read_text(encoding="utf-8")
        self.task_brief = sdlc_common.load_script("bin/task-brief")

    def test_check_kind_table(self):
        rows = re.findall(r"^  \| `([a-z-]+)` \| `([^`]*)`", self.skill, re.M)
        self.assertEqual({kind: usage.replace("\\|", "|") for kind, usage in rows},
                         {kind: usage for kind, (usage, _, _) in self.task_brief.CHECK_KINDS.items()})

    def test_sha_rule(self):
        low, high = re.search(r"A `<sha>` is (\d+) to (\d+) hex digits", self.skill).groups()
        self.assertIn("[0-9a-f]{{{},{}}}".format(low, high), self.task_brief.CHECK_ARGS["sha"])

    def test_step_header_examples(self):
        section = self.skill[self.skill.index("## After merge format"):]
        headings = re.findall(r"^### A.*$", section, re.M)
        bold = re.findall(r"^\*\*A.*$", section, re.M)
        self.assertTrue(headings and bold)
        for line in headings:
            self.assertTrue(self.task_brief.STEP_HEADING.match(line), line)
        for line in bold:
            self.assertTrue(self.task_brief.BOLD_STEP.match(line), line)
        self.assertIn("--strict", section)

    def test_deferral_markers(self):
        listed = re.search(r'title or prose says (.*?) \(or their Ukrainian', self.skill, re.S).group(1)
        english = [marker for marker in self.task_brief.DEFERRED_MARKERS if marker.isascii()]
        self.assertEqual(re.findall(r'"([^"]+)"', listed), english)


class DeferredCardsTest(TempTestCase):
    def setUp(self):
        super().setUp()
        self.repo = AppRepo(self.tmp, "feature-demo")
        self.repo.commit("feature")
        stub = self.repo.stub_bin / "curl"
        stub.write_text(CURL_STUB, encoding="utf-8")
        stub.chmod(0o755)
        self.log = self.tmp / "curl.log"
        self.log.write_text("", encoding="utf-8")
        self.data_path = self.tmp / "curl-data.json"
        env_file = self.tmp / "trello.env"
        env_file.write_text("", encoding="utf-8")
        self.repo.env.update({
            "TRELLO_API_KEY": "fake-key-1",
            "TRELLO_TOKEN": "fake-token-1",
            "TRELLO_BOARD_ID": BOARD,
            "TRELLO_ENV_FILE": str(env_file),
            "CURL_STUB_LOG": str(self.log),
            "CURL_STUB_DATA": str(self.data_path),
        })
        task = {"id": TASK_CARD, "idShort": 472, "name": "sdlc task-brief", "idBoard": BOARD, "closed": False,
                "idList": "2a" * 12, "shortUrl": "https://{}/c/a1a1a1a1".format(HOST)}
        self.data = {
            "board": BOARD,
            "cards": {TASK_CARD: task},
            "lists": [{"id": BACKLOG, "name": "Backlog", "idBoard": BOARD},
                      {"id": "2a" * 12, "name": "In Progress", "idBoard": BOARD}],
            "checklists": {},
            "posts": 0,
        }
        self.save()

    def save(self):
        self.data_path.write_text(json.dumps(self.data), encoding="utf-8")

    def board(self):
        return json.loads(self.data_path.read_text(encoding="utf-8"))

    def calls(self):
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def posts(self):
        return [c["data"] for c in self.calls() if c["call"] == "POST /1/cards"]

    def create(self, text, *args):
        self.log.write_text("", encoding="utf-8")
        self.repo.write(SOURCE, text)
        return self.repo.bin("task-brief", "--check-after-merge", SOURCE, "--create-cards", *args)

    def test_creates_cards_and_drops_only_the_deferred_steps(self):
        result = self.create(TOP + SECTION + A0 + DEFERRED + LATER + A3 + TAIL)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        posts = self.posts()
        self.assertEqual([p["name"] for p in posts],
                         ["Publish the release notes after the release", "Archive the old dashboards"])
        for post, text in zip(posts, (DEFERRED, LATER)):
            self.assertEqual(post["idList"], BACKLOG)
            self.assertNotIn("idLabels", post)
            first, blank, rest = post["desc"].split("\n", 2)
            self.assertIn("PILOT-472 https://{}/c/a1a1a1a1".format(HOST), first)
            self.assertEqual((blank, rest), ("", text.rstrip("\n")))
        self.assertEqual(self.repo.read(SOURCE), TOP + SECTION + A0 + A3 + TAIL)
        self.assertIn("PILOT-301 created", result.stdout)
        self.assertIn("After merge (operator) OK, 2 steps (A0, A3)", result.stdout)

        again = self.create(TOP + SECTION + A0 + DEFERRED + LATER + A3 + TAIL)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(self.posts(), [])
        self.assertIn("PILOT-301 adopted", again.stdout)
        self.assertEqual(self.repo.read(SOURCE), TOP + SECTION + A0 + A3 + TAIL)

    def test_all_steps_deferred_removes_the_section(self):
        result = self.create(TOP + SECTION + DEFERRED + LATER + TAIL)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.repo.read(SOURCE), TOP + TAIL)
        self.assertIn("no After merge (operator) section", result.stdout)

    def test_other_problems_remain_after_the_drop(self):
        text = TOP + SECTION + A0.replace("http-ok https", "http-ok ftp") + DEFERRED + TAIL
        result = self.create(text)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(self.posts()), 1)
        self.assertIn("- check: http-ok ftp://demo.example.com/up", result.stderr)
        self.assertEqual(self.repo.read(SOURCE), TOP + SECTION + A0.replace("http-ok https", "http-ok ftp") + TAIL)

    def test_failed_write_leaves_the_file(self):
        self.data["fail_post"] = 2
        self.save()
        text = TOP + SECTION + A0 + DEFERRED + LATER + TAIL
        result = self.create(text)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.repo.read(SOURCE), text)
        for needle in ("HTTP 500", "PILOT-301 created", "safe"):
            self.assertIn(needle, result.stderr)

    def test_schema_errors_are_not_deferred_cards(self):
        unfenced = A1.replace("~~~\nbin/deploy production\n~~~\n", "bin/deploy production\n")
        for name, a1 in (("Run without a fence", unfenced), ("fence without Run", A1.replace("Run:\n", ""))):
            with self.subTest(name):
                text = TOP + SECTION + A0 + a1 + TAIL
                result = self.create(text)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(self.calls(), [])
                self.assertEqual(self.repo.read(SOURCE), text)

    def test_unwritable_file_after_the_cards(self):
        source = "brief/" + SOURCE
        text = TOP + SECTION + A0 + DEFERRED + TAIL
        self.repo.write(source, text)
        folder = self.repo.path / "brief"
        folder.chmod(0o555)
        self.addCleanup(folder.chmod, 0o755)
        result = self.repo.bin("task-brief", "--check-after-merge", source, "--create-cards")
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("Traceback", result.stderr)
        for needle in ("cannot write " + source, "A1 PILOT-301 created", "adopts"):
            self.assertIn(needle, result.stderr)
        self.assertEqual(self.repo.read(source), text)

    def test_task_card_number(self):
        text = (TOP + SECTION + A0 + DEFERRED + TAIL).replace("PILOT-472", "the task")
        result = self.create(text)
        self.assertEqual(result.returncode, 1)
        self.assertIn("--card", result.stderr)
        self.assertEqual(self.calls(), [])

        result = self.create(text, "--card", "PILOT-472")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(self.posts()), 1)

        result = self.create(TOP + SECTION + A0 + DEFERRED + TAIL, "--card", "PILOT-999")
        self.assertEqual(result.returncode, 1)
        self.assertIn("PILOT-999", result.stderr)
        self.assertEqual(self.posts(), [])

    def test_no_backlog_list(self):
        self.data["lists"] = self.data["lists"][1:]
        self.save()
        result = self.create(TOP + SECTION + A0 + DEFERRED + TAIL)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Backlog", result.stderr)
        self.assertEqual(self.posts(), [])

    def test_validation_alone_never_calls_trello(self):
        self.repo.write(SOURCE, TOP + SECTION + A0 + DEFERRED + TAIL)
        result = self.repo.bin("task-brief", "--check-after-merge", SOURCE)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.calls(), [])
