import { basename } from "node:path";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A real run's ARTIFACTS_DIR ends in its run id; a dry run's ends in `artifacts`.
export function runIdFrom(artifactsDir: string): string | null {
  const name = basename(artifactsDir);
  return RUN_ID.test(name) ? name : null;
}

// Archon v0.10.1's CLI exits when a run reaches a durable `wait:` and only the
// `archon serve` continuation scan resumes it; v0.11.1's CLI holds the run and
// resumes it at the deadline itself, so a keeper there would race it.
export function keeperApplies(versionText: string): boolean {
  return /\bv0\.10\.1(?![.\d])/.test(versionText);
}

// A real run lives for hours; this only bounds a keeper whose run never ends.
export const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

// A live pid in the pid file means a keeper already watches this run; a second
// one would race it to resume. A stale pid (keeper died) must not block a new one.
export function keeperRunning(pidText: string, alive: (pid: number) => boolean): boolean {
  const pid = Number(pidText);
  return Number.isInteger(pid) && pid > 0 && alive(pid);
}

// Margin past `resumeAt`: a resume before the deadline re-enters the wait.
const RESUME_GRACE_MS = 5_000;

export type KeeperAction = "exit" | "resume" | "wait";

// Reads one `archon workflow get <id> --json` document.
export function nextAction(run: unknown, now: Date): KeeperAction {
  if (run === null || typeof run !== "object" || Array.isArray(run)) return "wait";
  const doc = run as Record<string, unknown>;
  if (doc.ok === false) return "exit";
  const status = doc.status;
  if (status === "completed" || status === "failed" || status === "cancelled") return "exit";
  if (status !== "paused") return "wait";
  const metadata = doc.metadata;
  if (metadata === null || typeof metadata !== "object") return "wait";
  const { wait, approval } = metadata as Record<string, unknown>;
  if (approval !== undefined && approval !== null) return "wait";
  if (wait === null || typeof wait !== "object") return "wait";
  const { kind, resumeAt } = wait as Record<string, unknown>;
  if (kind !== "time" || typeof resumeAt !== "string") return "wait";
  const due = Date.parse(resumeAt);
  if (Number.isNaN(due)) return "wait";
  return now.getTime() >= due + RESUME_GRACE_MS ? "resume" : "wait";
}
