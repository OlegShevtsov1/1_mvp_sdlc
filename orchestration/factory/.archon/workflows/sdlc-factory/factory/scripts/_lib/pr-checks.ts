import type { CiCheck } from "./merge-decision.ts";

// gh's bucket for a rollup entry: a CheckRun's conclusion once it completed,
// else pending; a commit status's state.
function checkBucket(entry: Record<string, unknown>): string {
  const state = entry.__typename === "StatusContext" ? entry.state : entry.status === "COMPLETED" ? entry.conclusion : "PENDING";
  switch (state) {
    case "SUCCESS":
      return "pass";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipping";
    case "CANCELLED":
      return "cancel";
    case "FAILURE":
    case "ERROR":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "fail";
    default:
      return "pending";
  }
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

// A run not yet concluded is later than any concluded one; else the later start,
// then the later completion; on a tie the entry listed later.
function rank(c: { bucket: string; startedAt: string; completedAt: string }): [number, string, string] {
  return [c.bucket === "pending" ? 1 : 0, c.startedAt, c.completedAt];
}

function isLater(a: ReturnType<typeof rank>, b: ReturnType<typeof rank>): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// The rollup holds every run of every check on the head; a workflow's
// concurrency cancels a run when a newer one starts, so each check is judged
// by its latest run per workflow and name.
export function latestChecks(rollup: unknown): CiCheck[] {
  const latest = new Map<string, { bucket: string; name: string; startedAt: string; completedAt: string }>();
  for (const entry of Array.isArray(rollup) ? rollup : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = text(entry.name) || text(entry.context);
    if (name === "") continue;
    const run = { name, bucket: checkBucket(entry), startedAt: text(entry.startedAt), completedAt: text(entry.completedAt) };
    const key = `${text(entry.workflowName)}\0${name}`;
    const prev = latest.get(key);
    if (prev === undefined || isLater(rank(run), rank(prev))) latest.set(key, run);
  }
  return [...latest.values()].map(({ name, bucket }) => ({ name, bucket }));
}

// Every run on the head, not `gh pr checks`: that lists one row per name, so a
// cancelled run hides whether a newer run of the same check exists.
export function readChecks(url: string): { checks: CiCheck[]; checks_read: boolean } {
  const p = Bun.spawnSync(["gh", "pr", "view", url, "--json", "statusCheckRollup"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return { checks: [], checks_read: false };
  try {
    const rollup: unknown = JSON.parse(p.stdout.toString())?.statusCheckRollup;
    return Array.isArray(rollup) ? { checks: latestChecks(rollup), checks_read: true } : { checks: [], checks_read: false };
  } catch {
    return { checks: [], checks_read: false };
  }
}

// A cancelled run's successor is a workflow run that can sit queued with no
// check run yet; an unreadable answer leaves the checks alone to decide.
function workflowRunsInFlight(url: string, headSha: string): boolean {
  const [, , , owner, repo] = url.split("/");
  const p = Bun.spawnSync(
    ["gh", "api", `repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&per_page=100`, "--jq", '[.workflow_runs[] | select(.status != "completed")] | length'],
    { stdout: "pipe", stderr: "pipe" },
  );
  return p.exitCode === 0 && Number(p.stdout.toString().trim()) > 0;
}

// Re-reads, bounded by waitMs, while a check or a workflow run on the head is
// queued or in progress; past the bound it returns what it read last.
export async function settledChecks(
  url: string,
  headSha: string,
  { pollMs, waitMs }: { pollMs: number; waitMs: number },
): Promise<{ checks: CiCheck[]; checks_read: boolean }> {
  const deadline = Date.now() + waitMs;
  const unsettled = (r: { checks: CiCheck[] }) => r.checks.some((c) => c.bucket === "pending") || workflowRunsInFlight(url, headSha);
  let read = readChecks(url);
  while (Date.now() + pollMs <= deadline && unsettled(read)) {
    await Bun.sleep(pollMs);
    read = readChecks(url);
  }
  return read;
}
