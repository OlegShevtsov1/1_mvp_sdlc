"""The plugin README documents every skill, bin command, script and hook the plugin ships."""
import unittest

from support import PLUGIN


class ReadmeTest(unittest.TestCase):
    def test_every_component_is_documented(self):
        readme = (PLUGIN / "README.md").read_text(encoding="utf-8")
        names = [p.name for p in (PLUGIN / "skills").iterdir() if p.is_dir()]
        names += [p.name for p in (PLUGIN / "bin").iterdir()]
        names += [p.stem for p in (PLUGIN / "hooks").glob("*.sh")]
        names += ["lint-prd", "feature-state", "state.json"]
        missing = sorted(n for n in set(names) if "`{}".format(n) not in readme)
        self.assertEqual(missing, [])
