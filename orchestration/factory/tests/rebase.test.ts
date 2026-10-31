import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REBASE = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "_lib", "rebase.ts");

// The identity covers every git in a chained command: CI runners have no global one.
function git(cwd: string, args: string): string {
  const p = Bun.spawnSync(
    ["bash", "-c", `export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e.com; git ${args}`],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  return p.stdout.toString().trim();
}

// A bare origin whose develop has one commit, a checkout on feature-x (one
// commit on develop), and a second clone that lands feature-x into develop the
// way `how` says; returns the checkout, the merged-in commit and develop's tip.
function landed(how: "merge" | "squash"): { repo: string; mergeSha: string; oldBase: string } {
  const remote = mkdtempSync(join(tmpdir(), "factory-rebase-remote-"));
  git(remote, "init -q --bare -b develop");
  const repo = mkdtempSync(join(tmpdir(), "factory-rebase-repo-"));
  git(repo, `init -q -b develop && git remote add origin ${remote}`);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add -A && git commit -q -m base && git push -q origin develop && git checkout -q -b feature-x");
  const oldBase = git(repo, "rev-parse HEAD");
  writeFileSync(join(repo, "feature.txt"), "feature\n");
  git(repo, "add -A && git commit -q -m feature && git push -q origin feature-x");
  const other = mkdtempSync(join(tmpdir(), "factory-rebase-other-"));
  git(other, `clone -q ${remote} . && git fetch -q origin feature-x`);
  git(other, how === "merge" ? "merge -q --no-ff -m merge FETCH_HEAD" : "merge -q --squash FETCH_HEAD && git commit -q -m squash");
  git(other, "push -q origin develop");
  return { repo, mergeSha: git(other, "rev-parse HEAD"), oldBase };
}

function mergeContains(repo: string, mergeSha: string): boolean {
  const p = Bun.spawnSync(
    ["bun", "-e", `const { mergeContains } = await import(${JSON.stringify(REBASE)});
console.log(mergeContains({ remote: "origin", base: "develop", mergeSha: ${JSON.stringify(mergeSha)} }, () => {}));`],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  return p.stdout.toString().trim() === "true";
}

describe("mergeContains", () => {
  test("a merge commit that brought the checkout's HEAD into the base contains it", () => {
    const { repo, mergeSha } = landed("merge");
    expect(mergeContains(repo, mergeSha)).toBe(true);
  });

  test("a squash commit does not: the checkout's commit is not its ancestor", () => {
    const { repo, mergeSha } = landed("squash");
    expect(mergeContains(repo, mergeSha)).toBe(false);
  });

  test("a checkout on a base commit older than the merge does not count", () => {
    const { repo, mergeSha, oldBase } = landed("merge");
    git(repo, `checkout -q ${oldBase}`);
    expect(mergeContains(repo, mergeSha)).toBe(false);
  });

  test("a commit git does not know does not", () => {
    const { repo } = landed("merge");
    expect(mergeContains(repo, "0123456789abcdef0123456789abcdef01234567")).toBe(false);
  });
});
