import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/act.ts";
import type { LedgerEntry } from "../src/ledger.ts";
import { listen, listenLoop, loadPolicy, tick } from "../src/main.ts";
import { nextTasks, type QueueDeps } from "../src/queue.ts";
import { readRuns, type RunView } from "../src/runs.ts";
import { digest, realTelegramDeps } from "../src/telegram.ts";
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
type Fake = {
  requests: Request[];
  updates: Record<string, unknown>[];
  failWith?: Record<string, unknown>;
  // Resolved when an update is pushed: a held getUpdates answers then, as Telegram's long polling does.
  waiters: (() => void)[];
};

let dir: string;
let ledger: string;
let fake: Fake;
let server: ReturnType<typeof Bun.serve>;
let calls: [string, Decision["action"]][];
let nextMessageId: number;
let nextUpdateId: number;
const respond = (run: RunView, d: Decision) => void calls.push([run.id, d.action]);

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
  calls = [];
  nextMessageId = 100;
  nextUpdateId = 1;
  fake = { requests: [], updates: [], waiters: [] };
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const [, token, method] = new URL(req.url).pathname.match(/^\/bot([^/]+)\/(\w+)$/) ?? [];
      const body = (await req.json()) as Record<string, unknown>;
      fake.requests.push({ method, token, body });
      if (fake.failWith) return Response.json(fake.failWith, { status: 401 });
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
      return Response.json({ ok: true, result: true });
    },
  });
  process.env.SDLC_AUTOPILOT_TELEGRAM_API = server.url.origin;
});

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

function say(text: string, chat = CHAT): void {
  fake.updates.push({ update_id: nextUpdateId++, message: { chat: { id: chat }, text } });
  wake();
}

const runsOf = (db: Database) => () => readRuns(db, 14 * 24);
const poll = (db: Database, r: (run: RunView, d: Decision) => void = respond) =>
  listen({ runs: runsOf(db), respond: r, telegram: realTelegramDeps, status: () => "", pollSeconds: 0 });
const toasts = () => sent("answerCallbackQuery").map((r) => r.body.text);

async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(10);
}

const operatorLines = () => lines().filter((l) => l.rule === "operator");

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
