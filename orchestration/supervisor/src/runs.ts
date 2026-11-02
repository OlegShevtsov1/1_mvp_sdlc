import type { Database } from "bun:sqlite";

export type PauseKind = "plan-gate" | "install-gate" | "post-merge-gate" | "pr-approve" | "qa-dev" | "other";

export type RunView = {
  id: string;
  workflow: string;
  status: string;
  cwd: string;
  message: string;
  pause?: Pause;
  lastError?: string;
  failure?: { eventId: string; at: string };
  owner?: { host: string; pid: number };
  cancelReason?: string;
};

// The supervisor never acts on these repos; a run there is escalated instead.
const FORBIDDEN_REPO = /^[^/]+\/(1_hrss_pilot|pilot-srv-.*)$/;

export function isForbiddenRepo(repo: string): boolean {
  return FORBIDDEN_REPO.test(repo);
}

// `owner/repo` of an Archon workspace path, "" for a path outside `~/.archon/workspaces`.
export function repoOf(cwd: string): string {
  return cwd.match(/\/workspaces\/([^/]+\/[^/]+)\//)?.[1] ?? "";
}

export type Pause = {
  eventId: string;
  node: string;
  kind: PauseKind;
  text: string;
  occurrence: string;
  iteration: number;
  // The answers the pause itself declares (gate decisions or wait options), in its own order.
  decisions: { id: string; label: string }[];
  plan?: { ready: boolean; openQuestions: string[] };
};

type RunRow = {
  id: string;
  workflow_name: string;
  status: string;
  working_path: string | null;
  user_message: string;
  metadata: string | null;
  last_activity_at: string;
};

type EventRow = {
  id: string;
  event_order: number;
  event_type: string;
  step_name: string | null;
  data: string | null;
  created_at: string;
};

export const OPEN_STATUSES = ["pending", "running", "paused"];

// Open runs are read regardless of age, so a pause that predates the supervisor is still seen.
const RUNS_SQL = `SELECT id, workflow_name, status, working_path, user_message, metadata, last_activity_at
  FROM remote_agent_workflow_runs
  WHERE status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(", ")})
     OR (status IN ('failed', 'cancelled', 'completed') AND last_activity_at >= datetime('now', ?))
  ORDER BY started_at`;

const EVENTS_SQL = `SELECT id, event_order, event_type, step_name, data, created_at FROM remote_agent_workflow_events
  WHERE workflow_run_id = ? AND event_type IN (SELECT value FROM json_each(?))
  ORDER BY event_order DESC LIMIT 50`;

// The factory's `plan` include expands to node `plan__plan`; the plan gate renders its output without the open
// questions, so they are read from this node's completion.
const PLAN_SQL = `SELECT data FROM remote_agent_workflow_events
  WHERE workflow_run_id = ? AND event_type = 'node_completed' AND json_extract(data, '$.node.id') = 'plan__plan'
    AND event_order < ?
  ORDER BY event_order DESC LIMIT 1`;

// Post-merge's `fetch` names the PR the run delivers; Archon also replays it as `node_skipped_prior_success` on resume.
const FETCH_SQL = `SELECT data FROM remote_agent_workflow_events
  WHERE workflow_run_id = ? AND event_type = 'node_completed' AND step_name = 'fetch'
  ORDER BY event_order DESC LIMIT 1`;

// An answer given anywhere (CLI, web, a respond) follows the pause it answers as the run's next answer event.
const ANSWER_SQL = `SELECT data FROM remote_agent_workflow_events
  WHERE workflow_run_id = ? AND event_type IN ('approval_received', 'wait_answered')
    AND event_order > (SELECT event_order FROM remote_agent_workflow_events WHERE id = ?)
  ORDER BY event_order LIMIT 1`;

const KINDS: Record<string, PauseKind> = {
  "factory/plan-gate": "plan-gate",
  "factory/pr-approve": "pr-approve",
  "factory/qa-dev": "qa-dev",
  "post-merge/install-gate": "install-gate",
  "post-merge/gate": "post-merge-gate",
};

export function readRuns(db: Database, sinceHours: number): RunView[] {
  const rows = db.query(RUNS_SQL).all(`-${sinceHours} hours`) as RunRow[];
  const events = (runId: string, ...types: string[]) =>
    db.query(EVENTS_SQL).all(runId, JSON.stringify(types)) as EventRow[];

  return rows.map((r) => {
    const view: RunView = {
      id: r.id, workflow: r.workflow_name, status: r.status, cwd: r.working_path ?? "", message: r.user_message,
    };
    if (r.status === "paused") view.pause = readPause(db, r, events(r.id, "node_suspended", "approval_requested"));
    if (r.status === "failed") {
      const failed = events(r.id, "workflow_failed")[0];
      view.lastError = data(failed).error;
      if (failed) view.failure = { eventId: failed.id, at: failed.created_at };
    }
    if (r.status === "cancelled") view.cancelReason = data(events(r.id, "workflow_cancelled")[0]).reason;
    const owner = readOwner(r);
    if (owner) view.owner = owner;
    return view;
  });
}

// Archon keeps metadata.execution_owner after the owner process exits, so this names who ran the run, not who is alive.
function readOwner(run: RunRow): RunView["owner"] {
  const owner = parse(run.metadata).execution_owner as { host?: unknown; pid?: unknown } | undefined;
  if (typeof owner?.host !== "string" || typeof owner.pid !== "number") return undefined;
  return { host: owner.host, pid: owner.pid };
}

// The open pause is the newest leaf suspension; Archon follows it with an aggregate `loop_group` one.
function readPause(db: Database, run: RunRow, newestFirst: EventRow[]): Pause {
  const meta = parse(run.metadata) as {
    wait?: { pauseId?: unknown; options?: unknown };
    approval?: { pauseId?: unknown; decisions?: unknown };
  };
  const pauseId = meta.wait?.pauseId ?? meta.approval?.pauseId;
  const occurrence = typeof pauseId === "string" ? pauseId : "";
  const decisions = readDecisions(meta.approval?.decisions ?? meta.wait?.options);
  const leaf = newestFirst.find((e) => e.event_type === "node_suspended" && data(e).node?.kind !== "loop_group");
  if (!leaf) {
    return { eventId: `paused@${run.last_activity_at}`, node: "", kind: "other", text: "", occurrence, iteration: 1, decisions };
  }
  const { node, invocation } = data(leaf);
  const kind = KINDS[`${run.workflow_name}/${node?.id}`] ?? "other";
  const iteration = invocation?.loopPath?.at(-1)?.iteration;
  const pause: Pause = {
    eventId: leaf.id,
    node: leaf.step_name ?? "",
    kind,
    text: node?.kind === "wait" ? waitMessage(run) : gateMessage(leaf, newestFirst),
    occurrence,
    iteration: typeof iteration === "number" ? iteration : 1,
    decisions,
  };
  if (kind === "plan-gate") pause.plan = readPlan(db, run.id, leaf.event_order);
  return pause;
}

function readDecisions(list: unknown): Pause["decisions"] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((d: { id?: unknown; label?: unknown } | null) =>
    typeof d?.id === "string" && typeof d.label === "string" ? [{ id: d.id, label: d.label }] : []);
}

