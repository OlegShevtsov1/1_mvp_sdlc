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

// A check's latest run, with the page GitHub links it to.
export interface CheckRun extends CiCheck {
  detailsUrl: string;
}

// The rollup holds every run of every check on the head; a workflow's
// concurrency cancels a run when a newer one starts, so each check is judged
// by its latest run per workflow and name.
export function latestCheckRuns(rollup: unknown): CheckRun[] {
  const latest = new Map<string, CheckRun & { startedAt: string; completedAt: string }>();
  for (const entry of Array.isArray(rollup) ? rollup : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const name = text(entry.name) || text(entry.context);
    if (name === "") continue;
    const run = {
      name, bucket: checkBucket(entry), detailsUrl: text(entry.detailsUrl),
      startedAt: text(entry.startedAt), completedAt: text(entry.completedAt),
    };
    const key = `${text(entry.workflowName)}\0${name}`;
    const prev = latest.get(key);
    if (prev === undefined || isLater(rank(run), rank(prev))) latest.set(key, run);
  }
  return [...latest.values()].map(({ name, bucket, detailsUrl }) => ({ name, bucket, detailsUrl }));
}

interface ChecksRead {
  checks: CiCheck[];
  checks_read: boolean;
  runs: CheckRun[];
}

// Every run on the head, not `gh pr checks`: that lists one row per name, so a
// cancelled run hides whether a newer run of the same check exists.
export function readChecks(url: string): ChecksRead {
  const unread = { checks: [], checks_read: false, runs: [] };
  const p = Bun.spawnSync(["gh", "pr", "view", url, "--json", "statusCheckRollup"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return unread;
  try {
    const rollup: unknown = JSON.parse(p.stdout.toString())?.statusCheckRollup;
    if (!Array.isArray(rollup)) return unread;
    const runs = latestCheckRuns(rollup);
    return { checks: runs.map(({ name, bucket }) => ({ name, bucket })), checks_read: true, runs };
  } catch {
    return unread;
  }
}

// owner/repo of a pull request URL PR_URL already accepted.
function repoOf(url: string): string {
  const [, , , owner, repo] = url.split("/");
  return `${owner}/${repo}`;
}

// A cancelled run's successor is a workflow run that can sit queued with no
// check run yet; an unreadable answer leaves the checks alone to decide.
function workflowRunsInFlight(url: string, headSha: string): boolean {
  const p = Bun.spawnSync(
    ["gh", "api", `repos/${repoOf(url)}/actions/runs?head_sha=${headSha}&per_page=100`, "--jq", '[.workflow_runs[] | select(.status != "completed")] | length'],
    { stdout: "pipe", stderr: "pipe" },
  );
  return p.exitCode === 0 && Number(p.stdout.toString().trim()) > 0;
}

export const CHECKS_POLL_MS = 30_000;
export const CHECKS_WAIT_MS = 20 * 60_000;

// Re-reads, bounded by waitMs, while a check or a workflow run on the head is
// queued or in progress, or (requireAny) while the head has no check at all;
// past the bound it returns what it read last, with settled false.
export async function waitForChecks(
  url: string,
  headSha: string,
  { pollMs, waitMs, requireAny = false }: { pollMs: number; waitMs: number; requireAny?: boolean },
): Promise<ChecksRead & { settled: boolean }> {
  const deadline = Date.now() + waitMs;
  const unsettled = (r: ChecksRead) =>
    (requireAny && r.checks.length === 0) || r.checks.some((c) => c.bucket === "pending") || workflowRunsInFlight(url, headSha);
  let read = readChecks(url);
  let waiting = unsettled(read);
  while (Date.now() + pollMs <= deadline && waiting) {
    await Bun.sleep(pollMs);
    read = readChecks(url);
    waiting = unsettled(read);
  }
  return { ...read, settled: !waiting };
}

export async function settledChecks(
  url: string,
  headSha: string,
  opts: { pollMs: number; waitMs: number },
): Promise<{ checks: CiCheck[]; checks_read: boolean }> {
  const { checks, checks_read } = await waitForChecks(url, headSha, opts);
  return { checks, checks_read };
}

// A GitHub Actions job page: …/actions/runs/<run-id>/job/<job-id>.
const ACTIONS_JOB = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/([0-9]+)\/job\/([0-9]+)$/;

export function actionsJob(detailsUrl: string): { runId: string; jobId: string } | null {
  const m = ACTIONS_JOB.exec(detailsUrl);
  return m ? { runId: m[1], jobId: m[2] } : null;
}

// Plain, case-sensitive substrings: no escaping and no invalid pattern.
export function isKnownFlaky(name: string, log: string, patterns: string[]): boolean {
  return patterns.some((p) => name.includes(p) || log.includes(p));
}

// The failed steps' log of one job, so another job's flaky test cannot excuse it.
export function failedJobLog(url: string, jobId: string): string {
  const p = Bun.spawnSync(["gh", "run", "view", "--job", jobId, "--log-failed", "--repo", repoOf(url)], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return p.exitCode === 0 ? p.stdout.toString() : "";
}

export function rerunFailed(url: string, runId: string): { ok: boolean; err: string } {
  const p = Bun.spawnSync(["gh", "run", "rerun", runId, "--failed", "--repo", repoOf(url)], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  return { ok: p.exitCode === 0, err: p.stderr.toString().trim() };
}
