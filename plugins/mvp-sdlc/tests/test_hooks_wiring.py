"""hooks/hooks.json sends every tool a guard covers to that guard; the hook tests call the scripts directly."""
import json
import re
import unittest

from support import PLUGIN

GIT_GUARDS = {"block-main-push", "block-destructive-git"}
EXPECTED = {
    ("PreToolUse", "Bash"): GIT_GUARDS | {"block-env", "block-state-edit", "check-branch-name"},
    ("PreToolUse", "Read"): {"block-env"},
    ("PreToolUse", "Grep"): {"block-env"},
    ("PreToolUse", "Edit"): {"block-env", "block-state-edit"},
    ("PreToolUse", "MultiEdit"): {"block-env", "block-state-edit"},
    ("PreToolUse", "Write"): {"block-env", "block-state-edit"},
    ("PreToolUse", "NotebookEdit"): {"block-state-edit"},
    ("PreToolUse", "Skill"): {"sdlc-gate-hook"},
    ("UserPromptSubmit", None): {"sdlc-gate-hook"},
}


def wired(config, event, tool):
    """Hook names the config runs for `tool` (None for events without a tool)."""
    names = set()
    for group in config["hooks"].get(event, []):
        matcher = group.get("matcher", "")
        if tool is None or not matcher or matcher == "*" or re.fullmatch(matcher, tool):
            for hook in group["hooks"]:
                names.add(re.search(r"/hooks/([\w-]+)\.sh", hook["command"]).group(1))
    return names


class HooksWiringTest(unittest.TestCase):
    def test_each_tool_reaches_its_guards(self):
        config = json.loads((PLUGIN / "hooks" / "hooks.json").read_text(encoding="utf-8"))
        for (event, tool), names in EXPECTED.items():
            with self.subTest(event=event, tool=tool):
                self.assertEqual(wired(config, event, tool), names)
