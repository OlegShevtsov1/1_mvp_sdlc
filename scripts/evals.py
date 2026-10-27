#!/usr/bin/env python3
"""LLM evals of the mvp-sdlc plugin (evals layer 1): runs `claude plugin eval` and summarizes the results.

Every run makes model calls and costs money: it runs by hand before a version bump (make eval), never in CI.

Usage:
  evals.py run --out DIR [--case NAME]... [--jobs N] [--max-cost-usd X] [--replace]
  evals.py results --runs DIR --out FILE

run: the GREEN arm evaluates a copy of the plugin; the RED arm evaluates, per case, a copy with
evals/broken/<case>.patch applied. Raw CLI output stays in DIR (it holds local paths, never commit it).
results: writes the verdict file (no paths, prompts or traces). A case is PASS when GREEN passed 3 of 3 runs and
RED failed 3 of 3, every run without an error; a run with an error never counts as passed, and in a case of
TOOL_CALL_CASES neither does a run whose tool-call log shows no successful call of a mocked MCP tool.
Exit codes: run 0 at least one invocation ran and every one produced a result (also when the budget stopped it
early), 1 otherwise,
2 usage or preflight error; results 0 PASS, 1 FAIL, 2 no run directory.
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLUGIN = REPO / "plugins" / "mvp-sdlc"
ALLOW_TOOLS = ["Bash", "Write", "Edit", "mcp__plugin_mvp-sdlc_mvp-rag__search"]
# Cases that assert a call of a mocked MCP tool (evals/mocks/), read from the CLI's per-run tool-call log.
TOOL_CALL_CASES = {"task-brief-consults-rag"}
REQUIRED = ["claude", "bwrap", "socat", "git"]
SANDBOX_TOOLS = {"bwrap", "socat"}
RUNS_PER_CASE = 3
RUN_RECORD = "run.json"
RESULT = "aggregate-result.json"
MIN_BUDGET_USD = 0.5


class UsageError(Exception):
    pass


def discover(plugin):
    """Case names under <plugin>/evals/, except the broken/ patches and cases/_template/."""
    evals = plugin / "evals"
    names = []
    for path in sorted(evals.rglob("case.yaml")):
        rel = path.relative_to(evals).parts
        if rel[0] != "broken" and rel[:2] != ("cases", "_template"):
            names.append(path.parent.name)
    return sorted(names)


def plugin_version(plugin):
    return json.loads((plugin / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))["version"]


def preflight():
    missing = [tool for tool in REQUIRED if shutil.which(tool) is None]
    if missing:
        hint = ""
        if SANDBOX_TOOLS & set(missing):
            hint = " (bwrap and socat are the OS sandbox that `claude plugin eval` needs to grant Bash)"
        raise UsageError("missing on PATH: {}{}".format(", ".join(missing), hint))
    result = subprocess.run(["claude", "--version"], stdout=subprocess.PIPE, universal_newlines=True)
    return result.stdout.strip()


def prepare_out(out, replace):
    if out.exists() and any(out.iterdir()):
        if not replace:
            raise UsageError("{} is not empty (pass --replace to rerun)".format(out))
        if not (out / RUN_RECORD).is_file():
            raise UsageError("{} is not empty and has no {}: refusing to remove it".format(out, RUN_RECORD))
        shutil.rmtree(str(out))
    out.mkdir(parents=True, exist_ok=True)


def plugin_copy(plugin, workdir, patch=None):
    """A copy the CLI accepts (no group/other write bits), with `patch` applied when given."""
    copy = Path(tempfile.mkdtemp(dir=str(workdir))) / plugin.name
    shutil.copytree(str(plugin), str(copy), ignore=shutil.ignore_patterns("__pycache__"))
    if patch is not None:
        env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(copy.parent))
        for args in (["apply", "--check"], ["apply"]):
            subprocess.run(["git"] + args + [str(patch)], cwd=str(copy), env=env, check=True)
    subprocess.run(["chmod", "-R", "go-w", str(copy)], check=True)
    return copy


def eval_command(copy, output_dir, jobs, budget, case=None):
    command = ["claude", "plugin", "eval", str(copy), "--ablation", "none", "--no-publish", "--trust-plugin",
               "--scaffold", "--allow-tools"] + ALLOW_TOOLS
    command += ["--threshold", "1", "-j", str(jobs), "--max-cost-usd", "{:.2f}".format(budget),
                "--output-dir", str(output_dir)]
    if case is not None:
        command += ["--case", case]
    return command


class Runner:
    def __init__(self, args, out, workdir):
        self.args = args
        self.out = out
        self.workdir = workdir
        self.remaining = args.max_cost_usd
        self.invocations = []
        self.budget_exhausted = False

    def invoke(self, arm, copy, output_dir, case=None):
        if self.remaining < MIN_BUDGET_USD:
            self.budget_exhausted = True
            return
        result = subprocess.run(eval_command(copy, output_dir, self.args.jobs, self.remaining, case))
        aggregate = output_dir / RESULT
        cost = 0.0
        if aggregate.is_file():
            cost = float(json.loads(aggregate.read_text(encoding="utf-8")).get("costUsd") or 0)
        self.remaining -= cost
        self.invocations.append({
            "arm": arm,
            "case": case,
            "exit_code": result.returncode,
            "cost_usd": round(cost, 4),
            "ok": result.returncode in (0, 1) and aggregate.is_file(),
        })

    def run(self, plugin, cases):
        green = plugin_copy(plugin, self.workdir)
        for case in cases or [None]:
            output = self.out / "green" / case if case else self.out / "green"
            self.invoke("green", green, output, case)
        for case in cases or discover(plugin):
            if self.budget_exhausted:
                break
            red = plugin_copy(plugin, self.workdir, plugin / "evals" / "broken" / (case + ".patch"))
            self.invoke("red", red, self.out / "red" / case, case)


def cmd_run(args):
    plugin = PLUGIN.resolve()
    out = args.out.resolve()
    claude_version = preflight()
    known = discover(plugin)
    unknown = sorted(set(args.case) - set(known))
    if unknown:
        raise UsageError("unknown case(s): {}; known: {}".format(", ".join(unknown), ", ".join(known)))
    prepare_out(out, args.replace)
    started = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with tempfile.TemporaryDirectory(prefix="mvp-sdlc-eval-") as workdir:
        runner = Runner(args, out, Path(workdir))
        runner.run(plugin, sorted(set(args.case)))
    record = {
        "plugin": plugin.name,
        "version": plugin_version(plugin),
        "claude_version": claude_version,
        "started_at": started,
        "cases_requested": sorted(set(args.case)),
        "cases_known": known,
        "max_cost_usd": args.max_cost_usd,
        "budget_exhausted": runner.budget_exhausted,
        "invocations": runner.invocations,
    }
    (out / RUN_RECORD).write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    for item in runner.invocations:
        print("{:<6} {:<36} exit {} cost {:.2f} USD".format(
            item["arm"], item["case"] or "(all cases)", item["exit_code"], item["cost_usd"]))
    if runner.budget_exhausted:
        print("budget exhausted: the run is incomplete")
    return 0 if runner.invocations and all(item["ok"] for item in runner.invocations) else 1


# ---------------------------------------------------------------- results


def load_aggregate(path):
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def arm_cases(aggregate):
    return {case["name"]: case for case in (aggregate or {}).get("cases", [])}


def called_a_mock(run):
    calls = (run.get("mocks") or {}).get("calls") or {}
    return (calls.get("total") or 0) >= 1 and (calls.get("errors") or 0) == 0


def arm_summary(case):
    runs = ((case or {}).get("arms") or {}).get("with") or []
    needs_call = (case or {}).get("name") in TOOL_CALL_CASES
    return {
        "runs": len(runs),
        "passed": sum(
            1 for r in runs
            if r.get("passed") is True and r.get("error") is None and (not needs_call or called_a_mock(r))
        ),
        "errors": sum(1 for r in runs if r.get("error") is not None),
        "max_turns_used": max([r.get("turns") or 0 for r in runs] or [0]),
        "duration_seconds": round(sum(r.get("durationSeconds") or 0 for r in runs), 1),
        "cost_usd": round(sum(r.get("costUsd") or 0 for r in runs), 4),
    }


def case_verdict(green, red):
    green_ok = green["runs"] == RUNS_PER_CASE and green["passed"] == RUNS_PER_CASE and green["errors"] == 0
    red_ok = red["runs"] == RUNS_PER_CASE and red["passed"] == 0 and red["errors"] == 0
    return "PASS" if green_ok and red_ok else "FAIL"


def cmd_results(args):
    runs = args.runs.resolve()
    record_path = runs / RUN_RECORD
    if not record_path.is_file():
        print("evals.py: no {} in {}: run `make eval` first".format(RUN_RECORD, runs), file=sys.stderr)
        return 2
    record = json.loads(record_path.read_text(encoding="utf-8"))
    green_aggregates = [load_aggregate(p) for p in sorted((runs / "green").rglob(RESULT))]
    green_cases = {}
    for aggregate in green_aggregates:
        green_cases.update(arm_cases(aggregate))
    red_aggregates = {}
    for case in record["cases_known"]:
        red_aggregates[case] = load_aggregate(runs / "red" / case / RESULT)
    aggregates = [a for a in green_aggregates + list(red_aggregates.values()) if a]

    names = record["cases_requested"] or record["cases_known"]
    cases = []
    for name in names:
        green = arm_summary(green_cases.get(name))
        red = arm_summary(arm_cases(red_aggregates.get(name)).get(name))
        source = green_cases.get(name) or arm_cases(red_aggregates.get(name)).get(name) or {}
        cases.append({
            "name": name,
            "max_turns": source.get("maxTurns"),
            "timeout_seconds": source.get("timeoutSeconds"),
            "green": green,
            "red": red,
            "verdict": case_verdict(green, red),
        })
    complete = (
        not record["budget_exhausted"]
        and set(names) == set(record["cases_known"])
        and all(c["green"]["runs"] and c["red"]["runs"] for c in cases)
    )
    invocations_ok = all(item["ok"] for item in record["invocations"]) and not any(a.get("partial") for a in aggregates)
    passed = bool(cases) and invocations_ok and not record["budget_exhausted"] and all(c["verdict"] == "PASS" for c in cases)
    summary = {
        "plugin": record["plugin"],
        "version": record["version"],
        "claude_version": record["claude_version"],
        "started_at": record["started_at"],
        "ablation": "none",
        "runs_per_case": RUNS_PER_CASE,
        "complete": complete,
        "verdict": "PASS" if passed else "FAIL",
        "duration_seconds": round(sum(a.get("durationSeconds") or 0 for a in aggregates), 1),
        "cost_usd": round(sum(a.get("costUsd") or 0 for a in aggregates), 4),
        "cases": cases,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    for case in cases:
        print("{:<36} {} green {}/{} red {}/{} passed, errors {}".format(
            case["name"], case["verdict"], case["green"]["passed"], case["green"]["runs"], case["red"]["passed"],
            case["red"]["runs"], case["green"]["errors"] + case["red"]["errors"]))
    print("{} (complete: {}) -> {}".format(summary["verdict"], str(complete).lower(), args.out))
    return 0 if passed else 1


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command")
    run = sub.add_parser("run", help="run the GREEN and RED arms (model calls)")
    run.add_argument("--out", type=Path, required=True)
    run.add_argument("--case", action="append", default=[], metavar="NAME")
    run.add_argument("--jobs", type=int, default=2)
    run.add_argument("--max-cost-usd", type=float, default=40.0, help="total budget for all invocations")
    run.add_argument("--replace", action="store_true", help="remove an earlier run in --out (only if it has run.json)")
    results = sub.add_parser("results", help="summarize a run into the verdict file")
    results.add_argument("--runs", type=Path, required=True)
    results.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command is None:
        parser.error("choose run or results")
    try:
        return cmd_run(args) if args.command == "run" else cmd_results(args)
    except UsageError as exc:
        print("evals.py: {}".format(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
