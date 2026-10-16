import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keeperApplies, keeperRunning, MAX_LIFETIME_MS, nextAction, runIdFrom } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/keeper.ts";

const WAIT_KEEPER = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "wait-keeper.ts");
const RUN_ID = "abcdef01-2345-4a6b-8c9d-0123456789ef";
const NOW = new Date("2026-10-16T01:00:00Z");

function paused(resumeAt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    status: "paused",
    metadata: { wait: { owner: "loop_group", nodeId: "deliver__await-checks", bodyWaitId: "ci-pause", kind: "time", resumeAt }, ...extra },
  };
}

describe("runIdFrom", () => {
  test("a real run's artifacts dir ends in its run id", () => {
    expect(runIdFrom(`/home/op/.archon/workspaces/o/r/artifacts/runs/${RUN_ID}`)).toBe(RUN_ID);
  });

  test("a dry run's artifacts dir yields no run id", () => {
    expect(runIdFrom(`/tmp/dry-run-${RUN_ID}/artifacts`)).toBeNull();
  });
});

describe("keeperApplies", () => {
  test("only Archon v0.10.1", () => {
    expect(keeperApplies("Archon CLI v0.10.1\n  Platform: linux-x64\n")).toBe(true);
    expect(keeperApplies("Archon CLI v0.11.1\n")).toBe(false);
    expect(keeperApplies("Archon CLI v0.10.10\n")).toBe(false);
    expect(keeperApplies("")).toBe(false);
  });
});

describe("keeperRunning", () => {
  test("only a live pid in the pid file blocks a second keeper", () => {
    const alive = (pid: number) => pid === 4242;
    expect(keeperRunning("4242", alive)).toBe(true);
    expect(keeperRunning("4243", alive)).toBe(false);
    expect(keeperRunning("", alive)).toBe(false);
    expect(keeperRunning("0", () => true)).toBe(false);
    expect(keeperRunning("not a pid", () => true)).toBe(false);
  });
});

