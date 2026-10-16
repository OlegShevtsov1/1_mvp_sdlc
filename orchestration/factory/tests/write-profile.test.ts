import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPTS = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts");

function sh(cmd: string, cwd: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const draft = {
  version: 1,
  stack: { language: "python", framework: "", test_command: "pytest -q", lint_command: "", build_command: "" },
  repo: { remote: "origin", base_branch: "main", merge_strategy: "squash" },
  deploy: { command: "echo deploy", health_url: "http://localhost:8000/health", wait_seconds: 30, rollback_command: "echo rollback" },
  monitoring: { provider: "none", mcp_config: "", window_minutes: 10 },
  secrets: ["API_TOKEN"],
};

function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
  sh("git init -q -b main && git config user.email t@e.com && git config user.name t && git commit -q --allow-empty -m init", repo);
  return repo;
}

function newArtifacts(): string {
  const artifacts = mkdtempSync(join(tmpdir(), "factory-art-"));
  writeFileSync(join(artifacts, "factory-profile.json"), JSON.stringify(draft));
  return artifacts;
}

describe("write-profile then load-profile", () => {
  test("writes, commits and reads back the profile", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const artifacts = mkdtempSync(join(tmpdir(), "factory-art-"));
    sh("git init -q -b main && git config user.email t@e.com && git config user.name t && git commit -q --allow-empty -m init", repo);
    writeFileSync(join(artifacts, "factory-profile.json"), JSON.stringify(draft));

    const w = sh(`bun ${SCRIPTS}/write-profile.ts`, repo, { ARTIFACTS_DIR: artifacts });
    expect(w.err).toBe("");
    expect(w.code).toBe(0);
    const wdoc = JSON.parse(w.out);
    expect(wdoc.written).toBe(true);
    expect(wdoc.path).toBe(".archon/factory-profile.yaml");
    expect(existsSync(join(repo, ".archon/factory-profile.yaml"))).toBe(true);
    expect(sh("git log --oneline | head -1", repo).out).toContain("factory profile");
    expect(readFileSync(join(repo, ".archon/factory-profile.yaml"), "utf8")).not.toContain("API_TOKEN=");

    const l = sh(`bun ${SCRIPTS}/load-profile.ts`, repo);
    expect(l.code).toBe(0);
    const flat = JSON.parse(l.out);
    expect(flat.health_url).toBe("http://localhost:8000/health");
    expect(flat.secret_names).toEqual(["API_TOKEN"]);
    expect(flat.monitoring_provider).toBe("none");
  });

  test("refuses an invalid draft and writes nothing", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const artifacts = mkdtempSync(join(tmpdir(), "factory-art-"));
    sh("git init -q -b main && git commit -q --allow-empty -m init", repo);
    writeFileSync(join(artifacts, "factory-profile.json"), JSON.stringify({ ...draft, secrets: ["BAD=value"] }));
    const w = sh(`bun ${SCRIPTS}/write-profile.ts`, repo, { ARTIFACTS_DIR: artifacts });
    expect(w.code).toBe(1);
    expect(w.err).toContain("secrets[0]");
    expect(existsSync(join(repo, ".archon/factory-profile.yaml"))).toBe(false);
  });

  test("a re-run with an unchanged profile succeeds and emits the current HEAD", () => {
    const repo = newRepo();
    const artifacts = newArtifacts();

    const first = sh(`bun ${SCRIPTS}/write-profile.ts`, repo, { ARTIFACTS_DIR: artifacts });
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    const head = sh("git rev-parse HEAD", repo).out.trim();
    const count = sh("git rev-list --count HEAD", repo).out.trim();
    expect(JSON.parse(first.out).commit).toBe(head);

    const second = sh(`bun ${SCRIPTS}/write-profile.ts`, repo, { ARTIFACTS_DIR: artifacts });
    expect(second.err).toBe("");
    expect(second.code).toBe(0);
    const doc = JSON.parse(second.out);
    expect(doc.written).toBe(true);
    expect(doc.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.commit).toBe(head);
    expect(sh("git rev-list --count HEAD", repo).out.trim()).toBe(count);
  });

  test("commits the profile even when the repo gitignores .archon/", () => {
    const repo = newRepo();
    const artifacts = newArtifacts();
    writeFileSync(join(repo, ".gitignore"), ".archon/\n");

    const w = sh(`bun ${SCRIPTS}/write-profile.ts`, repo, { ARTIFACTS_DIR: artifacts });
    expect(w.err).toBe("");
    expect(w.code).toBe(0);
    expect(sh("git ls-files .archon/factory-profile.yaml", repo).out.trim()).toBe(".archon/factory-profile.yaml");
  });

  test("a commit step that prints on stdout does not contaminate the emitted commit sha", () => {
    const repo = newRepo();
    const artifacts = newArtifacts();
    // A post-commit hook alone proves nothing here: this git sends hook stdout
    // to stderr. A `git` shim on PATH that banners on `commit` reproduces what
    // a husky-style wrapper does to the commit step's stdout on any git.
    const realGit = sh("command -v git", repo).out.trim();
    const bin = mkdtempSync(join(tmpdir(), "factory-bin-"));
    const shim = join(bin, "git");
    writeFileSync(shim, `#!/bin/sh\n[ "$1" = "commit" ] && echo "[husky] running pre-commit"\nexec ${realGit} "$@"\n`);
    chmodSync(shim, 0o755);
    const hook = join(repo, ".git", "hooks", "post-commit");
    writeFileSync(hook, "#!/bin/sh\necho '[husky] running post-commit'\n");
    chmodSync(hook, 0o755);

    const w = sh(`bun ${SCRIPTS}/write-profile.ts`, repo, { ARTIFACTS_DIR: artifacts, PATH: `${bin}:${process.env.PATH}` });
    expect(w.err).toBe("");
    expect(w.code).toBe(0);
    const doc = JSON.parse(w.out);
    expect(doc.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.commit).toBe(sh("git rev-parse HEAD", repo).out.trim());
  });

  test("refuses to run without ARTIFACTS_DIR", () => {
    const repo = newRepo();
    // env: {} in Bun.spawnSync would still inherit nothing else either, so the
    // variable is removed from an otherwise complete environment instead.
    const env = { ...process.env } as Record<string, string>;
    delete env.ARTIFACTS_DIR;
    const p = Bun.spawnSync(["bash", "-c", `bun ${SCRIPTS}/write-profile.ts`], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("ARTIFACTS_DIR");
    expect(p.stdout.toString()).toBe("");
    expect(existsSync(join(repo, ".archon/factory-profile.yaml"))).toBe(false);
  });

  test("load-profile fails when the file is missing", () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
    const l = sh(`bun ${SCRIPTS}/load-profile.ts`, repo);
    expect(l.code).toBe(1);
    expect(l.err).toContain(".archon/factory-profile.yaml");
  });
});
