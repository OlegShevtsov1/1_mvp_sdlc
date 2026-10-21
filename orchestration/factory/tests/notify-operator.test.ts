import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOTIFY = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "notify-operator.ts");
const PR_URL = "https://github.com/example/repo/pull/3";

// A fake `gh` first on PATH that records each argument on its own line, then
// prints FAKE_GH_ERR to stderr and exits FAKE_GH_EXIT.
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-notify-bin-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "${dir}/gh.args"
printf '%s' "$FAKE_GH_ERR" >&2
exit "\${FAKE_GH_EXIT:-0}"
`,
  );
  chmodSync(gh, 0o755);
  return dir;
}

function run(env: Record<string, string>): { doc: Record<string, unknown>; bin: string } {
  const bin = fakeGh();
  const p = Bun.spawnSync(["bun", NOTIFY], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INPUTS_PR_URL: PR_URL, INPUTS_BASE: "main", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines = p.stdout.toString().trim().split("\n").filter((l) => l !== "");
  expect(p.exitCode).toBe(0);
  expect(lines.length).toBe(1);
  return { doc: JSON.parse(lines[0]), bin };
}

describe("notify-operator", () => {
  test("comments on the pull request that it is ready for the operator", () => {
    const r = run({});
    expect(r.doc).toEqual({ notified: true, reason: "" });
    const args = readFileSync(join(r.bin, "gh.args"), "utf8").split("\n");
    expect(args.slice(0, 4)).toEqual(["pr", "comment", PR_URL, "--body"]);
    expect(args[4].startsWith("ready for the operator: base main is manual")).toBe(true);
  });

  test("a failed comment is reported, naming the gh failure", () => {
    const r = run({ FAKE_GH_EXIT: "1", FAKE_GH_ERR: "HTTP 403: forbidden\nmore detail" });
    expect(r.doc).toEqual({ notified: false, reason: "gh pr comment failed: HTTP 403: forbidden" });
  });

  test("no GitHub pull request URL never calls gh", () => {
    for (const url of ["", "https://example.com/pull/3", `${PR_URL}; rm -rf /`]) {
      const r = run({ INPUTS_PR_URL: url });
      expect(r.doc).toEqual({ notified: false, reason: "no GitHub pull request URL to comment on" });
      expect(existsSync(join(r.bin, "gh.args"))).toBe(false);
    }
  });
});
