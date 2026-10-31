import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runDetached } from "./act.ts";
import { alreadyActed, appendLedger, ledgerPath } from "./ledger.ts";
import { activeRuns, canStart, type Host, readHost } from "./resources.ts";
import { isForbiddenRepo, type RunView } from "./runs.ts";

export type MergedPr = { url: string; title: string };

export type PostMergeDeps = {
  // `null` when GitHub could not be asked; the repo is then tried again next tick.
  mergedPrs(repo: string): MergedPr[] | null;
  launch(argv: string[], cwd: string, logFile: string): void;
  host(): Host;
};

const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/;

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

type Candidate = { run: RunView; url: string; repo: string };

// Merged on GitHub is the only criterion, not the report status: a cancelled `not-delivered` run can own a merged PR.
// A post-merge run already in Archon for the PR, failed ones included, is never launched again. Every launch is pushed
// onto `active`, so later starters of the same tick see the slot taken.
export function launchPostMerges(
  db: Database, runs: RunView[], deps: PostMergeDeps, active: RunView[] = activeRuns(runs),
): number {
  const byUrl = new Map<string, Candidate>();
  for (const run of runs) {
    if (run.workflow !== "factory" || (run.status !== "completed" && run.status !== "cancelled")) continue;
    const url = reportPrUrl(db, run.id);
    const repo = url.match(PR_URL)?.[1];
    if (repo) byUrl.set(url, { run, url, repo });
  }
  const launched = new Set(runs.filter((r) => r.workflow === "post-merge").flatMap((r) => r.message.split(/\s+/)));
  const candidates = [...byUrl.values()].filter((c) =>
    !launched.has(`pr=${c.url}`) && !alreadyActed(c.run.id, eventId(c.url)));

  const merged = new Map<string, Map<string, string> | null>();
  let written = 0;
  let deferred = 0;
  for (const c of candidates) {
    if (!merged.has(c.repo)) {
      const prs = deps.mergedPrs(c.repo);
      if (!prs) console.log(`sdlc-autopilot: could not list merged PRs of ${c.repo}, retrying next tick`);
      merged.set(c.repo, prs && new Map(prs.map((p) => [p.url, p.title])));
    }
    const title = merged.get(c.repo)?.get(c.url);
    if (title === undefined) continue;

    if (isForbiddenRepo(c.repo)) {
      written += escalate(c, "post-merge-forbidden-repo",
        `Post-merge не запущено: репозиторій ${c.repo} поза межами супервізора.`);
      continue;
    }
    let launch: { cwd: string; args: string };
    try {
      launch = postMergeArgs({ url: c.url, title, repo: c.repo });
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
        ["gh", "pr", "list", "--repo", repo, "--state", "merged", "--limit", "100", "--json", "url,title"],
        { stdin: "ignore", timeout: 60_000 },
      );
      if (gh.exitCode !== 0) return null;
      const prs: unknown = JSON.parse(gh.stdout.toString());
      if (!Array.isArray(prs)) return null;
      return prs.filter((p): p is MergedPr => typeof p?.url === "string" && typeof p?.title === "string");
    } catch {
      return null;
    }
  },
  launch: runDetached,
  host: readHost,
};
