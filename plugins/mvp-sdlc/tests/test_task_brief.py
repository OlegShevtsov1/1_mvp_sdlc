"""bin/task-brief: the factory task text for one task, generated so gate 2 needs no operator edits."""
import json
import re

from support import AppRepo, TempTestCase

FEATURE = "docs/features/demo/"
CARD_ID = "c0ffee" * 4


class TaskBriefTest(TempTestCase):
    def setUp(self):
        super().setUp()
        self.repo = AppRepo(self.tmp, "feature-demo")
        self.repo.commit("feature")

    def brief(self, task="T1", slug="demo"):
        return self.repo.bin("task-brief", slug, task)

    def edit_tasks(self, change):
        path = FEATURE + "tasks/tasks.json"
        tasks = json.loads(self.repo.read(path))
        change({t["id"]: t for t in tasks["tasks"]})
        self.repo.write(path, json.dumps(tasks))

    def assertRefused(self, result, *needles):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stderr)

    def test_brief_for_a_ready_task(self):
        result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout
        headings = [line for line in out.splitlines() if re.match(r"^[A-D]\. ", line)]
        self.assertEqual([h[:2] for h in headings], ["A.", "B.", "C.", "D."])
        prd = self.repo.read(FEATURE + "PRD.md")
        for ac in ("AC-01", "AC-02"):
            block = re.search(r"### {} .*?(?=\n### |\n## )".format(ac), prd, re.S).group(0).strip()
            self.assertIn(block, out)
        self.assertNotIn("### AC-03", out)
        self.assertIn("AC-01: unit + e2e", out)
        self.assertIn("AC-02: unit", out)
        for item in ("unit tests for the export rule pass", "e2e test for the export flow passes"):
            self.assertIn(item, out)
        self.assertIn("≤ 1 day of work, ≤ 500 LOC diff", out)
        positions = [out.index(prefix) for prefix in ("`test(", "`feat(", "`refactor(")]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("`fix(", out)
        self.assertIn("do not change tests after RED", out)
        self.assertIn("SDLC-Task: T1", out)
        self.assertIn("SDLC-AC: AC-01, AC-02", out)
        for command in ("bundle exec rspec", "bundle exec rubocop", "bundle exec brakeman -q"):
            self.assertIn(command, out)
        row = next(line for line in self.repo.read(FEATURE + "tasks/tracker.md").splitlines() if line.startswith("| T1 |"))
        self.assertIn(row, out)
        self.assertIn("`done` in the same pull request", out)
        self.assertIn(CARD_ID, out)
        self.assertIn("checklist item T1", out)
        lines = out.splitlines()
        self.assertIn("  PILOT-42: demo: Monthly order export", lines)
        self.assertIn("  Type: feat", lines)
        description = lines[next(i for i, line in enumerate(lines) if line.startswith("- Pull request description")):]
        self.assertEqual(description[1:4], ["  Type: feat", "  SDLC-Task: T1", "  SDLC-AC: AC-01, AC-02"])
        self.assertIn("bin/deploy production", out)
        self.assertIn("https://demo.example.com/up", out)
        self.assertIn("90", out)
        self.assertIn("bin/deploy rollback", out)

    def test_acceptance_criteria_come_from_the_current_prd(self):
        old = "a shop manager whose shop has orders this month"
        new = "a regional manager responsible for several shops"
        self.repo.replace(FEATURE + "PRD.md", old, new)
        result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("**Given** " + new, result.stdout)
        self.assertNotIn(old, result.stdout)

    def test_pr_title_and_type_pass_pr_conventions(self):
        lines = self.brief().stdout.splitlines()
        title = lines[next(i for i, line in enumerate(lines) if line.startswith("- Pull request title")) + 1]
        self.assertRegex(title.strip(), r"^PILOT-[0-9]+: .+$")
        types = [line.strip() for line in lines if line.strip().startswith("Type:")]
        self.assertEqual(len(types), 1, types)
        self.assertRegex(types[0], r"^Type: (feat|fix|chore|docs|refactor|test|ci)$")

    def test_brief_names_its_card_once_for_the_factory(self):
        cards = [line for line in self.brief().stdout.splitlines() if re.match(r"^\s*PILOT-[1-9][0-9]{0,5}:", line)]
        self.assertEqual(cards, ["  PILOT-42: demo: Monthly order export"])

    def board_line(self, out):
        lines = [line for line in out.splitlines() if line.startswith("- Board:")]
        self.assertEqual(len(lines), 1, out)
        return lines[0]

    def test_brief_states_the_board_flow(self):
        line = self.board_line(self.brief().stdout)
        positions = [line.index(name) for name in ("In Progress", "Review", "Test")]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("Blocked", line)
        self.assertIn("do not move the card by hand", line)

    def test_board_line_uses_renamed_lists(self):
        profile = self.repo.read(".archon/factory-profile.yaml")
        self.repo.write(".archon/factory-profile.yaml", profile + 'trello:\n  lists:\n    review: "Code Review"\n')
        out = self.brief().stdout
        self.assertIn("Code Review", self.board_line(out))
        self.assertIn("bin/deploy production", out)

    def test_task_type_comes_from_tasks_json(self):
        self.edit_tasks(lambda tasks: tasks["T1"].update(type="fix"))
        self.assertIn("  Type: fix\n", self.brief().stdout)
        self.edit_tasks(lambda tasks: tasks["T1"].update(type="feature"))
        self.assertRefused(self.brief(), "type", "feat")

    def test_null_task_type_defaults_to_feat(self):
        self.edit_tasks(lambda tasks: tasks["T1"].update(type=None))
        result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("  Type: feat\n", result.stdout)

    def test_empty_task_type_is_refused(self):
        self.edit_tasks(lambda tasks: tasks["T1"].update(type=""))
        self.assertRefused(self.brief(), "type", "feat")

    def test_missing_card_number_is_refused(self):
        state = json.loads(self.repo.read(FEATURE + "state.json"))
        del state["trello_card_id_short"], state["trello_card_title"]
        self.repo.write(FEATURE + "state.json", json.dumps(state))
        self.assertRefused(self.brief(), "PILOT-", "feature-start", "sync-spec")

    def test_invalid_card_fields_are_refused(self):
        valid = json.loads(self.repo.read(FEATURE + "state.json"))
        for invalid in ({"trello_card_id_short": 0}, {"trello_card_id_short": -1}, {"trello_card_title": ""}):
            with self.subTest(invalid=invalid):
                self.repo.write(FEATURE + "state.json", json.dumps(dict(valid, **invalid)))
                self.assertRefused(self.brief(), "PILOT-", "feature-start", "sync-spec")

    def test_card_fields_from_spec_source_in_the_frontend(self):
        (self.repo.path / FEATURE / "state.json").unlink()
        record = {
            "source_repo": "be",
            "source_sha": "0" * 40,
            "files": {},
            "trello_card_id": CARD_ID,
            "trello_card_id_short": 7,
            "trello_card_title": "demo: From be",
        }
        self.repo.write(FEATURE + ".spec-source", json.dumps(record))
        result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("  PILOT-7: demo: From be\n", result.stdout)
        self.assertIn("Trello card " + CARD_ID, result.stdout)

    def test_brief_never_names_a_branch(self):
        self.assertNotIn("branch", self.brief().stdout.lower())

    def test_unfinished_dependency_is_refused(self):
        self.assertRefused(self.brief("T2"), "T1")
        self.edit_tasks(lambda tasks: tasks["T1"].update(status="done"))
        self.assertEqual(self.brief("T2").returncode, 0)

    def test_large_task_is_refused(self):
        self.assertRefused(self.brief("T3"), "split the task")
        self.edit_tasks(lambda tasks: tasks["T1"].update(estimate="12h"))
        self.assertRefused(self.brief("T1"), "split the task")

    def test_unknown_task_is_refused(self):
        self.assertRefused(self.brief("T9"), "T9")
        self.assertRefused(self.brief("T1", slug="nosuch"), "nosuch")

    def test_ac_missing_from_prd_is_refused(self):
        self.edit_tasks(lambda tasks: tasks["T1"].update(acs=["AC-01", "AC-07"]))
        self.assertRefused(self.brief(), "AC-07")

    def test_ac_without_test_level_is_refused(self):
        self.repo.replace(FEATURE + "test-plan.md", "| AC-02 error |", "| later |")
        self.assertRefused(self.brief(), "AC-02", "test level")

    def test_test_level_may_come_from_the_prd(self):
        self.repo.replace(FEATURE + "test-plan.md", "| AC-02 error |", "| later |")
        prd = self.repo.read(FEATURE + "PRD.md")
        self.repo.write(
            FEATURE + "PRD.md",
            prd + "\n## Test plan\n\n| AC | Test name | Level | Expected outcome |\n|---|---|---|---|\n"
            "| AC-02 | empty export refused | integration | nothing to export |\n",
        )
        result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AC-02: integration", result.stdout)

    def test_missing_local_settings_is_refused(self):
        (self.repo.path / ".claude/sdlc.local.md").unlink()
        self.assertRefused(self.brief(), "bootstrap-project")

    def test_missing_factory_profile_leaves_deploy_to_the_profile_gate(self):
        (self.repo.path / ".archon/factory-profile.yaml").unlink()
        result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count("profile gate"), 3, result.stdout)
