"""The LLM eval suite under evals/ (evals layer 1), checked without model calls.

Case files follow the `claude plugin eval` case schema; every broken/<case>.patch applies and really removes the
guarded behavior; the graders pass the end state a working plugin leaves (states/green.sh) and fail the one a
broken plugin leaves (states/red.sh). Scaffolds run the way the CLI runs them: `bash <abs path>` in an empty
workspace under a throwaway HOME, with only PATH, HOME, TMPDIR and GIT_CONFIG_NOSYSTEM in the environment.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from support import PLUGIN, TempTestCase, run
from test_hooks_wiring import wired

EVALS = PLUGIN / "evals"
GOLDEN = {
    "block-main-push",
    "block-destructive-git",
    "block-env",
    "sdlc-gate-blocks-unapproved",
    "rails-data-model-no-sql",
    "rails-data-model-expand-contract",
    "task-brief-ac",
    "task-brief-split-large",
    "task-brief-consults-rag",
    "sync-spec-stale",
    "bootstrap-project-idempotent",
}
CASE_KEYS = {"schema_version", "name", "description", "tags", "context", "execution", "runs", "graders"}
REQUIRED_KEYS = CASE_KEYS - {"description"}
EXECUTION_KEYS = {"prompt", "max_turns", "timeout_seconds", "allowed_tools"}
GRADER_KEYS = {
    "regex": ({"name", "type", "target", "pattern", "match"}, {"flags"}),
    "file_exists": ({"name", "type", "path", "exists"}, set()),
}
# Files that server-side hooks of the scaffolded origin.git append to.
LEDGERS = {"block-main-push": "push-log.txt", "block-destructive-git": "rewrite-log.txt"}
PATCHABLE = ("hooks/", "skills/", "bin/")
FLAGS = {"i": re.I, "m": re.M, "s": re.S}
# The plugin's mvp-rag server (.mcp.json) as Claude Code names its search tool; evals/mocks/mvp-rag/ answers it.
RAG_SEARCH_TOOL = "mcp__plugin_mvp-sdlc_mvp-rag__search"


def discover():
    """{case name: case dir} for every case.yaml under evals/, except the broken/ patches and cases/_template/."""
    found = {}
    for path in sorted(EVALS.rglob("case.yaml")):
        rel = path.relative_to(EVALS).parts
        if rel[0] != "broken" and rel[:2] != ("cases", "_template"):
            found[path.parent.name] = path.parent
    return found


def load(case_dir):
    return json.loads((case_dir / "case.yaml").read_text(encoding="utf-8"))


def patched_files(patch):
    return re.findall(r"^\+\+\+ b/(\S+)$", patch.read_text(encoding="utf-8"), re.M)


def file_graders(case):
    return [g for g in case["graders"] if g["type"] == "regex" and isinstance(g["target"], dict)]


class Workspace:
    """A scaffolded eval workspace: <tmp>/home/cwd, as the CLI lays it out."""

    def __init__(self, tmp, case_dir, plugin_root):
        self.home = Path(tempfile.mkdtemp(dir=str(tmp)))
        stub = self.home / ".git"
        for sub in ("objects", "refs/heads"):
            (stub / sub).mkdir(parents=True)
        (stub / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
        (self.home / ".gitconfig").write_text("[user]\n\tname = Plugin Eval\n\temail = eval@example.invalid\n")
        self.path = self.home / "cwd"
        self.path.mkdir()
        self.env = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.home),
            "TMPDIR": str(tmp),
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        result = self.run_script(Path(plugin_root) / "evals" / case_dir.relative_to(EVALS) / "scaffold.sh")
        if result.returncode != 0:
            raise AssertionError("scaffold of {} failed: {}".format(case_dir.name, result.stderr))
        self.before = self.files()

    def run_script(self, script, **extra):
        return run(["bash", script.resolve()], self.path, dict(self.env, **extra))

    def files(self):
        return {
            p.relative_to(self.path).as_posix()
            for p in self.path.rglob("*")
            if p.is_file() and ".git" not in p.relative_to(self.path).parts
        }

    def created(self):
        return sorted(self.files() - self.before)

    def git(self, *args):
        return run(["git"] + list(args), self.path, self.env)


def glob_regex(pattern):
    return "".join("[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c) for c in pattern)


def grade(grader, workspace):
    """True when the grader passes, judged the way the CLI judges it."""
    created = workspace.created()
    if grader["type"] == "file_exists":
        matched = any(re.fullmatch(glob_regex(grader["path"]), path) for path in created)
        return matched == grader["exists"]
    target = grader["target"]
    if target == "files":
        text = "\n".join(created)
    else:
        path = workspace.path / target["path"]
        if not path.is_file():
            return False
        text = path.read_text(encoding="utf-8")
    flags = 0
    for flag in grader.get("flags", ""):
        flags |= FLAGS[flag]
    count = len(re.findall(grader["pattern"], text, flags))
    match = grader["match"]
    if match == "contains":
        return count > 0
    if match == "not_contains":
        return count == 0
    return count == int(match[len("count:"):])


class PluginCopies(TempTestCase):
    def plugin_copy(self, patch=None):
        root = Path(tempfile.mkdtemp(dir=str(self.tmp))) / "mvp-sdlc"
        shutil.copytree(str(PLUGIN), str(root), ignore=shutil.ignore_patterns("__pycache__"))
        if patch is not None:
            env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(root.parent))
            for args in (["apply", "--check"], ["apply"]):
                result = run(["git"] + args + [patch], root, env)
                if result.returncode != 0:
                    raise AssertionError("git {} {} failed: {}".format(" ".join(args), patch.name, result.stderr))
        return root

    def broken(self, name):
        return self.plugin_copy(EVALS / "broken" / (name + ".patch"))


class CaseFilesTest(TempTestCase):
    def test_golden_cases_are_the_agreed_set(self):
        golden = {name for name, path in discover().items() if path.parent == EVALS}
        self.assertEqual(golden, GOLDEN)

    def test_case_files_follow_the_schema(self):
        for name, case_dir in discover().items():
            with self.subTest(case=name):
                self.check_case(name, case_dir, load(case_dir))

    def check_case(self, name, case_dir, case):
        self.assertIsInstance(case, dict)
        self.assertLessEqual(set(case), CASE_KEYS)
        self.assertLessEqual(REQUIRED_KEYS, set(case))
        self.assertEqual(case["schema_version"], "1.0")
        self.assertEqual(case["name"], name)
        tags = case["tags"]
        self.assertTrue(tags)
        self.assertLessEqual(set(tags), {"golden", "defect"})
        self.assertIn("defect" if case_dir.parent.name == "cases" else "golden", tags)
        self.assertEqual(case["context"], {"scaffold_script": "scaffold.sh"})
        self.assertTrue((case_dir / "scaffold.sh").is_file())
        execution = case["execution"]
        self.assertEqual(set(execution), EXECUTION_KEYS)
        prompt = execution["prompt"]
        self.assertTrue(prompt.strip())
        self.assertNotRegex(prompt, r"(^|\s)(/(?!sdlc[:-]|mvp-sdlc:)\w|~/)")
        for key, limit in (("max_turns", 200), ("timeout_seconds", 3600)):
            self.assertIs(type(execution[key]), int)
            self.assertTrue(1 <= execution[key] <= limit, key)
        self.assertTrue(execution["allowed_tools"])
        self.assertEqual(case["runs"], 3)
        graders = case["graders"]
        self.assertTrue(graders)
        self.assertEqual(len({g["name"] for g in graders}), len(graders))
        for grader in graders:
            self.check_grader(grader)

    def check_grader(self, grader):
        required, optional = GRADER_KEYS[grader["type"]]
        self.assertLessEqual(required, set(grader), grader["name"])
        self.assertLessEqual(set(grader), required | optional, grader["name"])
        if grader["type"] == "file_exists":
            self.assertIs(type(grader["exists"]), bool)
            paths = [grader["path"]]
            self.assertNotIn("**", grader["path"])
        else:
            target = grader["target"]
            if target != "files":
                self.assertEqual(set(target), {"source", "path"}, grader["name"])
                self.assertEqual(target["source"], "file")
            paths = [target["path"]] if isinstance(target, dict) else []
            self.assertLessEqual(set(grader.get("flags", "")), set(FLAGS))
            self.assertRegex(grader["match"], r"^(contains|not_contains|count:\d+)$")
            re.compile(grader["pattern"])
        for path in paths:
            self.assertFalse(path.startswith(("/", "~")) or ".." in path.split("/"), path)

    def test_every_case_has_one_broken_patch(self):
        patches = {p.stem: p for p in (EVALS / "broken").glob("*.patch")}
        self.assertEqual(set(patches), set(discover()))
        self.assertEqual(sorted(p.name for p in (EVALS / "broken").iterdir()), sorted(p.name for p in patches.values()))
        for name, patch in patches.items():
            with self.subTest(case=name):
                files = patched_files(patch)
                self.assertTrue(files)
                for path in files:
                    self.assertTrue(path.startswith(PATCHABLE), path)


class PatchesTest(PluginCopies):
    def test_patches_apply_and_keep_hooks_json_valid(self):
        for name in discover():
            with self.subTest(case=name):
                json.loads((self.broken(name) / "hooks" / "hooks.json").read_text(encoding="utf-8"))


class WorkspaceTest(PluginCopies):
    def test_scaffolds_build_a_clean_workspace(self):
        broken = {name: self.broken(name) for name in discover()}
        for name, case_dir in discover().items():
            for label, root in (("real", PLUGIN), ("broken", broken[name])):
                with self.subTest(case=name, plugin=label):
                    workspace = Workspace(self.tmp, case_dir, root)
                    status = workspace.git("status", "--porcelain")
                    self.assertEqual((status.returncode, status.stdout), (0, ""), status.stderr)
                    for grader in file_graders(load(case_dir)):
                        if grader["match"] == "not_contains":
                            ledger = workspace.path / grader["target"]["path"]
                            self.assertTrue(ledger.is_file(), "{} must exist after the scaffold".format(ledger.name))

    def test_ledgers_start_empty(self):
        for name, ledger in LEDGERS.items():
            with self.subTest(case=name):
                workspace = Workspace(self.tmp, discover()[name], PLUGIN)
                self.assertEqual((workspace.path / ledger).read_text(encoding="utf-8"), "")

    def test_graders_pass_green_and_catch_red(self):
        for name, case_dir in discover().items():
            case = load(case_dir)
            for state in ("green", "red"):
                with self.subTest(case=name, state=state):
                    workspace = Workspace(self.tmp, case_dir, PLUGIN)
                    result = workspace.run_script(case_dir / "states" / (state + ".sh"), EVAL_PLUGIN=str(PLUGIN))
                    self.assertEqual(result.returncode, 0, result.stderr)
                    verdicts = {g["name"]: grade(g, workspace) for g in case["graders"]}
                    if state == "green":
                        self.assertTrue(all(verdicts.values()), verdicts)
                    else:
                        self.assertFalse(all(verdicts.values()), verdicts)

    def test_rag_mock_answers_with_the_cited_source(self):
        mocks = EVALS / "mocks" / "mvp-rag"
        tools = json.loads((mocks / "_tools.json").read_text(encoding="utf-8"))["tools"]
        self.assertEqual([tool["name"] for tool in tools], ["search"])
        self.assertEqual(sorted(p.name for p in mocks.iterdir()), ["_tools.json", "search.md"])
        front, body = re.fullmatch(r"---\n(.*?)\n---\n(.*)", (mocks / "search.md").read_text(encoding="utf-8"), re.S).groups()
        self.assertEqual(front, "type: fixed")
        paths = [hit["path"] for hit in json.loads(body)["hits"]]
        grader = next(g for g in load(discover()["task-brief-consults-rag"])["graders"] if g["name"] == "rag-source-cited")
        self.assertEqual([p for p in paths if re.search(grader["pattern"], p)], paths)
        self.assertEqual(len(paths), 1)
        execution = load(discover()["task-brief-consults-rag"])["execution"]
        self.assertIn(RAG_SEARCH_TOOL, execution["allowed_tools"])

    def test_sync_spec_grader_hash_matches_the_scaffold(self):
        case_dir = discover()["sync-spec-stale"]
        grader = next(g for g in load(case_dir)["graders"] if g["name"] == "synced-by-sync-spec")
        workspace = Workspace(self.tmp, case_dir, PLUGIN)
        prd = workspace.path / "be" / "docs" / "features" / "demo" / "PRD.md"
        self.assertEqual(grader["pattern"], hashlib.sha256(prd.read_bytes()).hexdigest())


class BrokenConfigurationTest(PluginCopies):
    """The real plugin guards what the case exercises; the patched copy does not."""

    def workspace(self, name, root=PLUGIN):
        return Workspace(self.tmp, discover()[name], root)

    def hooks(self, root):
        return json.loads((root / "hooks" / "hooks.json").read_text(encoding="utf-8"))

    def guard(self, hook, event, workspace):
        event = dict(event, cwd=str(workspace.path))
        return run([sys.executable, PLUGIN / "hooks" / "guards.py", hook], workspace.path, workspace.env, json.dumps(event))

    def assertHookCase(self, name, hook, wiring, event, needle):
        real, broken = self.hooks(PLUGIN), self.hooks(self.broken(name))
        for hook_event, tool in wiring:
            self.assertIn(hook, wired(real, hook_event, tool))
            self.assertNotIn(hook, wired(broken, hook_event, tool))
        result = self.guard(hook, event, self.workspace(name))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(needle, result.stderr)

    def bash(self, command):
        return {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}}

    def test_block_main_push(self):
        self.assertHookCase(
            "block-main-push", "block-main-push", [("PreToolUse", "Bash")], self.bash("git push origin main"), "main"
        )

    def test_block_destructive_git(self):
        self.assertHookCase(
            "block-destructive-git",
            "block-destructive-git",
            [("PreToolUse", "Bash")],
            self.bash("git push --force origin feature/report"),
            "force push",
        )

    def test_block_env(self):
        read_env = {"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": ".env"}}
        self.assertHookCase(
            "block-env", "block-env", [("PreToolUse", "Bash"), ("PreToolUse", "Read")], read_env, ".env"
        )
        redirect = self.guard("block-env", self.bash("cut -d= -f1 < .env"), self.workspace("block-env"))
        self.assertEqual(redirect.returncode, 2, redirect.stderr)
        self.assertIn(".env", redirect.stderr)

    def test_sdlc_gate_blocks_unapproved(self):
        name = "sdlc-gate-blocks-unapproved"
        prompt = {"hook_event_name": "UserPromptSubmit", "prompt": load(discover()[name])["execution"]["prompt"]}
        self.assertHookCase(
            name,
            "sdlc-gate-hook",
            [("UserPromptSubmit", None), ("PreToolUse", "Skill")],
            prompt,
            "idea-brief.md has status 'Draft'",
        )

    def test_task_brief_split_large(self):
        name = "task-brief-split-large"
        workspace = self.workspace(name)
        real = run([sys.executable, PLUGIN / "bin" / "task-brief", "demo", "T3"], workspace.path, workspace.env)
        self.assertEqual(real.returncode, 1)
        self.assertIn("split the task", real.stderr)
        broken = self.broken(name)
        patched = run([sys.executable, broken / "bin" / "task-brief", "demo", "T3"], workspace.path, workspace.env)
        self.assertEqual(patched.returncode, 0, patched.stderr)

    def test_task_brief_ac(self):
        name = "task-brief-ac"
        workspace = self.workspace(name)
        outputs = {}
        for label, root in (("real", PLUGIN), ("broken", self.broken(name))):
            result = run([sys.executable, root / "bin" / "task-brief", "demo", "T1"], workspace.path, workspace.env)
            self.assertEqual(result.returncode, 0, result.stderr)
            outputs[label] = result.stdout
        self.assertIn("Exactly three commits", outputs["real"])
        self.assertNotIn("Exactly three commits", outputs["broken"])

    def test_task_brief_consults_rag(self):
        name = "task-brief-consults-rag"
        real = (PLUGIN / "skills" / "task-brief" / "SKILL.md").read_text(encoding="utf-8")
        broken = (self.broken(name) / "skills" / "task-brief" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("## Project knowledge first (mvp-rag)", real)
        self.assertIn(RAG_SEARCH_TOOL, real)
        self.assertNotIn("mvp-rag", broken)

    def test_sync_spec_stale(self):
        name = "sync-spec-stale"
        workspace = self.workspace(name)
        exits = {}
        for label, root in (("real", PLUGIN), ("broken", self.broken(name))):
            command = [sys.executable, root / "bin" / "sync-spec", "demo", "--from", "be", "--check"]
            exits[label] = run(command, workspace.path, workspace.env).returncode
        self.assertEqual(exits, {"real": 1, "broken": 0})

    def test_bootstrap_project_idempotent(self):
        name = "bootstrap-project-idempotent"
        for label, root in (("real", PLUGIN), ("broken", self.broken(name))):
            with self.subTest(plugin=label):
                workspace = self.workspace(name, root)
                result = run([sys.executable, root / "bin" / "bootstrap-project", "be"], workspace.path, workspace.env)
                self.assertEqual(result.returncode, 0, result.stderr)
                kept = "KEEP-THIS-LINE" in (workspace.path / "CLAUDE.md").read_text(encoding="utf-8")
                self.assertEqual(kept, label == "real")
                self.assertEqual(result.stdout.splitlines()[-1] == "No changes", label == "real")

    def skill_text(self, root):
        """Every Markdown file of the rails-data-model skill (SKILL.md and its template), lowercased."""
        skill = root / "skills" / "rails-data-model"
        return "\n".join(path.read_text(encoding="utf-8") for path in sorted(skill.rglob("*.md"))).lower()

    def test_rails_data_model_rules(self):
        # Leaks: wording that still teaches the guarded rule. One left in the patched skill lets the model follow it.
        for name, rule, replacement, leaks in (
            (
                "rails-data-model-no-sql",
                "Never write `.sql` files",
                "schema.sql",
                ["never write `.sql` files", "sql-first", "migrations/<nn>_<name>.rb", "migrations/01_", "ruby -c",
                 "rules/migrations.md"],
            ),
            (
                "rails-data-model-expand-contract",
                "expand → backfill → contract",
                "in a single migration",
                ["expand", "backfill", "concurrently", "safe while old code runs", "rules/migrations.md"],
            ),
        ):
            with self.subTest(case=name):
                broken_root = self.broken(name)
                real = (PLUGIN / "skills" / "rails-data-model" / "SKILL.md").read_text(encoding="utf-8")
                broken = (broken_root / "skills" / "rails-data-model" / "SKILL.md").read_text(encoding="utf-8")
                self.assertIn(rule, real)
                self.assertNotIn(replacement, real)
                self.assertNotIn(rule, broken)
                self.assertIn(replacement, broken)
                real_text, broken_text = self.skill_text(PLUGIN), self.skill_text(broken_root)
                for leak in leaks:
                    self.assertIn(leak, real_text)
                    self.assertNotIn(leak, broken_text)
