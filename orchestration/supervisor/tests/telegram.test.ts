import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/act.ts";
import type { LedgerEntry } from "../src/ledger.ts";
import { listen, listenLoop, loadPolicy, tick } from "../src/main.ts";
import { nextTasks, type QueueDeps } from "../src/queue.ts";
import { readRuns, type RunView } from "../src/runs.ts";
import { digest, realTelegramDeps } from "../src/telegram.ts";
import { HINT, type IntakeDeps, respondStage, stageViews, taskCommand } from "../src/intake.ts";
import {
  type Evidence, FILES, qaMessage, WAIT_NODE,
} from "../../factory/.archon/workflows/sdlc-factory/factory/scripts/_lib/qa-evidence.ts";
import { FIXTURES, fixtureDb, insertEvent, insertRun } from "./fixtures/db.ts";

const POLICY = join(import.meta.dir, "..", "policy.yaml");
// Built from parts so secret scanners do not take the fake for a real bot token.
const TOKEN = ["123456", "TESTtokenSECRETabc123XYZ_-q9w8e7r6t5"].join(":");
const CHAT = -1001;
const POST_MERGE_RUN = "c2154fea-2e08-4385-8589-d413204db098";
const POST_MERGE_EVENT = "d13280fe-8b0d-4de6-a014-87abfce50625";
const INSTALL_RUN = "ec459894-e870-46d3-a37a-bed2af487528";
const RELEASE_RUN = "8275c6ec-780e-44c4-98cc-b8e5bac0e0dc";

type Request = { method: string; token: string; body: Record<string, unknown> };
type TrelloRequest = { method: string; path: string; auth: string; body: unknown };
type Fake = {
  requests: Request[];
  updates: Record<string, unknown>[];
  failWith?: Record<string, unknown>;
  // The HTTP status every editMessageText is refused with.
  failEdit?: number;
  // A sendMessage this matches is refused with 429.
  failSend?: (body: Record<string, unknown>) => boolean;
  // Resolved when an update is pushed: a held getUpdates answers then, as Telegram's long polling does.
  waiters: (() => void)[];
  // Every sendMediaGroup is refused with 400.
  failMedia?: boolean;
  // Requests to the fake Trello API under /1/.
  trello: TrelloRequest[];
};

let dir: string;
let ledger: string;
let fake: Fake;
let server: ReturnType<typeof Bun.serve>;
let calls: [string, Decision["action"]][];
let texts: string[];
let nextMessageId: number;
let nextUpdateId: number;
let nextMediaId: number;
const respond = (run: RunView, d: Decision) => {
  calls.push([run.id, d.action]);
  texts.push(d.text);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-telegram-"));
  ledger = join(dir, "state", "ledger.jsonl");
  process.env.SDLC_AUTOPILOT_LEDGER = ledger;
  process.env.SDLC_AUTOPILOT_QUEUE = join(dir, "queue");
  process.env.ARCHON_HOME = join(dir, "archon");
  const env = join(dir, "telegram.env");
  writeFileSync(env, [
    "# bots", `TELEGRAM_MVP_VPN_ALERTS_BOT_TOKEN="${TOKEN}"`, `TELEGRAM_MVP_VPN_ALERTS_CHAT_ID=${CHAT}`,
    "TELEGRAM_MVP_VPN_ALERTS_THREAD_ID=226", "", "TELEGRAM_PILOT_PROD_ALERTS_CHAT_ID=-42",
  ].join("\n"));
  process.env.SDLC_AUTOPILOT_TELEGRAM_ENV = env;
  const trelloEnv = join(dir, "trello.env");
  writeFileSync(trelloEnv, "TRELLO_API_KEY=test-key\nTRELLO_TOKEN=test-token\nTRELLO_BOARD_ID=board-1\n");
  process.env.SDLC_AUTOPILOT_TRELLO_ENV = trelloEnv;
  calls = [];
  texts = [];
  nextMessageId = 100;
  nextUpdateId = 1;
  nextMediaId = 900;
  fake = { requests: [], updates: [], waiters: [], trello: [] };
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/1/")) return trello(req);
      const [, token, method] = path.match(/^\/bot([^/]+)\/(\w+)$/) ?? [];
      const body = req.headers.get("content-type")?.startsWith("multipart/")
        ? multipart(await req.formData())
        : (await req.json()) as Record<string, unknown>;
      fake.requests.push({ method, token, body });
      if (fake.failWith) return Response.json(fake.failWith, { status: 401 });
      if (method === "editMessageText" && fake.failEdit) {
        const status = fake.failEdit;
        return Response.json({ ok: false, error_code: status, description: "refused" }, { status });
      }
      if (method === "sendMessage" && fake.failSend?.(body)) {
        return Response.json({ ok: false, error_code: 429, description: "Too Many Requests" }, { status: 429 });
      }
      if (method === "getUpdates") {
        const offset = Number(body.offset);
        const ready = () => fake.updates.filter((u) => Number(u.update_id) >= offset);
        if (ready().length === 0 && Number(body.timeout) > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Number(body.timeout) * 1000);
            fake.waiters.push(() => (clearTimeout(timer), resolve()));
          });
        }
        return Response.json({ ok: true, result: ready() });
      }
      if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
      if (method === "sendMediaGroup" && fake.failMedia) {
        return Response.json({ ok: false, error_code: 400, description: "Bad Request" }, { status: 400 });
      }
      if (method === "sendMediaGroup") {
        const result = (body.media as unknown[]).map(() => ({ message_id: nextMediaId++ }));
        return Response.json({ ok: true, result });
      }
      return Response.json({ ok: true, result: true });
    },
  });
  process.env.SDLC_AUTOPILOT_TELEGRAM_API = server.url.origin;
  process.env.SDLC_AUTOPILOT_TRELLO_API = `${server.url.origin}/1`;
});

// The fields of a multipart request, its `media` parsed and its files listed by field name.
function multipart(form: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = { files: [] };
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") body[name] = name === "media" ? JSON.parse(value) : value;
    else (body.files as string[]).push(name);
  }
  return body;
}

// One board with card #900 (short link AbCd1234) in Test.
async function trello(req: globalThis.Request): Promise<Response> {
  const url = new URL(req.url);
  const body = req.method === "GET" ? undefined : await req.json();
  fake.trello.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") ?? "", body });
  const card = { id: "card-900", idShort: 900, idBoard: "board-id", idList: "list-test" };
  if (url.pathname === "/1/cards/AbCd1234") return Response.json(card);
  if (url.pathname === "/1/boards/board-1") return Response.json({ id: "board-id" });
  if (url.pathname === "/1/boards/board-1/cards") return Response.json([card]);
  if (url.pathname === "/1/boards/board-1/lists") {
    return Response.json([{ id: "list-test", name: "Test" }, { id: "list-rtr", name: "Ready to Release" }]);
  }
  if (req.method === "PUT" && url.pathname === "/1/cards/card-900") return Response.json(card);
  return new Response("not found", { status: 404 });
}

afterEach(() => {
  wake();
  server.stop(true);
});

function wake(): void {
  for (const w of fake.waiters.splice(0)) w();
}

const lines = (): LedgerEntry[] =>
  existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const sent = (method: string) => fake.requests.filter((r) => r.method === method);
