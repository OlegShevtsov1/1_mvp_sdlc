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
// run out, and exits FAKE_GH_ROLLUP_EXIT; any other `pr view` prints the n-th
// FAKE_GH_JSON_<n>, or FAKE_GH_JSON, and exits FAKE_GH_EXIT, with @REMOTE_HEAD@
// replaced by feature-x in the bare repository FAKE_GH_REMOTE, the way GitHub
// reports the branch head. `api` prints the n-th FAKE_GH_RUNS_<n>, or FAKE_GH_RUNS.
// `run view --job <id> --log-failed` prints FAKE_GH_LOG_<id>; `run rerun` exits 0.
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
    var="FAKE_GH_JSON_$(next view)"; json="\${!var:-$FAKE_GH_JSON}"
    if [ -n "\${FAKE_GH_REMOTE:-}" ]; then oid=$(git --git-dir="$FAKE_GH_REMOTE" rev-parse feature-x); json="\${json//@REMOTE_HEAD@/$oid}"; fi
    printf '%s' "$json"; exit "\${FAKE_GH_EXIT:-0}" ;;
  "run view") var="FAKE_GH_LOG_$4"; printf '%s' "\${!var:-}"; exit 0 ;;
  "run rerun") exit 0 ;;
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

interface Result { code: number; doc: Record<string, unknown>; lines: string[]; bin: string; artifacts: string }

