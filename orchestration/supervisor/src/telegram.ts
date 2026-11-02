import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isRespondAction, type RespondAction } from "./act.ts";
import { readStep, stepsFile } from "./allowlist.ts";
import { readEnvFile } from "./envfile.ts";
import {
  ANSWERED_TOAST, buttonLabel, type Escalation, field, MAX_TEXT, renderEscalation, resolvedLine, RETRY_TOAST, shortId,
} from "./humanize.ts";
import { isOperatorAnswer, type LedgerEntry, ledgerPath, readLedger, redact } from "./ledger.ts";
import type { QueuedTask } from "./queue.ts";
import { stepNumber } from "./policy.ts";
import { readEvidence, renderQaCard, type Shot } from "./qa.ts";
import { type Pause, readAnswer, readFetchTitle, repoOf, type RunView } from "./runs.ts";

export type OperatorAnswer = { runId: string; eventId: string; action: RespondAction; text?: string };

// A press is answered with `toast` at once; `act`, when given, runs after the answer. `askReason` asks the operator to
// reply with the reason the press needs.
export type Press = { toast: string; act?: () => Promise<void>; askReason?: boolean };

export type UpdateHandlers = {
  status: () => string;
  task: (text: string) => Promise<string>;
  press: (a: OperatorAnswer) => Press;
};

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

// A «Що змінити?» prompt the operator answers by replying to it; `card` is the message whose button asked.
type Reply = { run_id: string; event_id: string; card: string };

// `albums`: the first message of the screenshots sent for an open QA pause (`run|event`) whose card is not out yet.
type State = {
  offset: number; notified: string[]; messages: Record<string, Buttons>; replies: Record<string, Reply>;
  albums: Record<string, number>;
};

export function envPath(): string {
  return process.env.SDLC_AUTOPILOT_TELEGRAM_ENV || join(homedir(), ".config", "telegram-bots", ".env");
}