const sentTo = (runPrefix: string) => sent("sendMessage").find((r) => String(r.body.text).includes(runPrefix));
const messageOf = (runPrefix: string) =>
  100 + sent("sendMessage").findIndex((r) => String(r.body.text).includes(runPrefix));
const keyboard = (r: Request | undefined) =>
  ((r?.body.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] })?.inline_keyboard ?? [])
    .flat();

function press(messageId: number, data: string, chat = CHAT): void {
  const id = nextUpdateId++;
  fake.updates.push({
    update_id: id,
    callback_query: { id: `cb-${id}`, data, message: { message_id: messageId, chat: { id: chat } } },
  });
  wake();
}

function say(text: string, chat = CHAT): number {
  const messageId = 6000 + nextUpdateId;
  fake.updates.push({ update_id: nextUpdateId++, message: { message_id: messageId, chat: { id: chat }, text } });
  wake();
  return messageId;
}

// A reply to message `replyTo`; `text` undefined is a reply without text, a sticker say.
function reply(text: string | undefined, replyTo: number, chat = CHAT): number {
  const messageId = 5000 + nextUpdateId;
  fake.updates.push({
    update_id: nextUpdateId++,
    message: { message_id: messageId, chat: { id: chat }, ...(text === undefined ? {} : { text }), reply_to_message: { message_id: replyTo } },
  });
  wake();
  return messageId;
}

const runsOf = (db: Database) => () => readRuns(db, 14 * 24);
const poll = (db: Database, r: (run: RunView, d: Decision) => void = respond) =>
  listen({ runs: runsOf(db), respond: r, telegram: realTelegramDeps, status: () => "", pollSeconds: 0 });
const toasts = () => sent("answerCallbackQuery").map((r) => r.body.text);

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(10);
}

const operatorLines = () => lines().filter((l) => l.rule === "operator");

const PR_RUN = "7b3c1d2e-5f6a-4b8c-9d0e-1f2a3b4c5d6e";
const PR_EVENT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const prompts = () => sent("sendMessage").filter((r) => (r.body.reply_markup as { force_reply?: boolean })?.force_reply);

// The PR card is the only message the pr-approve fixture sends; it gets message id 100.
async function prCard(): Promise<Database> {
  const db = fixtureDb("pr-approve-7b3c1d2e.json");
  await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
  calls = [];
  return db;
}

describe("pr-approve card", () => {
  test("pr-approve renders a PR card with link, diff and checks", async () => {
    await prCard();
    expect(sent("sendMessage")).toHaveLength(1);
    const card = sent("sendMessage")[0];
    expect(card.body).toMatchObject({ chat_id: String(CHAT), message_thread_id: 226, parse_mode: "HTML" });
    const text = String(card.body.text);
    expect(text).toStartWith("🟡 <b>PR готовий: PILOT-900: fe: dark theme toggle on the settings page</b>\n");
    expect(text).toContain('<a href="https://github.com/OlegShevtsov1/1_mvp_pilot_fe/pull/42">PR #42</a>');
    expect(text).toContain("Diff: 7 файлів, +120 −8 · Checks: 9 ✅");
    expect(text).toContain("<b>Підсумок:</b> The settings page gets a dark theme toggle.");
    expect(keyboard(card)).toEqual([
      { text: "✅ Апрув", callback_data: "approve" },
      { text: "↩️ Повернути", callback_data: "reject" },
    ]);
    expect(lines()).toMatchObject([{ run_id: PR_RUN, kind: "pr-approve", rule: "pr-approve", action: "escalate" }]);
  });

  test("reject asks for a reason and responds reject with it", async () => {
    const db = await prCard();
    press(100, "reject");
    await poll(db);
    expect(toasts()).toEqual(["↩️ Напиши відповіддю, що змінити"]);
    expect(calls).toEqual([]);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0].body).toMatchObject({
      text: "↩️ Що змінити? Напиши відповіддю на це повідомлення.", message_thread_id: 226,
      reply_markup: { force_reply: true }, reply_parameters: { message_id: 100 },
    });
    expect(sent("editMessageText")).toEqual([]);

    const answer = reply("- прибери кнопку", 101);
    await poll(db);
    expect(calls).toEqual([[PR_RUN, "reject"]]);
    expect(texts).toEqual(["- прибери кнопку"]);
    expect(operatorLines()).toMatchObject([{
      run_id: PR_RUN, kind: "pr-approve", action: "reject", evidence: { event_id: PR_EVENT, text: "- прибери кнопку" },
    }]);
    expect(sent("sendMessage").at(-1)?.body).toMatchObject({
      text: "↩️ Повертаю на доопрацювання", reply_parameters: { message_id: answer },
    });
    const closed = sent("editMessageText");
    expect(closed).toHaveLength(1);
    expect(closed[0].body).toMatchObject({ message_id: 100, reply_markup: { inline_keyboard: [] } });
    expect(String(closed[0].body.text)).toEndWith("\n\n✅ Вирішено: повернуто на доопрацювання (кнопкою)");
    expect(JSON.parse(readFileSync(join(dir, "state", "telegram.json"), "utf8")).replies).toEqual({});

    reply("ще одне", 101);
    await poll(db);
    expect(calls).toHaveLength(1);
  });

  test("a reject reason reaches Archon when its confirmation cannot be sent", async () => {
    const db = await prCard();
    press(100, "reject");
    await poll(db);
    const answer = reply("прибери кнопку", 101);
    fake.failSend = (body) => (body.reply_parameters as { message_id?: number } | undefined)?.message_id === answer;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await poll(db);
    } finally {
      error.mockRestore();
    }
    expect(calls).toEqual([[PR_RUN, "reject"]]);
    expect(texts).toEqual(["прибери кнопку"]);
    expect(sent("editMessageText")).toHaveLength(1);
  });

  test("reject without text sends nothing", async () => {
    const db = await prCard();
    press(100, "reject");
    await poll(db);
    const blank = reply("   ", 101);
    await poll(db);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1].body).toMatchObject({ reply_parameters: { message_id: blank } });
    reply(undefined, 102);
    await poll(db);
    expect(prompts()).toHaveLength(3);

    say("прибери кнопку");
    reply("прибери кнопку", 100);
    reply("прибери кнопку", 103, -999);
    await poll(db);
    expect(calls).toEqual([]);
    expect(operatorLines()).toEqual([]);
    expect(prompts()).toHaveLength(3);
    expect(sent("sendMessage")).toHaveLength(4);
    expect(sent("editMessageText")).toEqual([]);

    reply("прибери кнопку", 103);
    await poll(db);
    expect(texts).toEqual(["прибери кнопку"]);
  });

  test("approve responds approve once", async () => {
    const db = await prCard();
    for (let i = 0; i < 3; i++) press(100, "approve");
    await poll(db);
    expect(calls).toEqual([[PR_RUN, "approve"]]);
    expect(operatorLines()).toMatchObject([{ run_id: PR_RUN, action: "approve", evidence: { event_id: PR_EVENT } }]);
    expect(toasts()).toEqual(["✅ Прийнято, виконую", "Це питання вже вирішене", "Це питання вже вирішене"]);
    expect(prompts()).toEqual([]);
    const closed = sent("editMessageText");
    expect(closed).toHaveLength(1);
    expect(String(closed[0].body.text)).toEndWith("\n\n✅ Вирішено: прийнято (кнопкою)");
  });

  test("a gate other than the PR card offers no reject button", async () => {
    const db = fixtureDb("pr-approve-7b3c1d2e.json");
    db.query("UPDATE remote_agent_workflow_runs SET workflow_name = 'archon-interactive-prd' WHERE id = ?").run(PR_RUN);
    await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
    expect(keyboard(sent("sendMessage")[0])).toEqual([{ text: "✅ Прийняти", callback_data: "approve" }]);
  });
});