function run(repo: string, env: Record<string, string>): Result {
  const bin = fakeGh();
  const artifacts = mkdtempSync(join(tmpdir(), "factory-pr-state-art-"));
  const p = Bun.spawnSync(["bun", PR_STATE], {
    cwd: repo,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, ARTIFACTS_DIR: artifacts, FAKE_GH_ROLLUP: rollup([]), FAKE_GH_RUNS: "0",
      PR_STATE_POLL_MS: "1", PR_STATE_WAIT_MS: "1000", ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = p.stdout.toString().trim().split("\n").filter((l) => l !== "");
  expect(p.exitCode).toBe(0);
  expect(lines.length).toBe(1);
  return { code: p.exitCode, doc: JSON.parse(lines[0]), lines, bin, artifacts };
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
      checks_settled: true,
      waited_minutes: 0,
      rerun_checks: [],
      rebase: "none",
      conflict_files: [],
      rebase_detail: "",
      merge_sha: "",
      merge_contains_checkout: false,
    });
    expect(ghArgs(r)).toContain(`pr view ${PR_URL} --json headRefOid,headRefName,isDraft,state,baseRefName,mergeable,mergeCommit`);
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

  test("a merged pull request reports its merge commit, and its CI is not read", () => {
    const { repo, head } = newRepo();
    const r = run(repo, {
      INPUTS_DELIVERY: DELIVERY,
      FAKE_GH_JSON: prJson(head, { state: "MERGED", mergeable: "UNKNOWN", mergeCommit: { oid: "abc1234" } }),
      FAKE_GH_ROLLUP: rollup([checkRun("Tests", "QUEUED", "", null)]),
    });
    expect(r.doc).toMatchObject({
      read: true, state: "MERGED", checkout_is_head: true, merge_sha: "abc1234", merge_contains_checkout: false,
      checks: [], checks_read: true, checks_settled: true, rerun_checks: [], rebase: "none",
    });
    expect(rollupReads(r)).toBe(0);
    expect(readFileSync(join(r.artifacts, "pr-state.log"), "utf8")).toContain("already merged; CI not waited for");
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

  test("still pending after the first window waits once more, then reports unsettled", () => {
    const { repo, head } = newRepo();
    const r = run(repo, {
      INPUTS_DELIVERY: DELIVERY,
      FAKE_GH_JSON: prJson(head),
      FAKE_GH_ROLLUP: rollup([checkRun("Tests", "QUEUED", "", null)]),
      PR_STATE_POLL_MS: "50",
      PR_STATE_WAIT_MS: "120",
    });
    expect(r.doc).toMatchObject({ checks: [{ name: "Tests", bucket: "pending" }], checks_read: true, checks_settled: false, waited_minutes: 0 });
    expect(readFileSync(join(r.artifacts, "pr-state.log"), "utf8")).toContain("checks still pending after 0 min; waiting once more");
    // Each window reads at least twice (its first read and one at its deadline).
    expect(rollupReads(r)).toBeGreaterThanOrEqual(4);
    expect(rollupReads(r)).toBeLessThanOrEqual(8);
  });

  test("pending in the first window and green in the second reports settled", () => {
    const { repo, head } = newRepo();
    const r = run(repo, {
      INPUTS_DELIVERY: DELIVERY,
      FAKE_GH_JSON: prJson(head),
      FAKE_GH_ROLLUP_1: rollup([checkRun("Tests", "QUEUED", "", null)]),
      FAKE_GH_ROLLUP_2: rollup([checkRun("Tests", "QUEUED", "", null)]),
      FAKE_GH_ROLLUP: rollup([checkRun("Tests", "COMPLETED", "SUCCESS", NEW)]),
      PR_STATE_POLL_MS: "100",
      PR_STATE_WAIT_MS: "150",
    });
    expect(r.doc).toMatchObject({ checks: [{ name: "Tests", bucket: "pass" }], checks_settled: true });
    expect(readFileSync(join(r.artifacts, "pr-state.log"), "utf8")).toContain("waiting once more");
  });

  describe("a known-flaky failure", () => {
    const JOB = "https://github.com/example/repo/actions/runs/111/job/222";
    const failed = (name = "Test", detailsUrl = JOB, conclusion = "FAILURE") => ({ ...checkRun(name, "COMPLETED", conclusion, OLD), detailsUrl });
    const green = (name = "Test") => ({ ...checkRun(name, "COMPLETED", "SUCCESS", NEW), detailsUrl: JOB });
    const reruns = (r: Result) => ghArgs(r).match(/^run rerun .*$/gm) ?? [];

    test("is rerun once, then reported green", () => {
      const { repo, head } = newRepo();
      const r = run(repo, {
        INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head), INPUTS_FLAKY_PATTERNS: '["tokenStore"]',
        FAKE_GH_ROLLUP_1: rollup([failed()]), FAKE_GH_ROLLUP: rollup([green()]),
        FAKE_GH_LOG_222: "FAIL src/auth/tokenStore.test.ts > refreshes the token",
      });
      expect(reruns(r)).toEqual(["run rerun 111 --failed --repo example/repo"]);
      expect(ghArgs(r)).toContain("run view --job 222 --log-failed --repo example/repo");
      expect(r.doc).toMatchObject({ checks: [{ name: "Test", bucket: "pass" }], rerun_checks: ["Test"], checks_settled: true });
      expect(readFileSync(join(r.artifacts, "pr-state.log"), "utf8")).toContain("gh run rerun 111 --failed");
    });

    test("that fails again is rerun only once", () => {
      const { repo, head } = newRepo();
      const r = run(repo, {
        INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head), INPUTS_FLAKY_PATTERNS: '["Test"]',
        FAKE_GH_ROLLUP: rollup([failed()]),
      });
      expect(reruns(r)).toEqual(["run rerun 111 --failed --repo example/repo"]);
      expect(r.doc).toMatchObject({ checks: [{ name: "Test", bucket: "fail" }], rerun_checks: ["Test"] });
    });

    test("is not rerun when no pattern matches, the list is empty, another red check is not flaky, or the check is cancelled or not an Actions job", () => {
      const cases: Array<[string, Record<string, unknown>[]]> = [
        ['["nothing"]', [failed()]],
        ["[]", [failed()]],
        ["", [failed()]],
        ['["tokenStore"]', [failed(), failed("Lint", "https://github.com/example/repo/actions/runs/111/job/333")]],
        ['["tokenStore"]', [failed("Test", JOB, "CANCELLED")]],
        ['["tokenStore"]', [failed("Test", "https://ci.example.com/build/7")]],
      ];
      for (const [patterns, entries] of cases) {
        const { repo, head } = newRepo();
        const r = run(repo, {
          INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head), INPUTS_FLAKY_PATTERNS: patterns,
          FAKE_GH_ROLLUP: rollup(entries), FAKE_GH_LOG_222: "tokenStore", FAKE_GH_LOG_333: "eslint: 3 problems",
        });
        expect(reruns(r)).toEqual([]);
        expect(r.doc.rerun_checks).toEqual([]);
      }
    }, 30_000);
  });

  describe("a pull request that conflicts with its base", () => {
    // The identity covers every git in a chained command: CI runners have no global one.
    const git = (cwd: string, args: string) =>
      sh(cwd, `export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e.com; git ${args}`);

    // A bare origin with main, feature-x (the checkout, one commit on main) and develop
    // (one commit on main, made in another clone); `conflict` makes both edit tracked.txt.
    function conflictingPr(conflict: boolean): { repo: string; remote: string; head: string } {
      const remote = mkdtempSync(join(tmpdir(), "factory-pr-state-remote-"));
      sh(remote, "git init -q --bare -b main");
      const { repo } = newRepo();
      git(repo, `remote add origin ${remote} && git checkout -q -b feature-x`);
      writeFileSync(join(repo, conflict ? "tracked.txt" : "feature.txt"), "feature\n");
      git(repo, "add -A && git commit -q -m feature && git push -q origin main feature-x");
      const seed = mkdtempSync(join(tmpdir(), "factory-pr-state-seed-"));
      sh(seed, `git clone -q ${remote} . && git checkout -q -b develop`);
      writeFileSync(join(seed, conflict ? "tracked.txt" : "base.txt"), "base\n");
      git(seed, "add -A && git commit -q -m base && git push -q origin develop");
      return { repo, remote, head: sh(repo, "git rev-parse HEAD") };
    }

    const conflicting = (remote: string) => ({
      INPUTS_DELIVERY: DELIVERY,
      FAKE_GH_REMOTE: remote,
      FAKE_GH_JSON_1: prJson("@REMOTE_HEAD@", { mergeable: "CONFLICTING" }),
      FAKE_GH_JSON: prJson("@REMOTE_HEAD@", { mergeable: "UNKNOWN" }),
    });

    test("is rebased onto its base and pushed with a lease", () => {
      const { repo, remote, head } = conflictingPr(false);
      const r = run(repo, conflicting(remote));
      const local = sh(repo, "git rev-parse HEAD");
      expect(local).not.toBe(head);
      expect(sh(remote, "git rev-parse feature-x")).toBe(local);
      expect(Bun.spawnSync(["git", "merge-base", "--is-ancestor", "origin/develop", "HEAD"], { cwd: repo }).exitCode).toBe(0);
      expect(r.doc).toMatchObject({ read: true, rebase: "rebased", conflict_files: [], mergeable: "UNKNOWN", checkout_is_head: true, checkout_clean: true, checks_settled: true });
      expect(readFileSync(join(r.artifacts, "pr-state.log"), "utf8")).toContain("rebase");
    });

    test("waits for a check on the rebased head when the old head had one", () => {
      const { repo, remote } = conflictingPr(false);
      const r = run(repo, {
        ...conflicting(remote),
        FAKE_GH_ROLLUP_1: rollup([checkRun("Tests", "COMPLETED", "SUCCESS", OLD)]),
        FAKE_GH_ROLLUP_2: rollup([]),
        FAKE_GH_ROLLUP: rollup([checkRun("Tests", "COMPLETED", "SUCCESS", NEW)]),
      });
      expect(r.doc).toMatchObject({ rebase: "rebased", checks: [{ name: "Tests", bucket: "pass" }], checks_settled: true });
      expect(rollupReads(r)).toBe(3);
    });

    test("is rebased on merge_conflict although GitHub still reports it mergeable", () => {
      const { repo, remote, head } = conflictingPr(false);
      const r = run(repo, {
        INPUTS_DELIVERY: DELIVERY, INPUTS_MERGE_CONFLICT: "true", FAKE_GH_REMOTE: remote, FAKE_GH_JSON: prJson("@REMOTE_HEAD@"),
      });
      const local = sh(repo, "git rev-parse HEAD");
      expect(local).not.toBe(head);
      expect(sh(remote, "git rev-parse feature-x")).toBe(local);
      expect(r.doc).toMatchObject({ rebase: "rebased", mergeable: "MERGEABLE", checkout_is_head: true, checks_settled: true });
    });

    test("is not rebased while it reads mergeable without merge_conflict", () => {
      const { repo, remote, head } = conflictingPr(false);
      const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_REMOTE: remote, FAKE_GH_JSON: prJson("@REMOTE_HEAD@") });
      expect(r.doc).toMatchObject({ rebase: "none" });
      expect(sh(remote, "git rev-parse feature-x")).toBe(head);
    });

    test("a merged pull request is never rebased, even on merge_conflict", () => {
      const { repo, remote, head } = conflictingPr(false);
      const r = run(repo, {
        INPUTS_DELIVERY: DELIVERY, INPUTS_MERGE_CONFLICT: "true", FAKE_GH_REMOTE: remote,
        FAKE_GH_JSON: prJson("@REMOTE_HEAD@", { state: "MERGED", mergeable: "CONFLICTING" }),
      });
      expect(r.doc).toMatchObject({ state: "MERGED", rebase: "none" });
      expect(sh(repo, "git rev-parse HEAD")).toBe(head);
      expect(sh(remote, "git rev-parse feature-x")).toBe(head);
    });

    test("a pull request merged at another head whose merge commit introduced the checkout contains it", () => {
      const { repo, remote } = conflictingPr(false);
      const other = mkdtempSync(join(tmpdir(), "factory-pr-state-other-"));
      sh(other, `git clone -q -b develop ${remote} .`);
      git(other, "fetch -q origin feature-x && git merge -q --no-ff -m merge FETCH_HEAD && git push -q origin develop");
      const mergeSha = sh(other, "git rev-parse HEAD");
      const r = run(repo, {
        INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson("0".repeat(40), { state: "MERGED", mergeable: "UNKNOWN", mergeCommit: { oid: mergeSha } }),
      });
      expect(r.doc).toMatchObject({ state: "MERGED", checkout_is_head: false, merge_sha: mergeSha, merge_contains_checkout: true });
    });

    test("whose rebase conflicts is aborted and reports the files", () => {
      const { repo, remote, head } = conflictingPr(true);
      const r = run(repo, conflicting(remote));
      expect(r.doc).toMatchObject({ rebase: "conflicted", conflict_files: ["tracked.txt"], checkout_is_head: true, checkout_clean: true, checks_settled: false });
      expect(sh(repo, "git rev-parse HEAD")).toBe(head);
      expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(false);
      expect(existsSync(join(repo, ".git", "rebase-apply"))).toBe(false);
      expect(sh(remote, "git rev-parse feature-x")).toBe(head);
      // The one read before the rebase; no wait on a head that cannot merge.
      expect(rollupReads(r)).toBe(1);
    });

    test("whose lease no longer holds fails the rebase and restores the checkout", () => {
      const { repo, remote, head } = conflictingPr(false);
      const other = mkdtempSync(join(tmpdir(), "factory-pr-state-other-"));
      sh(other, `git clone -q -b feature-x ${remote} .`);
      writeFileSync(join(other, "late.txt"), "late\n");
      git(other, "add -A && git commit -q -m late && git push -q origin feature-x");
      const late = sh(remote, "git rev-parse feature-x");
      // GitHub has not seen the late push yet: the view still names the checkout.
      const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head, { mergeable: "CONFLICTING" }) });
      expect(r.doc).toMatchObject({ rebase: "failed", checkout_is_head: true, checkout_clean: true });
      expect(r.doc.rebase_detail).not.toBe("");
      expect(sh(repo, "git rev-parse HEAD")).toBe(head);
      expect(sh(remote, "git rev-parse feature-x")).toBe(late);
    });

    test("is never rebased from a dirty checkout or one that is not the PR head", () => {
      for (const dirty of [true, false]) {
        const { repo, remote, head } = conflictingPr(false);
        if (dirty) writeFileSync(join(repo, "tracked.txt"), "dirty\n");
        const view = dirty ? prJson(head, { mergeable: "CONFLICTING" }) : prJson("0".repeat(40), { mergeable: "CONFLICTING" });
        const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: view });
        expect(r.doc).toMatchObject({ rebase: "none", mergeable: "CONFLICTING" });
        expect(sh(repo, "git rev-parse HEAD")).toBe(head);
        expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "origin/develop"], { cwd: repo }).exitCode).not.toBe(0);
      }
    }, 30_000);
  });
});
