import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runDetached } from "./act.ts";
import { alreadyActed, appendLedger, ledgerPath } from "./ledger.ts";
import type { Policy } from "./main.ts";
import { activeRuns, canStart, type Host, readHost } from "./resources.ts";
import { isForbiddenRepo, repoOf, type RunView } from "./runs.ts";

export type MergedPr = { url: string; title: string; mergedAt: string };

export type PostMergeDeps = {
  // `null` when GitHub could not be asked; the repo is then tried again next tick.
  mergedPrs(repo: string): MergedPr[] | null;
  launch(argv: string[], cwd: string, logFile: string): void;
  host(): Host;
};

const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/;

const REPORT_SQL = `SELECT data FROM remote_agent_workflow_events
  WHERE workflow_run_id = ? AND event_type = 'node_completed' AND step_name = 'report'
  ORDER BY event_order DESC LIMIT 1`;

export function archonHome(): string {
  return process.env.ARCHON_HOME || join(homedir(), ".archon");
}

// The argument convention the operator uses with `launch.ts` today.
export function postMergeArgs(pr: { url: string; title: string; repo: string }): { cwd: string; args: string } {
  const card = pr.title.match(/^PILOT-(\d+):/)?.[1];
  if (!card) throw new Error("PR title has no PILOT-<n>: prefix");
  const args = /^PILOT-\d+:\s*Release\b/.test(pr.title)
    ? `run=PILOT${card} pr=${pr.url}`
    : `run=C8.Tn pr=${pr.url} part=C8.TnP${card}`;
  return { cwd: join(archonHome(), "workspaces", pr.repo, "source"), args };
}

// `policy.yaml` `post_merge.since`; the zone is required so the host's TZ cannot move the cutoff.
export function parseSince(raw: unknown, path: string): Date | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new Error(`${path}: post_merge.since must be an ISO timestamp with a time zone`);
  }
  return new Date(raw);
}

function statePath(): string {
  return join(dirname(ledgerPath()), "state.json");
}

// Written once, on the first tick, and never moved: moving it later would only skip owed post-merges, and a file the
// supervisor cannot read is replaced, which moves the cutoff later and so never re-runs a stale post-merge.
export function firstStart(now: Date): Date {
  const path = statePath();
  try {
    const recorded = (JSON.parse(readFileSync(path, "utf8")) as { first_start?: unknown }).first_start;
    if (typeof recorded === "string" && !Number.isNaN(Date.parse(recorded))) return new Date(recorded);
  } catch {
    // Missing or unreadable: recorded below.
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ first_start: now.toISOString() })}\n`);
  renameSync(`${path}.tmp`, path);
  console.log(`sdlc-autopilot: post-merge cutoff (first start) ${now.toISOString()} recorded in ${path}`);
  return now;
}

// The first start is recorded even under `since`, so removing `since` later falls back to it, not to "now".
export function postMergeCutoff(policy: Policy, now: Date): Date {
  const first = firstStart(now);
  return policy.postMergeSince ?? first;
}

type Candidate = { run: RunView; url: string; repo: string; number: string };

const prKey = (repo: string, number: string) => `${repo.toLowerCase()}#${Number(number)}`;