const QA_RUN = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
const QA_EVENT = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6f";
const QA_SHA = "9d8c7b6a5f4e3d2c1b0a99887766554433221100";
const QA_PR = "https://github.com/OlegShevtsov1/1_mvp_pilot_fe/pull/42";
const QA_E2E = "https://github.com/OlegShevtsov1/1_mvp_pilot_fe/actions/runs/7001";
// Built from parts: the hygiene check bans card links in tracked files.
const CARD_LINK = ["https://trello", "com/c/AbCd1234/900-dark-theme-toggle"].join(".");

type QaOptions = {
  // The run's user message; by default a task of card PILOT-900 that names CARD_LINK.
  message?: string;
  // What the factory's qa-dev.json holds instead of the evidence it wrote; undefined leaves no file.
  evidence?: (doc: { sha: string; shots: { page: string; width: number; path: string }[] }, runDir: string) => string | undefined;
};

const QA_MESSAGE = "Build in THIS repository OlegShevtsov1/1_mvp_pilot_fe, base develop, one PR, squash. " +
  `Trello PILOT-900 ${CARD_LINK}. PR title «PILOT-900: fe: dark theme toggle on the settings page», trailer «Type: feat». ` +
  "Touches src/settings/Theme.tsx.";

// The QA dev pause with `shots` screenshots on disk, its text as the factory's qaMessage renders it, after one tick.
// The paths and the wait's node are the factory's own names, so a rename there fails here.
async function qaCard(shots: number, options: QaOptions = {}): Promise<Database> {
  const workspace = join(dir, "archon", "workspaces", "OlegShevtsov1", "1_mvp_pilot_fe");
  const runDir = join(workspace, "artifacts", "runs", QA_RUN);
  mkdirSync(join(runDir, FILES.shots), { recursive: true });
  mkdirSync(join(workspace, "source"), { recursive: true });
  const list = Array.from({ length: shots }, (_, i) => {
    const path = join(runDir, FILES.shots, `shot-${i}.png`);
    writeFileSync(path, new Uint8Array([137, 80, 78, 71, i]));
    return { page: `https://dev.example.test/p${Math.floor(i / 2)}`, width: i % 2 ? 360 : 1440, path };
  });
  const evidence: Evidence = {
    status: "ready", reason: "", cause: "", link: "", sha: QA_SHA, url: "https://dev.example.test",
    e2e: { conclusion: "success", run_url: QA_E2E }, shots: list,
  };
  const evidencePath = join(runDir, FILES.evidence);
  const doc = { sha: QA_SHA, url: evidence.url, e2e: evidence.e2e, shots: list };
  const file = options.evidence ? options.evidence(doc, runDir) : JSON.stringify(doc);
  if (file !== undefined) writeFileSync(evidencePath, file);
  const db = fixtureDb("qa-dev-5e6f7a8b.json");
  const row = db.query("SELECT metadata FROM remote_agent_workflow_runs WHERE id = ?").get(QA_RUN) as { metadata: string };
  const meta = JSON.parse(row.metadata);
  meta.wait.message = qaMessage(evidence, QA_PR, evidencePath);
  meta.wait.nodeId = WAIT_NODE;
  db.query("UPDATE remote_agent_workflow_runs SET metadata = ?, user_message = ?, working_path = ? WHERE id = ?").run(
    JSON.stringify(meta), options.message ?? QA_MESSAGE,
    join(workspace, "worktrees", "archon", "task-factory-1793561200455"), QA_RUN);
  const events = db.query("SELECT id, data FROM remote_agent_workflow_events WHERE workflow_run_id = ? AND data IS NOT NULL")
    .all(QA_RUN) as { id: string; data: string }[];
  for (const ev of events) {
    const data = JSON.parse(ev.data);
    if (data.node?.kind !== "wait") continue;
    data.node.id = WAIT_NODE;
    db.query("UPDATE remote_agent_workflow_events SET data = ? WHERE id = ?").run(JSON.stringify(data), ev.id);
  }
  await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
  calls = [];
  return db;
}

const qaCardSent = () => sent("sendMessage").find((r) => String(r.body.text).startsWith("🟡 <b>На dev готово"));

