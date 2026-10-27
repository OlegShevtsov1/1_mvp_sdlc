#!/usr/bin/env python3
"""Black-box tests for scripts/evals.py with a stub `claude` (no model calls). Run: python3 scripts/test_evals.py"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RUNNER = REPO / "scripts" / "evals.py"
PLUGIN = REPO / "plugins" / "mvp-sdlc"
FIXED_FLAGS = ["--ablation", "none", "--no-publish", "--trust-plugin", "--scaffold", "--allow-tools", "Bash",
               "Write", "Edit", "mcp__plugin_mvp-sdlc_mvp-rag__search", "--threshold", "1"]
RAG_CASE = "task-brief-consults-rag"

# Stub claude: `--version`, and `plugin eval <target> ... --output-dir DIR [--case NAME]` which logs its argv and
# the sha256 of <target>/hooks/hooks.json, then writes aggregate-result.json for the cases under <target>/evals.
# The arm is the parent of --output-dir (green or red). EVAL_STUB_PLAN (JSON) sets per arm and case the runs as
# [passed, error] pairs, or [passed, error, mock calls] for the per-run tool-call log, and the cost of each
# invocation. By default GREEN runs pass with one mock call and RED runs fail with none.
CLAUDE_STUB = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import hashlib, json, os, sys
    from pathlib import Path
    args = sys.argv[1:]
    if args == ["--version"]:
        print("2.1.281 (Claude Code)")
        sys.exit(0)
    target = Path(args[2])
    out = Path(args[args.index("--output-dir") + 1])
    case = args[args.index("--case") + 1] if "--case" in args else None
    hooks = hashlib.sha256((target / "hooks" / "hooks.json").read_bytes()).hexdigest()
    with open(os.environ["EVAL_STUB_LOG"], "a") as log:
        log.write(json.dumps({"argv": args, "hooks_sha256": hooks}) + "\\n")
    plan = json.loads(os.environ["EVAL_STUB_PLAN"])
    arm = "red" if out.parent.name == "red" else "green"
    evals = target / "evals"
    rels = [p.relative_to(evals).parts for p in evals.rglob("case.yaml")]
    names = [case] if case else sorted(r[-2] for r in rels if r[0] != "broken" and r[:2] != ("cases", "_template"))
    cases = []
    for name in names:
        runs = plan.get(arm, {}).get(name, [[arm == "green", None, int(arm == "green")]] * 3)
        cases.append({"name": name, "maxTurns": 8, "timeoutSeconds": 180, "runsPerCase": 3, "arms": {"with": [
            dict({"score": 1 if r[0] else 0, "passed": r[0], "turns": 2, "costUsd": 0.01, "durationSeconds": 5.0,
                  "error": r[1], "tracePath": str(target / "trace.jsonl")},
                 **({"mocks": {"calls": {"total": r[2], "errors": 0, "unmocked": []}}} if len(r) > 2 else {}))
            for r in runs]}})
    out.mkdir(parents=True, exist_ok=True)
    result = {"claudeVersion": "2.1.281", "durationSeconds": 10.0, "costUsd": plan.get("cost", {}).get(arm, 0.1),
              "partial": False, "suite": {"root": str(target)}, "cases": cases}
    (out / "aggregate-result.json").write_text(json.dumps(result))
    failed = any(not r["passed"] for c in cases for r in c["arms"]["with"])
    sys.exit(1 if failed else 0)
    """
)


def write_exe(path, text):
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)


class EvalsRunnerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        write_exe(self.bin / "claude", "#!{}\n{}".format(sys.executable, CLAUDE_STUB.split("\n", 1)[1]))
        for tool in ("bwrap", "socat"):
            write_exe(self.bin / tool, "#!/bin/sh\nexit 0\n")
        self.log = self.tmp / "calls.log"
        self.plan = {}
        self.out = self.tmp / "runs"

    def env(self):
        path = os.pathsep.join([str(self.bin), os.path.dirname(shutil.which("git")), "/usr/bin", "/bin"])
        return dict(os.environ, PATH=path, EVAL_STUB_LOG=str(self.log), EVAL_STUB_PLAN=json.dumps(self.plan))

    def runner(self, *args):
        return subprocess.run(
            [sys.executable, str(RUNNER)] + [str(a) for a in args],
            env=self.env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
        )

    def run_evals(self, *args):
        return self.runner("run", "--out", self.out, *args)

    def results(self):
        target = self.tmp / "results" / "0.1.0.json"
        result = self.runner("results", "--runs", self.out, "--out", target)
        return result, (json.loads(target.read_text(encoding="utf-8")) if target.is_file() else None)

    def calls(self):
        if not self.log.is_file():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def cases(self):
        evals = PLUGIN / "evals"
        rels = [p.relative_to(evals).parts for p in evals.rglob("case.yaml")]
        return sorted(r[-2] for r in rels if r[0] != "broken" and r[:2] != ("cases", "_template"))

    def test_green_and_red_invocations_use_fixed_flags(self):
        result = self.run_evals()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [c["argv"] for c in self.calls()]
        self.assertEqual(len(calls), 1 + len(self.cases()))
        self.assertNotIn("--case", calls[0])
        self.assertEqual(sorted(c[c.index("--case") + 1] for c in calls[1:]), self.cases())
        for argv in calls:
            self.assertEqual(argv[:2], ["plugin", "eval"])
            joined = " ".join(argv)
            self.assertIn(" ".join(FIXED_FLAGS), joined)
            for banned in ("--runs", "--model", "--publish-report"):
                self.assertNotIn(banned, argv)

    def test_red_copy_is_patched_and_green_copy_is_not(self):
        before = self.plugin_status()
        result = self.run_evals("--case", "block-main-push")
        self.assertEqual(result.returncode, 0, result.stderr)
        real = hashlib.sha256((PLUGIN / "hooks" / "hooks.json").read_bytes()).hexdigest()
        green, red = self.calls()
        self.assertEqual(green["hooks_sha256"], real)
        self.assertNotEqual(red["hooks_sha256"], real)
        self.assertEqual(self.plugin_status(), before)

    def plugin_status(self):
        return subprocess.run(["git", "status", "--porcelain", "--", str(PLUGIN)], cwd=str(REPO),
                              stdout=subprocess.PIPE, universal_newlines=True).stdout

    def test_preflight_names_missing_sandbox_tools(self):
        (self.bin / "socat").unlink()
        if shutil.which("socat", path="/usr/bin:/bin"):
            self.skipTest("socat is installed system-wide")
        result = self.run_evals()
        self.assertEqual(result.returncode, 2)
        self.assertIn("socat", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_unknown_case_is_refused(self):
        result = self.run_evals("--case", "no-such-case")
        self.assertEqual(result.returncode, 2)
        self.assertIn("no-such-case", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_out_dir_is_never_overwritten_blindly(self):
        self.out.mkdir()
        (self.out / "notes.txt").write_text("keep me", encoding="utf-8")
        for args in ((), ("--replace",)):
            with self.subTest(args=args):
                result = self.run_evals(*args)
                self.assertEqual(result.returncode, 2)
                self.assertTrue((self.out / "notes.txt").is_file())
        self.assertEqual(self.calls(), [])

    def test_replace_reruns_over_an_earlier_run(self):
        self.assertEqual(self.run_evals("--case", "block-env").returncode, 0)
        self.assertEqual(self.run_evals("--case", "block-env").returncode, 2)
        result = self.run_evals("--case", "block-env", "--replace")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_results_verdicts(self):
        ok, fail, errored = [True, None], [False, None], [True, "sandbox refused Bash"]
        table = [
            ("green 3/3, red 0/3", {}, "PASS", (3, 0, 0, 0)),
            ("green 2/3", {"green": {"block-env": [ok, ok, fail]}}, "FAIL", (2, 0, 0, 0)),
            ("red passes once", {"red": {"block-env": [fail, ok, fail]}}, "FAIL", (3, 0, 1, 0)),
            ("errored run reported as passed", {"green": {"block-env": [ok, ok, errored]}}, "FAIL", (2, 1, 0, 0)),
            ("red run errored", {"red": {"block-env": [fail, [False, "sandbox refused Bash"], fail]}}, "FAIL", (3, 0, 0, 1)),
        ]
        for label, plan, verdict, counts in table:
            with self.subTest(label):
                self.plan.update({"green": {}, "red": {}}, **plan)
                shutil.rmtree(str(self.out), ignore_errors=True)
                self.assertEqual(self.run_evals("--case", "block-env").returncode, 0)
                result, summary = self.results()
                self.assertEqual(result.returncode, 0 if verdict == "PASS" else 1, result.stdout + result.stderr)
                case = summary["cases"][0]
                self.assertEqual((summary["verdict"], case["verdict"], summary["complete"]), (verdict, verdict, False))
                got = (case["green"]["passed"], case["green"]["errors"], case["red"]["passed"], case["red"]["errors"])
                self.assertEqual(got, counts)

    def test_tool_call_case_needs_a_mock_call(self):
        green_no_call, red_with_call = [True, None, 0], [False, None, 1]
        table = [
            ("green calls the mock, red does not", {}, "PASS", (3, 0)),
            ("green passes its graders without a call", {"green": {RAG_CASE: [green_no_call] * 3}}, "FAIL", (0, 0)),
            ("green has no tool-call log", {"green": {RAG_CASE: [[True, None]] * 3}}, "FAIL", (0, 0)),
            ("red calls the mock but fails its graders", {"red": {RAG_CASE: [red_with_call] * 3}}, "PASS", (3, 0)),
        ]
        for label, plan, verdict, counts in table:
            with self.subTest(label):
                self.plan.update({"green": {}, "red": {}}, **plan)
                shutil.rmtree(str(self.out), ignore_errors=True)
                self.assertEqual(self.run_evals("--case", RAG_CASE).returncode, 0)
                result, summary = self.results()
                self.assertEqual(result.returncode, 0 if verdict == "PASS" else 1, result.stdout + result.stderr)
                case = summary["cases"][0]
                self.assertEqual(case["verdict"], verdict)
                self.assertEqual((case["green"]["passed"], case["red"]["passed"]), counts)

    def test_full_run_is_complete(self):
        self.assertEqual(self.run_evals().returncode, 0)
        result, summary = self.results()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((summary["verdict"], summary["complete"]), ("PASS", True))
        self.assertEqual([c["name"] for c in summary["cases"]], self.cases())

    def test_missing_red_result_fails(self):
        self.assertEqual(self.run_evals("--case", "block-env").returncode, 0)
        shutil.rmtree(str(self.out / "red" / "block-env"))
        result, summary = self.results()
        self.assertEqual(result.returncode, 1)
        self.assertEqual((summary["verdict"], summary["complete"], summary["cases"][0]["red"]["runs"]), ("FAIL", False, 0))

    def test_results_without_a_run_exit_2(self):
        result, summary = self.results()
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(summary)

    def test_results_file_has_no_local_paths(self):
        self.assertEqual(self.run_evals().returncode, 0)
        _, summary = self.results()
        text = json.dumps(summary)
        self.assertNotIn(str(self.tmp), text)
        self.assertNotIn(str(REPO), text)

        def strings(value):
            if isinstance(value, dict):
                for item in value.values():
                    yield from strings(item)
            elif isinstance(value, list):
                for item in value:
                    yield from strings(item)
            elif isinstance(value, str):
                yield value

        self.assertEqual([s for s in strings(summary) if s.startswith("/")], [])

    def test_budget_stops_further_invocations(self):
        self.plan["cost"] = {"green": 5.0}
        result = self.run_evals("--max-cost-usd", "5.2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 1)
        record = json.loads((self.out / "run.json").read_text(encoding="utf-8"))
        self.assertTrue(record["budget_exhausted"])
        _, summary = self.results()
        self.assertEqual((summary["verdict"], summary["complete"]), ("FAIL", False))

    def test_budget_below_minimum_runs_nothing_and_fails(self):
        result = self.run_evals("--max-cost-usd", "0.4")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(self.calls(), [])
        self.assertTrue(json.loads((self.out / "run.json").read_text(encoding="utf-8"))["budget_exhausted"])

    def test_ci_runs_hook_tests_but_never_llm_evals(self):
        ci = (REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertRegex(ci, r"(?m)^  pull_request:")
        self.assertRegex(ci, r"(?m)^\s+run: bash scripts/ci/check\.sh mvp_sdlc$")
        self.assertIn('"${tests}"/hooks/test-*.sh', (PLUGIN / "tests" / "run.sh").read_text(encoding="utf-8"))
        for number, line in enumerate(ci.splitlines(), 1):
            self.assertIsNone(re.search(r"make eval|evals\.py run|plugin eval", line), "ci.yml:{}".format(number))


if __name__ == "__main__":
    unittest.main()
