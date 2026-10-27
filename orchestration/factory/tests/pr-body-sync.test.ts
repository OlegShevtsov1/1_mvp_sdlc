import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PR_BODY_SYNC = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "pr-body-sync.ts");
const PR_URL = "https://github.com/example/repo/pull/3";
const DELIVERY = JSON.stringify({ ready: true, reason: "delivered", pr_url: PR_URL });

// A fake `gh` first on PATH that records its argv. A read prints FAKE_GH_LIVE —
// or, with FAKE_GH_STICKY set, the last edited body — and exits
// FAKE_GH_READ_EXIT; an edit copies its --body-file to edited.md, prints
// FAKE_GH_STDERR to stderr and exits FAKE_GH_EDIT_EXIT.
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-pr-body-sync-bin-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/gh.args"
case "$*" in
  "pr edit "*)
    cp "\${@: -1}" "${dir}/edited.md"
    printf '%s' "$FAKE_GH_STDERR" >&2
    exit "\${FAKE_GH_EDIT_EXIT:-0}" ;;
  "pr view "*)
    if [ -n "$FAKE_GH_STICKY" ] && [ -f "${dir}/edited.md" ]; then
      cat "${dir}/edited.md"; echo
    else
      printf '%s\\n' "$FAKE_GH_LIVE"
    fi
    printf '%s' "$FAKE_GH_STDERR" >&2
    exit "\${FAKE_GH_READ_EXIT:-0}" ;;
