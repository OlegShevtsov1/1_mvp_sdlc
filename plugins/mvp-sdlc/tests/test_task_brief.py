"""bin/task-brief: the factory task text for one task, generated so gate 2 needs no operator edits."""
import json
import re
import shutil

from support import AppRepo, TempTestCase

FEATURE = "docs/features/demo/"
CARD_ID = "c0ffee" * 4
TASK_CARD = "a1" * 12
CARD_LINK = "trello" + ".com/c/"


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
        self.assertIn('"## After merge (operator)"', out)
        self.assertIn("task-brief --check-after-merge <file>", out)

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
        self.assertIn("Trello feature card " + CARD_ID, result.stdout)

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

    def test_one_day_task_is_briefed(self):
        for estimate in ("L", "8h"):
            self.edit_tasks(lambda tasks: tasks["T1"].update(estimate=estimate))
            result = self.brief("T1")
            self.assertEqual(result.returncode, 0, estimate + ": " + result.stderr)

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

    def title_lines(self, out):
        return [line for line in out.splitlines() if re.match(r"^\s*PILOT-[1-9][0-9]{0,5}:", line)]

    def test_task_card_titles_the_pull_request(self):
        self.edit_tasks(lambda tasks: tasks["T1"].update(trello_card_id=TASK_CARD, trello_card_id_short=250))
        result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.title_lines(result.stdout),
                         ["  PILOT-250: Export a shop's orders for a period as a spreadsheet file"])
        self.assertEqual(result.stderr, "")
        self.assertIn("Trello feature card {} (from {}state.json)".format(CARD_ID, FEATURE), result.stdout)
        self.assertNotIn(CARD_LINK, result.stdout)

    def test_task_without_card_falls_back_to_the_feature_card_with_a_warning(self):
        result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.title_lines(result.stdout), ["  PILOT-42: demo: Monthly order export"])
        self.assertIn("warning", result.stderr)
        self.assertIn("task-cards demo", result.stderr)
        self.assertNotIn(CARD_LINK, result.stdout)

    def test_task_card_needs_no_feature_card(self):
        state = json.loads(self.repo.read(FEATURE + "state.json"))
        for key in ("trello_card_id", "trello_card_id_short", "trello_card_title"):
            state[key] = None
        self.repo.write(FEATURE + "state.json", json.dumps(state))
        self.edit_tasks(lambda tasks: tasks["T1"].update(trello_card_id=TASK_CARD, trello_card_id_short=250))
        result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("  PILOT-250: ", result.stdout)
        self.assertNotIn("Trello feature card", result.stdout)

    def test_invalid_task_card_fields_are_refused(self):
        for invalid in (
            {"trello_card_id": TASK_CARD, "trello_card_id_short": 0},
            {"trello_card_id": "a1", "trello_card_id_short": 250},
            {"trello_card_id_short": 250},
            {"trello_card_id": TASK_CARD},
        ):
            with self.subTest(invalid=invalid):
                self.repo.git("checkout", "-q", "--", FEATURE)
                self.edit_tasks(lambda tasks: tasks["T1"].update(invalid))
                self.assertRefused(self.brief(), "T1", "task-cards")


class TaskBriefFromBackendTest(TempTestCase):
    """A frontend task is briefed in the frontend from the backend's committed tasks/, which owns its status."""

    def setUp(self):
        super().setUp()
        self.be = AppRepo(self.tmp, "feature-demo", name="be")
        self.be.commit("feature")
        self.be.push()
        self.fe = AppRepo(self.tmp, "feature-demo", name="fe")
        shutil.rmtree(str(self.fe.path / FEATURE / "tasks"))
        self.fe.commit("feature without tasks")

    def brief(self, task="T1", *options):
        return self.fe.bin("task-brief", "demo", task, *options)

    def assertRefused(self, result, *needles):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stderr)

    def test_frontend_brief_reads_the_backend_tasks(self):
        self.assertRefused(self.brief(), "tasks.json not found", "--from")
        result = self.brief("T1", "--from", self.be.path, "--ref", "origin/main")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Feature demo, task T1: Export a shop's orders", result.stdout)
        self.assertIn("live in the backend repository", result.stdout)
        self.assertNotIn("tracker.md", result.stdout)

    def test_backend_tasks_are_read_at_the_ref_not_the_working_tree(self):
        path = FEATURE + "tasks/tasks.json"
        tasks = json.loads(self.be.read(path))
        tasks["tasks"][0]["status"] = "done"
        self.be.write(path, json.dumps(tasks))
        self.assertEqual(self.brief("T2", "--from", self.be.path).returncode, 1)
        self.be.commit("T1 done")
        self.assertEqual(self.brief("T2", "--from", self.be.path).returncode, 1)
        self.be.push()
        result = self.brief("T2", "--from", self.be.path)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_local_tasks_are_never_shadowed_by_the_backend(self):
        shutil.copytree(str(self.be.path / FEATURE / "tasks"), str(self.fe.path / FEATURE / "tasks"))
        self.assertRefused(self.brief("T1", "--from", self.be.path), "tasks/tasks.json exists here", "drop --from")
        self.assertEqual(self.brief("T1").returncode, 0)

    def test_the_sync_spec_copy_of_the_tasks_keeps_from_working(self):
        path = FEATURE + "tasks/tasks.json"
        tasks = json.loads(self.be.read(path))
        for task in tasks["tasks"]:
            task["repo"] = "fe"
        self.be.write(path, json.dumps(tasks))
        self.be.commit("frontend tasks")
        self.be.push()
        synced = self.fe.bin("sync-spec", "demo", "--from", self.be.path, "--repo", "fe")
        self.assertEqual(synced.returncode, 0, synced.stderr)
        self.assertTrue((self.fe.path / path).is_file())
        result = self.brief("T1", "--from", self.be.path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("live in the backend repository", result.stdout)
        self.assertRefused(self.brief(), "sync-spec copy", "--from")

    def test_default_ref_follows_the_profile_base_branch(self):
        self.fe.replace(".archon/factory-profile.yaml", 'base_branch: "main"', 'base_branch: "develop"')
        result = self.brief("T1", "--from", self.be.path)
        self.assertEqual(result.returncode, 1)
        self.assertIn("origin/develop does not resolve", result.stderr)
        self.assertIn("fetch origin", result.stderr)

    def test_bad_options_are_refused(self):
        for options, needle in (
            (["--from", self.tmp / "nowhere"], "not a git checkout"),
            (["--from", self.be.path, "--ref", "origin/nosuch"], "does not resolve"),
            (["--ref", "origin/main"], "usage"),
            (["--from"], "usage"),
            (["--into", self.be.path], "usage"),
        ):
            with self.subTest(options=options):
                result = self.brief("T1", *options)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(needle, result.stderr)