// Read on every call: the token never lives longer than one request.
function config(): Config | null {
  const env = readEnvFile(envPath());
  if (!env?.[TOKEN_VAR] || !env[CHAT_VAR]) return null;
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

// `status` is Telegram's HTTP answer, 0 when none arrived.
class TelegramError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

// The request URL carries the token, and Bun's fetch errors keep the URL in their own `path` property, so no original
// error leaves this function: only a scrubbed message, without a cause. A FormData body goes as multipart, which is
// how Telegram takes uploaded files.
async function call<T>(
  cfg: Config, method: string, body: Record<string, unknown> | FormData, timeoutMs = 10_000,
): Promise<T> {
  let reply: { ok?: boolean; result?: T; description?: string };
  let status: number;
  try {
    const res = await fetch(`${cfg.api}/bot${cfg.token}/${method}`, {
      method: "POST",
      ...(body instanceof FormData
        ? { body }
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    reply = (await res.json().catch(() => ({}))) as typeof reply;
  } catch (e) {
    throw new TelegramError(scrub(`Telegram ${method}: ${e instanceof Error ? e.message : String(e)}`, cfg));
  }
  if (!reply.ok) {
    throw new TelegramError(scrub(`Telegram ${method}: HTTP ${status} ${reply.description ?? ""}`.trim(), cfg), status);
  }
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
      replies: s.replies && typeof s.replies === "object" ? s.replies : {},
      albums: s.albums && typeof s.albums === "object" ? s.albums : {},
    };
  } catch {
    return { offset: 0, notified: [], messages: {}, replies: {}, albums: {} };
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

// One album of the screenshots, each captioned with its page and width; the ids of the messages Telegram made.
async function sendShots(cfg: Config, shots: Shot[]): Promise<number[]> {
  const form = new FormData();
  form.set("chat_id", cfg.chat);
  if (cfg.thread) form.set("message_thread_id", cfg.thread);
  form.set("media", JSON.stringify(shots.map((s, i) => ({
    type: "photo", media: `attach://shot${i}`, caption: `${s.page} · ${s.width}px`,
  }))));
  for (const [i, s] of shots.entries()) form.set(`shot${i}`, Bun.file(s.path), basename(s.path));
  const sent = await call<{ message_id: number }[]>(cfg, "sendMediaGroup", form, 60_000);
  return sent.map((m) => m.message_id);
}

const albumKey = (runId: string, pause: Pause) => `${runId}|${pause.eventId}`;

// The QA dev card goes out after its screenshots, as a reply to them; they are sent only with the policy's first
// escalation of the open pause, so a re-escalation repeats the card alone, and a card whose send failed is retried
// as a reply to the album already sent. A refused album is logged and the card still goes out: the dev URL and the
// buttons must not wait on the photos.
async function qaCard(cfg: Config, e: Escalation, pause: Pause | undefined): Promise<{ text: string; replyTo?: number }> {
  const sha = field(pause?.text ?? "", "SHA");
  if (!pause || e.rule !== "qa-dev") return { text: renderQaCard(e, { sha, shots: "omitted" }) ?? "" };
  const evidence = readEvidence(e.runId, e.repo, pause.text);
  if (!evidence) return { text: renderQaCard(e, { sha, shots: "unreadable" }) ?? "" };
  if (evidence.shots.length === 0) return { text: renderQaCard(e, { sha, shots: "none" }) ?? "" };
  const shots = { sent: evidence.shots.length, total: evidence.total };
  const key = albumKey(e.runId, pause);
  const album = loadState().albums[key];
  if (album) return { text: renderQaCard(e, { sha, shots }) ?? "", replyTo: album };
  try {
    const [first] = await sendShots(cfg, evidence.shots);
    updateState((s) => void (s.albums[key] = first));
    return { text: renderQaCard(e, { sha, shots }) ?? "", replyTo: first };
  } catch (err) {
    logged(err);
    return { text: renderQaCard(e, { sha, shots: "failed" }) ?? "" };
  }
}

// Buttons go only under the run's open pause; a pause that moved on, or a failure, has nothing to press. Reject is
// offered only on a PR or QA card: another gate's reject may cancel its run.
export async function notifyEscalation(e: Escalation, pause: Pause | undefined): Promise<number> {
  const cfg = config();
  if (!cfg) return 0;
  const actions = (pause?.decisions ?? []).map((x) => x.id).filter(isRespondAction)
    .filter((a) => a !== "reject" || e.kind === "pr-approve" || e.kind === "qa-dev");
  const qa = renderQaCard(e, { sha: "", shots: "omitted" }) ? await qaCard(cfg, e, pause) : undefined;
  const text = qa?.text ||
    renderEscalation(e, { needsRevision: pause?.decisions.some((x) => x.id === "needs-revision") ?? false });
  const markup = actions.length > 0
    ? { reply_markup: { inline_keyboard: actions.map((a) => [{ text: buttonLabel(a, e), callback_data: a }]) } }
    : {};
  const replyTo = qa?.replyTo ? { reply_parameters: { message_id: qa.replyTo, allow_sending_without_reply: true } } : {};
  const { message_id } = await send(cfg, text, { parse_mode: "HTML", ...markup, ...replyTo });
  if (pause) {
    updateState((s) => {
      if (actions.length > 0) s.messages[String(message_id)] = { run_id: e.runId, event_id: pause.eventId, actions, text };
      delete s.albums[albumKey(e.runId, pause)];
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
  const step = e.kind === "post-merge-gate" ? stepNumber(e.evidence?.text ?? "") : undefined;
  return {
    workflow: e.workflow, runId: e.run_id, repo: repoOf(cwd), runMessage: run?.message ?? "", kind: e.kind,
    rule: e.rule, text: e.evidence?.text ?? "", reason: e.evidence?.message ?? "",
    prTitle: e.workflow === "post-merge" ? readFetchTitle(db, e.run_id) : "",
    lastStep: e.kind === "post-merge-gate" ? lastStepNumber(e.run_id, cwd) : "",
    stepText: step ? readStep(e.run_id, cwd, step)?.text ?? "" : "",
  };
}

const lineKey = (e: LedgerEntry) => `${e.ts}|${e.run_id}|${e.evidence?.event_id ?? ""}|${e.rule}`;

// The outbox: every escalation the ledger got in the last 24 h is sent once, whichever module wrote it. A key is
// recorded only after Telegram accepted the message, so a failed send is retried on the next tick. A message whose
// pause is no longer its run's open pause was answered — outside Telegram, or the run moved on — and is closed once.
// A line about a pause the operator already answered by button (a QA follow-up that failed, say) gets no buttons.
export async function notifyEscalations(runs: RunView[], db: Database): Promise<number> {
  const cfg = config();
  if (!cfg) return 0;
  const since = Date.now() - HISTORY_HOURS * 3_600_000;
  const ledger = readLedger();
  const pending = ledger.filter((e) => e.action === "escalate" && Date.parse(e.ts) >= since);
  const byId = new Map(runs.map((r) => [r.id, r]));
  updateState((s) => {
    const keys = new Set(pending.map(lineKey));
    s.notified = s.notified.filter((k) => keys.has(k));
    const open = new Set(runs.flatMap((r) => (r.pause ? [albumKey(r.id, r.pause)] : [])));
    for (const k of Object.keys(s.albums)) if (!open.has(k)) delete s.albums[k];
  });
  for (const [id, m] of Object.entries(loadState().messages)) {
    const run = byId.get(m.run_id);
    if (run?.pause?.eventId === m.event_id) continue;
    // A press whose own close failed is still closed as answered by button.
    const byButton = ledger.some((e) => isOperatorAnswer(e, m.run_id, m.event_id));
    await closeMessage(cfg, id, m, resolvedLine(readAnswer(db, m.run_id, m.event_id), byButton, run?.status));
  }
  const notified = new Set(loadState().notified);
  let sent = 0;
  for (const e of pending) {
    if (notified.has(lineKey(e))) continue;
    const run = byId.get(e.run_id);
    const event = e.evidence?.event_id ?? "";
    const answered = ledger.some((l) => isOperatorAnswer(l, e.run_id, event));
    const pause = run?.pause?.eventId === event && !answered ? run?.pause : undefined;
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
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
    reply_to_message?: { message_id: number };
  };
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

const REASON_PROMPT = "↩️ Що змінити? Напиши відповіддю на це повідомлення.";

// Only a reply to this prompt is read as the reason, so no other message in the chat can return a PR.
async function askReason(cfg: Config, replyTo: number, r: Reply): Promise<void> {
  const { message_id } = await send(cfg, REASON_PROMPT, {
    reply_markup: { force_reply: true, input_field_placeholder: "Що змінити?" },
    reply_parameters: { message_id: replyTo, allow_sending_without_reply: true },
  });
  updateState((s) => {
    s.replies[String(message_id)] = r;
  });
}

// A reply to a prompt is a reject with its text, whatever the text says; one without text asks again. The prompt is
// forgotten before the answer is sent, so a failed answer must not keep the reason from Archon.
async function replied(cfg: Config, handlers: UpdateHandlers, message: NonNullable<Update["message"]>, prompt: string) {
  const r = loadState().replies[prompt];
  updateState((s) => void delete s.replies[prompt]);
  const press = pressed(handlers, { runId: r.run_id, eventId: r.event_id, action: "reject", text: message.text ?? "" });
  if (press.askReason) return askReason(cfg, message.message_id, r);
  await send(cfg, press.toast, { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } })
    .catch(logged);
  await press.act?.();
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
      const prompt = String(u.message?.reply_to_message?.message_id ?? "");
      if (u.message && Object.hasOwn(loadState().replies, prompt)) {
        await replied(cfg, handlers, u.message, prompt);
      } else if (u.message && /^\/status(@\w+)?$/.test(u.message.text?.trim() ?? "")) {
        await send(cfg, redact(handlers.status()).slice(0, MAX_TEXT));
      } else if (u.message && /^\/task(@\w+)?(\s|$)/.test(u.message.text?.trim() ?? "")) {
        const answer = await handlers.task(u.message.text ?? "").catch((e: unknown) =>
          `⚠️ /task не виконано: ${e instanceof Error ? e.message : String(e)}`);
        await send(cfg, redact(answer).slice(0, MAX_TEXT), {
          reply_parameters: { message_id: u.message.message_id, allow_sending_without_reply: true },
        });
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
        if (m && press.askReason) {
          const card = String(q.message.message_id);
          await askReason(cfg, q.message.message_id, { run_id: m.run_id, event_id: m.event_id, card });
        }
        await press.act?.();
      }
    } catch (e) {
      logged(e);
    }
  }
  return true;
}

// One edit appends the note and drops the buttons, so the message is edited once. A failure that may pass — no answer,
// 429 or a server error — keeps the message for the next tick; Telegram refusing the edit forgets it. A message sent
// before PILOT-544 holds plain text, which HTML mode could fail to parse.
async function closeMessage(cfg: Config, id: string, m: Buttons, note: string): Promise<void> {
  const html = m.text.startsWith("🟡 <b>");
  const text = `${m.text}\n\n${note}`;
  try {
    await call(cfg, "editMessageText", {
      chat_id: cfg.chat, message_id: Number(id), reply_markup: { inline_keyboard: [] },
      ...(html ? { text, parse_mode: "HTML" } : { text: text.slice(0, MAX_TEXT) }),
    });
    console.log(`sdlc-autopilot: Telegram message ${id} of ${shortId(m.run_id)} closed: ${note}`);
  } catch (e) {
    logged(e);
    const refused = e instanceof TelegramError && e.status > 0 && e.status !== 429 && e.status < 500;
    if (!refused) return;
  }
  updateState((s) => {
    delete s.messages[id];
    for (const [prompt, r] of Object.entries(s.replies)) if (r.card === id) delete s.replies[prompt];
  });
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
    return lines.some((e) => e.action === "escalate") && !lines.some((e) => isOperatorAnswer(e, r.id, event));
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
