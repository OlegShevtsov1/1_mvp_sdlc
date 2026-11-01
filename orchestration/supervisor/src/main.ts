import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Decision, respond } from "./act.ts";
import { housekeep } from "./housekeeping.ts";
import { ANSWERED_TOAST, pressToast, resolvedLine } from "./humanize.ts";
import { alreadyActed, appendLedger, readLedger } from "./ledger.ts";
import { launchPostMerges, parseSince, type PostMergeDeps, postMergeCutoff, realPostMergeDeps } from "./postmerge.ts";
import { decide, gateRules } from "./policy.ts";
import { inFlight, nextTasks, type QueueDeps, realQueueDeps, startQueued } from "./queue.ts";
import { activeRuns, type Host, limits, readHost } from "./resources.ts";
import { OPEN_STATUSES, type RunView, readRuns } from "./runs.ts";
import {
  digest, type OperatorAnswer, type Press, realTelegramDeps, type TelegramDeps, telegramStatus,
} from "./telegram.ts";
import { handleFailure, resumeDetached, transientRule } from "./transient.ts";

export type Policy = { version: 1; rules: unknown[]; postMergeSince?: Date };

const TICK_MS = 30_000;
// Telegram holds a getUpdates this long when nothing arrives, so a press reaches the supervisor within about a second.
const POLL_SECONDS = 25;
const BACKOFF_MS = [5_000, 15_000, 60_000];
const HISTORY_HOURS = 24;
// A PR the operator merges days after its run ended, over a weekend for example, still gets its post-merge run.
const POST_MERGE_HISTORY_HOURS = 14 * 24;
const HOUSEKEEPING_MS = 24 * 60 * 60 * 1000;
const OPERATOR_TEXT = "Відповідь оператора в Telegram (sdlc-autopilot).";

export function loadPolicy(path: string): Policy {
  const p = Bun.YAML.parse(readFileSync(path, "utf8")) as (Partial<Policy> & { post_merge?: unknown }) | null;
  if (p?.version !== 1 || !Array.isArray(p.rules)) throw new Error(`${path}: want version: 1 and a rules list`);
  if (p.post_merge !== undefined && (typeof p.post_merge !== "object" || p.post_merge === null)) {
    throw new Error(`${path}: post_merge must be a mapping`);
  }
  const policy: Policy = {
    version: 1, rules: p.rules, postMergeSince: parseSince((p.post_merge as { since?: unknown } | undefined)?.since, path),
  };
  transientRule(policy);
  gateRules(policy.rules);
  return policy;
}

