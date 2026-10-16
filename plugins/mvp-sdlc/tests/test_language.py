"""Every file of the mvp-sdlc plugin is written in English (no Cyrillic text)."""
import re
import unittest

from support import PLUGIN

CYRILLIC = re.compile("[\u0400-\u052f]")


class LanguageTest(unittest.TestCase):
    def test_no_cyrillic_anywhere_in_the_plugin(self):
        offenders = []
        for path in sorted(p for p in PLUGIN.rglob("*") if p.is_file() and "__pycache__" not in p.parts):
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            offenders += [
                "{}:{}".format(path.relative_to(PLUGIN), number)
                for number, line in enumerate(text.splitlines(), 1)
                if CYRILLIC.search(line)
            ]
        self.assertEqual(offenders, [])

    def test_the_check_sees_cyrillic(self):
        self.assertTrue(CYRILLIC.search("PRD \u0434\u043b\u044f"))