esac
exit 1
`,
  );
  chmodSync(gh, 0o755);
  return dir;
}

// Writes the run's body files, oldest first: each one a second newer than the last.
function artifacts(files: Array<[string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-pr-body-sync-art-"));
  files.forEach(([name, text], i) => {
    writeFileSync(join(dir, name), text);
    utimesSync(join(dir, name), 1_000_000 + i, 1_000_000 + i);
  });
  return dir;
}

interface Result { doc: Record<string, unknown>; out: string; bin: string }

function run(dir: string, env: Record<string, string>): Result {
  const bin = fakeGh();
  const p = Bun.spawnSync(["bun", PR_BODY_SYNC], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARTIFACTS_DIR: dir, INPUTS_DELIVERY: DELIVERY, FAKE_GH_LIVE: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = p.stdout.toString();
  const lines = out.trim().split("\n").filter((l) => l !== "");
  expect(p.exitCode).toBe(0);
  expect(lines.length).toBe(1);
  return { doc: JSON.parse(lines[0]), out, bin };
}

const args = (r: Result) => (existsSync(join(r.bin, "gh.args")) ? readFileSync(join(r.bin, "gh.args"), "utf8") : "");
const edited = (r: Result) => readFileSync(join(r.bin, "edited.md"), "utf8");

describe("pr-body-sync", () => {
  test("a stale live description is replaced by the newest body file and read back", () => {
    const body = "## Problem\nround 2\n\n## After merge (operator)\n- A0\n";
    const dir = artifacts([["pr-body-final.md", body]]);
    const r = run(dir, { FAKE_GH_LIVE: "## Problem\nround 1", FAKE_GH_STICKY: "1" });
    expect(r.doc).toEqual({ pr_url: PR_URL, action: "updated", source: "pr-body-final.md", reason: "" });
    expect(edited(r)).toBe(body);
    const calls = args(r);
    expect(calls).toContain(`pr view ${PR_URL} --json body --jq .body`);
    expect(calls).toContain(`pr edit ${PR_URL} --body-file ${join(dir, "pr-body-sync.md")}`);
    expect(calls).not.toContain("round 2");
  });

  test("the newest file wins; on equal mtimes pr-body-final.md wins", () => {
    const json = JSON.stringify({ ref: { number: 3 }, body: "forge" });
    const files: Array<[string, string]> = [["pr-body.md", "opening"], ["pr-create-started", ""], ["pr-body-final.md", "final"], ["pr-body-final.json", json]];
    const newer = artifacts(files);
    expect(edited(run(newer, { FAKE_GH_STICKY: "1" }))).toBe("forge");

    const tie = artifacts(files);
    utimesSync(join(tie, "pr-body-final.json"), 1_000_002, 1_000_002);
    const r = run(tie, { FAKE_GH_STICKY: "1" });
    expect(r.doc).toMatchObject({ action: "updated", source: "pr-body-final.md" });
    expect(edited(r)).toBe("final");
  });

  test("a pr-body.md rewritten after the PR opened wins over a newer pr-body-final.md", () => {
    const round2 = "## Problem\nround 2\n\n## After merge (operator)\n- A0\n";
    const dir = artifacts([["pr-create-started", ""], ["pr-body.md", round2], ["pr-body-final.md", "## Problem\nround 1, claims patched\n"]]);
    const r = run(dir, { FAKE_GH_LIVE: "## Problem\nround 1", FAKE_GH_STICKY: "1" });
    expect(r.doc).toEqual({ pr_url: PR_URL, action: "updated", source: "pr-body.md", reason: "" });
    expect(edited(r)).toContain("## After merge (operator)");
  });

  test("a continuation run's pr-body.md, with no pr-create-started, wins over a newer pr-body-final.md", () => {
    const dir = artifacts([["pr-body.md", "## Problem\nthis run\n"], ["pr-body-final.md", "## Problem\nprevious run, claims patched\n"]]);
    const r = run(dir, { FAKE_GH_LIVE: "## Problem\nprevious run", FAKE_GH_STICKY: "1" });
    expect(r.doc).toEqual({ pr_url: PR_URL, action: "updated", source: "pr-body.md", reason: "" });
    expect(edited(r)).toContain("this run");
  });

  test("a pr-body.md not newer than pr-create-started leaves the newest file in charge", () => {
    const dir = artifacts([["pr-body.md", "opening"], ["pr-create-started", ""], ["pr-body-final.md", "final"]]);
    const r = run(dir, { FAKE_GH_STICKY: "1" });
    expect(r.doc).toMatchObject({ action: "updated", source: "pr-body-final.md" });
    expect(edited(r)).toBe("final");
  });

  test("the forge source's pr-body-final.json body counts as a candidate", () => {
    const dir = artifacts([["pr-body-final.json", JSON.stringify({ ref: { number: 3 }, body: "x" })]]);
    const r = run(dir, { FAKE_GH_STICKY: "1" });
    expect(r.doc).toMatchObject({ action: "updated", source: "pr-body-final.json" });
    expect(edited(r)).toBe("x");
  });

  test("an unparsable pr-body-final.json counts as absent", () => {
    const dir = artifacts([["pr-body.md", "draft"], ["pr-create-started", ""], ["pr-body-final.json", "not json"]]);
    expect(run(dir, { FAKE_GH_STICKY: "1" }).doc).toMatchObject({ action: "updated", source: "pr-body.md" });
  });

  test("a live description differing only in CRLF and trailing newlines is unchanged", () => {
    const dir = artifacts([["pr-body-final.md", "## Problem\nsame\n\n"]]);
    const r = run(dir, { FAKE_GH_LIVE: "## Problem\r\nsame" });
    expect(r.doc).toEqual({ pr_url: PR_URL, action: "unchanged", source: "pr-body-final.md", reason: "" });
    expect(args(r)).not.toContain("pr edit");
  });

  test("no body file, or an empty one, is skipped and never blanks the PR", () => {
    expect(run(artifacts([]), { FAKE_GH_LIVE: "live" }).doc).toMatchObject({ action: "skipped", reason: "no pr-body file in the run's artifacts" });
    const r = run(artifacts([["pr-body-final.md", " \n\n"]]), { FAKE_GH_LIVE: "live" });
    expect(r.doc).toMatchObject({ action: "skipped", source: "pr-body-final.md", reason: "pr-body-final.md is empty" });
    expect(args(r)).not.toContain("pr edit");
  });

  test("a delivery with no GitHub pull request URL never calls gh", () => {
    const dir = artifacts([["pr-body.md", "draft"]]);
    for (const delivery of ["{}", "not json", JSON.stringify({ pr_url: `${PR_URL}; rm -rf /` })]) {
      const r = run(dir, { INPUTS_DELIVERY: delivery });
      expect(r.doc).toEqual({ pr_url: "", action: "skipped", source: "", reason: "delivery did not return a GitHub pull request URL" });
      expect(existsSync(join(r.bin, "gh.args"))).toBe(false);
    }
  });

  test("a failed read or edit is reported failed with gh's first stderr line, token redacted", () => {
    const dir = artifacts([["pr-body.md", "draft"]]);
    const read = run(dir, { FAKE_GH_READ_EXIT: "1", FAKE_GH_STDERR: "HTTP 404: Not Found\nmore" });
    expect(read.doc).toMatchObject({ action: "failed", reason: "could not read the pull request description from GitHub: HTTP 404: Not Found" });
    expect(args(read)).not.toContain("pr edit");

    const token = "secret-token-value";
    const edit = run(dir, { GH_TOKEN: token, FAKE_GH_EDIT_EXIT: "1", FAKE_GH_STDERR: `HTTP 502 for token ${token}` });
    expect(edit.doc).toMatchObject({ action: "failed", source: "pr-body.md", reason: "gh pr edit exited 1: HTTP 502 for token ***" });
    expect(edit.out).not.toContain(token);

    const actions = run(dir, { GITHUB_TOKEN: token, FAKE_GH_EDIT_EXIT: "1", FAKE_GH_STDERR: `HTTP 502 for token ${token}` });
    expect(actions.doc).toMatchObject({ action: "failed", reason: "gh pr edit exited 1: HTTP 502 for token ***" });
    expect(actions.out).not.toContain(token);
  });

  test("an edit that did not land is reported failed", () => {
    const dir = artifacts([["pr-body-final.md", "corrected"]]);
    const r = run(dir, { FAKE_GH_LIVE: "stale" });
    expect(r.doc).toMatchObject({ action: "failed", reason: "the pull request description still differs from pr-body-final.md after the update" });
  });
});
