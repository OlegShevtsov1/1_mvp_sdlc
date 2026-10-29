import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function redact(
  text: string,
  secretNames: string[],
  env: Record<string, string | undefined> = process.env,
): string {
  let out = text;
  for (const name of secretNames) {
    const value = env[name];
    if (!value || value.length < 4) continue;
    out = out.split(value).join("***");
  }
  return out;
}

export function parseSecretNames(raw: string): string[] {
  try {
    const doc: unknown = JSON.parse(raw);
    return Array.isArray(doc) ? doc.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface RunOptions {
  logPath: string;
  secretNames: string[];
  cwd?: string;
  timeoutMs?: number;
}

// Grace a command gets between SIGTERM and SIGKILL once it has missed its deadline.
const KILL_GRACE_MS = 1_000;
// How long to keep draining the pipe after the kill before writing the exit marker.
const DRAIN_AFTER_KILL_MS = 500;

// True when `pid` leads its own process group, i.e. `setsid` gave the command a
// group of its own. Checked before every group kill: this process shares its
// group with the engine, so signalling a group we did not create would kill us.
function leadsOwnGroup(pid: number): boolean {
  try {
    // /proc/<pid>/stat is "pid (comm) state ppid pgrp ..."; comm can itself
    // contain spaces and parentheses, so parse after the last ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === pid;
  } catch {
    return false;
  }
}

// Signals the whole command — the shell and anything it backgrounded — falling
// back to the shell alone where there is no group of our own to signal.
function killAll(proc: { pid: number; kill: (signal?: number | string) => void }, signal: string): void {
  if (leadsOwnGroup(proc.pid)) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Already gone.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Already gone.
  }
}

// Appends the command's output to the log as it arrives, so a slow or wedged
// deploy still leaves a readable log instead of an empty one. The last
// `holdback` characters stay buffered: a secret value straddling two chunks
// would otherwise reach the log before `redact` could see it whole.
async function pumpToLog(
  stream: ReadableStream<Uint8Array>,
  logPath: string,
  secretNames: string[],
): Promise<void> {
  const longest = secretNames.reduce((max, name) => Math.max(max, (process.env[name] ?? "").length), 0);
  const holdback = Math.max(0, longest - 1);
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending = redact(pending + decoder.decode(chunk, { stream: true }), secretNames);
    if (pending.length > holdback) {
      appendFileSync(logPath, pending.slice(0, pending.length - holdback));
      pending = pending.slice(pending.length - holdback);
    }
  }
  const rest = redact(pending + decoder.decode(), secretNames);
  if (rest) appendFileSync(logPath, rest);
}

// Runs one shell command, appends its redacted output to `logPath`, and returns
// the exit code. Nothing the command prints reaches this process's stdout — a
// node's stdout is its declared result and nothing else. `timeoutMs` is a hard
// bound: the command's own fds cannot extend it, and a command that outlives it
// reports 124 with `timed_out` set — the one way to tell it from a command that
// exits 124 by itself.
export async function runLogged(command: string, opts: RunOptions): Promise<{ exit_code: number; timed_out: boolean }> {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  appendFileSync(opts.logPath, `\n$ ${redact(command, opts.secretNames)}\n`);
  // Two wrappers around the command, both load-bearing for the deadline:
  //   setsid — gives the command a process group of its own (verified on Linux
  //     to exec in place, so the child's pid is its pgid), letting the kill
  //     below reach whatever the command backgrounded. Killing only the shell
  //     leaves an orphan holding the pipe open and the read below never ends.
  //     Skipped where setsid does not exist; the deadline still holds.
  //   exec bash -c "$0" 2>&1 — merges stderr into the piped stdout, so the log
  //     is one chronological stream and `exec` leaves no extra shell behind.
  //     The command travels as an argument, so nothing about it is re-quoted.
  const shell = ["bash", "-c", 'exec bash -c "$0" 2>&1', command];
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...shell] : shell, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  // Both settle-or-ignore: a killed child can tear its pipe down mid-read, and
  // nothing here may reject after this function has already resolved.
  const drained = pumpToLog(proc.stdout as ReadableStream<Uint8Array>, opts.logPath, opts.secretNames)
    .catch(() => {});
  const exited = proc.exited.catch(() => -1);

  let exit_code: number;
  let timed_out = false;
  if (!opts.timeoutMs) {
    await drained;
    exit_code = await exited;
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
    });
    // The deadline races the read as well as the child, so this resolves
    // whatever the command does with its file descriptors.
    const finished = Promise.all([drained, exited]).then(([, code]) => code);
    const first = await Promise.race([finished, deadline]);
    clearTimeout(timer);
    if (first === "timeout") {
      killAll(proc, "SIGTERM");
      await Promise.race([exited, Bun.sleep(KILL_GRACE_MS)]);
      killAll(proc, "SIGKILL");
      await Promise.race([drained, Bun.sleep(DRAIN_AFTER_KILL_MS)]);
      exit_code = 124;
      timed_out = true;
    } else {
      exit_code = first;
    }
  }
  appendFileSync(opts.logPath, `\n[exit ${exit_code}]\n`);
  return { exit_code, timed_out };
}
