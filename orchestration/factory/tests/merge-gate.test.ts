import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OTHER_COMMAND_TIMEOUT_SECONDS } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/merge-decision.ts";
import { PREFLIGHT_TIMEOUT_MS } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/host-check.ts";
import { CHECKS_WAIT_MS } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/pr-checks.ts";
import { MAX_TEST_TIMEOUT_SECONDS } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/profile.ts";

const PACK = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory");
const MERGE_GATE = join(PACK, "scripts", "merge-gate.ts");
const PR_URL = "https://github.com/example/repo/pull/3";

interface Result { code: number; doc: Record<string, unknown>; lines: string[]; artifacts: string }

// A pr-state output for a clean, open, ready PR whose head the checkout holds.
function prState(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pr_url: PR_URL,
    read: true,
    head: "feature-x",
    base: "develop",
    state: "OPEN",
    is_draft: false,
    checkout_is_head: true,
    checkout_clean: true,
    checks: [],
    checks_read: true,
    ...extra,
  });
}

function bodySync(action: string, reason = ""): string {
  return JSON.stringify({ pr_url: PR_URL, action, source: "pr-body.md", reason });
}

// An undefined value removes that variable from the gate's environment.
function run(env: Record<string, string | undefined>, cwd?: string): Result {
  const artifacts = mkdtempSync(join(tmpdir(), "factory-merge-gate-art-"));
  const merged: Record<string, string | undefined> = {
    ...process.env,
    ARTIFACTS_DIR: artifacts,
    INPUTS_PR: prState(),
    INPUTS_BODY_SYNC: bodySync("unchanged"),
    INPUTS_TEST_COMMAND: "true",
    INPUTS_LINT_COMMAND: "true",
    INPUTS_BUILD_COMMAND: "true",
    INPUTS_SECRET_NAMES: "[]",
    INPUTS_MANUAL_MERGE_BASES: '["main"]',
    ...env,
  };
  const p = Bun.spawnSync(["bun", MERGE_GATE], {
    cwd: cwd ?? artifacts,
    env: Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = p.stdout.toString().trim().split("\n").filter((l) => l !== "");
  return { code: p.exitCode, doc: lines.length === 1 ? JSON.parse(lines[0]) : {}, lines, artifacts };
}

// Every case: exit 0 and exactly one JSON line, so `merge`'s condition is always readable.
function expectOneLine(r: Result): void {
  expect(r.code).toBe(0);
  expect(r.lines.length).toBe(1);
}

// Commands that leave a marker file per check, to see which ones ran.
function markerCommands(): { marks: string; env: Record<string, string> } {
  const marks = mkdtempSync(join(tmpdir(), "factory-merge-gate-marks-"));
  return {
    marks,
    env: {
      INPUTS_TEST_COMMAND: `touch ${marks}/test`,
      INPUTS_LINT_COMMAND: `touch ${marks}/lint`,
      INPUTS_BUILD_COMMAND: `touch ${marks}/build`,
    },
  };
}

const MISSING_TOOL_PREFLIGHT = JSON.stringify({ tools: ["factory-preflight-missing-tool"], services: [], min_disk_free_pct: 0 });

describe("merge-gate", () => {
  test("a clean, ready PR and green checks → green", () => {
    const r = run({});
    expectOneLine(r);
    expect(r.doc).toEqual({ action: "merge", pr_url: PR_URL, head: "feature-x", base: "develop", reason: "", already_merged: false });
  });

  test("a failing test command refuses and stops before lint and build", () => {
    const { marks, env } = markerCommands();
    const r = run({ ...env, INPUTS_TEST_COMMAND: "exit 1" });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "refuse", pr_url: PR_URL, head: "feature-x", base: "develop" });
    expect(r.doc.reason).toBe("failure: test command exited 1 on the pull request head; see merge-gate.log");
    expect(existsSync(join(marks, "lint"))).toBe(false);
    expect(existsSync(join(marks, "build"))).toBe(false);
  });

  test("each pr-state guard refuses before any command runs", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["unreadable PR", { read: false, head: "" }, "failure: could not read the pull request from GitHub"],
      ["draft", { is_draft: true }, "failure: not an open, ready pull request (state OPEN, draft true)"],
      ["closed", { state: "CLOSED" }, "failure: not an open, ready pull request (state CLOSED, draft false)"],
      ["checkout not head", { checkout_is_head: false }, "failure: the checkout is not the pull request head, so the checks would not test what would be merged"],
      ["dirty checkout", { checkout_clean: false }, "failure: the checkout has uncommitted changes to tracked files"],
      ["unreadable CI checks", { checks_read: false }, "failure: could not read the pull request's CI checks from GitHub"],
      ["unreadable base branch", { base: "" }, "failure: could not read the pull request's base branch"],
    ];
    for (const [, extra, reason] of cases) {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_PR: prState(extra) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "refuse", pr_url: PR_URL, reason });
      expect(existsSync(join(marks, "test"))).toBe(false);
    }
  });

  describe("a pull request that is already merged", () => {
    test("at this run's head passes as already merged without running any command", () => {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_TEST_COMMAND: "false", INPUTS_PR: prState({ state: "MERGED", checks_read: false }) });
      expectOneLine(r);
      expect(r.doc).toEqual({ action: "merge", pr_url: PR_URL, head: "feature-x", base: "develop", reason: "", already_merged: true });
      expect(existsSync(join(marks, "lint"))).toBe(false);
      expect(existsSync(join(r.artifacts, "merge-gate.log"))).toBe(false);
    });

    test("by a merge commit that introduced this run's head passes as already merged", () => {
      const r = run({ INPUTS_TEST_COMMAND: "false", INPUTS_PR: prState({ state: "MERGED", checkout_is_head: false, merge_contains_checkout: true }) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "merge", already_merged: true });
    });

    test("at another head is refused", () => {
      const r = run({ INPUTS_PR: prState({ state: "MERGED", checkout_is_head: false, merge_contains_checkout: false }) });
      expectOneLine(r);
      expect(r.doc).toEqual({
        action: "refuse", pr_url: PR_URL, head: "feature-x", base: "develop", already_merged: false,
        reason: "failure: the pull request is already merged, but this run's head (the checkout) was not shown to be in the merge (see pr-state.log), so this run did not count it as delivered",
      });
    });

    test("into a manual base keeps the refusal of a pull request that is not open", () => {
      const r = run({ INPUTS_PR: prState({ state: "MERGED", base: "main" }) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "refuse", already_merged: false, reason: "failure: not an open, ready pull request (state MERGED, draft false)" });
    });
  });

  test("a description pr-body-sync could not republish refuses before any command runs", () => {
    const cases: Array<[string | undefined, string]> = [
      [bodySync("failed", "gh pr edit exited 1: HTTP 502"), "gh pr edit exited 1: HTTP 502"],
      [undefined, "no pr-body-sync result"],
      ["not json", "no pr-body-sync result"],
    ];
    for (const [binding, detail] of cases) {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_BODY_SYNC: binding });
      expectOneLine(r);
      expect(r.doc).toEqual({
        action: "refuse", pr_url: PR_URL, head: "feature-x", base: "develop",
        reason: `failure: the pull request description could not be republished: ${detail}`, already_merged: false,
      });
      for (const mark of ["test", "lint", "build"]) expect(existsSync(join(marks, mark))).toBe(false);
    }
  });

  test("an updated or skipped description does not refuse", () => {
    for (const action of ["updated", "skipped"]) {
      const r = run({ INPUTS_BODY_SYNC: bodySync(action) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "merge", reason: "" });
    }
  });

  test("a pull request that conflicts with its base refuses before any command runs", () => {
    const { marks, env } = markerCommands();
    const r = run({ ...env, INPUTS_PR: prState({ mergeable: "CONFLICTING" }) });
    expectOneLine(r);
    expect(r.doc).toEqual({ action: "refuse", pr_url: PR_URL, head: "feature-x", base: "develop", reason: "conflict: the pull request is not mergeable: it conflicts with develop", already_merged: false });
    expect(existsSync(join(marks, "test"))).toBe(false);
  });

  test("mergeable UNKNOWN or absent does not refuse", () => {
    for (const pr of [prState({ mergeable: "UNKNOWN" }), prState()]) {
      const r = run({ INPUTS_PR: pr });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "merge", reason: "" });
    }
  });

  test("no pull request URL refuses with an empty pr_url and head", () => {
    for (const pr of [prState({ pr_url: "", read: false, head: "" }), prState({ pr_url: `${PR_URL}; rm -rf /` }), "not json", "{}"]) {
      const r = run({ INPUTS_PR: pr });
      expectOneLine(r);
      expect(r.doc).toEqual({ action: "refuse", pr_url: "", head: "", base: "", reason: "failure: delivery did not return a GitHub pull request URL", already_merged: false });
    }
  });

  test("a pending check refuses with how long the factory waited, before any command runs", () => {
    const { marks, env } = markerCommands();
    const r = run({ ...env, INPUTS_PR: prState({ checks: [{ name: "Lint", bucket: "pass" }, { name: "Tests", bucket: "pending" }, { name: "E2E", bucket: "pending" }], checks_settled: false, waited_minutes: 40 }) });
    expectOneLine(r);
    expect(r.doc).toEqual({ action: "refuse", pr_url: PR_URL, head: "feature-x", base: "develop", reason: "pending: checks still pending after 40 min (Tests, E2E)", already_merged: false });
    for (const mark of ["test", "lint", "build"]) expect(existsSync(join(marks, mark))).toBe(false);
  });

  test("checks_settled false with no pending check refuses as pending", () => {
    const cases: Array<[unknown[], string]> = [
      [[{ name: "Tests", bucket: "pass" }], "pending: checks still pending after 40 min (a workflow run on the head is still queued or in progress)"],
      [[], "pending: checks still pending after 40 min (no check has reported on the head yet)"],
    ];
    for (const [checks, reason] of cases) {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_PR: prState({ checks, checks_settled: false, waited_minutes: 40 }) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "refuse", reason });
      expect(existsSync(join(marks, "test"))).toBe(false);
    }
  });

  test("a concluded red check is named before a pending one", () => {
    const r = run({ INPUTS_PR: prState({ checks: [{ name: "Tests", bucket: "pending" }, { name: "Lint", bucket: "fail" }], checks_settled: false, waited_minutes: 40 }) });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "refuse", reason: "failure: CI check Lint is fail on the pull request head" });
  });

  test("a red check that was rerun refuses as flaky-after-rerun; one that was not rerun as failure", () => {
    const cases: Array<[string[], string]> = [
      [["Test"], "flaky-after-rerun: CI check Test failed again after one rerun of a known flaky failure"],
      [["Other"], "failure: CI check Test is fail on the pull request head"],
      [[], "failure: CI check Test is fail on the pull request head"],
    ];
    for (const [rerun, reason] of cases) {
      const r = run({ INPUTS_PR: prState({ checks: [{ name: "Test", bucket: "fail" }], rerun_checks: rerun }) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "refuse", reason });
    }
  });

  test("a rerun check that went green merges", () => {
    const r = run({ INPUTS_PR: prState({ checks: [{ name: "Test", bucket: "pass" }], rerun_checks: ["Test"], checks_settled: true }) });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "merge", reason: "" });
  });

  test("a rebase that conflicted refuses as conflict naming the files and the replan", () => {
    const { marks, env } = markerCommands();
    const r = run({ ...env, INPUTS_PR: prState({ mergeable: "CONFLICTING", rebase: "conflicted", conflict_files: ["a.ts", "docs/b.md"], checks_settled: false }) });
    expectOneLine(r);
    expect(r.doc).toEqual({
      action: "refuse", pr_url: PR_URL, head: "feature-x", base: "develop",
      reason: "conflict: rebasing feature-x onto origin/develop conflicts in a.ts, docs/b.md; the change needs a replan against the current develop",
      already_merged: false,
    });
    expect(existsSync(join(marks, "test"))).toBe(false);
  });

  test("a conflict listing more than 20 files names the first 20 and counts the rest", () => {
    const files = Array.from({ length: 23 }, (_, i) => `f${i}.ts`);
    const r = run({ INPUTS_PR: prState({ mergeable: "CONFLICTING", rebase: "conflicted", conflict_files: files }), INPUTS_REMOTE: "upstream" });
    expectOneLine(r);
    expect(r.doc.reason).toBe(`conflict: rebasing feature-x onto upstream/develop conflicts in ${files.slice(0, 20).join(", ")} and 3 more; the change needs a replan against the current develop`);
  });

  test("a rebase that failed refuses as conflict with git's detail", () => {
    const r = run({ INPUTS_PR: prState({ mergeable: "CONFLICTING", rebase: "failed", rebase_detail: "push rejected:\n ! [rejected] (stale info)" }) });
    expectOneLine(r);
    expect(r.doc).toMatchObject({
      action: "refuse",
      reason: "conflict: the pull request conflicts with develop and the automatic rebase failed: push rejected: ! [rejected] (stale info)",
    });
  });

  test("a rebased pull request whose CI went green merges", () => {
    const r = run({ INPUTS_PR: prState({ mergeable: "UNKNOWN", rebase: "rebased", checks: [{ name: "Tests", bucket: "pass" }], checks_settled: true }) });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "merge", reason: "" });
  });

  test("every refusal reason is one line that starts with its class", () => {
    const { marks } = markerCommands();
    const cases: Array<Record<string, string | undefined>> = [
      { INPUTS_PR: prState({ pr_url: "" }) },
      { INPUTS_PR: prState({ read: false }) },
      { INPUTS_PR: prState({ is_draft: true }) },
      { INPUTS_PR: prState({ mergeable: "CONFLICTING" }) },
      { INPUTS_PR: prState({ mergeable: "CONFLICTING", rebase: "conflicted", conflict_files: ["a"] }) },
      { INPUTS_PR: prState({ mergeable: "CONFLICTING", rebase: "failed", rebase_detail: "x\ny" }) },
      { INPUTS_PR: prState({ checkout_clean: false }) },
      { INPUTS_BODY_SYNC: bodySync("failed", "gh pr edit exited 1:\nHTTP 502") },
      { INPUTS_PR: prState({ checks: [{ name: "T", bucket: "cancel" }] }) },
      { INPUTS_PR: prState({ checks: [{ name: "T", bucket: "fail" }], rerun_checks: ["T"] }) },
      { INPUTS_PR: prState({ checks: [{ name: "T", bucket: "pending" }] }) },
      { INPUTS_TEST_COMMAND: "exit 2" },
      { INPUTS_BUILD_COMMAND: "exit 2" },
      { INPUTS_TEST_COMMAND: `echo x >> ${marks}/runs; sleep 30`, INPUTS_TEST_TIMEOUT_SECONDS: "1" },
      { INPUTS_PREFLIGHT: MISSING_TOOL_PREFLIGHT },
    ];
    for (const env of cases) {
      const r = run(env);
      expectOneLine(r);
      expect(r.doc.action).toBe("refuse");
      expect(r.doc.reason).toMatch(/^(pending|flaky-after-rerun|failure|timeout|conflict|preflight): [^\n]+$/);
    }
  }, 60_000);

  test("a host the profile's preflight finds lacking refuses as preflight before the test command runs", () => {
    const { marks, env } = markerCommands();
    const r = run({ ...env, INPUTS_PREFLIGHT: MISSING_TOOL_PREFLIGHT });
    expectOneLine(r);
    expect(r.doc.action).toBe("refuse");
    expect(r.doc.reason).toMatch(/^preflight: tools not on PATH: factory-preflight-missing-tool — .*; the pull request stays open — fix it on the Archon host, then start a new run$/);
    expect(existsSync(join(marks, "test"))).toBe(false);
    expect(readFileSync(join(r.artifacts, "merge-gate.log"), "utf8")).toContain("factory-preflight-missing-tool");
  });

  test("a host the profile's preflight finds ready goes on to the commands and merges", () => {
    const listener = Bun.listen({ hostname: "localhost", port: 0, socket: { data() {} } });
    try {
      const { marks, env } = markerCommands();
      const preflight = { tools: ["bash"], services: [{ name: "db", tcp: `localhost:${listener.port}`, start: "" }], min_disk_free_pct: 1 };
      const r = run({ ...env, INPUTS_PREFLIGHT: JSON.stringify(preflight) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "merge", reason: "" });
      expect(existsSync(join(marks, "test"))).toBe(true);
    } finally {
      listener.stop(true);
    }
  });

  test("ignored __pycache__ and .terraform leftovers are removed before the test command; other ignored and untracked files stay", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-merge-gate-repo-"));
    const sh = (command: string) => Bun.spawnSync(["bash", "-c", command], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(repo, ".gitignore"), "__pycache__/\n.terraform/\nnode_modules/\n.tools/\n.env\n");
    writeFileSync(join(repo, "tracked.txt"), "a\n");
    sh("git init -q -b main && git config user.email t@e.com && git config user.name t && git add .gitignore tracked.txt && git commit -q -m init");
    const files = ["app/__pycache__/x.pyc", "infra/mod/.terraform/p", "node_modules/x/i", ".tools/bin/b", ".env", "keep.txt"];
    for (const f of files) {
      mkdirSync(join(repo, f, ".."), { recursive: true });
      writeFileSync(join(repo, f), "x\n");
    }
    const r = run({ INPUTS_TEST_COMMAND: "test ! -e app/__pycache__ && test ! -e infra/mod/.terraform" }, repo);
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "merge", reason: "" });
    for (const f of ["node_modules/x/i", ".tools/bin/b", ".env", "keep.txt", "tracked.txt"]) expect(existsSync(join(repo, f))).toBe(true);
    const log = readFileSync(join(r.artifacts, "merge-gate.log"), "utf8");
    expect(log).toContain("app/__pycache__/");
    expect(log).toContain("infra/mod/.terraform/");
  });

  test("factory.yaml binds the remote and the flaky patterns into pr-state and the remote into merge-gate", () => {
    const yaml = Bun.YAML.parse(readFileSync(join(PACK, "factory.yaml"), "utf8")) as {
      nodes: { id: string; timeout?: number; with?: Record<string, unknown>; output_format?: { properties: Record<string, unknown>; required: string[] } }[];
    };
    const loadProfile = yaml.nodes.find((n) => n.id === "load-profile");
    expect(loadProfile?.output_format?.properties.flaky_patterns).toEqual({ type: "array", items: { type: "string" } });
    expect(loadProfile?.output_format?.required).toContain("flaky_patterns");
    const prStateNode = yaml.nodes.find((n) => n.id === "pr-state");
    expect(prStateNode?.with?.flaky_patterns).toBe("$load-profile.output.flaky_patterns");
    expect(prStateNode?.with?.remote).toBe("$load-profile.output.remote");
    expect(yaml.nodes.find((n) => n.id === "merge-gate")?.with?.remote).toBe("$load-profile.output.remote");
    expect(yaml.nodes.find((n) => n.id === "merge-gate")?.output_format?.required).toContain("already_merged");
    // Two windows, two more after a flaky rerun, plus fetch, push, rerun and the head re-reads.
    expect(prStateNode?.timeout ?? 0).toBeGreaterThanOrEqual(4 * CHECKS_WAIT_MS + 15 * 60_000);
  });

  test("a concluded red CI check refuses, naming it, before any command runs", () => {
    for (const bucket of ["fail", "cancel"]) {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_PR: prState({ checks: [{ name: "Lint", bucket: "pass" }, { name: "Tests", bucket }] }) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "refuse", reason: `failure: CI check Tests is ${bucket} on the pull request head` });
      expect(existsSync(join(marks, "test"))).toBe(false);
    }
  });

  test("a passing CI lint check stands in for the local lint command", () => {
    for (const name of ["Lint", "Rails CI / Lint"]) {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_LINT_COMMAND: "exit 1", INPUTS_PR: prState({ checks: [{ name, bucket: "pass" }] }) });
      expectOneLine(r);
      expect(r.doc.action).toBe("merge");
      expect(existsSync(join(marks, "test"))).toBe(true);
      expect(existsSync(join(marks, "build"))).toBe(true);
      expect(readFileSync(join(r.artifacts, "merge-gate.log"), "utf8")).toContain(`lint: deferred to the pull request's CI check '${name}' (pass)`);
    }
  });

  test("without a passing check named lint, the local lint command runs", () => {
    const checksCases = [[{ name: "Actionlint", bucket: "pass" }], [{ name: "ESLint", bucket: "pass" }], [{ name: "Lint", bucket: "skipping" }], []];
    for (const checks of checksCases) {
      const r = run({ INPUTS_LINT_COMMAND: "exit 1", INPUTS_PR: prState({ checks }) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "refuse", reason: "failure: lint command exited 1 on the pull request head; see merge-gate.log" });
    }
  });

  test("a project with no checks at all is green", () => {
    const r = run({ INPUTS_TEST_COMMAND: "", INPUTS_LINT_COMMAND: "", INPUTS_BUILD_COMMAND: "" });
    expectOneLine(r);
    expect(r.doc.action).toBe("merge");
  });

  test("a green PR into a manual base is handed to the operator after every check ran", () => {
    const { marks, env } = markerCommands();
    const r = run({ ...env, INPUTS_PR: prState({ base: "main" }) });
    expectOneLine(r);
    expect(r.doc).toEqual({ action: "notify", pr_url: PR_URL, head: "feature-x", base: "main", reason: "", already_merged: false });
    for (const check of ["test", "lint", "build"]) expect(existsSync(join(marks, check))).toBe(true);
  });

  test("a red PR into a manual base is refused, not handed to the operator", () => {
    const r = run({ INPUTS_TEST_COMMAND: "exit 1", INPUTS_PR: prState({ base: "main" }) });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "refuse", base: "main", reason: "failure: test command exited 1 on the pull request head; see merge-gate.log" });
  });

  test("an empty manual_merge_bases lets the factory merge into main", () => {
    const r = run({ INPUTS_PR: prState({ base: "main" }), INPUTS_MANUAL_MERGE_BASES: "[]" });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "merge", base: "main" });
  });

  test("without manual_merge_bases, main is a manual base", () => {
    const r = run({ INPUTS_PR: prState({ base: "main" }), INPUTS_MANUAL_MERGE_BASES: undefined });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "notify", base: "main" });
  });

  test("a secret printed by a check never reaches merge-gate.log", () => {
    const r = run({
      INPUTS_TEST_COMMAND: 'echo "token=$FACTORY_TEST_SECRET"',
      INPUTS_SECRET_NAMES: '["FACTORY_TEST_SECRET"]',
      FACTORY_TEST_SECRET: "s3cr3t-value-123",
    });
    expectOneLine(r);
    expect(r.doc.action).toBe("merge");
    const log = readFileSync(join(r.artifacts, "merge-gate.log"), "utf8");
    expect(log).toContain("token=***");
    expect(log).not.toContain("s3cr3t-value-123");
  });

  // A slow test command, stubbed: each run appends a line to `runs`, then
  // outlives the 1 s limit the binding sets.
  function slowTest(): { marks: string; runs: () => number; env: Record<string, string> } {
    const { marks, env } = markerCommands();
    return {
      marks,
      runs: () => (existsSync(join(marks, "runs")) ? readFileSync(join(marks, "runs"), "utf8").split("\n").filter((l) => l !== "").length : 0),
      env: { ...env, INPUTS_TEST_TIMEOUT_SECONDS: "1" },
    };
  }

  test("a test command that times out twice refuses with a timeout, not a failing test", () => {
    const { marks, runs, env } = slowTest();
    const r = run({ ...env, INPUTS_TEST_COMMAND: `echo x >> ${marks}/runs; sleep 30` });
    expectOneLine(r);
    expect(r.doc).toEqual({
      action: "refuse", pr_url: PR_URL, head: "feature-x", base: "develop",
      reason: "timeout: test command timed out after 1 s on the pull request head, and again on its one retry; see merge-gate.log",
      already_merged: false,
    });
    expect(runs()).toBe(2);
    expect(existsSync(join(marks, "lint"))).toBe(false);
    expect(existsSync(join(marks, "build"))).toBe(false);
    expect(readFileSync(join(r.artifacts, "merge-gate.log"), "utf8")).toContain("test: timed out after 1 s; retrying once");
  }, 15_000);

  test("a test command that times out once and passes on its retry goes on to merge", () => {
    const { marks, env } = slowTest();
    const r = run({ ...env, INPUTS_TEST_COMMAND: `if [ -e ${marks}/once ]; then true; else touch ${marks}/once; sleep 30; fi` });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "merge", reason: "" });
    expect(existsSync(join(marks, "lint"))).toBe(true);
    expect(existsSync(join(marks, "build"))).toBe(true);
  }, 15_000);

  test("a test command that times out and then fails on its retry reports the failure", () => {
    const { marks, env } = slowTest();
    const r = run({ ...env, INPUTS_TEST_COMMAND: `if [ -e ${marks}/once ]; then exit 3; else touch ${marks}/once; sleep 30; fi` });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "refuse", reason: "failure: test command exited 3 on the pull request head; see merge-gate.log" });
  }, 15_000);

  test("a failing test command is not retried", () => {
    const { marks, runs, env } = slowTest();
    const r = run({ ...env, INPUTS_TEST_COMMAND: `echo x >> ${marks}/runs; exit 1` });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "refuse", reason: "failure: test command exited 1 on the pull request head; see merge-gate.log" });
    expect(runs()).toBe(1);
  }, 15_000);

  test("a test command that exits 124 by itself is reported as exiting 124, not retried", () => {
    const { marks, runs, env } = slowTest();
    const r = run({ ...env, INPUTS_TEST_COMMAND: `echo x >> ${marks}/runs; exit 124` });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ action: "refuse", reason: "failure: test command exited 124 on the pull request head; see merge-gate.log" });
    expect(runs()).toBe(1);
  }, 15_000);

  test("an absent or unreadable test_timeout_seconds binding still runs the test command", () => {
    for (const binding of [undefined, "", "abc", "0"]) {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_TEST_TIMEOUT_SECONDS: binding });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ action: "merge", reason: "" });
      expect(existsSync(join(marks, "test"))).toBe(true);
    }
  });

  test("factory.yaml binds the profile's test_timeout_seconds into merge-gate", () => {
    const yaml = Bun.YAML.parse(readFileSync(join(PACK, "factory.yaml"), "utf8")) as {
      nodes: { id: string; with?: Record<string, unknown>; output_format?: { properties: Record<string, unknown>; required: string[] } }[];
    };
    const loadProfile = yaml.nodes.find((n) => n.id === "load-profile");
    expect(loadProfile?.output_format?.properties.test_timeout_seconds).toEqual({ type: "number" });
    expect(loadProfile?.output_format?.required).toContain("test_timeout_seconds");
    const gate = yaml.nodes.find((n) => n.id === "merge-gate");
    expect(gate?.with?.test_timeout_seconds).toBe("$load-profile.output.test_timeout_seconds");
  });

  // Worst case: the test command at the largest limit, timed out and retried,
  // then lint and build at theirs; the margin covers the kill grace and startup.
  test("the merge-gate node timeout covers a retried test at the maximum limit plus lint and build", () => {
    const yaml = Bun.YAML.parse(readFileSync(join(PACK, "factory.yaml"), "utf8")) as { nodes: { id: string; timeout?: number }[] };
    const timeout = yaml.nodes.find((n) => n.id === "merge-gate")?.timeout ?? 0;
    expect(timeout).toBeGreaterThanOrEqual((2 * MAX_TEST_TIMEOUT_SECONDS + 2 * OTHER_COMMAND_TIMEOUT_SECONDS) * 1000 + PREFLIGHT_TIMEOUT_MS + 300_000);
  });
});
