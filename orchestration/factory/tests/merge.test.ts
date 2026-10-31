import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MERGE_GATE_TIMEOUT_MS, PR_STATE_TIMEOUT_MS } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/merge-decision.ts";

const PACK = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory");
const MERGE = join(PACK, "scripts", "merge.ts");
const PR_URL = "https://github.com/example/repo/pull/3";
const CONFLICT = "GraphQL: Pull Request has merge conflicts (mergePullRequest)";

// The identity covers every git in a chained command: CI runners have no global one.
function git(cwd: string, args: string): string {
  const p = Bun.spawnSync(
    ["bash", "-c", `export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e.com; git ${args}`],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  return p.stdout.toString().trim();
}

// A bare origin (…/example/repo.git) with develop and feature-x, the checkout on
// feature-x one commit ahead of develop, with its own identity for the rebase
// merge.ts runs. advance() lands another commit on
// develop from a second clone, editing the checkout's file when it conflicts.
function pullRequest(): { repo: string; remote: string; head: string; advance: (conflict: boolean) => void } {
  const remote = join(mkdtempSync(join(tmpdir(), "factory-merge-remote-")), "example", "repo.git");
  mkdirSync(remote, { recursive: true });
  git(remote, "init -q --bare -b develop");
  const repo = mkdtempSync(join(tmpdir(), "factory-merge-repo-"));
  git(repo, `init -q -b develop && git config user.email t@e.com && git config user.name t && git remote add origin ${remote}`);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add -A && git commit -q -m base && git push -q origin develop && git checkout -q -b feature-x");
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  git(repo, "add -A && git commit -q -m feature && git push -q origin feature-x");
  const advance = (conflict: boolean) => {
    const other = mkdtempSync(join(tmpdir(), "factory-merge-other-"));
    git(other, `clone -q -b develop ${remote} .`);
    writeFileSync(join(other, conflict ? "feature.txt" : "other.txt"), "other\n");
    git(other, "add -A && git commit -q -m other && git push -q origin develop");
  };
  return { repo, remote, head: git(repo, "rev-parse HEAD"), advance };
}

// A fake `gh` first on PATH that records its argv. The n-th `pr merge` prints
// FAKE_GH_MERGE_OUT_<n> and exits FAKE_GH_MERGE_EXIT_<n> (default 0). The
// re-read after a failed merge prints FAKE_GH_AFTER_FAIL; pr-state's read is an
// open, mergeable pull request. @REMOTE_HEAD@ is feature-x in FAKE_GH_REMOTE, the
// way GitHub reports the branch head. The title read prints FAKE_GH_TITLE, set
// or empty (default "PILOT-9: a title").
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-merge-bin-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/gh.args"
remote_head() { git --git-dir="$FAKE_GH_REMOTE" rev-parse feature-x; }
case "$*" in
  "pr merge "*)
    n=$(( $(cat "${dir}/merges" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/merges"
    out="FAKE_GH_MERGE_OUT_$n"; code="FAKE_GH_MERGE_EXIT_$n"; printf '%s\\n' "\${!out:-}" >&2; exit "\${!code:-0}" ;;
  *"--json state,headRefOid,mergeable") json="$FAKE_GH_AFTER_FAIL"; printf '%s' "\${json//@REMOTE_HEAD@/$(remote_head)}" ;;
  *"--json state --jq .state") echo "\${FAKE_GH_STATE:-MERGED}" ;;
  *"--json mergeCommit --jq "*) echo "\${FAKE_GH_MERGE_COMMIT:-}" ;;
  *"--json headRefName --jq .headRefName") echo feature-x ;;
  *"--json title --jq .title") printf '%s\\n' "\${FAKE_GH_TITLE-PILOT-9: a title}" ;;
  *"--json headRefOid,headRefName,isDraft,state,baseRefName,mergeable,mergeCommit")
    printf '{"headRefOid":"%s","headRefName":"feature-x","isDraft":false,"state":"OPEN","baseRefName":"develop","mergeable":"MERGEABLE","mergeCommit":null}' "$(remote_head)" ;;
  *"--json statusCheckRollup") printf '%s' '{"statusCheckRollup":[]}' ;;
  "api "*) echo 0 ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  return dir;
}

interface Result { doc: Record<string, unknown>; bin: string; artifacts: string; stderr: string }

