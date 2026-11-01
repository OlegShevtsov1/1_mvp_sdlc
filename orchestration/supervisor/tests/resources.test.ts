import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRuns, canStart, loadLimits } from "../src/resources.ts";
import type { RunView } from "../src/runs.ts";

const IDLE = { memAvailableMb: 8000, load1: 1 };

const runs = (repo: string, n: number, status = "running"): RunView[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${repo}-${i}`, workflow: "factory", status, message: "",
    cwd: `/home/operator/.archon/workspaces/OlegShevtsov1/${repo}/worktrees/archon/task-${i}`,
  }));

describe("canStart", () => {
  test("respects 5 total and 3 per repo", () => {
    expect(canStart("OlegShevtsov1/1_mvp_sdlc", runs("1_mvp_prompt", 4), IDLE)).toBe(true);
    expect(canStart("OlegShevtsov1/1_mvp_sdlc", runs("1_mvp_prompt", 5), IDLE)).toBe(false);
    expect(canStart("OlegShevtsov1/1_mvp_sdlc", runs("1_mvp_sdlc", 3), IDLE)).toBe(false);
    expect(canStart("OlegShevtsov1/1_mvp_sdlc", runs("1_mvp_sdlc", 2), IDLE)).toBe(true);

    const archon = [...runs("1_mvp_sdlc", 2), ...runs("1_mvp_sdlc", 1, "paused"), ...runs("1_mvp_sdlc", 1, "pending")];
    expect(activeRuns(archon).map((r) => r.status)).toEqual(["running", "running", "pending"]);
    expect(canStart("OlegShevtsov1/1_mvp_sdlc", activeRuns(archon), IDLE)).toBe(false);
    expect(canStart("OlegShevtsov1/1_mvp_sdlc", activeRuns(archon.slice(0, 3)), IDLE)).toBe(true);
  });

  test("does not start below 1500 MB available or above load 8", () => {
    const at = (memAvailableMb: number, load1: number) => canStart("OlegShevtsov1/1_mvp_sdlc", [], { memAvailableMb, load1 });
    expect(at(1499, 1)).toBe(false);
    expect(at(1500, 1)).toBe(true);
    expect(at(8000, 8)).toBe(true);
    expect(at(8000, 8.01)).toBe(false);
    expect(at(Number.NaN, 1)).toBe(false);
    expect(at(8000, Number.NaN)).toBe(false);
  });

  test("loadLimits rejects a missing or non-positive value", () => {
    const dir = mkdtempSync(join(tmpdir(), "supervisor-limits-"));
    const policy = (limits: string) => {
      const path = join(dir, `${Math.random()}.yaml`);
      writeFileSync(path, `version: 1\nrules: []\n${limits}`);
      return path;
    };
    expect(loadLimits(join(import.meta.dir, "..", "policy.yaml"))).toEqual({
      max_runs: 5, max_runs_per_repo: 3, min_mem_available_mb: 1500, max_load1: 8,
    });
    expect(() => loadLimits(policy(""))).toThrow("limits.max_runs");
    expect(() => loadLimits(policy("limits:\n  max_runs: 5\n  max_runs_per_repo: 3\n  min_mem_available_mb: 1500\n")))
      .toThrow("limits.max_load1");
    expect(() => loadLimits(policy("limits:\n  max_runs: 0\n  max_runs_per_repo: 3\n  min_mem_available_mb: 1500\n  max_load1: 8\n")))
      .toThrow("limits.max_runs");
    expect(() => loadLimits(policy("limits:\n  max_runs: 5\n  max_runs_per_repo: three\n  min_mem_available_mb: 1500\n  max_load1: 8\n")))
      .toThrow("limits.max_runs_per_repo");
  });
});
