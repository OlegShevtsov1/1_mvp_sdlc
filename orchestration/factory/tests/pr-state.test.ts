import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CiCheck, ciRefusal } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/merge-decision.ts";

const PR_STATE = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "pr-state.ts");
const PR_URL = "https://github.com/example/repo/pull/3";

function sh(cwd: string, command: string): string {
  const p = Bun.spawnSync(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  return p.stdout.toString().trim();
}

// A repository with one committed file; returns its path and HEAD.
function newRepo(): { repo: string; head: string } {
  const repo = mkdtempSync(join(tmpdir(), "factory-pr-state-repo-"));
  sh(repo, "git init -q -b main && git config user.email t@e.com && git config user.name t && echo a > tracked.txt && git add tracked.txt && git commit -q -m init");
  return { repo, head: sh(repo, "git rev-parse HEAD") };
}

// A fake `gh` first on PATH that records its argv. `pr view` with statusCheckRollup
// prints the n-th FAKE_GH_ROLLUP_<n>, or FAKE_GH_ROLLUP once the numbered answers
// run out, and exits FAKE_GH_ROLLUP_EXIT; any other `pr view` prints FAKE_GH_JSON
// and exits FAKE_GH_EXIT. `api` prints the n-th FAKE_GH_RUNS_<n>, or FAKE_GH_RUNS.
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-pr-state-bin-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/gh.args"
next() { local n=$(( $(cat "${dir}/$1" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/$1"; echo "$n"; }
case "$1 $2" in
  "pr view")
    if [[ "$*" == *statusCheckRollup* ]]; then
      var="FAKE_GH_ROLLUP_$(next rollup)"; printf '%s' "\${!var:-$FAKE_GH_ROLLUP}"; exit "\${FAKE_GH_ROLLUP_EXIT:-0}"
    fi
    printf '%s' "$FAKE_GH_JSON"; exit "\${FAKE_GH_EXIT:-0}" ;;
esac
if [ "$1" = api ]; then var="FAKE_GH_RUNS_$(next runs)"; printf '%s' "\${!var:-$FAKE_GH_RUNS}"; exit 0; fi
exit 1
`,
  );
  chmodSync(gh, 0o755);
  return dir;
}

function rollup(entries: Record<string, unknown>[]): string {
  return JSON.stringify({ statusCheckRollup: entries });
}

interface Result { code: number; doc: Record<string, unknown>; lines: string[]; bin: string }

function run(repo: string, env: Record<string, string>): Result {
  const bin = fakeGh();
  const p = Bun.spawnSync(["bun", PR_STATE], {
    cwd: repo,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_ROLLUP: rollup([]), FAKE_GH_RUNS: "0",
      PR_STATE_POLL_MS: "1", PR_STATE_WAIT_MS: "1000", ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = p.stdout.toString().trim().split("\n").filter((l) => l !== "");
  expect(p.exitCode).toBe(0);
  expect(lines.length).toBe(1);
  return { code: p.exitCode, doc: JSON.parse(lines[0]), lines, bin };
}

function prJson(head: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ headRefOid: head, headRefName: "feature-x", isDraft: false, state: "OPEN", baseRefName: "develop", mergeable: "MERGEABLE", ...extra });
}

const DELIVERY = JSON.stringify({ pr_url: PR_URL });

const OLD = "2026-10-28T14:00:00Z";
const NEW = "2026-10-28T14:48:00Z";

function checkRun(name: string, status: string, conclusion: string, startedAt: string | null): Record<string, unknown> {
  return { __typename: "CheckRun", name, workflowName: "TDD check", status, conclusion, startedAt, completedAt: status === "COMPLETED" ? startedAt : null };
}

const CANCELLED = checkRun("TDD RED on the test commit", "COMPLETED", "CANCELLED", NEW);
const OLD_GREEN = checkRun("TDD RED on the test commit", "COMPLETED", "SUCCESS", OLD);
const NEW_GREEN = checkRun("TDD RED on the test commit", "COMPLETED", "SUCCESS", "2026-10-28T14:49:00Z");

const ghArgs = (r: Result) => readFileSync(join(r.bin, "gh.args"), "utf8");
const rollupReads = (r: Result) => ghArgs(r).match(/--json statusCheckRollup/g)?.length ?? 0;

describe("pr-state", () => {
  test("a delivery report ({ready, reason, pr_url}) reads the PR and its checks", () => {
    const { repo, head } = newRepo();
    const r = run(repo, {
      INPUTS_DELIVERY: JSON.stringify({ ready: true, reason: "delivered", pr_url: PR_URL, ci_rerun: "none", threads_checked: true, summary: "x" }),
      FAKE_GH_JSON: prJson(head),
      FAKE_GH_ROLLUP: rollup([checkRun("Lint", "COMPLETED", "SUCCESS", OLD), checkRun("Tests", "COMPLETED", "FAILURE", OLD)]),
    });
    expect(r.doc).toEqual({
      pr_url: PR_URL,
      read: true,
      head: "feature-x",
      base: "develop",
      state: "OPEN",
      mergeable: "MERGEABLE",
      is_draft: false,
      checkout_is_head: true,
      checkout_clean: true,
      checks: [{ name: "Lint", bucket: "pass" }, { name: "Tests", bucket: "fail" }],
      checks_read: true,
    });
    expect(ghArgs(r)).toContain(`pr view ${PR_URL} --json headRefOid,headRefName,isDraft,state,baseRefName,mergeable`);
    expect(ghArgs(r)).toContain(`pr view ${PR_URL} --json statusCheckRollup`);
  });

  test("a delivery with no GitHub pull request URL never calls gh", () => {
    const { repo, head } = newRepo();
    for (const delivery of ["{}", "not json", JSON.stringify({ url: PR_URL }), JSON.stringify({ pr_url: `${PR_URL}; rm -rf /` })]) {
      const r = run(repo, { INPUTS_DELIVERY: delivery, FAKE_GH_JSON: prJson(head) });
      expect(r.doc).toMatchObject({ pr_url: "", read: false, head: "" });
      expect(existsSync(join(r.bin, "gh.args"))).toBe(false);
    }
  });

  test("an unreadable pull request is reported unread", () => {
    const { repo, head } = newRepo();
    const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head), FAKE_GH_EXIT: "1" });
    expect(r.doc).toMatchObject({ pr_url: PR_URL, read: false, head: "", base: "", mergeable: "" });
  });

  test("a pull request whose base branch is missing is reported unread", () => {
    const { repo, head } = newRepo();
    const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head, { baseRefName: undefined }) });
    expect(r.doc).toMatchObject({ pr_url: PR_URL, read: false, head: "", base: "" });
  });

  test("a draft or not-open pull request is reported as such", () => {
    const { repo, head } = newRepo();
    expect(run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head, { isDraft: true }) }).doc).toMatchObject({ read: true, is_draft: true });
    expect(run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head, { state: "MERGED" }) }).doc).toMatchObject({ read: true, state: "MERGED" });
  });

  test("mergeable is reported as GitHub states it, empty when missing", () => {
    const { repo, head } = newRepo();
    expect(run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head, { mergeable: "CONFLICTING" }) }).doc).toMatchObject({ read: true, mergeable: "CONFLICTING" });
    expect(run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head, { mergeable: undefined }) }).doc).toMatchObject({ read: true, mergeable: "" });
  });

  test("a checkout that is not the PR head is reported", () => {
    const { repo } = newRepo();
    const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson("0".repeat(40)) });
    expect(r.doc).toMatchObject({ read: true, checkout_is_head: false, checkout_clean: true });
  });

  test("an uncommitted change to a tracked file is reported; an untracked file is not", () => {
    const { repo, head } = newRepo();
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    expect(run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head) }).doc.checkout_clean).toBe(true);
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    expect(run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head) }).doc.checkout_clean).toBe(false);
  });

  test("an unreadable rollup is reported unread", () => {
    const { repo, head } = newRepo();
    for (const env of [{ FAKE_GH_ROLLUP_EXIT: "1" }, { FAKE_GH_ROLLUP: "garbage" }, { FAKE_GH_ROLLUP: "{}" }]) {
      const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head), ...env });
      expect(r.doc).toMatchObject({ read: true, checks: [], checks_read: false });
    }
  });

  test("a head with no checks reports an empty, read list", () => {
    const { repo, head } = newRepo();
    const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head) });
    expect(r.doc).toMatchObject({ checks: [], checks_read: true });
  });

  test("a superseded cancelled run next to a green one is not red", () => {
    const { repo, head } = newRepo();
    const r = run(repo, {
      INPUTS_DELIVERY: DELIVERY,
      FAKE_GH_JSON: prJson(head),
      FAKE_GH_ROLLUP: rollup([CANCELLED, OLD_GREEN, NEW_GREEN]),
    });
    expect(r.doc).toMatchObject({ checks: [{ name: "TDD RED on the test commit", bucket: "pass" }], checks_read: true });
    expect(ciRefusal(r.doc.checks as CiCheck[])).toBeNull();
  });

  test("waits while a newer workflow run on the head is queued", () => {
    const { repo, head } = newRepo();
    const r = run(repo, {
      INPUTS_DELIVERY: DELIVERY,
      FAKE_GH_JSON: prJson(head),
      FAKE_GH_ROLLUP_1: rollup([OLD_GREEN, CANCELLED]),
      FAKE_GH_RUNS_1: "1",
      FAKE_GH_ROLLUP: rollup([OLD_GREEN, CANCELLED, NEW_GREEN]),
    });
    expect(r.doc).toMatchObject({ checks: [{ name: "TDD RED on the test commit", bucket: "pass" }], checks_read: true });
    expect(rollupReads(r)).toBe(2);
    expect(ghArgs(r)).toContain(`api repos/example/repo/actions/runs?head_sha=${head}&per_page=100`);
  });

  test("waits while a run newer than a green one is in progress", () => {
    const { repo, head } = newRepo();
    const r = run(repo, {
      INPUTS_DELIVERY: DELIVERY,
      FAKE_GH_JSON: prJson(head),
      FAKE_GH_ROLLUP_1: rollup([OLD_GREEN, checkRun("TDD RED on the test commit", "IN_PROGRESS", "", NEW)]),
      FAKE_GH_ROLLUP: rollup([OLD_GREEN, NEW_GREEN]),
    });
    expect(r.doc).toMatchObject({ checks: [{ name: "TDD RED on the test commit", bucket: "pass" }], checks_read: true });
    expect(rollupReads(r)).toBe(2);
  });

  test("stops waiting at the limit and keeps the pending check", () => {
    const { repo, head } = newRepo();
    const r = run(repo, {
      INPUTS_DELIVERY: DELIVERY,
      FAKE_GH_JSON: prJson(head),
      FAKE_GH_ROLLUP: rollup([checkRun("Tests", "QUEUED", "", null)]),
      PR_STATE_POLL_MS: "50",
      PR_STATE_WAIT_MS: "120",
    });
    expect(r.doc).toMatchObject({ checks: [{ name: "Tests", bucket: "pending" }], checks_read: true });
    expect(rollupReads(r)).toBeGreaterThanOrEqual(2);
    expect(rollupReads(r)).toBeLessThanOrEqual(4);
  });
});
