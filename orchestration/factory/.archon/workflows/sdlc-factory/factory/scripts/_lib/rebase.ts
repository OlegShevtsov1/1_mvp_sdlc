export interface RebaseResult {
  status: "rebased" | "conflicted" | "failed";
  files: string[];
  detail: string;
}

const NETWORK_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 300_000;

function git(args: string[], timeout = LOCAL_TIMEOUT_MS): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", timeout });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

// Rebases the checkout (the pull request head at headOid, clean) onto
// <remote>/<base> and pushes it to <head> only if the branch is still at
// headOid. On any failure the checkout is left at headOid, clean.
export function rebaseOntoBase(
  { remote, base, head, headOid }: { remote: string; base: string; head: string; headOid: string },
  log: (line: string) => void,
): RebaseResult {
  const onto = `${remote}/${base}`;
  const fetch = git(["fetch", remote, `+refs/heads/${base}:refs/remotes/${onto}`], NETWORK_TIMEOUT_MS);
  if (!fetch.ok) {
    log(`rebase: git fetch ${remote} ${base} failed: ${fetch.err}`);
    return { status: "failed", files: [], detail: `git fetch ${remote} ${base} failed: ${fetch.err}` };
  }
  log(`rebase: rebasing ${head} (${headOid}) onto ${onto}`);
  const rebase = git(["-c", "core.editor=true", "rebase", onto]);
  if (!rebase.ok) {
    const unmerged = git(["diff", "--name-only", "--diff-filter=U"]);
    const files = unmerged.out === "" ? [] : unmerged.out.split("\n");
    git(["rebase", "--abort"]);
    if (files.length > 0) {
      log(`rebase: conflicts in ${files.join(", ")}; aborted`);
      return { status: "conflicted", files, detail: "" };
    }
    log(`rebase: git rebase failed: ${rebase.err || rebase.out}`);
    return { status: "failed", files: [], detail: `git rebase failed: ${rebase.err || rebase.out}` };
  }
  // The explicit lease value does not depend on the checkout's upstream tracking.
  const push = git(
    ["push", `--force-with-lease=refs/heads/${head}:${headOid}`, remote, `HEAD:refs/heads/${head}`],
    NETWORK_TIMEOUT_MS,
  );
  if (!push.ok) {
    git(["reset", "--hard", headOid]);
    log(`rebase: push to ${remote} ${head} refused, checkout reset to ${headOid}: ${push.err}`);
    return { status: "failed", files: [], detail: `git push to ${head} was refused: ${push.err}` };
  }
  log(`rebase: pushed ${git(["rev-parse", "HEAD"]).out} to ${remote} ${head}`);
  return { status: "rebased", files: [], detail: "" };
}

// Whether the merge commit mergeSha brought the checkout's HEAD into <base>:
// HEAD is reachable from it but not from its first parent, the base before the
// merge (so a checkout sitting on an old base commit does not count). A fetch
// that fails or a commit git does not know answers false.
export function mergeContains(
  { remote, base, mergeSha }: { remote: string; base: string; mergeSha: string },
  log: (line: string) => void,
): boolean {
  const fetch = git(["fetch", remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`], NETWORK_TIMEOUT_MS);
  if (!fetch.ok) {
    log(`merged: git fetch ${remote} ${base} failed: ${fetch.err}`);
    return false;
  }
  if (!git(["cat-file", "-e", `${mergeSha}^{commit}`]).ok) {
    log(`merged: merge commit ${mergeSha} is unknown after fetching ${remote}/${base}`);
    return false;
  }
  const isAncestor = (rev: string) => git(["merge-base", "--is-ancestor", "HEAD", rev]).ok;
  const contains = isAncestor(mergeSha) && !isAncestor(`${mergeSha}^1`);
  log(`merged: merge commit ${mergeSha} ${contains ? "introduced" : "does not contain"} the checkout's HEAD`);
  return contains;
}
