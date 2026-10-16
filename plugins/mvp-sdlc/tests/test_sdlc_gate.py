"""bin/sdlc-gate and the sdlc-gate-hook entry: phase order enforced by code (amendment "deterministic checks")."""
import json
import subprocess
import sys
import unittest

from support import MERGED, PLUGIN, UNMERGED, AppRepo, TempTestCase

sys.path.insert(0, str(PLUGIN / "lib"))
import sdlc_common  # noqa: E402

FEATURE = "docs/features/demo/"
CLEAN_AC = "**Then** the system delivers a spreadsheet file with one row per order and confirms the export"
DIRTY_AC = "**Then** the system answers with status 200 and runs SELECT on the orders"
ADR = """<!-- Format: MADR. -->

---
status: Accepted                 # Proposed -> Accepted
owner: "Architect"
---

# ADR-0001 Export format
"""


class GateTest(TempTestCase):
    def setUp(self):
        super().setUp()
        self.repo = AppRepo(self.tmp, "feature-demo")
        self.gh_log = self.repo.stub_gh(MERGED)

    def publish(self, message="merge"):
        sha = self.repo.commit(message)
        self.repo.push()
        return sha

    def gate(self, *args):
        return self.repo.bin("sdlc-gate", *args)

    def state(self):
        return json.loads(self.repo.read(FEATURE + "state.json"))

    def assertBlocked(self, result, *needles):
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stderr)

    def assertPassed(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # prd

    def test_prd_needs_confirmed_idea_brief(self):
        self.repo.replace(FEATURE + "idea-brief.md", "status: Confirmed", "status: Draft")
        self.publish()
        self.assertBlocked(self.gate("prd", "demo"), "idea-brief.md", "Confirmed")

    def test_prd_needs_idea_brief_on_origin(self):
        brief = self.repo.read(FEATURE + "idea-brief.md")
        (self.repo.path / FEATURE / "idea-brief.md").unlink()
        self.publish()
        self.repo.write(FEATURE + "idea-brief.md", brief)
        self.repo.commit("local only")
        self.assertBlocked(self.gate("prd", "demo"), "idea-brief.md", "origin/main", "git fetch")

    def test_status_and_merge_failures_of_one_artifact_are_both_reported(self):
        self.publish()
        self.repo.replace(FEATURE + "idea-brief.md", "status: Confirmed", "status: Draft")
        self.repo.commit("local draft")
        self.assertBlocked(self.gate("prd", "demo"), "has status 'Draft'", "has unmerged edits")

    def test_prd_needs_merged_pull_request(self):
        sha = self.publish()
        self.repo.stub_gh([])
        self.assertBlocked(self.gate("prd", "demo"), "idea-brief.md", sha[:7], "merged pull request")
        self.repo.stub_gh(UNMERGED)
        self.assertBlocked(self.gate("prd", "demo"), sha[:7])

    def test_prd_passes_and_advances_state(self):
        sha = self.publish()
        result = self.gate("prd", "demo")
        self.assertPassed(result)
        state = self.state()
        self.assertEqual(state["stage"], "prd")
        self.assertEqual(state["history"][-1]["evidence"], "sdlc-gate:prd:" + sha[:7])
        self.assertIn(["api", "repos/{owner}/{repo}/commits/" + sha + "/pulls"], self.repo.gh_calls())

    # architecture

    def test_architecture_blocks_on_prd_lint_findings(self):
        self.repo.replace(FEATURE + "PRD.md", CLEAN_AC, DIRTY_AC)
        self.publish()
        self.assertBlocked(self.gate("architecture", "demo"), "PRD.md", "HTTP code (200)", "SQL keyword (SELECT)")

    def test_architecture_passes_on_clean_approved_prd(self):
        self.publish()
        self.assertPassed(self.gate("architecture", "demo"))
        self.assertEqual(self.state()["stage"], "architecture")

    def test_all_failures_are_reported(self):
        self.repo.replace(FEATURE + "PRD.md", "status: Approved", "status: Draft")
        self.repo.replace(FEATURE + "PRD.md", CLEAN_AC, DIRTY_AC)
        self.publish()
        self.assertBlocked(self.gate("adr", "demo"), "Approved", "HTTP code (200)")

    # contracts / tasks

    def test_contracts_for_size_m_needs_sad_and_accepted_adr(self):
        self.repo.write(FEATURE + ".size", "M\n")
        self.publish()
        self.assertBlocked(self.gate("contracts", "demo"), "sad.md", "adr/")

    def test_contracts_for_size_m_passes_with_sad_and_accepted_adr(self):
        self.repo.write(FEATURE + ".size", "M\n")
        self.repo.write(FEATURE + "sad.md", "---\nstatus: Draft\n---\n\n# SAD\n")
        self.repo.write(FEATURE + "adr/0001-export-format.md", ADR)
        self.publish()
        self.assertPassed(self.gate("contracts", "demo"))
        self.assertEqual(self.state()["stage"], "contracts")

    def test_contracts_for_size_s_passes(self):
        self.publish()
        self.assertPassed(self.gate("tasks", "demo"))

    def test_contracts_need_size(self):
        (self.repo.path / FEATURE / ".size").unlink()
        self.publish()
        self.assertBlocked(self.gate("contracts", "demo"), ".size")

    # ship

    def test_ship_needs_every_task_done(self):
        tasks_path = FEATURE + "tasks/tasks.json"
        tasks = json.loads(self.repo.read(tasks_path))
        for task in tasks["tasks"]:
            task["status"] = "done" if task["id"] != "T2" else "review"
        self.repo.write(tasks_path, json.dumps(tasks))
        self.publish()
        self.assertBlocked(self.gate("ship", "demo"), "T2")
        tasks["tasks"][1]["status"] = "done"
        self.repo.write(tasks_path, json.dumps(tasks))
        self.publish()
        self.assertPassed(self.gate("ship", "demo"))
        self.assertEqual(self.state()["stage"], "review")

    # merge evidence and input errors

    def test_unmerged_working_tree_edit_blocks(self):
        self.publish()
        self.repo.replace(FEATURE + "PRD.md", "## 1. Context", "## 1. Context (edited)")
        self.assertBlocked(self.gate("architecture", "demo"), "PRD.md", "has unmerged edits")

    def test_gh_failure_fails_closed(self):
        self.publish()
        self.repo.stub_gh("FAIL")
        self.assertBlocked(self.gate("prd", "demo"), "cannot verify")
        self.assertEqual(self.state()["stage"], "idea")

    def test_unusable_input(self):
        self.publish()
        self.assertBlocked(self.gate("deploy", "demo"), "deploy")
        self.assertBlocked(self.gate("prd", "Demo_1"), "slug")
        self.assertBlocked(self.gate("prd", "nosuch"), "nosuch")
        self.assertBlocked(self.gate())

    def test_slug_defaults_to_the_only_active_feature(self):
        self.publish()
        self.assertPassed(self.gate("prd"))
        self.repo.env["SDLC_FEATURE"] = "nosuch"
        self.assertBlocked(self.gate("prd"), "nosuch")

    def test_slug_resolution_refuses_a_broken_state_file(self):
        for broken in ('{"schema_version": 1, "slug": "other", "history": []}\n', "<<<<<<< HEAD\n"):
            with self.subTest(broken=broken):
                self.repo.write("docs/features/other/state.json", broken)
                self.publish()
                self.assertBlocked(self.gate("prd"), "docs/features/other/state.json")

    def test_second_pass_does_not_rewrite_state(self):
        self.publish()
        self.assertPassed(self.gate("architecture", "demo"))
        before = (self.repo.path / FEATURE / "state.json").read_bytes()
        self.assertPassed(self.gate("architecture", "demo"))
        self.assertPassed(self.gate("prd", "demo"))
        self.assertEqual((self.repo.path / FEATURE / "state.json").read_bytes(), before)


class PhaseTableTest(unittest.TestCase):
    def test_hook_phases_are_the_gate_phases(self):
        guards = sdlc_common.load_script("hooks/guards.py")
        gate = sdlc_common.load_script("bin/sdlc-gate")
        self.assertEqual(set(guards.GATED_SKILLS.values()), set(gate.PHASE_STAGE))


class GateHookTest(TempTestCase):
    def setUp(self):
        super().setUp()
        self.repo = AppRepo(self.tmp, "feature-demo")
        self.repo.replace(FEATURE + "PRD.md", "status: Approved", "status: Draft")
        self.repo.commit("draft PRD")
        self.repo.push()
        self.repo.stub_gh(MERGED)

    def hook(self, event):
        event = dict(event, cwd=str(self.repo.path))
        return subprocess.run(
            [str(PLUGIN / "hooks" / "sdlc-gate-hook.sh")],
            input=json.dumps(event),
            env=self.repo.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )

    def assertBlocked(self, result):
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("docs/features/demo/PRD.md", result.stderr)
        self.assertIn("Approved", result.stderr)

    def test_skill_tool_call_is_gated(self):
        tool_input = {"skill": "sdlc:architecture-design", "args": "demo"}
        self.assertBlocked(self.hook({"hook_event_name": "PreToolUse", "tool_name": "Skill", "tool_input": tool_input}))

    def test_skill_without_args_uses_the_active_feature(self):
        tool_input = {"skill": "sdlc:break-tasks"}
        self.assertBlocked(self.hook({"hook_event_name": "PreToolUse", "tool_name": "Skill", "tool_input": tool_input}))

    def test_slash_commands_are_gated(self):
        for prompt in ("/sdlc:architecture-design demo", "/sdlc-architecture-design demo", "  /sdlc:decide-adr"):
            with self.subTest(prompt=prompt):
                self.assertBlocked(self.hook({"hook_event_name": "UserPromptSubmit", "prompt": prompt}))

    def test_ungated_prompts_and_skills_pass_without_calling_gh(self):
        for event in (
            {"hook_event_name": "UserPromptSubmit", "prompt": "/sdlc:interview demo"},
            {"hook_event_name": "UserPromptSubmit", "prompt": "/mvp-sdlc:rails-data-model demo"},
            {"hook_event_name": "UserPromptSubmit", "prompt": "please run /sdlc:architecture-design demo later"},
            {"hook_event_name": "UserPromptSubmit", "prompt": "/sdlc:architecture-designer demo"},
            {"hook_event_name": "PreToolUse", "tool_name": "Skill", "tool_input": {"skill": "sdlc:interview"}},
            {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "ls"}},
            {},
        ):
            with self.subTest(event=event):
                result = self.hook(event)
                self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.repo.gh_calls(), [])