describe("MAX_LIFETIME_MS", () => {
  test("a keeper outlives a long CI run by capping at 12 hours", () => {
    expect(MAX_LIFETIME_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe("nextAction", () => {
  test("a time wait past its deadline (plus grace) is resumed", () => {
    expect(nextAction(paused("2026-10-16T00:59:50Z"), NOW)).toBe("resume");
  });

  test("a time wait not yet due, or due within the grace, waits", () => {
    expect(nextAction(paused("2026-10-16T01:05:00Z"), NOW)).toBe("wait");
    expect(nextAction(paused("2026-10-16T00:59:58Z"), NOW)).toBe("wait");
  });

  test("an approval pause is never resumed", () => {
    expect(nextAction(paused("2026-10-16T00:00:00Z", { approval: { nodeId: "plan-gate" } }), NOW)).toBe("wait");
  });

  test("an event wait is never resumed", () => {
    const run = paused("2026-10-16T00:00:00Z");
    (run.metadata as { wait: { kind: string } }).wait.kind = "event";
    expect(nextAction(run, NOW)).toBe("wait");
  });

  test("a running run waits", () => {
    expect(nextAction({ ...paused("2026-10-16T00:00:00Z"), status: "running" }, NOW)).toBe("wait");
  });

  test("a terminal or unknown run ends the keeper", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      expect(nextAction({ id: RUN_ID, status }, NOW)).toBe("exit");
    }
    expect(nextAction({ ok: false, error: "not_found" }, NOW)).toBe("exit");
  });

  test("garbage waits", () => {
    for (const doc of [null, "paused", [], { status: "paused" }, { status: "paused", metadata: { wait: { kind: "time", resumeAt: "soon" } } }]) {
      expect(nextAction(doc, NOW)).toBe("wait");
    }
  });
});

describe("wait-keeper node", () => {
  test("a dry run reports the keeper off, on one line, and starts nothing", () => {
    const artifacts = join(mkdtempSync(join(tmpdir(), "factory-wait-keeper-")), "artifacts");
    mkdirSync(artifacts);
    const p = Bun.spawnSync(["bun", WAIT_KEEPER], {
      env: { ...process.env, ARTIFACTS_DIR: artifacts, INPUTS_POLL_SECONDS: "60" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines = p.stdout.toString().trim().split("\n");
    expect(p.exitCode).toBe(0);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual({ keeper: "off", reason: "no run id (dry run)", run_id: "" });
    expect(existsSync(join(artifacts, "wait-keeper.pid"))).toBe(false);
  });

  test("a parent binary that can no longer be run turns the keeper off instead of failing the node", () => {
    // The parent is a copy of bash that deletes itself, so /proc reads "<path> (deleted)".
    const dir = mkdtempSync(join(tmpdir(), "factory-wait-keeper-gone-"));
    const parent = join(dir, "archon");
    copyFileSync("/bin/bash", parent);
    chmodSync(parent, 0o755);
    const artifacts = join(dir, RUN_ID);
    mkdirSync(artifacts);
    const p = Bun.spawnSync([parent, "-c", 'rm "$0"; bun "$1"; true', parent, WAIT_KEEPER], {
      env: { ...process.env, ARTIFACTS_DIR: artifacts },
      stdout: "pipe",
      stderr: "pipe",
    });
    const lines = p.stdout.toString().trim().split("\n");
    expect(p.exitCode).toBe(0);
    expect(lines.length).toBe(1);
    const doc = JSON.parse(lines[0]);
    expect(doc).toMatchObject({ keeper: "off", run_id: RUN_ID });
    expect(doc.reason).toStartWith("cannot run the Archon binary: ");
    expect(existsSync(join(artifacts, "wait-keeper.pid"))).toBe(false);
  });
});

describe("wait-keeper loop", () => {
  // A fake Archon binary: each `workflow get` prints the next canned document;
  // `workflow resume` is recorded.
  function fakeArchon(docs: unknown[]): { bin: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "factory-wait-keeper-bin-"));
    docs.forEach((doc, i) => writeFileSync(join(dir, `get-${i}.json`), JSON.stringify(doc)));
    const bin = join(dir, "archon");
    writeFileSync(
      bin,
      `#!/usr/bin/env bash
case "$1 $2" in
  "workflow get")
    n=$(cat "${dir}/count" 2>/dev/null || echo 0); echo $((n + 1)) > "${dir}/count"
    cat "${dir}/get-$n.json" 2>/dev/null || echo '{"ok":false,"error":"not_found"}' ;;
  "workflow resume") printf '%s\\n' "$*" >> "${dir}/resumes"; echo resumed ;;
esac
`,
    );
    chmodSync(bin, 0o755);
    return { bin, dir };
  }

  test("a due time wait is resumed once, and the keeper exits when the run completes", () => {
    const { bin, dir } = fakeArchon([
      { ...paused("2026-01-01T00:00:00Z"), working_path: "/work/repo" },
      { id: RUN_ID, status: "running" },
      { id: RUN_ID, status: "completed" },
    ]);
    const artifacts = mkdtempSync(join(tmpdir(), "factory-wait-keeper-art-"));
    writeFileSync(join(artifacts, "wait-keeper.pid"), "1");
    const p = Bun.spawnSync(["bun", WAIT_KEEPER, "--loop", RUN_ID, bin], {
      env: { ...process.env, ARTIFACTS_DIR: artifacts, INPUTS_POLL_SECONDS: "0" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toBe("");
    expect(readFileSync(join(dir, "resumes"), "utf8")).toBe(`workflow resume ${RUN_ID} --cwd /work/repo\n`);
    const log = readFileSync(join(artifacts, "wait-keeper.log"), "utf8");
    expect(log).toContain("resume: ");
    expect(log).toContain("stopping: run is completed");
    expect(existsSync(join(artifacts, "wait-keeper.pid"))).toBe(false);
  });

  test("ten unreadable reads in a row end the keeper without a resume", () => {
    const { bin, dir } = fakeArchon(Array.from({ length: 12 }, () => "not a run"));
    const artifacts = mkdtempSync(join(tmpdir(), "factory-wait-keeper-art-"));
    const p = Bun.spawnSync(["bun", WAIT_KEEPER, "--loop", RUN_ID, bin], {
      env: { ...process.env, ARTIFACTS_DIR: artifacts, INPUTS_POLL_SECONDS: "0" },
      timeout: 20_000,
    });
    expect(p.exitCode).toBe(0);
    expect(readFileSync(join(dir, "count"), "utf8").trim()).toBe("10");
    expect(existsSync(join(dir, "resumes"))).toBe(false);
    expect(readFileSync(join(artifacts, "wait-keeper.log"), "utf8")).toContain("10 unreadable reads");
  });
});
