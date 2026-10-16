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
