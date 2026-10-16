"""The .claude/ templates for app repositories: CLAUDE.md shape, settings deny rules, deny <-> hook consistency."""
import json
import re
import subprocess
import tempfile
import unittest

from support import PLUGIN

TEMPLATES = PLUGIN / "templates" / "claude"
KINDS = ("be", "fe")
BASH_DENY = (
    "Bash(git push --force*)",
    "Bash(git push -f*)",
    "Bash(git push --force-with-lease*)",
    "Bash(git reset --hard*)",
    "Bash(git tag -d*)",
    "Bash(git push --delete*)",
)
FILE_DENY = {
    "be": (
        "Read(**/.env*)",
        "Edit(**/.env*)",
        "Read(config/master.key)",
        "Edit(config/master.key)",
        "Read(config/credentials*)",
        "Read(config/credentials/**)",
        "Edit(config/credentials*)",
        "Edit(config/credentials/**)",
        "Edit(docs/features/*/state.json)",
        "Write(docs/features/*/state.json)",
    ),
    "fe": (
        "Read(**/.env*)",
        "Edit(**/.env*)",
        "Edit(docs/features/*/state.json)",
        "Write(docs/features/*/state.json)",
    ),
}
BASH_HOOKS = ("block-main-push", "block-destructive-git", "block-env", "block-state-edit")


def settings(kind):
    return json.loads((TEMPLATES / "settings.{}.json".format(kind)).read_text(encoding="utf-8"))


class TemplatesTest(unittest.TestCase):
    def test_claude_md_templates(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                text = (TEMPLATES / "CLAUDE.{}.md.tmpl".format(kind)).read_text(encoding="utf-8")
                lines = text.splitlines()
                self.assertLessEqual(len(lines), 200)
                for heading in ("## Stack", "## Commands", "## Conventions", "## Hard Rules", "## Do not"):
                    self.assertIn(heading, lines)
                hard = text.split("## Hard Rules", 1)[1].split("\n## ", 1)[0]
                bullets = re.split(r"(?m)^- ", hard)[1:]
                self.assertGreaterEqual(len(bullets), 6)
                for bullet in bullets:
                    self.assertRegex(bullet, r"(?m)^\s+Why: \S", bullet)
                self.assertNotRegex(text, r"\{\{|TODO|TBD")

    def test_settings_templates(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                data = settings(kind)
                self.assertEqual(data["$schema"], "https://json.schemastore.org/claude-code-settings.json")
                self.assertEqual(
                    data["extraKnownMarketplaces"]["mvp"]["source"], {"source": "github", "repo": "OlegShevtsov1/1_mvp_sdlc"}
                )
                self.assertEqual(data["enabledPlugins"], {"sdlc@mvp": True, "mvp-sdlc@mvp": True})
                deny = data["permissions"]["deny"]
                for rule in BASH_DENY + FILE_DENY[kind]:
                    self.assertIn(rule, deny)

    def test_bash_deny_rules_are_also_blocked_by_hooks(self):
        rules = {rule for kind in KINDS for rule in settings(kind)["permissions"]["deny"] if rule.startswith("Bash(")}
        self.assertTrue(rules)
        with tempfile.TemporaryDirectory() as cwd:
            for rule in sorted(rules):
                command = re.fullmatch(r"Bash\((.*)\*\)", rule).group(1).strip()
                event = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd})
                codes = [
                    subprocess.run(
                        [str(PLUGIN / "hooks" / (hook + ".sh"))],
                        input=event,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        universal_newlines=True,
                    ).returncode
                    for hook in BASH_HOOKS
                ]
                with self.subTest(command=command):
                    self.assertIn(2, codes)

    def test_rules_per_kind(self):
        for name in ("git", "testing", "migrations", "api", "security", "frontend"):
            text = (TEMPLATES / "rules" / (name + ".md")).read_text(encoding="utf-8")
            self.assertRegex(text, r"(?m)^# ")

    def test_local_settings_templates(self):
        commands = {
            "be": {"cmd_test_unit": "bundle exec rspec", "cmd_lint": "bundle exec rubocop", "cmd_vet": "bundle exec brakeman -q"},
            "fe": {"cmd_test_unit": "npm test", "cmd_lint": "npm run lint", "cmd_vet": "npx tsc --noEmit"},
        }
        for kind in KINDS:
            text = (TEMPLATES / "sdlc.local.{}.md.tmpl".format(kind)).read_text(encoding="utf-8")
            front = text.split("---")[1]
            self.assertIn("tdd: true", front)
            for key, value in commands[kind].items():
                self.assertIn('{}: "{}"'.format(key, value), front)