describe("qa-dev card", () => {
  test("qa card sends screenshots and e2e link", async () => {
    await qaCard(2);
    const albums = sent("sendMediaGroup");
    expect(albums).toHaveLength(1);
    expect(albums[0].body).toMatchObject({
      chat_id: String(CHAT), message_thread_id: "226", files: ["shot0", "shot1"],
      media: [
        { type: "photo", media: "attach://shot0", caption: "https://dev.example.test/p0 · 1440px" },
        { type: "photo", media: "attach://shot1", caption: "https://dev.example.test/p0 · 360px" },
      ],
    });
    expect(sent("sendMessage")).toHaveLength(1);
    const card = qaCardSent();
    expect(card?.body).toMatchObject({
      message_thread_id: 226, parse_mode: "HTML", reply_parameters: { message_id: 900 },
    });
    const text = String(card?.body.text);
    expect(text).toStartWith("🟡 <b>На dev готово: PILOT-900: fe: dark theme toggle on the settings page</b>\n");
    expect(text).toContain(
      `<a href="https://dev.example.test">dev</a> · e2e: ✅ <a href="${QA_E2E}">прогін</a> · <a href="${QA_PR}">PR #42</a>`);
    expect(text).toContain("<b>Що сталося:</b> роботу задеплоєно на dev (коміт 9d8c7b6), e2e зелений.");
    expect(text).toContain("Скриншоти (2) — вище.");
    expect(text).not.toContain("Evidence:");
    expect(text).not.toContain("ok     →");
    expect(keyboard(card)).toEqual([
      { text: "✅ Прийнято", callback_data: "ok" },
      { text: "↩️ Є зауваження", callback_data: "reject" },
    ]);
    expect(lines()).toMatchObject([{ run_id: QA_RUN, kind: "qa-dev", rule: "qa-dev", action: "escalate" }]);
  });

  test("more than 6 shots sends the first 6 and says how many were left out", async () => {
    await qaCard(10);
    const albums = sent("sendMediaGroup");
    expect(albums).toHaveLength(1);
    expect(albums[0].body.media).toHaveLength(6);
    expect(albums[0].body.files).toEqual(["shot0", "shot1", "shot2", "shot3", "shot4", "shot5"]);
    expect(String(qaCardSent()?.body.text))
      .toContain("Скриншоти: надіслано перші 6 з 10, ще 4 не надіслано — вони в артефактах прогону.");
  });

  test("a refused album still sends the card with its buttons", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    fake.failMedia = true;
    try {
      await qaCard(2);
    } finally {
      error.mockRestore();
    }
    const card = qaCardSent();
    expect(String(card?.body.text)).toContain("⚠️ Скриншоти не вдалося надіслати.");
    expect(card?.body.reply_parameters).toBeUndefined();
    expect(keyboard(card).map((b) => b.callback_data)).toEqual(["ok", "reject"]);
    expect(sent("sendMessage")).toHaveLength(1);
  });

  test("ok moves the card to Ready to Release", async () => {
    const db = await qaCard(2);
    press(100, "ok");
    press(100, "ok");
    await poll(db);
    expect(calls).toEqual([[QA_RUN, "ok"]]);
    expect(toasts()).toEqual(["✅ Прийнято", "Це питання вже вирішене"]);
    expect(operatorLines()).toMatchObject([{ run_id: QA_RUN, kind: "qa-dev", action: "ok", evidence: { event_id: QA_EVENT } }]);
    const put = fake.trello.filter((r) => r.method === "PUT");
    expect(put).toEqual([{
      method: "PUT", path: "/1/cards/card-900", body: { idList: "list-rtr" },
      auth: 'OAuth oauth_consumer_key="test-key", oauth_token="test-token"',
    }]);
    const closed = sent("editMessageText");
    expect(closed).toHaveLength(1);
    expect(String(closed[0].body.text))
      .toEndWith("\n\n✅ Вирішено: прийнято (кнопкою)\n🗂 Картку AbCd1234 перенесено в Ready to Release.");
    expect(lines().filter((l) => l.action === "escalate")).toHaveLength(1);
  });

  test("ok finds a card without a link by its number", async () => {
    const db = await qaCard(2, { message: QA_MESSAGE.replace(` ${CARD_LINK}`, "") });
    press(100, "ok");
    await poll(db);
    expect(fake.trello.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /1/boards/board-1/cards", "GET /1/boards/board-1/lists", "PUT /1/cards/card-900",
    ]);
  });

  test.each([
    ["missing", () => join(dir, "missing.env")],
    ["unreadable", () => dir],
  ])("ok whose card move fails escalates (%s Trello env)", async (_, envPath) => {
    const db = await qaCard(2);
    process.env.SDLC_AUTOPILOT_TRELLO_ENV = envPath();
    press(100, "ok");
    await poll(db);
    expect(calls).toEqual([[QA_RUN, "ok"]]);
    expect(fake.trello).toEqual([]);
    expect(lines().at(-1)).toMatchObject({
      run_id: QA_RUN, kind: "qa-dev", rule: "qa-dev-trello", action: "escalate", evidence: { event_id: QA_EVENT },
    });
    expect(lines().at(-1)?.evidence.message).toStartWith("Роботу прийнято, але картку AbCd1234 не перенесено в Ready to Release");
    expect(String(sent("editMessageText")[0].body.text)).toContain("⚠️ Картку не перенесено в Ready to Release");

    await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
    const alert = sent("sendMessage").at(-1);
    expect(String(alert?.body.text)).toStartWith("🟡 <b>Потрібне твоє рішення: PILOT-900:");
    expect(String(alert?.body.text)).toContain("<b>Що сталося:</b> Роботу прийнято, але картку AbCd1234");
    expect(keyboard(alert)).toEqual([]);
    expect(sent("sendMediaGroup")).toHaveLength(1);
  });

  test("reject queues a fix brief linked to the original card", async () => {
    const db = await qaCard(2);
    const brief = join(dir, "queue", "1_mvp_pilot_fe", "fix-PILOT-900-5e6f7a8b.md");
    press(100, "reject");
    await poll(db);
    expect(toasts()).toEqual(["↩️ Напиши відповіддю, що змінити"]);
    expect(prompts()).toHaveLength(1);
    reply("  ", 101);
    await poll(db);
    expect(calls).toEqual([]);
    expect(existsSync(brief)).toBe(false);

    reply("кнопка не видна на 360", 102);
    await poll(db);
    expect(calls).toEqual([[QA_RUN, "reject"]]);
    expect(texts).toEqual(["кнопка не видна на 360"]);
    const text = readFileSync(brief, "utf8");
    expect(text).toStartWith("Fix for PILOT-900: кнопка не видна на 360\n");
    expect(text).toContain(`Trello: ${CARD_LINK.replace("/900-dark-theme-toggle", "")}`);
    expect(text).toContain(`Original PR: ${QA_PR}`);
    expect(text).toContain(`On dev: ${QA_SHA} https://dev.example.test`);
    expect(text).toContain("Paths: src/settings/Theme.tsx\n");
    expect(nextTasks()).toMatchObject([{ card: "PILOT-900", repo: "OlegShevtsov1/1_mvp_pilot_fe", briefFile: brief }]);
    expect(String(sent("editMessageText")[0].body.text)).toEndWith(
      "✅ Вирішено: повернуто на доопрацювання (кнопкою)\n📥 Fix-задачу поставлено в чергу: 1_mvp_pilot_fe/fix-PILOT-900-5e6f7a8b.md");
    expect(lines().filter((l) => l.action === "escalate")).toHaveLength(1);
  });

  test.each([
    ["no task card", { message: QA_MESSAGE.replaceAll("PILOT-900", "fe-900") }, () => {}],
    ["an unwritable queue", {}, () => {
      process.env.SDLC_AUTOPILOT_QUEUE = join(dir, "queue-file");
      writeFileSync(process.env.SDLC_AUTOPILOT_QUEUE, "");
    }],
  ])("reject with %s escalates the operator's text and queues nothing", async (_, options, setup) => {
    const db = await qaCard(2, options);
    setup();
    press(100, "reject");
    await poll(db);
    reply("кнопка не видна на 360", 101);
    await poll(db);
    expect(calls).toEqual([[QA_RUN, "reject"]]);
    expect(existsSync(join(dir, "queue"))).toBe(false);
    const fix = lines().filter((l) => l.rule === "qa-dev-fix");
    expect(fix).toMatchObject([{ run_id: QA_RUN, kind: "qa-dev", action: "escalate", evidence: { event_id: QA_EVENT } }]);
    expect(fix[0].evidence.message).toContain("Текст зауваження: кнопка не видна на 360");
    expect(String(sent("editMessageText")[0].body.text)).toContain("⚠️ Fix-задачу не поставлено в чергу");
  });

  test("a card whose send failed is retried without sending its screenshots again", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    fake.failSend = (body) => String(body.text).startsWith("🟡 <b>На dev готово");
    let db: Database;
    try {
      db = await qaCard(2);
    } finally {
      error.mockRestore();
    }
    expect(sent("sendMediaGroup")).toHaveLength(1);
    fake.failSend = undefined;
    await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
    await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
    expect(sent("sendMediaGroup")).toHaveLength(1);
    const cards = sent("sendMessage").filter((r) => String(r.body.text).startsWith("🟡 <b>На dev готово"));
    expect(cards).toHaveLength(2);
    expect(cards[1].body.reply_parameters).toMatchObject({ message_id: 900 });
    expect(String(cards[1].body.text)).toContain("Скриншоти (2) — вище.");
    expect(keyboard(cards[1]).map((b) => b.callback_data)).toEqual(["ok", "reject"]);
  });

  const outside = () => {
    const path = join(dir, "elsewhere.png");
    writeFileSync(path, new Uint8Array([137, 80, 78, 71]));
    return path;
  };
  test.each<[string, NonNullable<QaOptions["evidence"]>]>([
    ["no qa-dev.json", () => undefined],
    ["a malformed qa-dev.json", () => "{"],
    ["another commit's evidence", (doc) => JSON.stringify({ ...doc, sha: "0".repeat(40) })],
    ["a shot outside the run", (doc) => JSON.stringify({ ...doc, shots: [{ ...doc.shots[0], path: outside() }] })],
    ["a shot linked from outside the run", (doc, runDir) => {
      const path = join(runDir, FILES.shots, "linked.png");
      symlinkSync(outside(), path);
      return JSON.stringify({ ...doc, shots: [{ ...doc.shots[0], path }] });
    }],
    ["a shot that is not a PNG", (doc, runDir) => {
      const path = join(runDir, FILES.shots, "shot.txt");
      writeFileSync(path, "x");
      return JSON.stringify({ ...doc, shots: [{ ...doc.shots[0], path }] });
    }],
  ])("%s sends no screenshots and a card with its buttons", async (_, evidence) => {
    await qaCard(2, { evidence });
    expect(sent("sendMediaGroup")).toEqual([]);
    const card = qaCardSent();
    expect(String(card?.body.text)).toContain("⚠️ Скриншоти не вдалося прочитати.");
    expect(keyboard(card).map((b) => b.callback_data)).toEqual(["ok", "reject"]);
  });
});