function run(repo: string, remote: string, env: Record<string, string> = {}): Result {
  const bin = fakeGh();
  const artifacts = mkdtempSync(join(tmpdir(), "factory-merge-art-"));
  const p = Bun.spawnSync(["bun", MERGE], {
    cwd: repo,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, ARTIFACTS_DIR: artifacts, FAKE_GH_REMOTE: remote,
      FAKE_GH_MERGE_COMMIT: "abc1234", PR_STATE_POLL_MS: "1", PR_STATE_WAIT_MS: "1000",
      INPUTS_PR_URL: PR_URL, INPUTS_HEAD: "feature-x", INPUTS_BASE: "develop", INPUTS_ALREADY_MERGED: "false",
      INPUTS_MERGE_STRATEGY: "squash", INPUTS_REMOTE: "origin", INPUTS_FLAKY_PATTERNS: "[]",
      INPUTS_BODY_SYNC: JSON.stringify({ pr_url: PR_URL, action: "unchanged", source: "pr-body.md", reason: "" }),
      INPUTS_TEST_COMMAND: "true", INPUTS_LINT_COMMAND: "", INPUTS_BUILD_COMMAND: "", INPUTS_TEST_TIMEOUT_SECONDS: "60",
      INPUTS_SECRET_NAMES: "[]", INPUTS_MANUAL_MERGE_BASES: '["main"]',
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = p.stdout.toString().trim().split("\n").filter((l) => l !== "");
  expect(p.exitCode).toBe(0);
  expect(lines.length).toBe(1);
  return { doc: JSON.parse(lines[0]), bin, artifacts, stderr: p.stderr.toString() };
}

const ghArgs = (r: Result) => readFileSync(join(r.bin, "gh.args"), "utf8");
const merges = (r: Result) => ghArgs(r).match(/^pr merge .*$/gm) ?? [];
const afterFail = (state: string, oid = "@REMOTE_HEAD@", mergeable = "UNKNOWN") =>
  JSON.stringify({ state, headRefOid: oid, mergeable });
const MERGED = { merged: true, merge_sha: "abc1234", head: "feature-x", error: "" };

describe("merge", () => {
  test("a merge gh accepts reports the merge commit and deletes the branch", () => {
    const { repo, remote } = pullRequest();
    const r = run(repo, remote);
    expect(r.doc).toEqual(MERGED);
    expect(merges(r)).toEqual([`pr merge ${PR_URL} --repo example/repo --squash --subject PILOT-9: a title (#3)`]);
    expect(git(remote, "branch --list feature-x")).toBe("");
  });

  test("a merge strategy other than squash passes no subject", () => {
    const { repo, remote } = pullRequest();
    const r = run(repo, remote, { INPUTS_MERGE_STRATEGY: "merge" });
    expect(r.doc).toEqual(MERGED);
    expect(merges(r)).toEqual([`pr merge ${PR_URL} --repo example/repo --merge`]);
  });

  test("a title that cannot be read refuses the squash before gh merges", () => {
    const { repo, remote } = pullRequest();
    const r = run(repo, remote, { FAKE_GH_TITLE: "" });
    expect(r.doc).toMatchObject({ merged: false, error: "merge: could not read the pull request title." });
    expect(merges(r)).toEqual([]);
  });

  test("a conflict that appeared after pr-state is rebased once, gated again and merged", () => {
    const { repo, remote, head, advance } = pullRequest();
    advance(false);
    const r = run(repo, remote, { FAKE_GH_MERGE_OUT_1: CONFLICT, FAKE_GH_MERGE_EXIT_1: "1", FAKE_GH_AFTER_FAIL: afterFail("OPEN") });
    expect(r.doc).toEqual(MERGED);
    expect(merges(r)).toEqual(Array(2).fill(`pr merge ${PR_URL} --repo example/repo --squash --subject PILOT-9: a title (#3)`));
    const local = git(repo, "rev-parse HEAD");
    expect(local).not.toBe(head);
    expect(Bun.spawnSync(["git", "merge-base", "--is-ancestor", "origin/develop", "HEAD"], { cwd: repo }).exitCode).toBe(0);
    expect(readFileSync(join(r.artifacts, "pr-state.log"), "utf8")).toContain(`rebase: pushed ${local} to origin feature-x`);
    expect(readFileSync(join(r.artifacts, "merge.log"), "utf8")).toContain('merge-gate.ts: {"action":"merge"');
  }, 30_000);

  test("a rebase that conflicts ends the merge refused, naming the files, with the checkout unchanged", () => {
    const { repo, remote, head, advance } = pullRequest();
    advance(true);
    const r = run(repo, remote, { FAKE_GH_MERGE_OUT_1: CONFLICT, FAKE_GH_MERGE_EXIT_1: "1", FAKE_GH_AFTER_FAIL: afterFail("OPEN") });
    expect(r.doc).toMatchObject({ merged: false, merge_sha: "", head: "feature-x" });
    expect(r.doc.error).toBe(
      `merge: gh pr merge failed: ${CONFLICT}; after one rebase onto develop: conflict: rebasing feature-x onto origin/develop conflicts in ` +
        "feature.txt; the change needs a replan against the current develop",
    );
    expect(r.stderr).toContain("after one rebase onto develop");
    expect(merges(r).length).toBe(1);
    expect(git(repo, "rev-parse HEAD")).toBe(head);
    expect(git(remote, "rev-parse feature-x")).toBe(head);
  }, 30_000);

  test("a second refusal after the rebase is reported, never rebased again", () => {
    const { repo, remote, advance } = pullRequest();
    advance(false);
    const r = run(repo, remote, {
      FAKE_GH_MERGE_OUT_1: CONFLICT, FAKE_GH_MERGE_EXIT_1: "1", FAKE_GH_MERGE_OUT_2: CONFLICT, FAKE_GH_MERGE_EXIT_2: "1",
      FAKE_GH_AFTER_FAIL: afterFail("OPEN", "@REMOTE_HEAD@", "CONFLICTING"),
    });
    expect(r.doc).toMatchObject({ merged: false, error: `merge: gh pr merge failed after the rebase: ${CONFLICT}` });
    expect(merges(r).length).toBe(2);
    expect(readFileSync(join(r.artifacts, "pr-state.log"), "utf8").match(/rebase: pushed/g)?.length).toBe(1);
  }, 30_000);

  test("a pull request merge-gate found already merged is not merged again", () => {
    const { repo, remote } = pullRequest();
    const r = run(repo, remote, { INPUTS_ALREADY_MERGED: "true" });
    expect(r.doc).toEqual(MERGED);
    expect(merges(r)).toEqual([]);
    expect(ghArgs(r)).not.toContain("--json title");
  });

  test("a merge refused because another process merged it at this run's head is delivered; at another head it is not", () => {
    const { repo, remote } = pullRequest();
    const failed = { FAKE_GH_MERGE_OUT_1: "GraphQL: Pull Request is already merged", FAKE_GH_MERGE_EXIT_1: "1" };
    expect(run(repo, remote, { ...failed, FAKE_GH_AFTER_FAIL: afterFail("MERGED") }).doc).toEqual(MERGED);
    const other = run(repo, remote, { ...failed, FAKE_GH_AFTER_FAIL: afterFail("MERGED", "0".repeat(40)) });
    expect(other.doc).toMatchObject({ merged: false, error: "merge: gh pr merge failed: GraphQL: Pull Request is already merged" });
    expect(existsSync(join(other.artifacts, "pr-state.log"))).toBe(false);
  }, 30_000);

  test("a refusal that is not a conflict is reported in gh's words without a rebase", () => {
    const { repo, remote, head } = pullRequest();
    const out = "X Pull request example/repo#3 is not mergeable: the base branch policy prohibits the merge.\nAdd the --auto flag.";
    const r = run(repo, remote, { FAKE_GH_MERGE_OUT_1: out, FAKE_GH_MERGE_EXIT_1: "1", FAKE_GH_AFTER_FAIL: afterFail("OPEN", "@REMOTE_HEAD@", "MERGEABLE") });
    expect(r.doc).toMatchObject({ merged: false, error: `merge: gh pr merge failed: ${out.replace("\n", " ")}` });
    expect(existsSync(join(r.artifacts, "pr-state.log"))).toBe(false);
    expect(git(remote, "rev-parse feature-x")).toBe(head);
  });

  test("a pull request still open after the merge is refused", () => {
    const { repo, remote } = pullRequest();
    const r = run(repo, remote, { FAKE_GH_STATE: "OPEN" });
    expect(r.doc).toMatchObject({ merged: false, error: "merge: pull request is not MERGED after the merge (state: OPEN)." });
  });

  test("an unknown strategy or an origin that is not owner/repo is refused before gh runs", () => {
    const { repo, remote } = pullRequest();
    const strategy = run(repo, remote, { INPUTS_MERGE_STRATEGY: "fast-forward" });
    expect(strategy.doc).toMatchObject({ merged: false, error: "merge: unknown merge_strategy 'fast-forward'" });
    git(repo, "remote set-url origin 'o/r with space'");
    const origin = run(repo, remote);
    expect(origin.doc).toMatchObject({ merged: false, error: "merge: origin remote does not resolve to an owner/repo." });
    expect(existsSync(join(origin.bin, "gh.args"))).toBe(false);
  }, 30_000);

  test("factory.yaml runs the script with merge-gate's decision and budgets one pr-state and one merge-gate run", () => {
    const yaml = Bun.YAML.parse(readFileSync(join(PACK, "factory.yaml"), "utf8")) as {
      nodes: { id: string; script?: string; timeout?: number; with?: Record<string, unknown> }[];
    };
    const node = (id: string) => yaml.nodes.find((n) => n.id === id);
    expect(node("merge")?.script).toBe("merge");
    expect(node("merge")?.with?.already_merged).toBe("$merge-gate.output.already_merged");
    expect(node("merge")?.with?.body_sync).toBe(node("merge-gate")?.with?.body_sync);
    expect(node("pr-state")?.timeout).toBe(PR_STATE_TIMEOUT_MS);
    expect(node("merge-gate")?.timeout).toBe(MERGE_GATE_TIMEOUT_MS);
    expect(node("merge")?.timeout ?? 0).toBeGreaterThanOrEqual(PR_STATE_TIMEOUT_MS + MERGE_GATE_TIMEOUT_MS + 300_000);
    for (const key of ["test_command", "lint_command", "build_command", "test_timeout_seconds", "secret_names", "manual_merge_bases", "remote", "preflight"]) {
      expect(node("merge")?.with?.[key]).toBe(node("merge-gate")?.with?.[key]);
    }
    expect(node("merge")?.with?.flaky_patterns).toBe(node("pr-state")?.with?.flaky_patterns);
  });
});
