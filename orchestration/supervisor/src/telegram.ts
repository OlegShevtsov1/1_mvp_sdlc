import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Decision, isRespondAction, type RespondAction } from "./act.ts";
import { type LedgerEntry, ledgerPath, readLedger, redact } from "./ledger.ts";
import type { QueuedTask } from "./queue.ts";
import { repoOf, type RunView } from "./runs.ts";

export type OperatorAnswer = { runId: string; eventId: string; action: RespondAction; text?: string };

export type TelegramDeps = {
  pollUpdates: (status?: () => string) => Promise<OperatorAnswer[]>;
  notifyEscalations: (runs: RunView[]) => Promise<number>;
  closeAnswer: (a: OperatorAnswer, note: string) => Promise<void>;
};

// The bot this repo's harness already alerts through (claude-auth); its topic is the operator's harness channel.
const BOT = "MVP_VPN_ALERTS";
const TOKEN_VAR = `TELEGRAM_${BOT}_BOT_TOKEN`;
const CHAT_VAR = `TELEGRAM_${BOT}_CHAT_ID`;
const THREAD_VAR = `TELEGRAM_${BOT}_THREAD_ID`;
// Bounds what a lost state file can send again; older escalations stay visible in `/status`.
const HISTORY_HOURS = 24;
const MAX_TEXT = 4000;
const PAUSE_TEXT = 1500;

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
async function call<T>(cfg: Config, method: string, body: Record<string, unknown>): Promise<T> {
  let reply: { ok?: boolean; result?: T; description?: string };
  let status: number;
  try {
    const res = await fetch(`${cfg.api}/bot${cfg.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
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

function shortId(id: string): string {
  return /^[0-9a-f]{8}-/.test(id) ? id.slice(0, 8) : id;
}

// Buttons go only under the run's open pause; a pause that moved on, or a failure, has nothing to press.
export async function notifyEscalation(run: RunView, d: Decision, step = run.pause?.node ?? ""): Promise<number> {
  const cfg = config();
  if (!cfg) return 0;
  const pause = run.pause;
  const buttons = (pause?.decisions ?? []).filter((x) => isRespondAction(x.id));
  const lines = [
    "⚠️ sdlc-autopilot: потрібне рішення оператора",
    `Прогін: ${run.workflow} ${shortId(run.id)} ${repoOf(run.cwd) || "—"}`,
    `Крок: ${step || "—"}`,
    `Причина: ${d.text}`,
  ];
  if (pause?.text) lines.push("", pause.text.slice(0, PAUSE_TEXT));
  if (pause?.decisions.some((x) => x.id === "needs-revision")) lines.push("", "Needs revision — лише через archon CLI.");
  const text = redact(lines.join("\n")).slice(0, MAX_TEXT);
  const markup = buttons.length > 0
    ? { reply_markup: { inline_keyboard: buttons.map((b) => [{ text: b.label, callback_data: b.id }]) } }
    : {};
  const { message_id } = await send(cfg, text, markup);
  if (pause && buttons.length > 0) {
    updateState((s) => {
      s.messages[String(message_id)] = {
        run_id: run.id, event_id: pause.eventId, actions: buttons.map((b) => b.id), text,
      };
    });
  }
  return message_id;
}

const lineKey = (e: LedgerEntry) => `${e.ts}|${e.run_id}|${e.evidence?.event_id ?? ""}|${e.rule}`;

// The outbox: every escalation the ledger got in the last 24 h is sent once, whichever module wrote it. A key is
// recorded only after Telegram accepted the message, so a failed send is retried on the next tick.
export async function notifyEscalations(runs: RunView[]): Promise<number> {
  const cfg = config();
  if (!cfg) return 0;
  const since = Date.now() - HISTORY_HOURS * 3_600_000;
  const pending = readLedger().filter((e) => e.action === "escalate" && Date.parse(e.ts) >= since);
  const byId = new Map(runs.map((r) => [r.id, r]));
  updateState((s) => {
    const keys = new Set(pending.map(lineKey));
    s.notified = s.notified.filter((k) => keys.has(k));
    s.messages = Object.fromEntries(Object.entries(s.messages).filter(([, m]) =>
      byId.get(m.run_id)?.pause?.eventId === m.event_id));
  });
  const notified = new Set(loadState().notified);
  let sent = 0;
  for (const e of pending) {
    if (notified.has(lineKey(e))) continue;
    const run = byId.get(e.run_id);
    const current = run?.pause && run.pause.eventId === e.evidence?.event_id;
    const view: RunView = current && run
      ? run
      : { id: e.run_id, workflow: e.workflow, status: "", cwd: run?.cwd ?? "", message: "" };
    const step = e.evidence?.node || e.kind;
    try {
      await notifyEscalation(view, { action: "escalate", rule: e.rule, text: e.evidence?.message ?? e.evidence?.text ?? "" }, step);
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

// Only the operator's chat is heard; everything else is skipped without a reply. `status` renders `/status`.
export async function pollUpdates(status?: () => string): Promise<OperatorAnswer[]> {
  const cfg = config();
  if (!cfg) return [];
  const state = loadState();
  const updates = await call<Update[]>(cfg, "getUpdates", {
    offset: state.offset, timeout: 0, allowed_updates: ["message", "callback_query"],
  });
  const answers: OperatorAnswer[] = [];
  let offset = state.offset;
  for (const u of updates) {
    offset = Math.max(offset, u.update_id + 1);
    const chat = u.callback_query?.message?.chat.id ?? u.message?.chat.id;
    if (String(chat) !== cfg.chat) continue;
    try {
      if (u.message && /^\/status(@\w+)?$/.test(u.message.text?.trim() ?? "")) {
        if (status) await send(cfg, redact(status()).slice(0, MAX_TEXT));
      }
      const q = u.callback_query;
      if (q?.message) {
        const m = state.messages[String(q.message.message_id)];
        const action = q.data;
        const known = m !== undefined && isRespondAction(action) && m.actions.includes(action);
        if (known) answers.push({ runId: m.run_id, eventId: m.event_id, action });
        await call(cfg, "answerCallbackQuery", { callback_query_id: q.id, ...(known ? {} : { text: "Кнопка вже не діє" }) });
      }
    } catch (e) {
      console.error(`sdlc-autopilot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  updateState((s) => {
    s.offset = offset;
  });
  return answers;
}

// Closes the buttons of the answered pause in one edit, appending the note to the message.
export async function closeAnswer(a: OperatorAnswer, note: string): Promise<void> {
  const cfg = config();
  if (!cfg) return;
  const messages = Object.entries(loadState().messages).filter(([, m]) =>
    m.run_id === a.runId && m.event_id === a.eventId);
  for (const [id, m] of messages) {
    try {
      await call(cfg, "editMessageText", {
        chat_id: cfg.chat, message_id: Number(id), text: `${m.text}\n\n${note}`.slice(0, MAX_TEXT),
        reply_markup: { inline_keyboard: [] },
      });
    } catch (e) {
      console.error(`sdlc-autopilot: ${e instanceof Error ? e.message : String(e)}`);
    }
    updateState((s) => void delete s.messages[id]);
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
