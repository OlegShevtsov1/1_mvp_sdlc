import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MERGE_GATE = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "merge-gate.ts");
const PR_URL = "https://github.com/example/repo/pull/3";

interface Result { code: number; doc: Record<string, unknown>; lines: string[]; artifacts: string }

// A pr-state output for a clean, open, ready PR whose head the checkout holds.
function prState(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pr_url: PR_URL,
    read: true,
    head: "feature-x",
    state: "OPEN",
    is_draft: false,
    checkout_is_head: true,
    checkout_clean: true,
    checks: [],
    checks_read: true,
    ...extra,
  });
}

function run(env: Record<string, string>): Result {
  const artifacts = mkdtempSync(join(tmpdir(), "factory-merge-gate-art-"));
  const p = Bun.spawnSync(["bun", MERGE_GATE], {
    cwd: artifacts,
    env: {
      ...process.env,
      ARTIFACTS_DIR: artifacts,
      INPUTS_PR: prState(),
      INPUTS_TEST_COMMAND: "true",
      INPUTS_LINT_COMMAND: "true",
      INPUTS_BUILD_COMMAND: "true",
      INPUTS_SECRET_NAMES: "[]",
      ...env,
    },
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

describe("merge-gate", () => {
  test("a clean, ready PR and green checks → green", () => {
    const r = run({});
    expectOneLine(r);
    expect(r.doc).toEqual({ green: true, pr_url: PR_URL, head: "feature-x", reason: "" });
  });

  test("a failing test command refuses and stops before lint and build", () => {
    const { marks, env } = markerCommands();
    const r = run({ ...env, INPUTS_TEST_COMMAND: "exit 1" });
    expectOneLine(r);
    expect(r.doc).toMatchObject({ green: false, pr_url: PR_URL, head: "feature-x" });
    expect(r.doc.reason).toBe("test command exited 1 on the pull request head; see merge-gate.log");
    expect(existsSync(join(marks, "lint"))).toBe(false);
    expect(existsSync(join(marks, "build"))).toBe(false);
  });

  test("each pr-state guard refuses before any command runs", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["unreadable PR", { read: false, head: "" }, "could not read the pull request from GitHub"],
      ["draft", { is_draft: true }, "not an open, ready pull request (state OPEN, draft true)"],
      ["closed", { state: "CLOSED" }, "not an open, ready pull request (state CLOSED, draft false)"],
      ["merged", { state: "MERGED" }, "not an open, ready pull request (state MERGED, draft false)"],
      ["checkout not head", { checkout_is_head: false }, "the checkout is not the pull request head, so the checks would not test what would be merged"],
      ["dirty checkout", { checkout_clean: false }, "the checkout has uncommitted changes to tracked files"],
      ["unreadable CI checks", { checks_read: false }, "could not read the pull request's CI checks from GitHub"],
    ];
    for (const [, extra, reason] of cases) {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_PR: prState(extra) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ green: false, pr_url: PR_URL, reason });
      expect(existsSync(join(marks, "test"))).toBe(false);
    }
  });

  test("no pull request URL refuses with an empty pr_url and head", () => {
    for (const pr of [prState({ pr_url: "", read: false, head: "" }), prState({ pr_url: `${PR_URL}; rm -rf /` }), "not json", "{}"]) {
      const r = run({ INPUTS_PR: pr });
      expectOneLine(r);
      expect(r.doc).toEqual({ green: false, pr_url: "", head: "", reason: "delivery did not return a GitHub pull request URL" });
    }
  });

  test("a concluded red CI check refuses, naming it, before any command runs", () => {
    for (const bucket of ["fail", "cancel"]) {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_PR: prState({ checks: [{ name: "Lint", bucket: "pass" }, { name: "Tests", bucket }] }) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ green: false, reason: `CI check Tests is ${bucket} on the pull request head` });
      expect(existsSync(join(marks, "test"))).toBe(false);
    }
  });

  test("a passing CI lint check stands in for the local lint command", () => {
    for (const name of ["Lint", "Rails CI / Lint"]) {
      const { marks, env } = markerCommands();
      const r = run({ ...env, INPUTS_LINT_COMMAND: "exit 1", INPUTS_PR: prState({ checks: [{ name, bucket: "pass" }] }) });
      expectOneLine(r);
      expect(r.doc.green).toBe(true);
      expect(existsSync(join(marks, "test"))).toBe(true);
      expect(existsSync(join(marks, "build"))).toBe(true);
      expect(readFileSync(join(r.artifacts, "merge-gate.log"), "utf8")).toContain(`lint: deferred to the pull request's CI check '${name}' (pass)`);
    }
  });

  test("without a passing check named lint, the local lint command runs", () => {
    const checksCases = [[{ name: "Actionlint", bucket: "pass" }], [{ name: "ESLint", bucket: "pass" }], [{ name: "Lint", bucket: "pending" }], []];
    for (const checks of checksCases) {
      const r = run({ INPUTS_LINT_COMMAND: "exit 1", INPUTS_PR: prState({ checks }) });
      expectOneLine(r);
      expect(r.doc).toMatchObject({ green: false, reason: "lint command exited 1 on the pull request head; see merge-gate.log" });
    }
  });

  test("a project with no checks at all is green", () => {
    const r = run({ INPUTS_TEST_COMMAND: "", INPUTS_LINT_COMMAND: "", INPUTS_BUILD_COMMAND: "" });
    expectOneLine(r);
    expect(r.doc.green).toBe(true);
  });

  test("a secret printed by a check never reaches merge-gate.log", () => {
    const r = run({
      INPUTS_TEST_COMMAND: 'echo "token=$FACTORY_TEST_SECRET"',
      INPUTS_SECRET_NAMES: '["FACTORY_TEST_SECRET"]',
      FACTORY_TEST_SECRET: "s3cr3t-value-123",
    });
    expectOneLine(r);
    expect(r.doc.green).toBe(true);
    const log = readFileSync(join(r.artifacts, "merge-gate.log"), "utf8");
    expect(log).toContain("token=***");
    expect(log).not.toContain("s3cr3t-value-123");
  });
});
