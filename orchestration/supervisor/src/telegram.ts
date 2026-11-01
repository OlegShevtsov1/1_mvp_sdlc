import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isRespondAction, type RespondAction } from "./act.ts";
import { stepsFile } from "./allowlist.ts";
import {
  ANSWERED_TOAST, buttonLabel, type Escalation, MAX_TEXT, renderEscalation, resolvedLine, RETRY_TOAST, shortId,
} from "./humanize.ts";
import { type LedgerEntry, ledgerPath, readLedger, redact } from "./ledger.ts";
import type { QueuedTask } from "./queue.ts";
import { type Pause, readAnswer, readFetchTitle, repoOf, type RunView } from "./runs.ts";

export type OperatorAnswer = { runId: string; eventId: string; action: RespondAction; text?: string };

// A press is answered with `toast` at once; `act`, when given, runs after the answer.
export type Press = { toast: string; act?: () => Promise<void> };

export type UpdateHandlers = { status: () => string; press: (a: OperatorAnswer) => Press };

export type TelegramDeps = {
  pollUpdates: (handlers: UpdateHandlers, timeout: number) => Promise<boolean>;
  notifyEscalations: (runs: RunView[], db: Database) => Promise<number>;
  closeAnswer: (a: OperatorAnswer, note: string) => Promise<void>;
};

// The bot this repo's harness already alerts through (claude-auth); its topic is the operator's harness channel.
const BOT = "MVP_VPN_ALERTS";
const TOKEN_VAR = `TELEGRAM_${BOT}_BOT_TOKEN`;
const CHAT_VAR = `TELEGRAM_${BOT}_CHAT_ID`;
const THREAD_VAR = `TELEGRAM_${BOT}_THREAD_ID`;
// Bounds what a lost state file can send again; older escalations stay visible in `/status`.
const HISTORY_HOURS = 24;

type Config = { token: string; chat: string; thread: string; api: string };

type Buttons = { run_id: string; event_id: string; actions: string[]; text: string };

type State = { offset: number; notified: string[]; messages: Record<string, Buttons> };

export function envPath(): string {
  return process.env.SDLC_AUTOPILOT_TELEGRAM_ENV || join(homedir(), ".config", "telegram-bots", ".env");
}

// Read on every call: the token never lives longer than one request.
function config(): Config | null {
  const path = envPath();
  if (!existsSync(path)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!env[TOKEN_VAR] || !env[CHAT_VAR]) return null;
  return {
    token: env[TOKEN_VAR], chat: env[CHAT_VAR], thread: env[THREAD_VAR] ?? "",
    api: process.env.SDLC_AUTOPILOT_TELEGRAM_API || "https://api.telegram.org",
  };
}

export function telegramStatus(): string {
  return config() ? `Telegram enabled (${BOT})` : `Telegram disabled: ${TOKEN_VAR}/${CHAT_VAR} not set in ${envPath()}`;
}

function scrub(text: string, cfg: Config): string {
  return text.replaceAll(cfg.token, "[REDACTED]");
}

