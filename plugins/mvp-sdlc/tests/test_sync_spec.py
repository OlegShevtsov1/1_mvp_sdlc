"""bin/sync-spec: the fe repo gets a read-only copy of the be feature artifacts (R-B2), and --check detects drift."""
import hashlib
import json

from support import AppRepo, TempTestCase

FEATURE = "docs/features/demo/"
COPIED = [
    "PRD.md",
    "sad.md",
    "adr/0001-export-format.md",
    "contracts/openapi.yaml",
    "contracts/export-row.json",
    "CONTEXT.md",
    "test-plan.md",
]


class SyncSpecTest(TempTestCase):
    def setUp(self):
        super().setUp()
        self.be = AppRepo(self.tmp, "spec-sync", name="be")
        self.be_sha = self.be.commit("spec")
        self.be.push()
        self.fe = AppRepo(self.tmp, name="fe")
        self.fe.write("README.md", "fe\n")
        self.fe.commit("init")

    def sync(self, *args):
        return self.fe.bin("sync-spec", "demo", "--from", self.be.path, *args)

    def check(self):
        return self.sync("--check")

    def assertDrift(self, result, *needles):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stdout + result.stderr)

    def test_sync_copies_the_feature_artifacts(self):
        result = self.sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        copied = sorted(
            p.relative_to(self.fe.path / FEATURE).as_posix()
            for p in (self.fe.path / FEATURE).rglob("*")
            if p.is_file() and p.name != ".spec-source"
        )
        self.assertEqual(copied, sorted(COPIED))
        header = "Copied from be@{}:{}PRD.md by sync-spec. Do not edit here.".format(self.be_sha, FEATURE)
        prd = self.fe.read(FEATURE + "PRD.md").splitlines()
        self.assertEqual(prd[:5], ["---", "status: Approved", 'owner: "Product owner"', "---", "<!-- " + header + " -->"])
        context = self.fe.read(FEATURE + "CONTEXT.md").splitlines()
        self.assertTrue(context[0].startswith("<!-- Copied from be@" + self.be_sha), context[0])
        self.assertEqual(context[1:], self.be.read(FEATURE + "CONTEXT.md").splitlines())
        openapi = self.fe.read(FEATURE + "contracts/openapi.yaml").splitlines()
        self.assertTrue(openapi[0].startswith("# Copied from be@"), openapi[0])
        self.assertEqual(openapi[1:], self.be.read(FEATURE + "contracts/openapi.yaml").splitlines())
        self.assertEqual(
            self.fe.read(FEATURE + "contracts/export-row.json"), self.be.read(FEATURE + "contracts/export-row.json")
        )
        record = json.loads(self.fe.read(FEATURE + ".spec-source"))
        self.assertEqual(record["source_sha"], self.be_sha)
        self.assertNotIn(str(self.tmp), json.dumps(record))
        prd_hash = hashlib.sha256((self.be.path / FEATURE / "PRD.md").read_bytes()).hexdigest()
        self.assertEqual(record["files"]["PRD.md"]["source_sha256"], prd_hash)

    def test_sync_records_the_card_of_the_feature(self):
        card = {"trello_card_id": "c0" * 12, "trello_card_id_short": 42, "trello_card_title": "demo: Monthly export"}
        state = dict(card, schema_version=1, slug="demo", stage="tasks", history=[])
        self.be.write(FEATURE + "state.json", json.dumps(state))
        self.be.commit("state")
        self.be.push()
        self.assertEqual(self.sync().returncode, 0)
        record = json.loads(self.fe.read(FEATURE + ".spec-source"))
        self.assertEqual({key: record.get(key) for key in card}, card)
        self.assertFalse((self.fe.path / FEATURE / "state.json").exists())
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_sync_without_state_records_no_card(self):
        self.assertEqual(self.sync().returncode, 0)
        record = json.loads(self.fe.read(FEATURE + ".spec-source"))
        for key in ("trello_card_id", "trello_card_id_short", "trello_card_title"):
            self.assertNotIn(key, record)

    def test_unreadable_state_fails_the_sync(self):
        self.be.write(FEATURE + "state.json", json.dumps({"slug": "demo"}))
        self.be.commit("state")
        self.be.push()
        blob = self.be.git("rev-parse", "HEAD:" + FEATURE + "state.json")
        (self.be.path / ".git" / "objects" / blob[:2] / blob[2:]).unlink()
        result = self.sync()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("state.json", result.stderr)
        self.assertFalse((self.fe.path / FEATURE / ".spec-source").exists())

    def test_copies_come_from_the_commit_not_the_working_tree(self):
        self.be.replace(FEATURE + "PRD.md", "one row per order", "uncommitted text")
        self.assertEqual(self.sync().returncode, 0)
        self.assertNotIn("uncommitted text", self.fe.read(FEATURE + "PRD.md"))

    def test_check_passes_right_after_sync(self):
        self.sync()
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_check_detects_a_changed_source_file(self):
        self.sync()
        self.be.replace(FEATURE + "sad.md", "status: Draft", "status: Approved")
        self.be.commit("approve sad")
        self.be.push()
        self.assertDrift(self.check(), "sad.md")

    def test_check_detects_a_new_source_file(self):
        self.sync()
        self.be.write(FEATURE + "adr/0002-storage.md", "---\nstatus: Accepted\n---\n")
        self.be.commit("adr")
        self.be.push()
        self.assertDrift(self.check(), "adr/0002-storage.md")

    def test_check_ignores_a_new_sha_with_identical_files(self):
        self.sync()
        self.be.write("README.md", "unrelated\n")
        self.be.commit("unrelated")
        self.be.push()
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_check_detects_a_local_edit(self):
        self.sync()
        self.fe.replace(FEATURE + "PRD.md", "one row per order", "one row per order and a total")
        self.assertDrift(self.check(), "PRD.md")

    def test_source_feature_removed_entirely(self):
        self.sync()
        self.be.git("rm", "-r", "-q", FEATURE)
        self.be.commit("archive the feature")
        self.be.push()
        self.assertDrift(self.check(), "PRD.md: removed in be@", "test-plan.md: removed in be@")
        result = self.sync()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("0 files", result.stdout)
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_check_without_record_fails(self):
        self.assertDrift(self.check(), ".spec-source")

    def test_ref_option(self):
        self.be.replace(FEATURE + "PRD.md", "one row per order", "one row per order, newest first")
        branch_sha = self.be.commit("local change")
        result = self.sync("--ref", "HEAD")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("newest first", self.fe.read(FEATURE + "PRD.md"))
        self.assertEqual(json.loads(self.fe.read(FEATURE + ".spec-source"))["source_sha"], branch_sha)

    def test_missing_source_feature_fails(self):
        result = self.fe.bin("sync-spec", "nosuch", "--from", self.be.path)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("nosuch", result.stderr)

    def test_invalid_slug_exits_2(self):
        result = self.fe.bin("sync-spec", "Demo_1", "--from", self.be.path)
        self.assertEqual(result.returncode, 2, result.stderr)


