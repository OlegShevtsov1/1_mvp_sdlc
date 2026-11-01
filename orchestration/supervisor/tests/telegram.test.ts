import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../src/act.ts";
import type { LedgerEntry } from "../src/ledger.ts";
import { loadPolicy, tick } from "../src/main.ts";
import type { QueueDeps } from "../src/queue.ts";
import type { RunView } from "../src/runs.ts";
import { digest, realTelegramDeps } from "../src/telegram.ts";
import { FIXTURES, fixtureDb, insertRun } from "./fixtures/db.ts";

const POLICY = join(import.meta.dir, "..", "policy.yaml");
// Built from parts so secret scanners do not take the fake for a real bot token.
const TOKEN = ["123456", "TESTtokenSECRETabc123XYZ_-q9w8e7r6t5"].join(":");
const CHAT = -1001;
const POST_MERGE_RUN = "c2154fea-2e08-4385-8589-d413204db098";
const POST_MERGE_EVENT = "d13280fe-8b0d-4de6-a014-87abfce50625";
const INSTALL_RUN = "ec459894-e870-46d3-a37a-bed2af487528";

type Request = { method: string; token: string; body: Record<string, unknown> };
type Fake = { requests: Request[]; updates: Record<string, unknown>[]; failWith?: Record<string, unknown> };

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
  fake = { requests: [], updates: [] };
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const [, token, method] = new URL(req.url).pathname.match(/^\/bot([^/]+)\/(\w+)$/) ?? [];
      const body = (await req.json()) as Record<string, unknown>;
      fake.requests.push({ method, token, body });
      if (fake.failWith) return Response.json(fake.failWith, { status: 401 });
      if (method === "getUpdates") {
        const offset = Number(body.offset);
        return Response.json({ ok: true, result: fake.updates.filter((u) => Number(u.update_id) >= offset) });
      }
      if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: nextMessageId++ } });
      return Response.json({ ok: true, result: true });
    },
  });
  process.env.SDLC_AUTOPILOT_TELEGRAM_API = server.url.origin;
});

afterEach(() => {
  server.stop(true);
});

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
}

function say(text: string, chat = CHAT): void {
  fake.updates.push({ update_id: nextUpdateId++, message: { chat: { id: chat }, text } });
}

const operatorLines = () => lines().filter((l) => l.rule === "operator");

describe("telegram", () => {
  test("escalation message names run, step, reason and has the pause's own buttons", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });

    expect(sent("sendMessage")).toHaveLength(2);
    const postMerge = sentTo("c2154fea");
    expect(postMerge?.body).toMatchObject({ chat_id: String(CHAT), message_thread_id: 226 });
    expect(postMerge?.body.parse_mode).toBeUndefined();
    const text = String(postMerge?.body.text);
    expect(text).toContain("Прогін: post-merge c2154fea OlegShevtsov1/1_mvp_sdlc");
    expect(text).toContain("Крок: execute-cycle.gate");
    expect(text).toContain("схвалює лише оператор");
    expect(keyboard(postMerge)).toEqual([
      { text: "Approve — виконати/прийняти", callback_data: "approve" },
      { text: "Skip — пропустити крок", callback_data: "skip" },
      { text: "Abort — зупинити", callback_data: "abort" },
    ]);
    expect(keyboard(sentTo("ec459894")).map((b) => b.callback_data)).toEqual(["retry", "abort"]);

    await tick({ db, policy, respond, telegram: realTelegramDeps });
    expect(sent("sendMessage")).toHaveLength(2);
  });

  test("button press responds to the matching run and pause once", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const messageId = messageOf("c2154fea");
    calls = [];

    press(messageId, "approve");
    press(messageId, "approve");
    await tick({ db, policy, respond, telegram: realTelegramDeps });

    expect(calls).toEqual([[POST_MERGE_RUN, "approve"]]);
    expect(operatorLines()).toHaveLength(1);
    expect(operatorLines()[0]).toMatchObject({
      run_id: POST_MERGE_RUN, action: "approve", kind: "post-merge-gate", evidence: { event_id: POST_MERGE_EVENT },
    });
    expect(sent("answerCallbackQuery")).toHaveLength(2);
    const closed = sent("editMessageText");
    expect(closed).toHaveLength(1);
    expect(closed[0].body).toMatchObject({ message_id: messageId, reply_markup: { inline_keyboard: [] } });
    expect(String(closed[0].body.text)).toContain("✅ Оператор: Approve — виконати/прийняти");

    press(messageId, "skip");
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    expect(calls).toHaveLength(1);
    expect(operatorLines()).toHaveLength(1);
  });

  test("a press on a pause that moved on or closed is not answered", async () => {
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
    await tick({ db, policy, respond, telegram: realTelegramDeps });

    expect(calls).toEqual([]);
    expect(operatorLines()).toEqual([]);
    const closed = sent("editMessageText");
    expect(closed.map((r) => r.body.message_id)).toEqual([postMergeMessage, installMessage]);
    for (const r of closed) expect(String(r.body.text)).toContain("Пауза вже не відкрита.");
  });

  test("a press the pause does not declare, or on another message, is not answered", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    const installMessage = messageOf("ec459894");
    calls = [];

    press(installMessage, "approve");
    press(9999, "retry");
    await tick({ db, policy, respond, telegram: realTelegramDeps });
    expect(calls).toEqual([]);
    expect(operatorLines()).toEqual([]);
    expect(sent("answerCallbackQuery").map((r) => r.body.text)).toEqual(["Кнопка вже не діє", "Кнопка вже не діє"]);
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
    await tick({ db, policy, respond: failing, telegram: realTelegramDeps });
    expect(operatorLines()).toMatchObject([{ run_id: INSTALL_RUN, action: "escalate" }]);
    expect(operatorLines()[0].evidence.message).toContain("spawn failed");
    expect(sent("sendMessage")).toHaveLength(3);
    expect(keyboard(sent("sendMessage")[2]).map((b) => b.callback_data)).toEqual(["retry", "abort"]);

    calls = [];
    press(nextMessageId - 1, "abort");
    await tick({ db, policy, respond, telegram: realTelegramDeps });
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
    await tick({ db, policy, respond, telegram: realTelegramDeps });

    expect(calls).toEqual([]);
    expect(operatorLines()).toEqual([]);
    expect(fake.requests.slice(before).map((r) => r.method)).toEqual(["getUpdates"]);
    await tick({ db, policy, respond, telegram: realTelegramDeps });
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
    await tick({ db, policy, respond, queue, telegram: realTelegramDeps });
    const before = sent("sendMessage").length;

    say("/status@mvp_vpn_alerts_bot");
    await tick({ db, policy, respond, queue, telegram: realTelegramDeps });

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

  test("token never appears in ledger or logs", async () => {
    const log = spyOn(console, "log");
    const error = spyOn(console, "error");
    try {
      const db = fixtureDb(...FIXTURES);
      const policy = loadPolicy(POLICY);
      await tick({ db, policy, respond, telegram: realTelegramDeps });
      press(messageOf("c2154fea"), "approve");
      await tick({ db, policy, respond, telegram: realTelegramDeps });

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
    await tick({ db: fixtureDb(...FIXTURES), policy: loadPolicy(POLICY), respond, telegram: realTelegramDeps });
    expect(fake.requests).toEqual([]);
    expect(lines()).toHaveLength(3);
  });
});