// The request URL carries the token, and Bun's fetch errors keep the URL in their own `path` property, so no original
// error leaves this function: only a scrubbed message, without a cause.
async function call<T>(cfg: Config, method: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  let reply: { ok?: boolean; result?: T; description?: string };
  let status: number;
  try {
    const res = await fetch(`${cfg.api}/bot${cfg.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    reply = (await res.json().catch(() => ({}))) as typeof reply;
  } catch (e) {
    throw new Error(scrub(`Telegram ${method}: ${e instanceof Error ? e.message : String(e)}`, cfg));
  }
  if (!reply.ok) throw new Error(scrub(`Telegram ${method}: HTTP ${status} ${reply.description ?? ""}`.trim(), cfg));
  return reply.result as T;
}

function send(cfg: Config, text: string, extra: Record<string, unknown> = {}): Promise<{ message_id: number }> {
  return call(cfg, "sendMessage", {
    chat_id: cfg.chat, text, ...(cfg.thread ? { message_thread_id: Number(cfg.thread) } : {}), ...extra,
  });
}

function statePath(): string {
  return join(dirname(ledgerPath()), "telegram.json");
}

function loadState(): State {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8")) as Partial<State>;
    return {
      offset: typeof s.offset === "number" ? s.offset : 0,
      notified: Array.isArray(s.notified) ? s.notified : [],
      messages: s.messages && typeof s.messages === "object" ? s.messages : {},
    };
  } catch {
    return { offset: 0, notified: [], messages: {} };
  }
}

function updateState(change: (s: State) => void): void {
  const s = loadState();
  change(s);
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(s)}\n`);
  renameSync(`${path}.tmp`, path);
}

// Buttons go only under the run's open pause; a pause that moved on, or a failure, has nothing to press.
export async function notifyEscalation(e: Escalation, pause: Pause | undefined): Promise<number> {
  const cfg = config();
  if (!cfg) return 0;
  const actions = (pause?.decisions ?? []).map((x) => x.id).filter(isRespondAction);
  const text = renderEscalation(e, { needsRevision: pause?.decisions.some((x) => x.id === "needs-revision") ?? false });
  const markup = actions.length > 0
    ? { reply_markup: { inline_keyboard: actions.map((a) => [{ text: buttonLabel(a, e), callback_data: a }]) } }
    : {};
  const { message_id } = await send(cfg, text, { parse_mode: "HTML", ...markup });
  if (pause && actions.length > 0) {
    updateState((s) => {
      s.messages[String(message_id)] = { run_id: e.runId, event_id: pause.eventId, actions, text };
    });
  }
  return message_id;
}

// The plan's own step numbering: post-merge plans may start at step 0, so the last step's number, not their count.
function lastStepNumber(runId: string, cwd: string): string {
  const path = stepsFile(runId, cwd);
  if (!path) return "";
  try {
    const n = (JSON.parse(readFileSync(path, "utf8")) as { steps?: { n?: unknown }[] }).steps?.at(-1)?.n;
    return typeof n === "string" || typeof n === "number" ? String(n) : "";
  } catch {
    return "";
  }
}

function escalation(e: LedgerEntry, run: RunView | undefined, db: Database): Escalation {
  const cwd = run?.cwd ?? "";
  return {
    workflow: e.workflow, runId: e.run_id, repo: repoOf(cwd), runMessage: run?.message ?? "", kind: e.kind,
    rule: e.rule, text: e.evidence?.text ?? "", reason: e.evidence?.message ?? "",
    prTitle: e.workflow === "post-merge" ? readFetchTitle(db, e.run_id) : "",
    lastStep: e.kind === "post-merge-gate" ? lastStepNumber(e.run_id, cwd) : "",
  };
}

const lineKey = (e: LedgerEntry) => `${e.ts}|${e.run_id}|${e.evidence?.event_id ?? ""}|${e.rule}`;

// The outbox: every escalation the ledger got in the last 24 h is sent once, whichever module wrote it. A key is
// recorded only after Telegram accepted the message, so a failed send is retried on the next tick. A message whose
// pause is no longer its run's open pause was answered — outside Telegram, or the run moved on — and is closed once.
export async function notifyEscalations(runs: RunView[], db: Database): Promise<number> {
  const cfg = config();
  if (!cfg) return 0;
  const since = Date.now() - HISTORY_HOURS * 3_600_000;
  const pending = readLedger().filter((e) => e.action === "escalate" && Date.parse(e.ts) >= since);
  const byId = new Map(runs.map((r) => [r.id, r]));
  updateState((s) => {
    const keys = new Set(pending.map(lineKey));
    s.notified = s.notified.filter((k) => keys.has(k));
  });
  for (const [id, m] of Object.entries(loadState().messages)) {
    const run = byId.get(m.run_id);
    if (run?.pause?.eventId === m.event_id) continue;
    await closeMessage(cfg, id, m, resolvedLine(readAnswer(db, m.run_id, m.event_id), false, run?.status));
  }
  const notified = new Set(loadState().notified);
  let sent = 0;
  for (const e of pending) {
    if (notified.has(lineKey(e))) continue;
    const run = byId.get(e.run_id);
    const pause = run?.pause?.eventId === e.evidence?.event_id ? run?.pause : undefined;
    try {
      await notifyEscalation(escalation(e, run, db), pause);
    } catch (err) {
      console.error(`sdlc-autopilot: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
    updateState((s) => void s.notified.push(lineKey(e)));
    sent++;
  }
  return sent;
}

type Update = {
  update_id: number;
  message?: { chat: { id: number | string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number | string } } };
};

const logged = (e: unknown) => console.error(`sdlc-autopilot: ${e instanceof Error ? e.message : String(e)}`);

// A press whose state could not be read is still answered; its message keeps its buttons, so a later press retries.
function pressed(handlers: UpdateHandlers, a: OperatorAnswer): Press {
  try {
    return handlers.press(a);
  } catch (e) {
    logged(e);
    return { toast: RETRY_TOAST };
  }
}

// One long poll of `timeout` seconds; false when Telegram is not configured. Only the operator's chat is heard;
// everything else is skipped without a reply. Telegram drops a callback answer after about 15 s, so a press is answered
// before its action runs. The messages are read per press: an earlier press in the same batch may have closed one.
export async function pollUpdates(handlers: UpdateHandlers, timeout: number): Promise<boolean> {
  const cfg = config();
  if (!cfg) return false;
  const updates = await call<Update[]>(cfg, "getUpdates", {
    offset: loadState().offset, timeout, allowed_updates: ["message", "callback_query"],
  }, (timeout + 10) * 1000);
  for (const u of updates) {
    updateState((s) => {
      s.offset = Math.max(s.offset, u.update_id + 1);
    });
    const chat = u.callback_query?.message?.chat.id ?? u.message?.chat.id;
    if (String(chat) !== cfg.chat) continue;
    try {
      if (u.message && /^\/status(@\w+)?$/.test(u.message.text?.trim() ?? "")) {
        await send(cfg, redact(handlers.status()).slice(0, MAX_TEXT));
      }
      const q = u.callback_query;
      if (q?.message) {
        const m = loadState().messages[String(q.message.message_id)];
        const action = q.data;
        const press: Press = m === undefined
          ? { toast: ANSWERED_TOAST }
          : isRespondAction(action) && m.actions.includes(action)
          ? pressed(handlers, { runId: m.run_id, eventId: m.event_id, action })
          : { toast: "Кнопка вже не діє" };
        await call(cfg, "answerCallbackQuery", { callback_query_id: q.id, text: press.toast }).catch(logged);
        await press.act?.();
      }
    } catch (e) {
      logged(e);
    }
  }
  return true;
}

// One edit appends the note and drops the buttons; the message is forgotten even when Telegram refused the edit, so it
// is edited once. A message sent before PILOT-544 holds plain text, which HTML mode could fail to parse.
async function closeMessage(cfg: Config, id: string, m: Buttons, note: string): Promise<void> {
  const html = m.text.startsWith("🟡 <b>");
  const text = `${m.text}\n\n${note}`;
  try {
    await call(cfg, "editMessageText", {
      chat_id: cfg.chat, message_id: Number(id), reply_markup: { inline_keyboard: [] },
      ...(html ? { text, parse_mode: "HTML" } : { text: text.slice(0, MAX_TEXT) }),
    });
  } catch (e) {
    logged(e);
  }
  updateState((s) => void delete s.messages[id]);
}

// Closes the buttons of the answered pause, appending the note to the message.
export async function closeAnswer(a: OperatorAnswer, note: string): Promise<void> {
  const cfg = config();
  if (!cfg) return;
  for (const [id, m] of Object.entries(loadState().messages)) {
    if (m.run_id === a.runId && m.event_id === a.eventId) await closeMessage(cfg, id, m, note);
  }
}

const section = (title: string, items: string[]) => [`${title} (${items.length}):`, ...(items.length ? items : ["—"])];

// The `/status` digest: what runs, what waits for the operator, what is queued and what starts next.
export function digest(runs: RunView[], queue: QueuedTask[]): string {
  const ledger = readLedger();
  const waiting = runs.filter((r) => {
    const event = r.pause?.eventId;
    if (r.status !== "paused" || !event) return false;
    const lines = ledger.filter((e) => e.run_id === r.id && e.evidence?.event_id === event);
    return lines.some((e) => e.action === "escalate") && !lines.some((e) => e.rule === "operator" && e.action !== "escalate");
  });
  const running = runs.filter((r) => r.status === "pending" || r.status === "running").map((r) =>
    `${r.workflow} ${shortId(r.id)} ${repoOf(r.cwd) || "—"} ${r.message.split("\n")[0].slice(0, 80)}`.trimEnd());
  const task = (t: QueuedTask) => `${t.card || "—"} ${basename(dirname(t.briefFile))}/${basename(t.briefFile)}`;
  return [
    "sdlc-autopilot — статус",
    ...section("Йдуть", running),
    ...section("Чекають оператора", waiting.map((r) => `${r.workflow} ${shortId(r.id)} ${r.pause?.node ?? ""}`)),
    ...section("У черзі", queue.map(task)),
    `Далі: ${queue[0] ? task(queue[0]) : "черга порожня"}`,
  ].join("\n");
}

export const realTelegramDeps: TelegramDeps = { pollUpdates, notifyEscalations, closeAnswer };
