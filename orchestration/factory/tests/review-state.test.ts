import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REVIEW_STATE = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "review-state.ts");
const PR_URL = "https://github.com/example/repo/pull/3";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const FINDINGS = [
  { id: "R5", severity: "blocking", sources: ["code"], claim: "R5 claim", status: "fixed", round: 3 },
  { id: "R6", severity: "blocking", sources: ["code"], claim: "R6 claim", status: "open", round: 4 },
];

function delivery(summary = `Not ready: Round 4: review_open at the 4-round cap. x\n${PR_URL}`): string {
  return JSON.stringify({ ready: false, reason: "round_cap", pr_url: PR_URL, summary });
}

function reviewComment(sha: string, url: string): { body: string; url: string } {
  return { body: `<!-- archon-review-report -->\nReviewed commit: \`${sha}\`\nVerdict: not ready\n\n# Review`, url };
}

const VIEW = JSON.stringify({
  headRefOid: HEAD,
  isDraft: true,
  comments: [
    reviewComment("fedcba9876543210fedcba9876543210fedcba98", `${PR_URL}#issuecomment-1`),
    { body: "a person's comment", url: `${PR_URL}#issuecomment-2` },
    reviewComment(HEAD, `${PR_URL}#issuecomment-3`),
    { body: "Reviewed commit: `aaaaaaa` quoted, no marker", url: `${PR_URL}#issuecomment-4` },
  ],
});

// A fake `gh` first on PATH that records its argv. The n-th `pr view` with
// statusCheckRollup prints FAKE_GH_ROLLUP_<n>, or FAKE_GH_ROLLUP once the numbered
// answers run out; any other `pr view` prints FAKE_GH_VIEW and exits
// FAKE_GH_VIEW_EXIT. `api` (workflow runs in flight) prints 0.
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-review-state-bin-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/gh.args"
case "$1 $2" in
  "pr view")
    if [[ "$*" == *statusCheckRollup* ]]; then
      n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/n"
      var="FAKE_GH_ROLLUP_$n"
      printf '%s' "\${!var:-$FAKE_GH_ROLLUP}"; exit 0
    fi
    printf '%s' "$FAKE_GH_VIEW"; exit "\${FAKE_GH_VIEW_EXIT:-0}" ;;