function readPlan(db: Database, runId: string, before: number): Pause["plan"] {
  const row = db.query(PLAN_SQL).get(runId, before) as { data: string | null } | null;
  const output = data(row ?? undefined).node_output;
  const plan = parse(typeof output === "string" ? output : undefined);
  const questions = plan.open_questions;
  const strings = Array.isArray(questions) && questions.every((q): q is string => typeof q === "string");
  if (typeof plan.ready !== "boolean" || !strings) return undefined;
  return { ready: plan.ready, openQuestions: questions };
}

// The PR title post-merge's `fetch` read, "" when the run has none.
export function readFetchTitle(db: Database, runId: string): string {
  const row = db.query(FETCH_SQL).get(runId) as { data: string | null } | null;
  const output = data(row ?? undefined).node_output;
  const title = parse(typeof output === "string" ? output : undefined).title;
  return typeof title === "string" ? title : "";
}

// The decision that answered pause event `eventId`: a gate's `approved|skip|abort|retry|needs-revision|rejected`, or a
// wait's chosen option; undefined while nothing answered it.
export function readAnswer(db: Database, runId: string, eventId: string): string | undefined {
  const row = db.query(ANSWER_SQL).get(runId, eventId) as { data: string | null } | null;
  const answer = data(row ?? undefined);
  const decision = answer.decision ?? answer.answer?.decision;
  return typeof decision === "string" ? decision : undefined;
}

// A wait leaves no text event; Archon keeps the rendered text in metadata.wait until the wait is answered.
function waitMessage(run: RunRow): string {
  const wait = parse(run.metadata).wait as { message?: unknown } | undefined;
  return typeof wait?.message === "string" ? wait.message : "";
}

function gateMessage(leaf: EventRow, newestFirst: EventRow[]): string {
  const request = newestFirst.find((e) =>
    e.event_type === "approval_requested" && e.step_name === leaf.step_name && e.event_order > leaf.event_order);
  const message = data(request).message;
  return typeof message === "string" ? message : "";
}

type EventData = {
  node?: { id?: string; kind?: string };
  invocation?: { loopPath?: { iteration?: unknown }[] };
  node_output?: unknown;
  message?: unknown;
  error?: string;
  reason?: string;
  decision?: unknown;
  answer?: { decision?: unknown };
};

function data(e: { data: string | null } | undefined): EventData {
  return parse(e?.data) as EventData;
}

function parse(json: string | null | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
