import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoOf, type RunView } from "./runs.ts";

export type Host = { memAvailableMb: number; load1: number };

const LIMIT_KEYS = ["max_runs", "max_runs_per_repo", "min_mem_available_mb", "max_load1"] as const;

export type Limits = Record<(typeof LIMIT_KEYS)[number], number>;

export function loadLimits(path: string): Limits {
  const p = Bun.YAML.parse(readFileSync(path, "utf8")) as { limits?: Record<string, unknown> } | null;
  const limits = {} as Limits;
  for (const key of LIMIT_KEYS) {
    const v = p?.limits?.[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`${path}: limits.${key} must be a positive number`);
    limits[key] = v;
  }
  return limits;
}

let cached: Limits | undefined;
export function limits(): Limits {
  cached ??= loadLimits(process.env.SDLC_AUTOPILOT_POLICY || join(import.meta.dir, "..", "policy.yaml"));
  return cached;
}

export function readHost(text?: { meminfo: string; loadavg: string }): Host {
  const meminfo = text?.meminfo ?? readFileSync("/proc/meminfo", "utf8");
  const loadavg = text?.loadavg ?? readFileSync("/proc/loadavg", "utf8");
  const kb = meminfo.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1];
  const load1 = Number.parseFloat(loadavg);
  if (kb === undefined || Number.isNaN(load1)) throw new Error("cannot read MemAvailable and load1 from /proc");
  return { memAvailableMb: Number(kb) / 1024, load1 };
}

export function hostIdle(host: Host): boolean {
  const l = limits();
  return host.memAvailableMb >= l.min_mem_available_mb && host.load1 <= l.max_load1;
}

// A paused run holds no CPU, so it does not take a slot.
export function activeRuns(runs: RunView[]): RunView[] {
  return runs.filter((r) => r.status === "pending" || r.status === "running");
}

// `active` holds only runs that take a slot: `activeRuns` of Archon's runs plus what this tick already launched.
export function canStart(repo: string, active: RunView[], host: Host): boolean {
  const l = limits();
  return hostIdle(host) && active.length < l.max_runs
    && active.filter((r) => repoOf(r.cwd) === repo).length < l.max_runs_per_repo;
}