export async function tick(deps: {
  db: Database;
  policy: Policy;
  respond: (run: RunView, d: Decision) => void;
  now?: () => Date;
  host?: () => Host;
  resume?: (run: RunView) => void;
  postMerge?: PostMergeDeps;
  queue?: QueueDeps;
  telegram?: TelegramDeps;
}): Promise<RunView[]> {
  let decided = 0;
  const now = (deps.now ?? (() => new Date()))();
  const runs = readRuns(deps.db, HISTORY_HOURS);
  // Gate policy (PILOT-509): the install gate is retried only while the factory runs blocking it are open.
  const ctx = {
    activeFactoryRuns: runs
      .filter((r) => r.workflow === "factory" && OPEN_STATUSES.includes(r.status))
      .map((r) => r.id),
  };
  for (const run of runs) {
    // Transient failures (PILOT-508): resume with backoff, escalate after the last attempt. One run's error must not
    // keep the runs after it undecided.
    if (run.status === "failed") {
      const resume = deps.resume ?? resumeDetached;
      try {
        if (handleFailure(run, deps.policy, { now, host: deps.host ?? readHost, resume })) decided++;
      } catch (e) {
        console.error(`sdlc-autopilot: failed run ${run.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    const pause = run.pause;
    if (!pause || alreadyActed(run.id, pause.eventId)) continue;
    let decision = decide(run, deps.policy, ctx);
    if (decision.action === "approve" || decision.action === "retry") {
      try {
        deps.respond(run, decision);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`sdlc-autopilot: respond to ${run.id} failed: ${reason}`);
        decision = {
          action: "escalate", rule: decision.rule,
          text: `Не вдалося відповісти на паузу: ${reason} — потрібне рішення оператора.`,
        };
      }
    }
    appendLedger({
      ts: new Date().toISOString(), run_id: run.id, workflow: run.workflow, kind: pause.kind,
      rule: decision.rule, action: decision.action,
      evidence: { event_id: pause.eventId, node: pause.node, text: pause.text, message: decision.text },
    });
    decided++;
  }

  // Post-merge launches and queued briefs share the run slots and the host threshold (PILOT-511).
  const recent = readRuns(deps.db, POST_MERGE_HISTORY_HOURS);
  const queued = deps.queue ? inFlight(recent) : { views: [], written: 0 };
  const active = [...activeRuns(recent), ...queued.views];
  if (deps.postMerge) {
    decided += launchPostMerges(deps.db, recent, deps.postMerge, postMergeCutoff(deps.policy, now), active);
  }
  const open = [...recent.filter((r) => OPEN_STATUSES.includes(r.status)), ...queued.views];
  if (deps.queue) decided += queued.written + startQueued(active, open, deps.queue);

  // Operator answers arrive through `listenLoop`; the tick sends escalations and closes messages answered elsewhere.
  // Telegram being down must not fail the tick.
  if (deps.telegram) {
    try {
      const sent = await deps.telegram.notifyEscalations(recent, deps.db);
      if (sent > 0) console.log(`sdlc-autopilot: ${sent} escalation(s) sent to Telegram`);
    } catch (e) {
      console.error(`sdlc-autopilot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (decided > 0) console.log(`sdlc-autopilot: ${decided} decision(s) written to the ledger`);
  return open;
}

// An operator's button press is answered only on the pause it was shown for, once, and only with one of that pause's
// own decisions; `--occurrence` in the respond makes Archon refuse it if the pause moved on meanwhile. The ledger
// check is synchronous with the act's ledger line, so of several presses on one pause only the first acts.
function operatorPress(
  runs: RunView[], a: OperatorAnswer, respond: (run: RunView, d: Decision) => void, telegram: TelegramDeps,
): Press {
  const run = runs.find((r) => r.id === a.runId && r.status === "paused" && r.pause?.eventId === a.eventId);
  const pause = run?.pause;
  // The next tick's notifyEscalations closes that message as answered outside Telegram.
  if (!run || !pause) return { toast: ANSWERED_TOAST };
  const answered = readLedger().some((e) =>
    e.run_id === a.runId && e.evidence?.event_id === a.eventId && e.rule === "operator" && e.action !== "escalate");
  const choice = pause.decisions.find((d) => d.id === a.action);
  if (answered || !choice) return { toast: ANSWERED_TOAST };
  const text = a.text ?? OPERATOR_TEXT;
  const line = { ts: new Date().toISOString(), run_id: run.id, workflow: run.workflow, kind: pause.kind, rule: "operator" };
  const act = async () => {
    try {
      respond(run, { action: a.action, rule: "operator", text });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      appendLedger({
        ...line, action: "escalate", evidence: {
          event_id: pause.eventId, node: pause.node,
          message: `Не вдалося виконати відповідь оператора ${a.action}: ${reason} — потрібне рішення оператора.`,
        },
      });
      await telegram.closeAnswer(a, "❌ Не вдалося виконати відповідь — надіслано нове повідомлення.");
      return;
    }
    appendLedger({ ...line, action: a.action, evidence: { event_id: pause.eventId, node: pause.node, text } });
    console.log(`sdlc-autopilot: operator ${a.action} for ${run.id} written to the ledger`);
    await telegram.closeAnswer(a, resolvedLine(a.action, true));
  };
  return { toast: pressToast(a.action), act };
}

type ListenDeps = {
  runs: () => RunView[];
  respond: (run: RunView, d: Decision) => void;
  telegram: TelegramDeps;
  status: () => string;
  pollSeconds?: number;
};

// One long poll of Telegram updates; false when Telegram is not configured.
export function listen(deps: ListenDeps): Promise<boolean> {
  return deps.telegram.pollUpdates({
    status: deps.status,
    press: (a) => operatorPress(deps.runs(), a, deps.respond, deps.telegram),
  }, deps.pollSeconds ?? POLL_SECONDS);
}

// Runs next to the tick and never throws: a failed poll waits 5 s, 15 s, then 60 s per failure until one succeeds.
// Disabled Telegram is checked again every tick interval, since its config is re-read on each call.
export async function listenLoop(deps: ListenDeps & {
  sleep?: (ms: number) => Promise<void>;
  stop?: () => boolean;
}): Promise<void> {
  const sleep = deps.sleep ?? Bun.sleep;
  let failures = 0;
  while (!deps.stop?.()) {
    try {
      const enabled = await listen(deps);
      failures = 0;
      if (!enabled) await sleep(TICK_MS);
    } catch (e) {
      const wait = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)];
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`sdlc-autopilot: Telegram updates: ${reason}; next try in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

if (import.meta.main) {
  const dbPath = join(process.env.ARCHON_HOME || join(homedir(), ".archon"), "archon.db");
  const policy = loadPolicy(process.env.SDLC_AUTOPILOT_POLICY || join(import.meta.dir, "..", "policy.yaml"));
  limits();
  console.log(`sdlc-autopilot: ${telegramStatus()}`);
  console.log(`sdlc-autopilot: started, reading ${dbPath} every ${TICK_MS / 1000} s`);
  console.log("sdlc-autopilot: reading Telegram updates by long polling");
  // `/status` reports the last tick's view; `inFlight` writes files and ledger lines, so only the tick computes it.
  let open: RunView[] = [];
  const recentRuns = () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return readRuns(db, POST_MERGE_HISTORY_HOURS);
    } finally {
      db.close();
    }
  };
  void listenLoop({ runs: recentRuns, respond, telegram: realTelegramDeps, status: () => digest(open, nextTasks()) });
  let housekept = 0;
  for (;;) {
    if (Date.now() - housekept >= HOUSEKEEPING_MS) {
      housekept = Date.now();
      const removed = housekeep();
      if (removed > 0) console.log(`sdlc-autopilot: removed ${removed} test leftover(s) older than 24 h`);
    }
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        open = await tick({
          db, policy, respond, postMerge: realPostMergeDeps, queue: realQueueDeps, telegram: realTelegramDeps,
        });
      } finally {
        db.close();
      }
    } catch (e) {
      console.error(`sdlc-autopilot: tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await Bun.sleep(TICK_MS);
  }
}