TASK_FILE = "---\nid: {0}\ntitle: \"{1}\"\nrepo: {2}\nstatus: \"todo\"\n---\n\n# {0} — {1}\n"


class SyncSpecTasksTest(TempTestCase):
    """The fe gets its own tasks from the be tasks.json, so the course implement-tasks finds them there."""

    def setUp(self):
        super().setUp()
        self.be = AppRepo(self.tmp, "spec-sync", name="be")
        self.tasks = [
            {"id": "T1", "title": "Export endpoint", "layer": "ports", "deps": [], "repo": "be", "status": "done"},
            {"id": "T2", "title": "Export button", "layer": "ui", "deps": ["T1"], "repo": "fe", "status": "todo"},
            {"id": "T3", "title": "Export page", "layer": "ui", "deps": ["T1", "T2"], "repo": "fe", "status": "todo"},
        ]
        self.write_tasks()
        for task in self.tasks:
            self.be.write(FEATURE + "tasks/{}-task.md".format(task["id"].lower()),
                          TASK_FILE.format(task["id"], task["title"], task["repo"]))
        self.be.write(FEATURE + "tasks/_epic.md", "# Epic — demo\n")
        self.be.write(FEATURE + "tasks/tracker.md", "# Tracker — demo\n\n| T2 | Export button | todo |\n")
        self.be_sha = self.be.commit("tasks")
        self.be.push()
        self.fe = AppRepo(self.tmp, name="fe")
        self.fe.write("README.md", "fe\n")
        self.fe.commit("init")

    def write_tasks(self):
        self.be.write(FEATURE + "tasks/tasks.json", json.dumps({"slug": "demo", "tasks": self.tasks}, indent=2))

    def change_be(self, change):
        change({t["id"]: t for t in self.tasks})
        self.write_tasks()
        self.be.commit("tasks changed")
        self.be.push()

    def sync(self, *args):
        return self.fe.bin("sync-spec", "demo", "--from", self.be.path, "--repo", "fe", *args)

    def copied_tasks(self):
        return json.loads(self.fe.read(FEATURE + "tasks/tasks.json"))

    def assertDrift(self, result, *needles):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stdout + result.stderr)

    def assertInSync(self):
        result = self.sync("--check")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_sync_copies_only_this_repos_tasks(self):
        result = self.sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        tasks = sorted(p.name for p in (self.fe.path / FEATURE / "tasks").iterdir())
        self.assertEqual(tasks, ["_epic.md", "t2-task.md", "t3-task.md", "tasks.json"])
        copy = self.copied_tasks()
        self.assertEqual([t["id"] for t in copy["tasks"]], ["T2", "T3"])
        self.assertEqual(copy["slug"], "demo")
        self.assertEqual(copy["tasks"][1]["deps"], ["T2"])
        self.assertEqual(copy["tasks"][1]["external_deps"], ["T1"])
        self.assertEqual(copy["tasks"][0]["external_deps"], ["T1"])
        self.assertIn("be@{}:{}tasks/tasks.json".format(self.be_sha, FEATURE), copy["copied_from"])
        self.assertIn("Do not edit here", copy["copied_from"])
        task_file = self.fe.read(FEATURE + "tasks/t2-task.md").splitlines()
        self.assertEqual(task_file[1], "id: T2")
        self.assertTrue(task_file[6].startswith("<!-- Copied from be@" + self.be_sha), task_file[6])
        record = json.loads(self.fe.read(FEATURE + ".spec-source"))
        self.assertIn("tasks/tasks.json", record["files"])
        self.assertNotIn("tasks/tracker.md", record["files"])
        self.assertInSync()

    def test_this_repo_defaults_to_the_origin_name(self):
        self.fe.git("remote", "set-url", "origin", "git@github.com:someone/fe.git")
        result = self.fe.bin("sync-spec", "demo", "--from", self.be.path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([t["id"] for t in self.copied_tasks()["tasks"]], ["T2", "T3"])

    def test_no_tasks_of_this_repo_copies_no_tasks(self):
        result = self.fe.bin("sync-spec", "demo", "--from", self.be.path, "--repo", "other")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.fe.path / FEATURE / "tasks").exists())
        self.assertTrue((self.fe.path / FEATURE / "PRD.md").is_file())

    def test_check_detects_a_changed_task_of_this_repo(self):
        self.sync()
        self.change_be(lambda tasks: tasks["T2"].update(status="done"))
        self.assertDrift(self.sync("--check"), "tasks/tasks.json: changed in be@")
        self.assertEqual(self.sync().returncode, 0)
        self.assertEqual(self.copied_tasks()["tasks"][0]["status"], "done")
        self.assertInSync()

    def test_check_ignores_a_change_to_another_repos_task(self):
        self.sync()
        self.change_be(lambda tasks: tasks["T1"].update(title="Export endpoint, paged"))
        self.assertInSync()

    def test_check_detects_a_local_edit_of_the_task_copy(self):
        self.sync()
        self.fe.replace(FEATURE + "tasks/tasks.json", '"status": "todo"', '"status": "done"')
        self.assertDrift(self.sync("--check"), "tasks/tasks.json: the copy here was edited")

    def test_check_detects_a_tracker_written_here(self):
        self.sync()
        self.fe.write(FEATURE + "tasks/tracker.md", "| T2 | Export button | done |\n")
        self.assertDrift(self.sync("--check"), "tasks/tracker.md: not a copy from be", "live in be")

    def test_resync_removes_a_task_that_left_this_repo(self):
        self.sync()
        self.change_be(lambda tasks: tasks["T3"].update(repo="be"))
        self.be.write(FEATURE + "tasks/t3-task.md", TASK_FILE.format("T3", "Export page", "be"))
        self.be.commit("T3 moves to be")
        self.be.push()
        self.assertDrift(self.sync("--check"), "tasks/t3-task.md: removed in be@", "tasks/tasks.json: changed in be@")
        result = self.sync()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("removed {}tasks/t3-task.md".format(FEATURE), result.stdout)
        self.assertFalse((self.fe.path / FEATURE / "tasks/t3-task.md").exists())
        self.assertEqual([t["id"] for t in self.copied_tasks()["tasks"]], ["T2"])
        self.assertInSync()

    def test_invalid_tasks_json_fails_the_sync(self):
        self.be.write(FEATURE + "tasks/tasks.json", json.dumps({"slug": "demo"}))
        self.be.commit("broken tasks")
        self.be.push()
        result = self.sync()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("tasks.json contract", result.stderr)
        self.assertFalse((self.fe.path / FEATURE / ".spec-source").exists())
