import { appendFileSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit, parseJsonObject } from "./_lib/io.ts";
import { keeperApplies, keeperRunning, MAX_LIFETIME_MS, nextAction, runIdFrom } from "./_lib/keeper.ts";

// Node mode (no arguments): decides whether this run needs a keeper and, if so,
// starts a detached copy of this script in loop mode, then exits 0 with one
// {keeper, reason, run_id} line. Loop mode (`--loop <run-id> <archon-bin>`):
// resumes the run each time it is paused on a time wait that has fallen due.
// Binding: poll_seconds. ARTIFACTS_DIR is engine-provided.
const artifactsDir = process.env.ARTIFACTS_DIR ?? ".";
const logPath = join(artifactsDir, "wait-keeper.log");
const pidPath = join(artifactsDir, "wait-keeper.pid");

const MAX_UNREADABLE = 10;

function log(line: string): void {
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startKeeper(): { keeper: "on" | "off"; reason: string; run_id: string } {
  const runId = runIdFrom(artifactsDir);
  if (runId === null) return { keeper: "off", reason: "no run id (dry run)", run_id: "" };
  const off = (reason: string) => ({ keeper: "off" as const, reason, run_id: runId });

  // This script's parent is the Archon binary that is executing the run.
  let bin: string;
  try {
    bin = readlinkSync(`/proc/${process.ppid}/exe`);
  } catch (e) {
    return off(`cannot read the Archon binary: ${(e as Error).message}`);
  }
  // Spawning throws (not a failed exit) when the binary is gone, e.g. replaced
  // during an upgrade: /proc then reads "<path> (deleted)".
  let version: string;
  try {
    version = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
  } catch (e) {
    return off(`cannot run the Archon binary: ${(e as Error).message}`);
  }
  if (!keeperApplies(version)) {
    return off(`Archon ${version.split("\n")[0].trim() || "of unknown version"} resumes durable waits itself`);
  }

  if (keeperRunning(readPid(), alive)) return { keeper: "on", reason: "", run_id: runId };

  // setsid detaches the keeper from the engine's process group, so it outlives
  // this node and the CLI process that paused the run.
  const setsid = Bun.which("setsid");
  if (!setsid) return off("setsid not found");
  const child = Bun.spawn([setsid, process.execPath, import.meta.path, "--loop", runId, bin], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
  child.unref();
  writeFileSync(pidPath, String(child.pid));
  return { keeper: "on", reason: "", run_id: runId };
}

function readPid(): string {
  try {
    return readFileSync(pidPath, "utf8").trim();
  } catch {
    return "";
  }
}

function readRun(bin: string, runId: string): Record<string, unknown> | null {
  try {
    const p = Bun.spawnSync([bin, "workflow", "get", runId, "--json"], { stdout: "pipe", stderr: "ignore" });
    return parseJsonObject(p.stdout.toString());
  } catch {
    return null;
  }
}

async function keep(runId: string, bin: string): Promise<void> {
  const pollMs = Number(process.env.INPUTS_POLL_SECONDS || "60") * 1000;
  const stopAt = Date.now() + MAX_LIFETIME_MS;
  let unreadable = 0;
  log(`keeper started for run ${runId}, polling every ${pollMs / 1000}s`);
  try {
    while (true) {
      if (Date.now() >= stopAt) {
        log("stopping: 12 h cap reached");
        return;
      }
      await Bun.sleep(pollMs);
      const run = readRun(bin, runId);
      if (run === null) {
        if (++unreadable >= MAX_UNREADABLE) {
          log(`stopping: ${MAX_UNREADABLE} unreadable reads in a row`);
          return;
        }
        continue;
      }
      unreadable = 0;
      const action = nextAction(run, new Date());
      if (action === "exit") {
        log(`stopping: run is ${String(run.status ?? run.error)}`);
        return;
      }
      if (action === "resume") {
        const cwd = typeof run.working_path === "string" ? run.working_path : process.cwd();
        log("resume: the run's time wait is due");
        try {
          const p = Bun.spawnSync([bin, "workflow", "resume", runId, "--cwd", cwd], { stdout: "pipe", stderr: "pipe" });
          appendFileSync(logPath, p.stdout.toString() + p.stderr.toString());
          log(`resume exited ${p.exitCode}`);
        } catch (e) {
          log(`resume could not start: ${(e as Error).message}`);
        }
      }
    }
  } finally {
    rmSync(pidPath, { force: true });
  }
}

const [mode, runId, bin] = process.argv.slice(2);
if (mode === "--loop" && runId && bin) {
  await keep(runId, bin);
} else {
  emit(startKeeper());
}
