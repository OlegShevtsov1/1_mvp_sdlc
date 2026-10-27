import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decideSync, type SyncFacts } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/sync-decision.ts";

const SCRIPTS = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts");
const RUN_BRANCH = "archon/task-factory-test";

function sh(cmd: string, cwd: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function git(cmd: string, cwd: string): string {
  const r = sh(`git ${cmd}`, cwd);
  if (r.code !== 0) throw new Error(`git ${cmd}: ${r.err}`);
  return r.out.trim();
}

interface Layout { clone: string; run: string; artifacts: string; mainTip: string; developTip: string }

type Files = Record<string, string>;

function write(root: string, files: Files): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

// An origin whose default branch main has diverged from develop, a clone of it, and a run
// worktree cut from origin/main the way Archon cuts it. Each branch's own commit adds its files.
function diverged(opts: { from?: string; mainFiles?: Files; developFiles?: Files } = {}): Layout {
  const dir = mkdtempSync(join(tmpdir(), "factory-sync-"));
  const ident = "-c user.email=t@e.com -c user.name=t";
  sh(`git init -q --bare -b main origin.git && git clone -q origin.git seed 2>/dev/null`, dir);
  const seed = join(dir, "seed");
  const commitOwn = (branch: string, files: Files = {}) => {
    write(seed, files);
    sh(`git add -f -A && git ${ident} commit -q --allow-empty -m ${branch}-only && git push -q origin ${branch}`, seed);
  };
  sh(`git checkout -q -b main && git ${ident} commit -q --allow-empty -m base && git push -q origin main`, seed);
  sh("git checkout -q -b develop", seed);
  commitOwn("develop", opts.developFiles);
  sh("git checkout -q main", seed);
  commitOwn("main", opts.mainFiles);
  sh("git clone -q origin.git clone", dir);
  const clone = join(dir, "clone");
  const run = join(dir, "run");
  git(`worktree add -q -b ${RUN_BRANCH} ${run} ${opts.from ?? "origin/main"}`, clone);
  git("config user.email t@e.com", clone);
  git("config user.name t", clone);
  writeFileSync(join(run, "tracked.txt"), "one\n");
  return {
    clone,
    run,
    artifacts: mkdtempSync(join(tmpdir(), "factory-art-")),
    mainTip: git("rev-parse origin/main", clone),
    developTip: git("rev-parse origin/develop", clone),
  };
}

function syncBase(
  cwd: string,
  artifacts: string,
  inputs: { remote?: string; base?: string; profileCommit?: string } = {},
  env: Record<string, string> = {},
) {
  const r = sh(`bun ${SCRIPTS}/sync-base.ts`, cwd, {
    ...env,
    INPUTS_REMOTE: inputs.remote ?? "origin",
    INPUTS_BASE_BRANCH: inputs.base ?? "develop",
    INPUTS_PROFILE_COMMIT: inputs.profileCommit ?? "",
    ARTIFACTS_DIR: artifacts,
  });
  return { ...r, doc: r.code === 0 ? JSON.parse(r.out) : null };
}

const PROFILE = ".archon/factory-profile.yaml";
const PROFILE_TEXT = "version: 1\nrepo:\n  base_branch: develop\n";
const MONITORING = ".archon/mcp/monitoring.json";

// A `git` on PATH that fails every call starting with `prefix`, the way a broken probe would.
function failingGit(prefix: string): Record<string, string> {
  const bin = mkdtempSync(join(tmpdir(), "factory-git-"));
  const realGit = sh("command -v git", bin).out.trim();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase "$*" in "${prefix}"*) echo "probe broke" >&2; exit 128;; esac\nexec ${realGit} "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}

function commitProfile(run: string): string {
  write(run, { [PROFILE]: PROFILE_TEXT });
  git("add -f -- .archon/factory-profile.yaml", run);
  git('commit -q -m "chore: add factory profile"', run);
  return git("rev-parse HEAD", run);
}

describe("sync-base", () => {
  test("moves a fresh run worktree cut from the default branch to the base branch", () => {
    const l = diverged();
    expect(git("rev-parse HEAD", l.run)).toBe(l.mainTip);

    const r = syncBase(l.run, l.artifacts);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.doc).toEqual({
      action: "reset",
      base: "origin/develop",
      before: l.mainTip,
      after: l.developTip,
      reason: expect.any(String),
    });
    expect(git("rev-parse HEAD", l.run)).toBe(l.developTip);
    expect(git("symbolic-ref --short HEAD", l.run)).toBe(RUN_BRANCH);
    expect(readFileSync(join(l.artifacts, "sync-base.log"), "utf8")).toContain(`reset ${RUN_BRANCH}`);
  });

  test("keeps a run worktree already at the base branch", () => {
    const l = diverged({ from: "origin/develop" });
    const r = syncBase(l.run, l.artifacts);
    expect(r.code).toBe(0);
    expect(r.doc.action).toBe("kept");
    expect(r.doc.reason).toContain("already at");
    expect(git("rev-parse HEAD", l.run)).toBe(l.developTip);
    expect(readFileSync(join(l.artifacts, "sync-base.log"), "utf8")).toContain(`kept ${RUN_BRANCH}`);
  });

  test("keeps a branch with a commit of its own", () => {
    const l = diverged();
    git("add tracked.txt", l.run);
    git("commit -q -m work", l.run);
    const head = git("rev-parse HEAD", l.run);
    const r = syncBase(l.run, l.artifacts);
    expect(r.code).toBe(0);
    expect(r.doc.action).toBe("kept");
    expect(r.doc.reason).toContain("1 commit");
    expect(git("rev-parse HEAD", l.run)).toBe(head);
  });

  test("carries this run's profile commit over to the base branch", () => {
    const l = diverged();
    const profileCommit = commitProfile(l.run);
    const bytes = readFileSync(join(l.run, ".archon/factory-profile.yaml"));

    const r = syncBase(l.run, l.artifacts, { profileCommit });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.doc.action).toBe("reset");
    expect(r.doc.after).toBe(git("rev-parse HEAD", l.run));
    expect(git("rev-parse HEAD^", l.run)).toBe(l.developTip);
    expect(readFileSync(join(l.run, ".archon/factory-profile.yaml")).equals(bytes)).toBe(true);
    expect(git("log -1 --format=%s", l.run)).toBe("chore: add factory profile");
    expect(git("rev-list --count origin/develop..HEAD", l.run)).toBe("1");
  });

  test("skips the carry-over commit when the base already has the identical profile", () => {
    const l = diverged({ developFiles: { [PROFILE]: PROFILE_TEXT } });
    const profileCommit = commitProfile(l.run);

    const r = syncBase(l.run, l.artifacts, { profileCommit });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.doc.action).toBe("reset");
    expect(r.doc.after).toBe(l.developTip);
    expect(git("rev-parse HEAD", l.run)).toBe(l.developTip);
    expect(git("status --porcelain --untracked-files=no", l.run)).toBe("");
  });

  test("carries repo config committed on the default branch but not on the base", () => {
    const monitoring = '{"mcpServers":{}}\n';
    const l = diverged({ mainFiles: { [PROFILE]: PROFILE_TEXT, [MONITORING]: monitoring } });

    const r = syncBase(l.run, l.artifacts);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.doc.action).toBe("reset");
    expect(r.doc.after).toBe(git("rev-parse HEAD", l.run));
    expect(git("rev-list --reverse --format=%s --no-commit-header origin/develop..HEAD", l.run).split("\n")).toEqual([
      "chore: add factory profile",
      "chore: add monitoring MCP config",
    ]);
    expect(readFileSync(join(l.run, PROFILE), "utf8")).toBe(PROFILE_TEXT);
    expect(readFileSync(join(l.run, MONITORING), "utf8")).toBe(monitoring);
    expect(git("status --porcelain --untracked-files=no", l.run)).toBe("");
    const log = readFileSync(join(l.artifacts, "sync-base.log"), "utf8");
    expect(log).toContain(`carried ${PROFILE} over the reset`);
    expect(log).toContain(`carried ${MONITORING} over the reset`);
  });

  test("carries nothing the base already tracks", () => {
    const l = diverged({ mainFiles: { [MONITORING]: "{}\n" }, developFiles: { [MONITORING]: "{\"base\":1}\n" } });
    const r = syncBase(l.run, l.artifacts);
    expect(r.code).toBe(0);
    expect(r.doc.after).toBe(l.developTip);
    expect(readFileSync(join(l.run, MONITORING), "utf8")).toBe('{"base":1}\n');
  });

  for (const prefix of ["rev-parse --path-format", "rev-list", "status", "ls-tree"]) {
    test(`fails without moving the branch when git ${prefix} fails`, () => {
      const l = diverged({ mainFiles: { [MONITORING]: "{}\n" } });
      const r = syncBase(l.run, l.artifacts, {}, failingGit(prefix));
      expect(r.code).toBe(1);
      expect(r.err).toContain(`sync-base: git ${prefix.split(" ")[0]} failed: probe broke`);
      expect(r.out).toBe("");
      expect(git("rev-parse HEAD", l.run)).toBe(l.mainTip);
      expect(existsSync(join(l.run, MONITORING))).toBe(true);
    });
  }

  test("keeps a branch with work on top of the profile commit", () => {
    const l = diverged();
    const profileCommit = commitProfile(l.run);
    git("add tracked.txt", l.run);
    git("commit -q -m work", l.run);
    const head = git("rev-parse HEAD", l.run);
    const r = syncBase(l.run, l.artifacts, { profileCommit });
    expect(r.code).toBe(0);
    expect(r.doc.action).toBe("kept");
    expect(git("rev-parse HEAD", l.run)).toBe(head);
  });

  test("keeps a checkout with tracked changes", () => {
    const l = diverged();
    git("add tracked.txt", l.run);
    const r = syncBase(l.run, l.artifacts);
    expect(r.code).toBe(0);
    expect(r.doc.action).toBe("kept");
    expect(r.doc.reason).toContain("uncommitted");
    expect(git("rev-parse HEAD", l.run)).toBe(l.mainTip);
    expect(git("status --porcelain", l.run)).toBe("A  tracked.txt");
  });

  test("never moves a checkout that is not a linked worktree", () => {
    const l = diverged();
    git("checkout -q -b local-work origin/main", l.clone);
    const r = syncBase(l.clone, l.artifacts);
    expect(r.code).toBe(0);
    expect(r.doc.action).toBe("kept");
    expect(git("rev-parse HEAD", l.clone)).toBe(l.mainTip);
  });

  test("never moves a branch that is published on the remote", () => {
    const l = diverged();
    git(`push -q origin ${RUN_BRANCH}`, l.run);
    const r = syncBase(l.run, l.artifacts);
    expect(r.code).toBe(0);
    expect(r.doc.action).toBe("kept");
    expect(r.doc.reason).toContain("published");
    expect(git("rev-parse HEAD", l.run)).toBe(l.mainTip);
  });

  test("fails when the base branch cannot be fetched", () => {
    const l = diverged();
    const r = syncBase(l.run, l.artifacts, { base: "nosuch" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("sync-base: could not fetch origin/nosuch");
    expect(r.out).toBe("");
    expect(git("rev-parse HEAD", l.run)).toBe(l.mainTip);
  });

  test("refuses a malformed base branch or remote", () => {
    const l = diverged();
    for (const inputs of [{ base: "bad..name" }, { remote: "a b" }, { base: "" }]) {
      const r = syncBase(l.run, l.artifacts, inputs);
      expect(r.code).toBe(1);
      expect(r.err).toContain("sync-base:");
      expect(r.out).toBe("");
      expect(git("rev-parse HEAD", l.run)).toBe(l.mainTip);
    }
  });
});

