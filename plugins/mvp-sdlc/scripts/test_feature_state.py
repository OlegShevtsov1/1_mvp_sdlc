#!/usr/bin/env python3
"""Black-box tests for scripts/feature-state.py. Run: python3 scripts/test_feature_state.py"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
SCRIPT = PLUGIN / "scripts" / "feature-state.py"
FIXTURE = PLUGIN / "tests" / "fixtures" / "feature-demo"


class FeatureStateTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "app"
        shutil.copytree(str(FIXTURE), str(self.root))
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.state_path = self.root / "docs/features/demo/state.json"

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT)] + list(args),
            cwd=str(self.root / "docs"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )

    def state(self):
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def assertRefused(self, result, *needles):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stderr)

    def test_get_prints_state(self):
        result = self.cli("get", "demo")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["stage"], "idea")

    def test_set_requires_evidence(self):
        before = self.state_path.read_bytes()
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "set", "demo", "prd"], cwd=str(self.root), stderr=subprocess.PIPE
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"--evidence", result.stderr)
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_set_with_evidence_appends_history(self):
        evidence = "https://github.com/o/r/actions/runs/1"
        result = self.cli("set", "demo", "prd", "--evidence", evidence)
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.state()
        self.assertEqual(state["stage"], "prd")
        self.assertEqual(len(state["history"]), 2)
        entry = state["history"][-1]
        self.assertEqual(set(entry), {"stage", "evidence", "at"})
        self.assertEqual((entry["stage"], entry["evidence"]), ("prd", evidence))
        self.assertTrue(self.state_path.read_text(encoding="utf-8").endswith("}\n"))

    def test_evidence_forms(self):
        stages = iter(["accepted", "researched", "prd", "architecture", "contracts", "tasks", "in-progress", "review"])
        for evidence in (
            "exit:0",
            "docs/features/demo/PRD.md",
            str(self.root / "docs/features/demo/PRD.md"),
            "sdlc-gate:prd:abc1234",
            "feature-start:demo",
            "factory-deliver:run-1",
            "release:v0.1.0",
            "sdlc-metrics:report",
        ):
            with self.subTest(evidence=evidence):
                result = self.cli("--root", str(self.root), "set", "demo", next(stages), "--evidence", evidence)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_bad_evidence_refused(self):
        before = self.state_path.read_bytes()
        for evidence in ("trust me", "exit:x", "http://example.com/x", "missing/file.md", "someone:said-so", "release:"):
            with self.subTest(evidence=evidence):
                self.assertRefused(self.cli("set", "demo", "prd", "--evidence", evidence), "evidence")
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_unknown_stage_refused(self):
        self.assertRefused(self.cli("set", "demo", "done", "--evidence", "exit:0"), "done")

    def test_backwards_move_refused(self):
        self.assertEqual(self.cli("set", "demo", "architecture", "--evidence", "exit:0").returncode, 0)
        self.assertRefused(self.cli("set", "demo", "prd", "--evidence", "exit:0"), "backwards")
        self.assertEqual(self.state()["stage"], "architecture")

    def test_researched_and_briefed_share_a_rank(self):
        self.assertEqual(self.cli("set", "demo", "researched", "--evidence", "exit:0").returncode, 0)
        result = self.cli("set", "demo", "briefed", "--evidence", "exit:0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state()["stage"], "researched")
        self.assertEqual(self.cli("set", "demo", "prd", "--evidence", "exit:0").returncode, 0)

    def test_invalid_slug_refused(self):
        self.assertRefused(self.cli("get", "Demo_1"), "slug")
        self.assertRefused(self.cli("set", "Demo_1", "prd", "--evidence", "exit:0"), "slug")

    def test_missing_state_refused(self):
        self.state_path.unlink()
        self.assertRefused(self.cli("get", "demo"), "state.json")
        self.assertRefused(self.cli("set", "demo", "prd", "--evidence", "exit:0"), "state.json")

    def test_malformed_state_refused(self):
        for text in ("{not json", '{"schema_version": 1, "slug": "demo", "stage": "nope", "history": []}'):
            with self.subTest(text=text):
                self.state_path.write_text(text, encoding="utf-8")
                self.assertRefused(self.cli("get", "demo"), "state.json")
                self.assertRefused(self.cli("set", "demo", "prd", "--evidence", "exit:0"), "state.json")

    def write_state(self, **fields):
        state = self.state()
        state.update(fields)
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

    def test_card_fields_are_optional_but_typed(self):
        self.write_state(trello_card_id_short=12, trello_card_title="demo: Monthly order export")
        result = self.cli("get", "demo")
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(result.stdout)
        self.assertEqual((state["trello_card_id_short"], state["trello_card_title"]), (12, "demo: Monthly order export"))
        self.write_state(trello_card_id_short=None, trello_card_title=None)
        self.assertEqual(self.cli("get", "demo").returncode, 0)
        for fields in ({"trello_card_id_short": "12"}, {"trello_card_id_short": True}, {"trello_card_id_short": 0}):
            with self.subTest(fields=fields):
                self.write_state(**fields)
                self.assertRefused(self.cli("get", "demo"), "state.json")
        self.write_state(trello_card_id_short=12, trello_card_title=5)
        self.assertRefused(self.cli("get", "demo"), "state.json")

    def test_advance_keeps_card_fields(self):
        self.write_state(trello_card_id_short=12, trello_card_title="demo: Monthly order export")
        self.assertEqual(self.cli("set", "demo", "accepted", "--evidence", "exit:0").returncode, 0)
        state = self.state()
        self.assertEqual((state["trello_card_id_short"], state["trello_card_title"]), (12, "demo: Monthly order export"))


if __name__ == "__main__":
    unittest.main()
