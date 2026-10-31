import { appendFileSync, mkdirSync, statfsSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname } from "node:path";
import { runUntilExit } from "./exec.ts";
import { removeLeftovers } from "./merge-decision.ts";
import { type PreflightConfig, type PreflightService, validatePreflight } from "./profile.ts";

// The host checks a profile's stack.preflight asks for (PILOT-499): the tools on
// PATH, the free disk of the checkout's filesystem, and the TCP services the
// test command needs. A down service with a start command is started once and
// polled; every problem is collected, so one fix round covers them all.
export const CONNECT_TIMEOUT_MS = 2_000;
export const START_TIMEOUT_MS = 120_000;
// One window shared by every started service, so the worst case does not multiply.
export const POLL_WINDOW_MS = 60_000;
export const POLL_INTERVAL_MS = 2_000;
// Mirrors the `preflight` node timeout in factory.yaml; merge-gate's budget includes it.
export const PREFLIGHT_TIMEOUT_MS = 1_200_000;

export const PREFLIGHT_STATUSES = ["ok", "failed", "skipped"] as const;
export type PreflightStatus = (typeof PREFLIGHT_STATUSES)[number];

// The binding is load-profile's preflight object as JSON text, or "" when the
// profile has no block. Any other text that is not a valid block is an error,
// never "no block": a mangled binding must not drop the check unnoticed.
export function parsePreflight(raw: string): PreflightConfig | null | { error: string } {
  if (raw === "") return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { error: "it is not JSON" };
  }
  const errors: string[] = [];
  const cfg = validatePreflight(doc, errors);
  if (cfg === undefined || errors.length > 0) return { error: errors.length > 0 ? errors.join("; ") : "it is not a mapping" };
  return cfg;
}

export function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: host.replace(/^\[(.*)\]$/, "$1"), port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// bavail / blocks: the share an unprivileged process can still write, the
// stricter view than df's, whose denominator leaves out reserved blocks.
export function freeDiskPct(path: string): number {
  const st = statfsSync(path);
  return st.blocks > 0 ? (st.bavail / st.blocks) * 100 : 0;
}

export interface PreflightDeps {
  which(tool: string): boolean;
  tcpOpen(host: string, port: number): Promise<boolean>;
  freePct(): number;
  cleanup(): void;
  start(command: string): Promise<{ exit_code: number; timed_out: boolean }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(text: string): void;
  logName: string;
  cwd: string;
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
}

function hostPort(tcp: string): [string, number] {
  const at = tcp.lastIndexOf(":");
  return [tcp.slice(0, at), Number(tcp.slice(at + 1))];
}

const label = (s: PreflightService): string => `service ${s.name} (${s.tcp})`;

export async function runPreflight(
  cfg: PreflightConfig,
  deps: PreflightDeps,
  timing = { pollWindowMs: POLL_WINDOW_MS, pollIntervalMs: POLL_INTERVAL_MS },
): Promise<PreflightResult> {
  const problems: string[] = [];

  const missing = cfg.tools.filter((t) => !deps.which(t));
  deps.log(`\npreflight: tools ${cfg.tools.length === 0 ? "none listed" : missing.length === 0 ? "all on PATH" : `missing ${missing.join(", ")}`}\n`);
  if (missing.length > 0) {
    problems.push(`tools not on PATH: ${missing.join(", ")} — install them on the Archon host or put them on the PATH of the shell that starts Archon`);
  }

  const threshold = cfg.min_disk_free_pct;
  if (threshold > 0) {
    let free = deps.freePct();
    deps.log(`\npreflight: ${free.toFixed(1)}% of the disk is free (threshold ${threshold}%)\n`);
    if (free < threshold) {
      deps.cleanup();
      free = deps.freePct();
      deps.log(`\npreflight: ${free.toFixed(1)}% free after removing build leftovers\n`);
      if (free < threshold) {
        problems.push(`only ${Math.floor(free)}% of the disk holding ${deps.cwd} is free, below stack.preflight.min_disk_free_pct ${threshold}, after removing build leftovers — free space there (df -h ${deps.cwd})`);
      }
    }
  }

  const up = async (s: PreflightService): Promise<boolean> => deps.tcpOpen(...hostPort(s.tcp));
  const started: PreflightService[] = [];
  for (const s of cfg.services) {
    if (await up(s)) {
      deps.log(`\npreflight: ${label(s)} answers\n`);
      continue;
    }
    if (s.start === "") {
      deps.log(`\npreflight: ${label(s)} does not answer and has no start command\n`);
      problems.push(`${label(s)} does not answer — the profile gives no start command; start it on the Archon host`);
      continue;
    }
    deps.log(`\npreflight: ${label(s)} does not answer; starting it once\n`);
    const r = await deps.start(s.start);
    if (r.timed_out) {
      problems.push(`${label(s)} does not answer and its start command did not return within ${START_TIMEOUT_MS / 1000} s (see ${deps.logName}) — use a start command that returns once the service is launched, such as \`docker compose up -d\`, or start the service by hand`);
      continue;
    }
    if (r.exit_code !== 0) {
      problems.push(`${label(s)} does not answer and its start command exited ${r.exit_code} (see ${deps.logName}) — fix the start command or start the service by hand`);
      continue;
    }
    started.push(s);
  }

  let waiting = started;
  const deadline = deps.now() + timing.pollWindowMs;
  while (waiting.length > 0) {
    const still: PreflightService[] = [];
    for (const s of waiting) {
      if (await up(s)) deps.log(`\npreflight: ${label(s)} answers after its start command\n`);
      else still.push(s);
    }
    waiting = still;
    if (waiting.length === 0 || deps.now() >= deadline) break;
    await deps.sleep(timing.pollIntervalMs);
  }
  for (const s of waiting) {
    deps.log(`\npreflight: ${label(s)} still does not answer after its start command\n`);
    problems.push(`${label(s)} still does not answer ${timing.pollWindowMs / 1000} s after its start command \`${s.start}\` — start it by hand on the Archon host`);
  }

  return { ok: problems.length === 0, problems };
}

// Both checks' entry point: null when the profile has no block.
export async function checkPreflight(binding: string, deps: () => PreflightDeps): Promise<PreflightResult | null> {
  const cfg = parsePreflight(binding);
  if (cfg === null) return null;
  if ("error" in cfg) {
    return { ok: false, problems: [`the stack.preflight binding from load-profile is unreadable (${cfg.error}) — check stack.preflight in .archon/factory-profile.yaml and the load-profile output in the run log`] };
  }
  return runPreflight(cfg, deps());
}

export function preflightMessage(problems: string[]): string {
  return `preflight: ${problems.join("; ")}.`;
}

export function hostPreflightDeps(opts: { logPath: string; secretNames: string[] }): PreflightDeps {
  const log = (text: string) => {
    mkdirSync(dirname(opts.logPath), { recursive: true });
    appendFileSync(opts.logPath, text);
  };
  return {
    which: (tool) => Bun.which(tool) !== null,
    tcpOpen: (host, port) => tcpOpen(host, port, CONNECT_TIMEOUT_MS),
    freePct: () => freeDiskPct(process.cwd()),
    cleanup: () => removeLeftovers(log),
    start: (command) => runUntilExit(command, { logPath: opts.logPath, secretNames: opts.secretNames, timeoutMs: START_TIMEOUT_MS }),
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    log,
    logName: basename(opts.logPath),
    cwd: process.cwd(),
  };
}