describe("decideSync", () => {
  const facts: SyncFacts = {
    head: "a".repeat(40),
    target: "b".repeat(40),
    detached: false,
    linkedWorktree: true,
    branch: RUN_BRANCH,
    branchOnRemote: false,
    baseBranch: "develop",
    dirty: false,
    own: [],
    profileCommit: "",
  };

  test("resets a clean unpublished worktree branch with nothing of its own", () => {
    expect(decideSync(facts)).toEqual({ action: "reset", carryProfile: false, reason: expect.any(String) });
  });

  test("being at the target wins over every guard", () => {
    const d = decideSync({ ...facts, head: facts.target, detached: true, dirty: true });
    expect(d.action).toBe("kept");
    expect(d.reason).toContain("already at");
  });

  test("a detached HEAD is reported before a dirty tree", () => {
    const d = decideSync({ ...facts, detached: true, dirty: true });
    expect(d.action).toBe("kept");
    expect(d.reason).toContain("detached");
  });

  test("the branch named like the base is never moved", () => {
    const d = decideSync({ ...facts, branch: "develop" });
    expect(d.action).toBe("kept");
    expect(d.reason).toContain("published");
  });

  test("only the bound profile commit is carried over", () => {
    const sha = "c".repeat(40);
    expect(decideSync({ ...facts, own: [sha], profileCommit: sha })).toEqual({
      action: "reset",
      carryProfile: true,
      reason: expect.any(String),
    });
    expect(decideSync({ ...facts, own: [sha], profileCommit: "" }).action).toBe("kept");
    expect(decideSync({ ...facts, own: [sha], profileCommit: "d".repeat(40) }).action).toBe("kept");
    expect(decideSync({ ...facts, own: [sha, "e".repeat(40)], profileCommit: sha }).reason).toContain("2 commits");
  });
});
