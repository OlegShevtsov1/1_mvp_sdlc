import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEPLOY = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "deploy.ts");

function run(cwd: string, env: Record<string, string>): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", DEPLOY], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

// A repository with no `origin`, so `git fetch origin` cannot succeed.
function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "factory-deploy-repo-"));
  Bun.spawnSync(["bash", "-c", "git init -q -b main && git config user.email t@e.com && git config user.name t && git commit -q --allow-empty -m init"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  return repo;
}

describe("deploy", () => {
  test("a checkout that fails is a deploy outcome, not a node failure", () => {
    const repo = newRepo();
    const artifacts = mkdtempSync(join(tmpdir(), "factory-deploy-art-"));

    const r = run(repo, {
      INPUTS_COMMAND: "echo deploy-command-ran",
      INPUTS_SECRET_NAMES: "[]",
      INPUTS_REMOTE: "origin",
      INPUTS_MERGE_SHA: "deadbeefdeadbeef",
      ARTIFACTS_DIR: artifacts,
    });

    // Exit 0 and a well-formed result: `report` must still be reachable.
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines.length).toBe(1);
    const doc = JSON.parse(lines[0]);
    expect(doc.deployed).toBe(false);
    expect(doc.exit_code).not.toBe(0);
    expect(doc.log).toBe(`${artifacts}/deploy.log`);
    expect(typeof doc.deployed_at).toBe("string");

    const log = readFileSync(join(artifacts, "deploy.log"), "utf8");
    expect(log).toContain("could not check out merge commit deadbeefdeadbeef");
    // The deploy command must not have run after a failed checkout.
    expect(log).not.toContain("deploy-command-ran");
  });

  test("refuses a malformed remote or merge_sha", () => {
    const repo = newRepo();
    const artifacts = mkdtempSync(join(tmpdir(), "factory-deploy-art-"));
    const base = { INPUTS_COMMAND: "echo deploy-command-ran", INPUTS_SECRET_NAMES: "[]", ARTIFACTS_DIR: artifacts };

    const badRemote = run(repo, { ...base, INPUTS_REMOTE: "origin; rm -rf /", INPUTS_MERGE_SHA: "deadbeefdeadbeef" });
    expect(badRemote.code).toBe(1);
    expect(badRemote.out).toBe("");
    expect(badRemote.err).toContain("refusing malformed remote or merge_sha");

    const badSha = run(repo, { ...base, INPUTS_REMOTE: "origin", INPUTS_MERGE_SHA: "$(id) HEAD" });
    expect(badSha.code).toBe(1);
    expect(badSha.out).toBe("");
    expect(badSha.err).toContain("refusing malformed remote or merge_sha");
  });
});