describe("telegram", () => {
  test("escalation message says in plain words what the pause needs, with plain buttons", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });

    expect(sent("sendMessage")).toHaveLength(2);
    const postMerge = sentTo("c2154fea");
    expect(postMerge?.body).toMatchObject({ chat_id: String(CHAT), message_thread_id: 226, parse_mode: "HTML" });
    const text = String(postMerge?.body.text);
    expect(text).toStartWith("🟡 <b>Потрібне твоє рішення: post-merge OlegShevtsov1/1_mvp_sdlc</b>\n");
    expect(text).toContain("крок зачіпає твої локальні репозиторії");
    expect(text).toContain("Прогін: post-merge c2154fea · OlegShevtsov1/1_mvp_sdlc");
    expect(text).not.toContain("execute-cycle");
    expect(text).not.toContain("$ARTIFACTS_DIR");
    expect(keyboard(postMerge)).toEqual([
      { text: "✅ Готово", callback_data: "approve" },
      { text: "⏭ Пропустити крок", callback_data: "skip" },
      { text: "⛔ Зупинити", callback_data: "abort" },
    ]);
    expect(keyboard(sentTo("ec459894"))).toEqual([
      { text: "🔁 Чекати ще", callback_data: "retry" },
      { text: "⛔ Зупинити", callback_data: "abort" },
    ]);

    await tick({ db, policy, respond, telegram: realTelegramDeps });
    expect(sent("sendMessage")).toHaveLength(2);
  });

  test("the 8275c6ec A2 pause is sent in plain words", async () => {
    const db = fixtureDb("post-merge-gate-8275c6ec.json");
    const runDir = join(dir, "archon", "workspaces", "OlegShevtsov1", "1_mvp_sdlc", "artifacts", "runs", RELEASE_RUN);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "steps.json"), JSON.stringify({
      steps: Array.from({ length: 10 }, (_, n) => ({ n: String(n), title: `A${n}` })),
    }));
    await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });

    expect(sent("sendMessage")).toHaveLength(1);
    const text = String(sent("sendMessage")[0].body.text);
    expect(text.split("\n").slice(0, 3)).toEqual([
      "🟡 <b>Потрібне твоє рішення: реліз sdlc v0.9.3</b>",
      "Крок 2 з 9: Annotated tag v0.9.3 on the merge commit M",
      '<b>Що сталося:</b> автоматична перевірка дала не те, що очікувалось: GitHub відповів "не знайдено".',
    ]);
    expect(text.match(/потрібне.*рішення/gi)).toHaveLength(1);
    expect(text).not.toContain("execute-cycle");
    expect(text).not.toContain("$ARTIFACTS_DIR");
    expect(keyboard(sent("sendMessage")[0]).map((b) => b.text)).toEqual(["✅ Прийняти", "⏭ Пропустити крок", "⛔ Зупинити"]);
  });

  test("a pause answered outside Telegram closes its message once, without buttons", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const messageId = messageOf("c2154fea");

    insertEvent(db, {
      id: "cli-answer", workflow_run_id: POST_MERGE_RUN, event_order: 349340, event_type: "approval_received",
      step_name: "execute-cycle", data: JSON.stringify({ via: "cli", decision: "skip" }),
    });
    db.query("UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = ?").run(POST_MERGE_RUN);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    await tick({ db, policy, respond, telegram: realTelegramDeps });

    const closed = sent("editMessageText");
    expect(closed).toHaveLength(1);
    expect(closed[0].body).toMatchObject({
      message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: [] },
    });
    expect(String(closed[0].body.text)).toStartWith("🟡 <b>Потрібне твоє рішення:");
    expect(String(closed[0].body.text)).toEndWith("</blockquote>\n\n✅ Вирішено: пропущено (поза Telegram)");
    const state = JSON.parse(readFileSync(join(dir, "state", "telegram.json"), "utf8"));
    expect(Object.values(state.messages).map((m) => (m as { run_id: string }).run_id)).toEqual([INSTALL_RUN]);
  });

  test("a pause answered outside Telegram is closed once when the run pauses again at a later step", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const messageId = messageOf("c2154fea");
    const log = spyOn(console, "log");

    insertEvent(db, {
      id: "cli-answer", workflow_run_id: POST_MERGE_RUN, event_order: 349340, event_type: "approval_received",
      step_name: "execute-cycle", data: JSON.stringify({ via: "cli", decision: "approved" }),
    });
    insertEvent(db, {
      id: "a8-gate", workflow_run_id: POST_MERGE_RUN, event_order: 349400, event_type: "node_suspended",
      step_name: "execute-cycle.gate", data: JSON.stringify({
        node: { id: "gate", kind: "gate" },
        invocation: { loopPath: [{ groupId: "execute-cycle", iteration: 10 }] },
      }),
    });
    insertEvent(db, {
      id: "a8-request", workflow_run_id: POST_MERGE_RUN, event_order: 349401, event_type: "approval_requested",
      step_name: "execute-cycle.gate", data: JSON.stringify({
        message: "post-merge PILOT502 — потрібне рішення оператора.\nКрок: 8 — A8 — Operator, by hand: restart\n" +
          "Тип: checkout\nПричина: Крок A8 звертається до checkout оператора.\n\napprove → виконати крок\n" +
          "skip    → пропустити крок і продовжити\nabort   → зупинити виконання\n",
      }),
    });
    try {
      await tick({ db, policy, respond, telegram: realTelegramDeps });
      await tick({ db, policy, respond, telegram: realTelegramDeps });
      expect(log.mock.calls.flat().join("\n"))
        .toContain(`Telegram message ${messageId} of c2154fea closed: ✅ Вирішено: прийнято (поза Telegram)`);
    } finally {
      log.mockRestore();
    }

    const closed = sent("editMessageText");
    expect(closed).toHaveLength(1);
    expect(closed[0].body).toMatchObject({ message_id: messageId, reply_markup: { inline_keyboard: [] } });
    expect(String(closed[0].body.text)).toEndWith("✅ Вирішено: прийнято (поза Telegram)");
    const again = sent("sendMessage").filter((r) => String(r.body.text).includes("c2154fea"));
    expect(again).toHaveLength(2);
    expect(String(again[1].body.text)).toContain("Крок 8");
    expect(keyboard(again[1]).map((b) => b.text)).toEqual(["✅ Готово", "⏭ Пропустити крок", "⛔ Зупинити"]);
  });

  test("a close that fails on the network is retried once on the next tick", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    insertEvent(db, {
      id: "cli-answer", workflow_run_id: POST_MERGE_RUN, event_order: 349340, event_type: "approval_received",
      step_name: "execute-cycle", data: JSON.stringify({ via: "cli", decision: "skip" }),
    });
    db.query("UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = ?").run(POST_MERGE_RUN);
    const error = spyOn(console, "error").mockImplementation(() => {});
    process.env.SDLC_AUTOPILOT_TELEGRAM_API = "http://localhost:1";
    try {
      await tick({ db, policy, respond, telegram: realTelegramDeps });
    } finally {
      process.env.SDLC_AUTOPILOT_TELEGRAM_API = server.url.origin;
      error.mockRestore();
    }
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    await tick({ db, policy, respond, telegram: realTelegramDeps });

    expect(sent("editMessageText")).toHaveLength(1);
    const state = JSON.parse(readFileSync(join(dir, "state", "telegram.json"), "utf8"));
    expect(Object.values(state.messages).map((m) => (m as { run_id: string }).run_id)).toEqual([INSTALL_RUN]);
  });

  test("a close Telegram refuses is tried once and forgotten; a server error keeps it for the next tick", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id IN (?, ?)")
      .run(POST_MERGE_RUN, INSTALL_RUN);
    const messages = () =>
      Object.keys(JSON.parse(readFileSync(join(dir, "state", "telegram.json"), "utf8")).messages).map(Number).sort();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.failEdit = 500;
      await tick({ db, policy, respond, telegram: realTelegramDeps });
      await tick({ db, policy, respond, telegram: realTelegramDeps });
      expect(sent("editMessageText")).toHaveLength(4);
      expect(messages()).toEqual([100, 101]);

      fake.failEdit = 400;
      for (let i = 0; i < 3; i++) await tick({ db, policy, respond, telegram: realTelegramDeps });
      expect(sent("editMessageText")).toHaveLength(6);
      expect(messages()).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  test("a press whose close failed is closed as answered by button on the next tick", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const messageId = messageOf("c2154fea");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.failEdit = 500;
      press(messageId, "approve");
      await poll(db);
      expect(sent("editMessageText")).toHaveLength(1);
    } finally {
      fake.failEdit = undefined;
      error.mockRestore();
    }
    db.query("UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = ?").run(POST_MERGE_RUN);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    await tick({ db, policy, respond, telegram: realTelegramDeps });

    const closed = sent("editMessageText");
    expect(closed).toHaveLength(2);
    expect(closed[1].body).toMatchObject({ message_id: messageId, reply_markup: { inline_keyboard: [] } });
    expect(String(closed[1].body.text)).toEndWith("✅ Вирішено: продовжено (кнопкою)");
  });

  test("a wait answered outside Telegram closes with the nested decision, not an earlier answer", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const messageId = messageOf("ec459894");

    insertEvent(db, {
      id: "old-answer", workflow_run_id: INSTALL_RUN, event_order: 1, event_type: "approval_received",
      step_name: "install-cycle.install-gate", data: JSON.stringify({ via: "cli", decision: "approved" }),
    });
    insertEvent(db, {
      id: "wait-answer", workflow_run_id: INSTALL_RUN, event_order: 999999, event_type: "wait_answered",
      step_name: "install-cycle.install-gate", data: JSON.stringify({ answer: { decision: "abort" } }),
    });
    db.query("UPDATE remote_agent_workflow_runs SET status = 'running' WHERE id = ?").run(INSTALL_RUN);
    await tick({ db, policy, respond, telegram: realTelegramDeps });

    const closed = sent("editMessageText");
    expect(closed).toHaveLength(1);
    expect(closed[0].body).toMatchObject({ message_id: messageId, reply_markup: { inline_keyboard: [] } });
    expect(String(closed[0].body.text)).toEndWith("✅ Вирішено: зупинено (поза Telegram)");
  });

  test("four presses on one pause respond once and each get a toast", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const messageId = messageOf("c2154fea");
    calls = [];

    for (let i = 0; i < 4; i++) press(messageId, "approve");
    await poll(db);

    expect(calls).toEqual([[POST_MERGE_RUN, "approve"]]);
    expect(operatorLines()).toHaveLength(1);
    expect(operatorLines()[0]).toMatchObject({
      run_id: POST_MERGE_RUN, action: "approve", kind: "post-merge-gate", evidence: { event_id: POST_MERGE_EVENT },
    });
    expect(toasts()).toEqual(["✅ Прийнято, виконую", ...Array(3).fill("Це питання вже вирішене")]);
    const closed = sent("editMessageText");
    expect(closed).toHaveLength(1);
    expect(closed[0].body).toMatchObject({
      message_id: messageId, parse_mode: "HTML", reply_markup: { inline_keyboard: [] },
    });
    expect(String(closed[0].body.text)).toEndWith("\n\n✅ Вирішено: прийнято (кнопкою)");

    press(messageId, "skip");
    await poll(db);
    expect(toasts().at(-1)).toBe("Це питання вже вирішене");
    expect(calls).toHaveLength(1);
    expect(operatorLines()).toHaveLength(1);
  });

  test("a press on a pause that moved on or closed is already resolved, and its message is closed once", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const postMergeMessage = messageOf("c2154fea");
    const installMessage = messageOf("ec459894");
    calls = [];

    db.query("UPDATE remote_agent_workflow_events SET id = 'later-pause' WHERE id = ?").run(POST_MERGE_EVENT);
    db.query("UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = ?").run(INSTALL_RUN);
    press(postMergeMessage, "approve");
    press(installMessage, "abort");
    await poll(db);

    expect(calls).toEqual([]);
    expect(operatorLines()).toEqual([]);
    expect(toasts()).toEqual(["Це питання вже вирішене", "Це питання вже вирішене"]);
    expect(sent("editMessageText")).toEqual([]);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const closed = sent("editMessageText");
    expect(closed.map((r) => r.body.message_id).sort()).toEqual([postMergeMessage, installMessage].sort());
    for (const r of closed) {
      expect(String(r.body.text)).toEndWith("✅ Вирішено: продовжено (поза Telegram)");
      expect(r.body.reply_markup).toEqual({ inline_keyboard: [] });
    }
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    expect(sent("editMessageText")).toHaveLength(2);
  });

  test("a press whose state cannot be read is still answered, and a later press acts", async () => {
    const error = spyOn(console, "error");
    try {
      const db = fixtureDb(...FIXTURES);
      await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
      const messageId = messageOf("c2154fea");
      calls = [];
      const runs = () => {
        throw new Error("database is locked");
      };

      press(messageId, "approve");
      await listen({ runs, respond, telegram: realTelegramDeps, status: () => "", pollSeconds: 0 });
      expect(toasts()).toEqual(["⚠️ Не вдалося прочитати стан — натисніть ще раз"]);
      expect(calls).toEqual([]);
      expect(sent("editMessageText")).toEqual([]);
      expect(JSON.stringify(error.mock.calls)).toContain("database is locked");

      press(messageId, "approve");
      await poll(db);
      expect(toasts().at(-1)).toBe("✅ Прийнято, виконую");
      expect(calls).toEqual([[POST_MERGE_RUN, "approve"]]);
    } finally {
      error.mockRestore();
    }
  });

  test("a press the pause does not declare, or on another message, is not answered", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const installMessage = messageOf("ec459894");
    calls = [];

    press(installMessage, "approve");
    press(9999, "retry");
    await poll(db);
    expect(calls).toEqual([]);
    expect(operatorLines()).toEqual([]);
    expect(toasts()).toEqual(["Кнопка вже не діє", "Це питання вже вирішене"]);
  });

  test("a respond that fails escalates again with the pause's buttons", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const installMessage = messageOf("ec459894");

    press(installMessage, "abort");
    const failing = () => {
      throw new Error("spawn failed");
    };
    await poll(db, failing);
    expect(toasts()).toEqual(["⛔ Зупиняю"]);
    expect(operatorLines()).toMatchObject([{ run_id: INSTALL_RUN, action: "escalate" }]);
    expect(operatorLines()[0].evidence.message).toContain("spawn failed");
    expect(String(sent("editMessageText")[0]?.body.text)).toEndWith("❌ Не вдалося виконати відповідь — надіслано нове повідомлення.");
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    expect(sent("sendMessage")).toHaveLength(3);
    expect(keyboard(sent("sendMessage")[2]).map((b) => b.callback_data)).toEqual(["retry", "abort"]);

    calls = [];
    press(nextMessageId - 1, "abort");
    await poll(db);
    expect(calls).toEqual([[INSTALL_RUN, "abort"]]);
  });

  test("foreign chat id is ignored", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const before = fake.requests.length;
    calls = [];

    press(messageOf("c2154fea"), "approve", -999);
    say("/status", -999);
    await poll(db);

    expect(calls).toEqual([]);
    expect(operatorLines()).toEqual([]);
    expect(fake.requests.slice(before).map((r) => r.method)).toEqual(["getUpdates"]);
    await poll(db);
    expect(sent("getUpdates").at(-1)?.body.offset).toBe(3);
  });

  test("/status lists running, waiting-for-operator, queued and next", async () => {
    const db = fixtureDb(...FIXTURES);
    const running = "5e5e5e5e-0000-4000-8000-5e5e5e5e5e5e";
    insertRun(db, {
      id: running, workflow_name: "factory", user_message: "Build PILOT-650\nsecond line", status: "running",
      working_path: join(dir, "archon", "workspaces", "OlegShevtsov1", "1_mvp_sdlc", "worktrees", "archon", "task-1"),
    });
    for (const repo of ["1_mvp_sdlc", "1_mvp_prompt"]) {
      mkdirSync(join(dir, "archon", "workspaces", "OlegShevtsov1", repo, "source"), { recursive: true });
    }
    mkdirSync(join(dir, "queue", "1_mvp_prompt"), { recursive: true });
    mkdirSync(join(dir, "queue", "1_mvp_sdlc"), { recursive: true });
    writeFileSync(join(dir, "queue", "1_mvp_prompt", "PILOT-700.md"), "PILOT-700 docs/a.md\n");
    writeFileSync(join(dir, "queue", "1_mvp_sdlc", "PILOT-701.md"), "PILOT-701 src/b.ts\n");
    const launches: string[][] = [];
    const queue: QueueDeps = { launch: (argv) => void launches.push(argv), host: () => ({ memAvailableMb: 8000, load1: 99 }) };
    const policy = loadPolicy(POLICY);
    const open = await tick({ db, policy, respond, queue, telegram: realTelegramDeps });
    const before = sent("sendMessage").length;

    say("/status@mvp_vpn_alerts_bot");
    await listen({
      runs: runsOf(db), respond, telegram: realTelegramDeps, status: () => digest(open, nextTasks()), pollSeconds: 0,
    });

    expect(launches).toEqual([]);
    const replies = sent("sendMessage").slice(before);
    expect(replies).toHaveLength(1);
    const status = String(replies[0].body.text);
    const part = (from: string, to: string) => status.slice(status.indexOf(from), status.indexOf(to));
    expect(part("Йдуть", "Чекають")).toContain("factory 5e5e5e5e OlegShevtsov1/1_mvp_sdlc Build PILOT-650");
    expect(part("Йдуть", "Чекають")).not.toContain("second line");
    expect(part("Чекають оператора (2)", "У черзі")).toContain("c2154fea execute-cycle.gate");
    expect(part("Чекають оператора (2)", "У черзі")).toContain("ec459894 install-cycle.install-gate");
    expect(part("У черзі (2)", "Далі")).toContain("PILOT-701 1_mvp_sdlc/PILOT-701.md");
    expect(part("У черзі (2)", "Далі")).toContain("PILOT-700 1_mvp_prompt/PILOT-700.md");
    expect(status).toContain("Далі: PILOT-701 1_mvp_sdlc/PILOT-701.md");

    expect(digest([], [])).toBe([
      "sdlc-autopilot — статус", "Йдуть (0):", "—", "Чекають оператора (0):", "—", "У черзі (0):", "—",
      "Далі: черга порожня",
    ].join("\n"));
  });

  test("a press is answered within 2 s while the tick sleeps", async () => {
    const db = fixtureDb(...FIXTURES);
    await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
    const messageId = messageOf("c2154fea");
    calls = [];
    let stopped = false;
    const deadline = spyOn(AbortSignal, "timeout");
    const loop = listenLoop({
      runs: runsOf(db), respond, telegram: realTelegramDeps, status: () => "", stop: () => stopped,
    });

    await until(() => fake.waiters.length > 0);
    const pressed = Date.now();
    press(messageId, "approve");
    await until(() => sent("answerCallbackQuery").length > 0);
    expect(Date.now() - pressed).toBeLessThan(2000);
    expect(toasts()).toEqual(["✅ Прийнято, виконую"]);
    await until(() => sent("editMessageText").length > 0);
    expect(calls).toEqual([[POST_MERGE_RUN, "approve"]]);

    stopped = true;
    await until(() => fake.waiters.length > 0);
    wake();
    await loop;
    expect(sent("getUpdates").every((r) => r.body.timeout === 25)).toBe(true);
    // A quiet poll is held 25 s by Telegram, so its HTTP deadline must outlast it.
    expect(Math.max(...deadline.mock.calls.map(([ms]) => ms))).toBeGreaterThan(25_000);
    deadline.mockRestore();
  });

  test("a long-poll error backs off 5 s, 15 s, 60 s and keeps the token out", async () => {
    const error = spyOn(console, "error");
    try {
      const db = fixtureDb(...FIXTURES);
      fake.failWith = { ok: false, error_code: 401, description: "Unauthorized" };
      const waits: number[] = [];
      const sleep = async (ms: number) => void waits.push(ms);
      const deps = { runs: runsOf(db), respond, telegram: realTelegramDeps, status: () => "", pollSeconds: 0, sleep };
      await listenLoop({ ...deps, stop: () => waits.length >= 4 });
      expect(waits).toEqual([5000, 15000, 60000, 60000]);

      fake.failWith = undefined;
      let polls = sent("getUpdates").length;
      await listenLoop({ ...deps, stop: () => sent("getUpdates").length > polls });
      fake.failWith = { ok: false, error_code: 401, description: "Unauthorized" };
      polls = waits.length;
      await listenLoop({ ...deps, stop: () => waits.length > polls });
      expect(waits.at(-1)).toBe(5000);

      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain("Telegram updates: Telegram getUpdates: HTTP 401 Unauthorized; next try in 5 s");
      expect(logged).not.toContain(TOKEN);
    } finally {
      error.mockRestore();
    }
  });

  test("token never appears in ledger or logs", async () => {
    const log = spyOn(console, "log");
    const error = spyOn(console, "error");
    try {
      const db = fixtureDb(...FIXTURES);
      const policy = loadPolicy(POLICY);
      await tick({ db, policy, respond, telegram: realTelegramDeps });
      press(messageOf("c2154fea"), "approve");
      await poll(db);

      rmSync(join(dir, "state", "telegram.json"));
      process.env.SDLC_AUTOPILOT_TELEGRAM_API = "http://localhost:1";
      await tick({ db, policy, respond, telegram: realTelegramDeps });
      process.env.SDLC_AUTOPILOT_TELEGRAM_API = server.url.origin;
      fake.failWith = { ok: false, error_code: 401, description: "Unauthorized" };
      await tick({ db, policy, respond, telegram: realTelegramDeps });

      const logged = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      expect(error.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(logged).toContain("Telegram sendMessage: HTTP 401 Unauthorized");
      expect(logged).toContain("Telegram sendMessage: Unable to connect");
      expect(logged).not.toContain(TOKEN);
      expect(readFileSync(ledger, "utf8")).not.toContain(TOKEN);
      expect(readFileSync(join(dir, "state", "telegram.json"), "utf8")).not.toContain(TOKEN);
      expect(JSON.stringify(fake.requests.map((r) => r.body))).not.toContain(TOKEN);
      expect(fake.requests.every((r) => r.token === TOKEN)).toBe(true);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test("without the bot's variables nothing is sent", async () => {
    process.env.SDLC_AUTOPILOT_TELEGRAM_ENV = join(dir, "missing.env");
    const db = fixtureDb(...FIXTURES);
    await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
    expect(await poll(db)).toBe(false);
    expect(fake.requests).toEqual([]);
    expect(lines()).toHaveLength(3);
  });
});

describe("/task", () => {
  test("empty or foreign task is ignored with a hint", async () => {
    const db = fixtureDb();
    const listenTask = () => listen({
      runs: runsOf(db), respond, telegram: realTelegramDeps, status: () => "", task: (t) => taskCommand(t), pollSeconds: 0,
    });
    const asked = ["/task", "/task qa x", "/task be"].map((t) => say(t));
    await listenTask();
    const replies = sent("sendMessage");
    expect(replies.map((r) => r.body.text)).toEqual([HINT, HINT, HINT]);
    expect(replies.map((r) => (r.body.reply_parameters as { message_id: number }).message_id)).toEqual(asked);
    expect(fake.trello).toEqual([]);

    say("/task be Додати темну тему", -999);
    await listenTask();
    expect(sent("sendMessage")).toHaveLength(3);
    expect(fake.trello).toEqual([]);
    await listenTask();
    expect(sent("getUpdates").at(-1)?.body.offset).toBe(5);

    say("/task@mvp_vpn_alerts_bot");
    await listen({ runs: runsOf(db), respond, telegram: realTelegramDeps, status: () => "", pollSeconds: 0 });
    expect(sent("sendMessage").at(-1)?.body.text).toBe(HINT);

    say("/task be Додати темну тему");
    await listen({
      runs: runsOf(db), respond, telegram: realTelegramDeps, status: () => "", pollSeconds: 0,
      task: async () => { throw new Error("stages.json: EACCES"); },
    });
    expect(sent("sendMessage").at(-1)?.body.text).toBe("⚠️ /task не виконано: stages.json: EACCES");
  });

  test("a green stage PR is sent as a PR card with Approve and Return", async () => {
    const source = join(dir, "archon", "workspaces", "OlegShevtsov1", "1_mvp_pilot_be", "source");
    mkdirSync(join(source, ".archon"), { recursive: true });
    writeFileSync(join(source, ".archon", "factory-profile.yaml"), "repo:\n  base_branch: develop\n");
    const pr = "https://github.com/OlegShevtsov1/1_mvp_pilot_be/pull/77";
    const head = "1111111111111111111111111111111111111111";
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "stages.json"), JSON.stringify({ chains: { "PILOT-901": {
      card: "PILOT-901", cardId: "c", slug: "t901", kind: "be", text: "x", stage: "prd", attempt: 1, state: "review", pr,
      branch: "feature/PILOT-901-t901-prd", created: "2026-11-02T00:00:00Z",
    } } }));
    const ran: string[][] = [];
    const intake: IntakeDeps = {
      exec: (argv) => {
        ran.push(argv);
        const out = argv[2] === "view"
          ? { state: "OPEN", headRefOid: head, title: "PILOT-901: t901: Темна тема — prd", body: "Type: docs\nPRD of t901.", changedFiles: 1, additions: 9, deletions: 0, labels: [] }
          : argv[2] === "checks" ? [{ name: "ci", bucket: "pass" }] : "";
        return { code: 0, stdout: JSON.stringify(out), stderr: "" };
      },
    };
    const db = fixtureDb();
    await tick({ db, policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps, intake });

    const card = sent("sendMessage")[0];
    expect(String(card.body.text)).toStartWith("🟡 <b>PR готовий: PILOT-901: t901: Темна тема — prd</b>\n");
    expect(String(card.body.text)).toContain(`<a href="${pr}">PR #77</a> · Diff: 1 файл, +9 −0 · Checks: 1 ✅`);
    expect(keyboard(card).map((b) => b.callback_data)).toEqual(["approve", "reject"]);
    expect(lines()).toMatchObject([{ run_id: "stage:PILOT-901/prd", workflow: "sdlc-stage", kind: "pr-approve", rule: "pr-approve" }]);

    press(100, "approve");
    await listen({
      runs: () => [...runsOf(db)(), ...stageViews()], respond: (run, d) => respondStage(run, d, intake),
      telegram: realTelegramDeps, status: () => "", pollSeconds: 0,
    });
    expect(ran.filter((a) => a[2] === "merge")).toEqual([["gh", "pr", "merge", pr, "--squash", "--match-head-commit", head]]);
    expect(existsSync(join(dir, "queue", "1_mvp_pilot_be", "sdlc-stage.PILOT-901.architecture.1.md"))).toBe(true);
    expect(String(sent("editMessageText")[0].body.text))
      .toEndWith("✅ Вирішено: прийнято (кнопкою)\n📥 Наступна стадія architecture у черзі 1_mvp_pilot_be.");
  });
});