// Every PR a post-merge run names: a PR URL, `owner/repo#n`, or a `#n`, `pr=n` or `pr=#n` token in the run's own repo.
function namedPrs(runs: RunView[]): Set<string> {
  const keys = new Set<string>();
  for (const run of runs) {
    if (run.workflow !== "post-merge") continue;
    for (const m of run.message.matchAll(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/gi)) keys.add(prKey(m[1], m[2]));
    for (const m of run.message.matchAll(/(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d+)/g)) keys.add(prKey(m[1], m[2]));
    const repo = repoOf(run.cwd);
    if (!repo) continue;
    for (const token of run.message.split(/\s+/)) {
      const n = token.match(/^(?:#|pr=#?)(\d+)$/)?.[1];
      if (n) keys.add(prKey(repo, n));
    }
  }
  return keys;
}

// Merged on GitHub at or after the cutoff is the only criterion, not the report status: a cancelled `not-delivered`
// run can own a merged PR. A post-merge run already in Archon naming the PR, failed ones included, is never launched
// again. Every launch is pushed onto `active`, so later starters of the same tick see the slot taken.
export function launchPostMerges(
  db: Database, runs: RunView[], deps: PostMergeDeps, since: Date, active: RunView[] = activeRuns(runs),
): number {
  const byUrl = new Map<string, Candidate>();
  for (const run of runs) {
    if (run.workflow !== "factory" || (run.status !== "completed" && run.status !== "cancelled")) continue;
    const url = reportPrUrl(db, run.id);
    const m = url.match(PR_URL);
    if (m) byUrl.set(url, { run, url, repo: m[1], number: m[2] });
  }
  const named = namedPrs(runs);
  const candidates = [...byUrl.values()].filter((c) =>
    !named.has(prKey(c.repo, c.number)) && !alreadyActed(c.run.id, eventId(c.url)));

  const merged = new Map<string, Map<string, MergedPr> | null>();
  let written = 0;
  let deferred = 0;
  for (const c of candidates) {
    if (!merged.has(c.repo)) {
      const prs = deps.mergedPrs(c.repo);
      if (!prs) console.log(`sdlc-autopilot: could not list merged PRs of ${c.repo}, retrying next tick`);
      merged.set(c.repo, prs && new Map(prs.map((p) => [p.url, p])));
    }
    const pr = merged.get(c.repo)?.get(c.url);
    if (!pr) continue;
    // A missing or unparsable mergedAt is never owed: skipping is the safe side.
    if (!(Date.parse(pr.mergedAt) >= since.getTime())) continue;

    if (isForbiddenRepo(c.repo)) {
      written += escalate(c, "post-merge-forbidden-repo",
        `Post-merge не запущено: репозиторій ${c.repo} поза межами супервізора.`);
      continue;
    }
    let launch: { cwd: string; args: string };
    try {
      launch = postMergeArgs({ url: c.url, title: pr.title, repo: c.repo });
    } catch {
      written += escalate(c, "post-merge-no-card", `Post-merge не запущено: у назві PR ${c.url} немає префікса PILOT-<n>:.`);
      continue;
    }
    if (!canStart(c.repo, active, deps.host())) {
      deferred++;
      continue;
    }
    try {
      deps.launch(
        [process.execPath, join(archonHome(), "workflows", "mvp-ops", "post-merge", "scripts", "launch.ts"),
          "--cwd", launch.cwd, launch.args],
        launch.cwd,
        join(dirname(ledgerPath()), "logs", `post-merge-${c.run.id.slice(0, 8)}.log`),
      );
    } catch (e) {
      written += escalate(c, "post-merge-launch-failed",
        `Post-merge для ${c.url} не запущено: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    active.push({ id: eventId(c.url), workflow: "post-merge", status: "pending", cwd: launch.cwd, message: launch.args });
    appendLedger({
      ts: new Date().toISOString(), run_id: c.run.id, workflow: c.run.workflow, kind: "post-merge",
      rule: "post-merge-merged-pr", action: "launch-post-merge", evidence: { event_id: eventId(c.url), text: launch.args },
    });
    written++;
  }
  if (deferred > 0) console.log(`sdlc-autopilot: ${deferred} post-merge launch(es) wait for host resources or run slots`);
  return written;
}

function escalate(c: Candidate, rule: string, text: string): number {
  appendLedger({
    ts: new Date().toISOString(), run_id: c.run.id, workflow: c.run.workflow, kind: "post-merge",
    rule, action: "escalate", evidence: { event_id: eventId(c.url), text },
  });
  return 1;
}

function eventId(prUrl: string): string {
  return `post-merge:${prUrl}`;
}

function reportPrUrl(db: Database, runId: string): string {
  const row = db.query(REPORT_SQL).get(runId) as { data: string | null } | null;
  try {
    const url = (JSON.parse(row?.data ?? "{}") as { structured_output?: { pr_url?: unknown } }).structured_output?.pr_url;
    return typeof url === "string" ? url : "";
  } catch {
    return "";
  }
}

export const realPostMergeDeps: PostMergeDeps = {
  mergedPrs(repo) {
    try {
      const gh = Bun.spawnSync(
        ["gh", "pr", "list", "--repo", repo, "--state", "merged", "--limit", "100", "--json", "url,title,mergedAt"],
        { stdin: "ignore", timeout: 60_000 },
      );
      if (gh.exitCode !== 0) return null;
      const prs: unknown = JSON.parse(gh.stdout.toString());
      if (!Array.isArray(prs)) return null;
      return prs.filter((p): p is MergedPr => typeof p?.url === "string" && typeof p?.title === "string" && typeof p?.mergedAt === "string");
    } catch {
      return null;
    }
  },
  launch: runDetached,
  host: readHost,
};