esac
[ "$1" = api ] && echo 0
`,
  );
  chmodSync(gh, 0o755);
  return dir;
}

// The bundled review writes report-round-N.md each review round; N is the latest review round.
function artifacts(findings: string | null, reports = ["report-round-1.md", "report-round-2.md", "report-round-10.md", "report.md"]): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-review-state-art-"));
  mkdirSync(join(dir, "review"));
  if (findings !== null) writeFileSync(join(dir, "review", "findings.json"), findings);
  for (const name of reports) writeFileSync(join(dir, "review", name), "# Review report");
  return dir;
}

// One check, Tests, in the given state.
function rollup(status: string, conclusion: string): string {
  return JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "Tests", workflowName: "CI", status, conclusion, startedAt: "2026-10-28T14:00:00Z" }] });
}

interface Result { doc: Record<string, unknown>; bin: string }

function run(env: Record<string, string>, dir = artifacts(JSON.stringify(FINDINGS))): Result {
  const bin = fakeGh();
  const p = Bun.spawnSync(["bun", REVIEW_STATE], {
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, ARTIFACTS_DIR: dir, INPUTS_DELIVERY: delivery(),
      FAKE_GH_VIEW: VIEW, FAKE_GH_ROLLUP: rollup("COMPLETED", "SUCCESS"),
      REVIEW_STATE_POLL_MS: "1", REVIEW_STATE_WAIT_MS: "1000", ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = p.stdout.toString().trim().split("\n").filter((l) => l !== "");
  expect(p.exitCode).toBe(0);
  expect(lines.length).toBe(1);
  return { doc: JSON.parse(lines[0]), bin };
}

const ghArgs = (r: Result) => (existsSync(join(r.bin, "gh.args")) ? readFileSync(join(r.bin, "gh.args"), "utf8") : "");

describe("review-state", () => {
  test("reads the head, draft state, checks, latest review comment and findings", () => {
    const r = run({});
    expect(r.doc).toEqual({
      pr_url: PR_URL, round: 4, review_round: 10, read: true, head: HEAD, is_draft: true,
      checks: [{ name: "Tests", bucket: "pass" }], checks_read: true,
      review_url: `${PR_URL}#issuecomment-3`, review_commit: HEAD,
      findings_read: true, findings: FINDINGS,
    });
    expect(ghArgs(r)).toContain(`pr view ${PR_URL} --json headRefOid,isDraft,comments`);
    expect(ghArgs(r)).toContain(`pr view ${PR_URL} --json statusCheckRollup`);
  });

  test("waits while a check is pending", () => {
    const r = run({
      FAKE_GH_ROLLUP_1: rollup("IN_PROGRESS", ""),
      FAKE_GH_ROLLUP_2: rollup("IN_PROGRESS", ""),
    });
    expect(r.doc.checks).toEqual([{ name: "Tests", bucket: "pass" }]);
    expect(ghArgs(r).match(/--json statusCheckRollup/g)?.length).toBe(3);
  });

  test("stops waiting at the limit and keeps the pending check", () => {
    const r = run({ FAKE_GH_ROLLUP: rollup("QUEUED", ""), REVIEW_STATE_POLL_MS: "50", REVIEW_STATE_WAIT_MS: "120" });
    expect(r.doc.checks).toEqual([{ name: "Tests", bucket: "pending" }]);
    expect(r.doc.checks_read).toBe(true);
    const polls = ghArgs(r).match(/--json statusCheckRollup/g)?.length ?? 0;
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(4);
  });

  test("no review comment leaves the review fields empty", () => {
    const r = run({ FAKE_GH_VIEW: JSON.stringify({ headRefOid: HEAD, isDraft: false, comments: [] }) });
    expect(r.doc).toMatchObject({ read: true, is_draft: false, review_url: "", review_commit: "" });
  });

  for (const [label, raw] of [["missing", null], ["not JSON", "{"], ["not an array", "{}"], ["malformed", JSON.stringify([{ id: "R6" }])]] as const) {
    test(`a ${label} findings.json is unread`, () => {
      const r = run({}, artifacts(raw));
      expect(r.doc).toMatchObject({ read: true, findings_read: false, findings: [] });
    });
  }

  test("no review round report leaves the review round 0", () => {
    const r = run({}, artifacts(JSON.stringify(FINDINGS), ["report.md", "code-round-3.md"]));
    expect(r.doc).toMatchObject({ read: true, review_round: 0, findings_read: true });
  });

  test("an unreadable pull request is unread", () => {
    const r = run({ FAKE_GH_VIEW: "", FAKE_GH_VIEW_EXIT: "1" });
    expect(r.doc).toMatchObject({ pr_url: PR_URL, round: 4, review_round: 0, read: false, head: "", checks_read: false, findings_read: false, findings: [] });
  });

  test("a delivery that ended before round 3 reads nothing", () => {
    const r = run({ INPUTS_DELIVERY: delivery(`Not ready: Round 2: replan. x\n${PR_URL}`) });
    expect(r.doc).toMatchObject({ round: 2, read: false, findings_read: false });
    expect(ghArgs(r)).toBe("");
  });

  test("a delivery without a GitHub pull request URL reads nothing", () => {
    const r = run({ INPUTS_DELIVERY: JSON.stringify({ ready: false, reason: "replan", pr_url: "", summary: "Not ready: Round 3: replan." }) });
    expect(r.doc).toMatchObject({ pr_url: "", round: 3, read: false });
    expect(ghArgs(r)).toBe("");
  });
});
