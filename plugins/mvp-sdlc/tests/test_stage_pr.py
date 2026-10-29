"""bin/stage-pr (decision 105 c): a feature stage's files on their own branch, pushed, with a Type: docs PR."""
import json
import re
import sys
import unittest

from support import PLUGIN, AppRepo, TempTestCase

sys.path.insert(0, str(PLUGIN / "lib"))
import sdlc_common  # noqa: E402

guards = sdlc_common.load_script("hooks/guards.py")

FEATURE = "docs/features/demo/"
PR_URL = "https://github.com/acme/app/pull/101"
MESSAGE = "03: PRD for demo"
# scripts/ci/pr-conventions.sh
CARD_BRANCH = re.compile(r"^(feature|hotfix)/PILOT-[0-9]+-[a-z0-9-]+$")
TITLE = re.compile(r"^PILOT-[0-9]+: .+$")


class StagePrTest(TempTestCase):
    def setUp(self):
        super().setUp()
        self.repo = AppRepo(self.tmp, "feature-demo")
        self.repo.commit("feature demo")
        self.repo.push()
        self.repo.git("switch", "-q", "-c", "develop")
        self.repo.git("push", "-q", "-u", "origin", "develop")
        self.repo.env["SDLC_BASE_BRANCH"] = "develop"
        self.repo.stub_gh([], pr_create=PR_URL)

    def stage_pr(self, stage="prd", *paths, message=MESSAGE):
        return self.repo.bin("stage-pr", "demo", stage, "--message", message, *(paths or [FEATURE + "PRD.md"]))

    def remote_heads(self):
        heads = {}
        for line in self.repo.git("ls-remote", "--heads", "origin").splitlines():
            sha, ref = line.split()
            heads[ref[len("refs/heads/"):]] = sha
        return heads

    def pr_creates(self):
        return [call for call in self.repo.gh_calls() if call[:2] == ["pr", "create"]]

    def option(self, call, name):
        return call[call.index(name) + 1]

    def edit_prd(self, text="\nMore context.\n"):
        self.repo.write(FEATURE + "PRD.md", self.repo.read(FEATURE + "PRD.md") + text)

    def assertOk(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assertRefused(self, result, *needles, code=1):
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stderr)

    def test_opens_the_stage_pr(self):
        self.edit_prd()
        state = json.loads(self.repo.read(FEATURE + "state.json"))
        state["stage"] = "prd"
        self.repo.write(FEATURE + "state.json", json.dumps(state, indent=2) + "\n")
        result = self.stage_pr()
        self.assertOk(result)
        branch = "feature/PILOT-42-demo-prd"
        self.assertTrue(guards.BRANCH_NAME.fullmatch(branch))
        self.assertRegex(branch, CARD_BRANCH)
        head = self.remote_heads()[branch]
        self.assertEqual(self.repo.git("rev-parse", head + "^"), self.repo.git("rev-parse", "origin/develop"))
        changed = self.repo.git("diff", "--name-only", head + "^", head).splitlines()
        self.assertEqual(sorted(changed), [FEATURE + "PRD.md", FEATURE + "state.json"])
        self.assertEqual(self.repo.git("log", "-1", "--format=%B", head), MESSAGE)
        self.assertEqual(result.stdout.splitlines(), ["branch: " + branch, "commit: " + head, "pr: " + PR_URL])
        [create] = self.pr_creates()
        self.assertEqual(self.option(create, "--base"), "develop")
        self.assertEqual(self.option(create, "--head"), branch)
        title = self.option(create, "--title")
        self.assertEqual(title, "PILOT-42: demo: Monthly order export — prd")
        self.assertRegex(title, TITLE)
        body = self.option(create, "--body")
        self.assertEqual([line for line in body.splitlines() if line.startswith("Type:")], ["Type: docs"])
        for needle in ("R-C8.9", FEATURE + "PRD.md", FEATURE + "state.json"):
            self.assertIn(needle, body)

    def test_refuses_unrelated_changes(self):
        self.edit_prd()
        for unrelated, write in (
            ("notes.txt", lambda: self.repo.write("notes.txt", "scratch\n")),
            (FEATURE + "test-plan.md", lambda: self.repo.write(FEATURE + "test-plan.md", "changed\n")),
        ):
            with self.subTest(unrelated=unrelated):
                before = self.remote_heads()
                write()
                self.assertRefused(self.stage_pr(), unrelated)
                self.assertEqual(self.remote_heads(), before)
                self.assertEqual(self.repo.gh_calls(), [])
                self.assertEqual(self.repo.git("branch", "--show-current"), "develop")
                self.repo.git("checkout", "-q", "--", ".")
                self.repo.git("clean", "-q", "-f")
                self.edit_prd()

    def test_refuses_when_nothing_differs_from_the_base(self):
        before = self.remote_heads()
        self.assertRefused(self.stage_pr(), "already identical")
        self.assertEqual(self.remote_heads(), before)
        self.assertEqual(self.pr_creates(), [])

    def test_never_pushes_the_base_or_main(self):
        before = self.remote_heads()
        self.edit_prd()
        self.assertOk(self.stage_pr())
        after = self.remote_heads()
        self.assertEqual(after["develop"], before["develop"])
        self.assertEqual(after["main"], before["main"])
        self.assertEqual(set(after) - set(before), {"feature/PILOT-42-demo-prd"})

    def test_reuses_its_open_pr(self):
        self.edit_prd()
        self.assertOk(self.stage_pr())
        first = self.repo.git("rev-parse", "HEAD")
        self.edit_prd("\nAnswered a review comment.\n")
        self.repo.stub_gh([], pr_view={"state": "OPEN", "url": PR_URL})
        result = self.stage_pr()
        self.assertOk(result)
        head = self.remote_heads()["feature/PILOT-42-demo-prd"]
        self.assertEqual(self.repo.git("rev-parse", head + "^"), first)
        self.assertEqual(self.pr_creates(), [])
        self.assertIn("pr: " + PR_URL, result.stdout.splitlines())

    def test_takes_a_free_branch_after_a_merged_one(self):
        self.repo.git("push", "-q", "origin", "develop:refs/heads/feature/PILOT-42-demo-prd")
        self.edit_prd()
        self.assertOk(self.stage_pr())
        self.assertIn("feature/PILOT-42-demo-prd-2", self.remote_heads())
        self.assertEqual(self.option(self.pr_creates()[0], "--head"), "feature/PILOT-42-demo-prd-2")

    def test_leaves_its_merged_branch_for_a_free_one(self):
        self.edit_prd()
        self.assertOk(self.stage_pr())
        merged = "feature/PILOT-42-demo-prd"
        self.repo.git("push", "-q", "origin", merged + ":develop")
        self.repo.stub_gh([], pr_view={"state": "MERGED", "url": PR_URL}, pr_create=PR_URL)
        self.edit_prd("\nA later change.\n")
        result = self.stage_pr()
        self.assertOk(result)
        heads = self.remote_heads()
        self.assertEqual(self.repo.git("rev-parse", heads[merged + "-2"] + "^"), heads["develop"])
        self.assertEqual(self.repo.git("branch", "--show-current"), merged + "-2")
        [create] = self.pr_creates()
        self.assertEqual(self.option(create, "--head"), merged + "-2")

    def test_refuses_when_gh_cannot_read_its_branch_pr(self):
        self.edit_prd()
        self.assertOk(self.stage_pr())
        before = self.remote_heads()
        self.repo.stub_gh([], pr_view="FAIL")
        self.edit_prd("\nA later change.\n")
        self.assertRefused(self.stage_pr(), "cannot read the pull request of feature/PILOT-42-demo-prd", "HTTP 502")
        self.assertEqual(self.remote_heads(), before)
        self.assertEqual(self.pr_creates(), [])

    def test_gh_failure_after_push_is_reported_and_rerun_finishes(self):
        self.edit_prd()
        self.repo.stub_gh([], pr_create="FAIL")
        result = self.stage_pr()
        self.assertRefused(result, "pushed", "run stage-pr again")
        pushed = self.remote_heads()["feature/PILOT-42-demo-prd"]
        self.repo.stub_gh([], pr_create=PR_URL)
        result = self.stage_pr()
        self.assertOk(result)
        self.assertEqual(len(self.pr_creates()), 1)
        self.assertEqual(self.remote_heads()["feature/PILOT-42-demo-prd"], pushed)
        self.assertIn("pr: " + PR_URL, result.stdout.splitlines())

    def test_frontend_card_from_spec_source(self):
        self.repo.git("rm", "-q", FEATURE + "state.json")
        self.repo.commit("frontend has no state.json")
        self.repo.git("push", "-q", "origin", "develop")
        source = {"trello_card_id_short": 7, "trello_card_title": "demo: Export page", "source_sha": "abc1234"}
        self.repo.write(FEATURE + ".spec-source", json.dumps(source) + "\n")
        self.edit_prd()
        self.assertOk(self.stage_pr("spec", FEATURE, message="docs(spec): copy demo from be@abc1234"))
        [create] = self.pr_creates()
        self.assertEqual(self.option(create, "--title"), "PILOT-7: demo: Export page — spec")
        head = self.remote_heads()["feature/PILOT-7-demo-spec"]
        changed = self.repo.git("diff", "--name-only", head + "^", head).splitlines()
        self.assertEqual(sorted(changed), [FEATURE + ".spec-source", FEATURE + "PRD.md"])

    def test_usage_errors(self):
        self.edit_prd()
        (self.tmp / "outside.md").write_text("outside\n", encoding="utf-8")
        for args in (
            ["demo", "prd", "--message", MESSAGE, FEATURE + "state.json"],
            ["demo", "PRD", "--message", MESSAGE, FEATURE + "PRD.md"],
            ["demo", "prd", "--message", "docs: x\n\nType: feat", FEATURE + "PRD.md"],
            ["demo", "prd", "--message", MESSAGE, "../outside.md"],
            ["demo", "prd", "--message", MESSAGE],
            ["nosuch", "prd", "--message", MESSAGE, FEATURE + "PRD.md"],
        ):
            with self.subTest(args=args):
                self.assertRefused(self.repo.bin("stage-pr", *args), code=2)
        self.repo.write(FEATURE + "state.json", '{"schema_version": 1}\n')
        self.assertRefused(self.stage_pr(), "no card number")
        self.assertEqual(self.repo.gh_calls(), [])


