"""The plugin README documents every skill, bin command, script and hook the plugin ships."""
import unittest

from support import PLUGIN, TempTestCase


def shipped_bin_commands(bin_dir):
    # A test run that imports a bin script leaves bin/__pycache__ behind; it is not a shipped command.
    return [p.name for p in bin_dir.iterdir() if p.name != "__pycache__" and not p.name.startswith(".")]


class ReadmeTest(unittest.TestCase):
    def test_every_component_is_documented(self):
        readme = (PLUGIN / "README.md").read_text(encoding="utf-8")
        names = [p.name for p in (PLUGIN / "skills").iterdir() if p.is_dir()]
        names += shipped_bin_commands(PLUGIN / "bin")
        names += [p.stem for p in (PLUGIN / "hooks").glob("*.sh")]
        names += ["lint-prd", "feature-state", "state.json"]
        missing = sorted(n for n in set(names) if "`{}".format(n) not in readme)
        self.assertEqual(missing, [])


class ShippedBinCommandsTest(TempTestCase):
    def test_bytecode_cache_and_dot_entries_are_not_commands(self):
        (self.tmp / "stage-pr").write_text("", encoding="utf-8")
        (self.tmp / "__pycache__").mkdir()
        (self.tmp / ".DS_Store").write_text("", encoding="utf-8")
        self.assertEqual(shipped_bin_commands(self.tmp), ["stage-pr"])
