export interface SyncFacts {
  head: string;
  target: string;
  detached: boolean;
  linkedWorktree: boolean;
  branch: string;
  branchOnRemote: boolean;
  baseBranch: string;
  dirty: boolean;
  // Commits on HEAD that no remote-tracking branch of the profile's remote contains.
  own: string[];
  profileCommit: string;
}

export interface SyncDecision {
  action: "reset" | "kept";
  carryProfile: boolean;
  reason: string;
}

function kept(reason: string): SyncDecision {
  return { action: "kept", carryProfile: false, reason };
}

// Guards in order of precedence: the first that applies is the reported reason.
export function decideSync(f: SyncFacts): SyncDecision {
  if (f.head === f.target) return kept(`already at ${f.baseBranch}`);
  if (f.detached) return kept("HEAD is detached");
  if (!f.linkedWorktree) return kept("not a linked worktree; a checkout of its own is never moved");
  if (f.branch === f.baseBranch || f.branchOnRemote) return kept(`branch ${f.branch} is published; it is never moved`);
  if (f.dirty) return kept("the checkout has uncommitted tracked changes");
  if (f.own.length === 0) return { action: "reset", carryProfile: false, reason: "the branch has no commits of its own" };
  // The first-run profile commit is the factory's own bookkeeping, not work, so it moves along.
  if (f.own.length === 1 && f.profileCommit !== "" && f.own[0] === f.profileCommit) {
    return { action: "reset", carryProfile: true, reason: "the branch has only this run's profile commit" };
  }
  return kept(`the branch already has ${f.own.length} ${f.own.length === 1 ? "commit" : "commits"} of its own`);
}