class AdaptationTest(unittest.TestCase):
    """The course skills stay untouched (R-B1); the adaptation lives in the hook table, the rule and the templates."""

    def read(self, rel):
        return (PLUGIN / rel).read_text(encoding="utf-8")

    def test_rule_and_backend_template_map_every_feature_stage_skill(self):
        for rel in ("templates/claude/rules/git.md", "templates/claude/CLAUDE.be.md.tmpl"):
            text = self.read(rel)
            self.assertIn("stage-pr", text)
            for skill, stage in guards.FEATURE_STAGE_SKILLS.items():
                with self.subTest(rel=rel, skill=skill):
                    self.assertIn("`/sdlc:{}` → `{}`".format(skill, stage), text)

    def test_own_skills_and_frontend_template_run_stage_pr(self):
        fe = self.read("templates/claude/CLAUDE.fe.md.tmpl")
        self.assertIn("stage-pr <slug> spec", fe)
        for skill, needle in (
            ("sync-spec", "stage-pr <slug> spec"),
            ("task-cards", "stage-pr <slug> tasks"),
            ("rails-data-model", "stage-pr <slug> data-model"),
        ):
            with self.subTest(skill=skill):
                self.assertIn(needle, self.read("skills/{}/SKILL.md".format(skill)))

    def test_table_covers_the_gated_phases_and_names_course_skills(self):
        self.assertLessEqual(set(guards.GATED_SKILLS) - {"ship-feature"}, set(guards.FEATURE_STAGE_SKILLS))
        course = PLUGIN.parent / "sdlc" / "skills"
        for skill in guards.FEATURE_STAGE_SKILLS:
            with self.subTest(skill=skill):
                self.assertTrue((course / skill / "SKILL.md").is_file())


if __name__ == "__main__":
    unittest.main()
