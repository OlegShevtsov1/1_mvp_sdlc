#!/usr/bin/env python3
"""Black-box tests for scripts/lint_plugins.py (evals layer 0). Run: python3 scripts/test_lint_plugins.py"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LINTER = REPO / "scripts" / "lint_plugins.py"
FIXTURE = REPO / "tests" / "fixtures" / "broken-agent"


def lint(root):
    return subprocess.run(
        [sys.executable, str(LINTER), "--root", str(root)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )


def replace_in(path, old, new):
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise AssertionError("{!r} not in {}".format(old, path))
    path.write_text(text.replace(old, new), encoding="utf-8")


class LintPluginsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def fixture(self, fixed=True):
        root = self.tmp / "fixture"
        shutil.copytree(str(FIXTURE), str(root))
        if fixed:
            replace_in(root / "plugins/demo/agents/reviewer.md", ", Edit\n", "\n")
        return root

    def assertFails(self, result, *needles):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for needle in needles:
            self.assertIn(needle, result.stderr)

    def test_repo_is_clean(self):
        result = lint(REPO)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("OK", result.stdout)

    def test_read_only_agent_with_edit_fails(self):
        self.assertFails(lint(self.fixture(fixed=False)), "reviewer", "Edit")

    def test_fixed_fixture_passes(self):
        result = lint(self.fixture())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_agent_outside_contract_fails(self):
        root = self.fixture()
        (root / "plugins/demo/agents/extra.md").write_text(
            "---\nname: extra\ndescription: Extra.\ntools: Read\n---\n", encoding="utf-8"
        )
        self.assertFails(lint(root), "extra")

    def test_contract_agent_without_file_fails(self):
        root = self.fixture()
        replace_in(root / "plugins/contracts.yaml", "  read_only:", "    ghost: [Read]\n  read_only:")
        self.assertFails(lint(root), "ghost")

    def test_contract_grants_write_to_read_only_agent_fails(self):
        root = self.fixture()
        replace_in(root / "plugins/contracts.yaml", "[Read, Grep, Glob]", "[Read, Grep, Glob, Write]")
        self.assertFails(lint(root), "reviewer", "Write")

    def test_agent_without_tools_fails(self):
        root = self.fixture()
        replace_in(root / "plugins/demo/agents/reviewer.md", "tools: Read, Grep, Glob\n", "")
        self.assertFails(lint(root), "reviewer", "tools")

    def test_marketplace_version_mismatch_fails(self):
        root = self.fixture()
        path = root / ".claude-plugin/marketplace.json"
        market = json.loads(path.read_text(encoding="utf-8"))
        market["plugins"][0]["version"] = "1.0.1"
        path.write_text(json.dumps(market), encoding="utf-8")
        self.assertFails(lint(root), "demo", "1.0.0", "1.0.1")

    def test_skill_without_description_fails(self):
        root = self.fixture()
        replace_in(root / "plugins/demo/skills/hello/SKILL.md", "description: Fixture skill.\n", "")
        self.assertFails(lint(root), "hello", "description")

    def hooked_fixture(self, command, events=("PreToolUse", "UserPromptSubmit"), mode=0o755):
        root = self.fixture()
        hooks_dir = root / "plugins/demo/hooks"
        hooks_dir.mkdir()
        script = hooks_dir / "guard.sh"
        script.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        script.chmod(mode)
        entry = [{"matcher": "Bash", "hooks": [{"type": "command", "command": command}]}]
        (hooks_dir / "hooks.json").write_text(json.dumps({"hooks": {e: entry for e in events}}), encoding="utf-8")
        return root

    def test_hook_script_missing_fails(self):
        self.assertFails(lint(self.hooked_fixture('"${CLAUDE_PLUGIN_ROOT}/hooks/nope.sh"')), "nope.sh")

    def test_hook_script_not_executable_fails(self):
        root = self.hooked_fixture('"${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"', mode=0o644)
        self.assertFails(lint(root), "guard.sh", "not executable")

    def test_hook_unknown_event_fails(self):
        root = self.hooked_fixture('"${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"', events=("PreToolUze",))
        self.assertFails(lint(root), "PreToolUze")

    def test_hooks_valid_passes(self):
        result = lint(self.hooked_fixture('"${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh" --flag'))
        self.assertEqual(result.returncode, 0, result.stderr)

    def vendored_copy(self):
        root = self.tmp / "repo"
        root.mkdir()
        shutil.copytree(str(REPO / ".claude-plugin"), str(root / ".claude-plugin"))
        shutil.copytree(str(REPO / "plugins"), str(root / "plugins"))
        return root

    def test_vendored_tree_is_hash_locked(self):
        root = self.vendored_copy()
        upstream = root / "plugins/sdlc/UPSTREAM.md"
        upstream.write_text(upstream.read_text(encoding="utf-8") + "\nA prose note.\n", encoding="utf-8")
        result = lint(root)
        self.assertEqual(result.returncode, 0, result.stderr)

        with (root / "plugins/sdlc/README.md").open("ab") as readme:
            readme.write(b"x")
        self.assertFails(lint(root), "sha256")

    def test_tree_hash_matches_documented_shell_recipe(self):
        root = self.vendored_copy()
        plugin = root / "plugins/sdlc"
        recipe = re.search(r"```sh\n(.*?)```", (plugin / "UPSTREAM.md").read_text(encoding="utf-8"), re.S).group(1)
        (plugin / "skills/_shared/name with spaces-Ä.md").write_text("new\n", encoding="utf-8")
        (plugin / ".claude-plugin/excluded.json").write_text("{}\n", encoding="utf-8")
        result = lint(root)
        computed = re.search(r"tree sha256 ([0-9a-f]{64}) != recorded", result.stderr)
        self.assertIsNotNone(computed, result.stderr)
        shell = subprocess.run(
            ["bash", "-c", recipe], cwd=str(plugin), stdout=subprocess.PIPE, universal_newlines=True, check=True
        )
        self.assertEqual(shell.stdout.split()[0], computed.group(1))

    def test_manifest_copy_must_match_upstream_plugin_json(self):
        root = self.vendored_copy()
        with (root / "plugins/sdlc/.claude-plugin/plugin.json").open("ab") as manifest:
            manifest.write(b" ")
        self.assertFails(lint(root), "plugins/sdlc/.claude-plugin/plugin.json", "byte copy")

if __name__ == "__main__":
    unittest.main()
