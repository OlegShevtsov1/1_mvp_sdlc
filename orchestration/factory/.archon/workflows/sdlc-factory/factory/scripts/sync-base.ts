import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit, fail } from "./_lib/io.ts";
import { MONITORING_MCP_PATH, PROFILE_COMMIT_MESSAGE, PROFILE_PATH, commitIfChanged } from "./_lib/profile.ts";
import { decideSync } from "./_lib/sync-decision.ts";

// Bindings (see factory.yaml `sync-base` node): remote, base_branch,
// profile_commit. ARTIFACTS_DIR is engine-provided.
// Archon cuts the run worktree from the repository's default branch and never
// reads the profile, so this node moves a run branch with no work of its own
// to <remote>/<base_branch> before anything is planned or built.
const remote = process.env.INPUTS_REMOTE ?? "";
const base = process.env.INPUTS_BASE_BRANCH ?? "";
const profileCommit = (process.env.INPUTS_PROFILE_COMMIT ?? "").trim();
const logPath = join(process.env.ARTIFACTS_DIR ?? ".", "sync-base.log");
const REMOTE = /^[A-Za-z0-9._\/-]+$/;
// Fixed repo-config paths later nodes read from the checkout. One committed on
// the default branch but not yet on the base would vanish in the reset, and
// monitor-check would report it as never created.
const CARRIED: Record<string, string> = {
  [PROFILE_PATH]: PROFILE_COMMIT_MESSAGE,
  [MONITORING_MCP_PATH]: "chore: add monitoring MCP config",
};

function git(...args: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function log(line: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

// Every safety guard reads one of these, and a failed git call's empty output
// looks exactly like "nothing to report", so a failure stops the node instead.
function probe(...args: string[]): string {
  const r = git(...args);
  if (!r.ok) throw new Error(`sync-base: git ${args[0]} failed: ${r.err}`);
  return r.out;
}

function tracked(rev: string, path: string): boolean {
  return probe("ls-tree", "--name-only", rev, "--", path) !== "";
}

function main(): void {
  if (!REMOTE.test(remote) || base === "" || !git("check-ref-format", "--branch", base).ok) {
    fail(`sync-base: refusing malformed remote "${remote}" or base_branch "${base}"`);
    return;
  }
  const tracking = `refs/remotes/${remote}/${base}`;
  const fetch = git("fetch", "--quiet", remote, `+refs/heads/${base}:${tracking}`);
  if (!fetch.ok) {
    fail(`sync-base: could not fetch ${remote}/${base}: ${fetch.err}`);
    return;
  }
  const before = probe("rev-parse", "HEAD");
  const target = probe("rev-parse", `${tracking}^{commit}`);
  const symbolic = git("symbolic-ref", "-q", "--short", "HEAD");
  const branch = symbolic.ok ? symbolic.out : "";
  const [gitDir, commonDir] = probe("rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").split("\n");
  const own = probe("rev-list", "HEAD", "--not", `--remotes=${remote}`);

  const decision = decideSync({
    head: before,
    target,
    detached: !symbolic.ok,
    linkedWorktree: gitDir !== commonDir,
    branch,
    branchOnRemote: branch !== "" && git("show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`).ok,
    baseBranch: base,
    dirty: probe("status", "--porcelain", "--untracked-files=no") !== "",
    own: own === "" ? [] : own.split("\n"),
    profileCommit,
  });

  if (decision.action === "kept") {
    log(`kept ${branch || "HEAD"} at ${before}: ${decision.reason}`);
    emit({ action: "kept", base: `${remote}/${base}`, before, after: before, reason: decision.reason });
    return;
  }

  // This run's profile wins over one the base already has; it shows in the PR.
  const carried = Object.keys(CARRIED)
    .filter((path) => (path === PROFILE_PATH && decision.carryProfile) || (tracked(before, path) && !tracked(target, path)))
    .map((path) => ({ path, bytes: readFileSync(path) }));
  const reset = git("reset", "--hard", "--quiet", target);
  if (!reset.ok) {
    fail(`sync-base: could not reset ${branch} to ${remote}/${base}: ${reset.err}`);
    return;
  }
  log(`reset ${branch} from ${before} to ${remote}/${base} ${target}`);
  for (const { path, bytes } of carried) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const committed = commitIfChanged(path, CARRIED[path]);
    if (!committed.ok) {
      fail(`sync-base: reset to ${remote}/${base} but carrying ${path} over failed: ${committed.err}`);
      return;
    }
    log(`carried ${path} over the reset`);
  }
  emit({ action: "reset", base: `${remote}/${base}`, before, after: probe("rev-parse", "HEAD"), reason: decision.reason });
}

try {
  main();
} catch (e) {
  fail((e as Error).message);
}
