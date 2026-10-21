import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// A fake `gh` first on PATH that records its argv. `pr view` prints FAKE_GH_JSON
// and exits FAKE_GH_EXIT; `pr checks` prints FAKE_GH_CHECKS to stdout,
// FAKE_GH_CHECKS_ERR to stderr, and exits FAKE_GH_CHECKS_EXIT.
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-pr-state-bin-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/gh.args"
case "$1 $2" in
  "pr view") printf '%s' "$FAKE_GH_JSON"; exit "\${FAKE_GH_EXIT:-0}" ;;
  "pr checks") printf '%s' "$FAKE_GH_CHECKS"; printf '%s' "$FAKE_GH_CHECKS_ERR" >&2; exit "\${FAKE_GH_CHECKS_EXIT:-0}" ;;
esac
exit 1
`,
  );
  chmodSync(gh, 0o755);
  return dir;
}

interface Result { code: number; doc: Record<string, unknown>; lines: string[]; bin: string }

function run(repo: string, env: Record<string, string>): Result {
  const bin = fakeGh();
  const p = Bun.spawnSync(["bun", PR_STATE], {
    cwd: repo,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_CHECKS: "[]", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = p.stdout.toString().trim().split("\n").filter((l) => l !== "");
  expect(p.exitCode).toBe(0);
  expect(lines.length).toBe(1);
  return { code: p.exitCode, doc: JSON.parse(lines[0]), lines, bin };
}

function prJson(head: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ headRefOid: head, headRefName: "feature-x", isDraft: false, state: "OPEN", baseRefName: "develop", ...extra });
}

const DELIVERY = JSON.stringify({ pr_url: PR_URL });

describe("pr-state", () => {
  test("Archon v0.10.1 delivery (PR record with url) reads the PR and its checks", () => {
    const { repo, head } = newRepo();
    const checks = [{ name: "Lint", bucket: "pass" }, { name: "Tests", bucket: "pending" }];
    const r = run(repo, {
      INPUTS_DELIVERY: JSON.stringify({ url: PR_URL, head: "feature-x", number: 3 }),
      FAKE_GH_JSON: prJson(head),
      FAKE_GH_CHECKS: JSON.stringify(checks),
    });
    expect(r.doc).toEqual({
      pr_url: PR_URL,
      read: true,
      head: "feature-x",
      base: "develop",
      state: "OPEN",
      is_draft: false,
      checkout_is_head: true,
      checkout_clean: true,
      checks,
      checks_read: true,
    });
    const args = readFileSync(join(r.bin, "gh.args"), "utf8");
    expect(args).toContain(`pr view ${PR_URL} --json headRefOid,headRefName,isDraft,state,baseRefName`);
    expect(args).toContain(`pr checks ${PR_URL} --json name,bucket`);
  });

  test("Archon v0.11.1 delivery ({pr_url}) reads the PR", () => {
    const { repo, head } = newRepo();
    const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head) });
    expect(r.doc).toMatchObject({ pr_url: PR_URL, read: true, head: "feature-x", base: "develop" });
  });

  test("a delivery with no GitHub pull request URL never calls gh", () => {
    const { repo, head } = newRepo();
    for (const delivery of ["{}", "not json", JSON.stringify({ url: "https://example.com/pull/3" }), JSON.stringify({ pr_url: `${PR_URL}; rm -rf /` })]) {
      const r = run(repo, { INPUTS_DELIVERY: delivery, FAKE_GH_JSON: prJson(head) });
      expect(r.doc).toMatchObject({ pr_url: "", read: false, head: "" });
      expect(existsSync(join(r.bin, "gh.args"))).toBe(false);
    }
  });

  test("an unreadable pull request is reported unread", () => {
    const { repo, head } = newRepo();
    const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head), FAKE_GH_EXIT: "1" });
    expect(r.doc).toMatchObject({ pr_url: PR_URL, read: false, head: "", base: "" });
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

  test("checks are parsed even when gh exits non-zero", () => {
    const { repo, head } = newRepo();
    const checks = [{ name: "Tests", bucket: "fail" }];
    const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head), FAKE_GH_CHECKS: JSON.stringify(checks), FAKE_GH_CHECKS_EXIT: "1" });
    expect(r.doc).toMatchObject({ checks, checks_read: true });
  });

  test("a head with no checks reports an empty, read list", () => {
    const { repo, head } = newRepo();
    const r = run(repo, {
      INPUTS_DELIVERY: DELIVERY,
      FAKE_GH_JSON: prJson(head),
      FAKE_GH_CHECKS: "",
      FAKE_GH_CHECKS_ERR: "no checks reported on the 'feature-x' branch",
      FAKE_GH_CHECKS_EXIT: "1",
    });
    expect(r.doc).toMatchObject({ checks: [], checks_read: true });
  });

  test("unparseable checks are reported unread", () => {
    const { repo, head } = newRepo();
    const r = run(repo, { INPUTS_DELIVERY: DELIVERY, FAKE_GH_JSON: prJson(head), FAKE_GH_CHECKS: "garbage", FAKE_GH_CHECKS_EXIT: "1" });
    expect(r.doc).toMatchObject({ read: true, checks: [], checks_read: false });
  });
});
