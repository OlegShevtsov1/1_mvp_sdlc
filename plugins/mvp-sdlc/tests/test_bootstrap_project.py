"""bin/bootstrap-project: applies the .claude/ templates to an app repository, idempotently, never clobbering."""
from support import PLUGIN, AppRepo, TempTestCase

TEMPLATES = PLUGIN / "templates" / "claude"
RULES = {
    "be": ("git", "testing", "migrations", "api", "security"),
    "fe": ("git", "testing", "api", "security", "frontend"),
}


class BootstrapProjectTest(TempTestCase):
    def setUp(self):
        super().setUp()
        self.repo = AppRepo(self.tmp)

    def bootstrap(self, *args):
        return self.repo.bin("bootstrap-project", *args)

    def status(self):
        return self.repo.git("status", "--porcelain", "--untracked-files=all")

    def test_first_run_creates_everything(self):
        for kind in ("be", "fe"):
            with self.subTest(kind=kind):
                repo = AppRepo(self.tmp, name=kind)
                result = repo.bin("bootstrap-project", kind)
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = {
                    "CLAUDE.md": "CLAUDE.{}.md.tmpl".format(kind),
                    ".claude/settings.json": "settings.{}.json".format(kind),
                    ".claude/sdlc.local.md": "sdlc.local.{}.md.tmpl".format(kind),
                }
                expected.update({".claude/rules/{}.md".format(r): "rules/{}.md".format(r) for r in RULES[kind]})
                for target, template in expected.items():
                    self.assertEqual(repo.read(target), (TEMPLATES / template).read_text(encoding="utf-8"), target)
                    self.assertIn("{}: created".format(target), result.stdout)
                rules = sorted(p.name for p in (repo.path / ".claude/rules").iterdir())
                self.assertEqual(rules, sorted(r + ".md" for r in RULES[kind]))
                self.assertIn(".claude/*.local.md", repo.read(".gitignore").splitlines())

    def test_second_run_changes_nothing(self):
        self.repo.write(".gitignore", "node_modules/")
        self.assertEqual(self.bootstrap("be").returncode, 0)
        before = self.status()
        gitignore = self.repo.read(".gitignore")
        self.assertEqual(gitignore, "node_modules/\n.claude/*.local.md\n")
        result = self.bootstrap("be")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[-1], "No changes")
        self.assertTrue(lines[:-1] and all(line.endswith(": unchanged") for line in lines[:-1]), result.stdout)
        self.assertEqual(self.status(), before)
        self.assertEqual(self.repo.read(".gitignore"), gitignore)

    def test_existing_claude_md_is_kept(self):
        self.repo.write("CLAUDE.md", "# Our own rules\n")
        self.repo.write("README.md", "untouched\n")
        result = self.bootstrap("be")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.repo.read("CLAUDE.md"), "# Our own rules\n")
        template = TEMPLATES / "CLAUDE.be.md.tmpl"
        self.assertIn(
            "CLAUDE.md: differs (kept; re-run with --overwrite CLAUDE.md); template: {}".format(template), result.stdout
        )
        self.assertEqual(self.repo.read("README.md"), "untouched\n")
        result = self.bootstrap("be", "--overwrite", "CLAUDE.md")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CLAUDE.md: overwritten", result.stdout)
        self.assertEqual(self.repo.read("CLAUDE.md"), (TEMPLATES / "CLAUDE.be.md.tmpl").read_text(encoding="utf-8"))

    def test_target_option(self):
        other = AppRepo(self.tmp, name="other")
        result = self.bootstrap("fe", "--target", other.path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((other.path / "CLAUDE.md").is_file())
        self.assertFalse((self.repo.path / "CLAUDE.md").exists())

    def test_usage_errors(self):
        self.assertEqual(self.bootstrap("api").returncode, 2)
        self.assertEqual(self.bootstrap("be", "--overwrite", "README.md").returncode, 2)
        self.assertFalse((self.repo.path / "CLAUDE.md").exists())
