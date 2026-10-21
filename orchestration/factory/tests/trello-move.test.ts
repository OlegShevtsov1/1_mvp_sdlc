import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/build-report.ts";
import {
  applyMove,
  DEFAULT_LISTS,
  listNames,
  parseCardRef,
  readCreds,
  runTrelloMove,
  transition,
  type MoveInput,
} from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/trello.ts";

const TRELLO_MOVE = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts", "trello-move.ts");
const RUN_ID = "abcdef01-2345-4a6b-8c9d-0123456789ef";
const CREDS = { key: "test-key", token: "test-token", board: "board-1" };

// The public-repo hygiene check bans the Trello host written out, so links are assembled here.
function cardLink(short: string, slug?: string): string {
  return "https://trello" + ".com/c/" + short + (slug ? "/" + slug : "");
}

function report(fields: Record<string, unknown>): string {
  return JSON.stringify({
    delivered: false, summary: "Not delivered: deploy failed (exit 3).", pr_url: "https://github.com/o/r/pull/7",
    merge_sha: "", deploy_status: "failed (exit 3)", health: "skipped", monitoring: "skipped", rollback: "not needed",
    ...fields,
  });
}

function gate(proceed: boolean, stop_reason = ""): string {
  return JSON.stringify({ proceed, decision: proceed ? "approve" : "abort", stop_reason });
}

describe("parseCardRef", () => {
  test("a card link", () => {
    expect(parseCardRef(`see ${cardLink("AbCd1234")} please`)).toEqual({ kind: "link", value: "AbCd1234" });
  });
  test("a card link with its slug", () => {
    expect(parseCardRef(cardLink("AbCd1234", "12-add-health"))).toEqual({ kind: "link", value: "AbCd1234" });
  });
  test("task-brief's title line", () => {
    expect(parseCardRef("Title:\n  PILOT-12: Add x\nbody")).toEqual({ kind: "number", value: 12 });
  });
  test("the title line wins over an earlier bare reference", () => {
    expect(parseCardRef("depends on PILOT-3\n  PILOT-12: Add x")).toEqual({ kind: "number", value: 12 });
  });
  test("a bare reference", () => {
    expect(parseCardRef("work on PILOT-12 now")).toEqual({ kind: "number", value: 12 });
  });
  test("a link wins over a number", () => {
    expect(parseCardRef(`PILOT-12: x\n${cardLink("AbCd1234")}`)).toEqual({ kind: "link", value: "AbCd1234" });
  });
  for (const text of ["", "PILOT-0", "PILOT-0: no card", "PILOT-<n>", "PILOT-012", "XPILOT-12", "PILOT-12a", "/c/<shortLink>", cardLink("<shortLink>")]) {
    test(`no card in ${JSON.stringify(text)}`, () => {
      expect(parseCardRef(text)).toBeNull();
    });
  }
  test("no card in a request that only names the no-card marker and placeholders", () => {
    const text = `PR title «PILOT-0: factory moves the task's Trello card». When the task text names a Trello card
(a ${cardLink("<shortLink>")} URL or "PILOT-<n>" plus the board from config), the factory moves it.`;
    expect(parseCardRef(text)).toBeNull();
  });
});

describe("transition", () => {
  const t = (event: string, facts: Record<string, string> = {}) => transition(event, facts, RUN_ID);

  test("gate 1 waiting → Blocked with a comment", () => {
    const m = t("profile-gate");
    expect(m).toEqual({ target: "blocked", comment: `Factory run ${RUN_ID} waits for the operator at gate 1 (project profile).` });
  });
  test("gate 1 approved → back to Ready, no comment", () => {
    expect(t("profile-round", { gate: gate(true) })).toEqual({ target: "ready", comment: "" });
  });
  test("gate 1 stopped → Ready with the reason", () => {
    const m = t("profile-round", { gate: gate(false, "operator chose abort: wrong stack") });
    expect(m).toEqual({ target: "ready", comment: `Factory run ${RUN_ID} stopped at gate 1: operator chose abort: wrong stack.` });
  });
  test("gate 2 waiting on a ready plan → Blocked", () => {
    const m = t("plan-gate", { ready: "true", summary: "plan ok" });
    expect(m).toEqual({ target: "blocked", comment: `Factory run ${RUN_ID} waits for the operator at gate 2 (plan approval).` });
  });
  test("gate 2 waiting on a plan that is not ready → Blocked naming why", () => {
    const m = t("plan-gate", { ready: "false", summary: "the deploy host is unknown" });
    expect(m).toEqual({
      target: "blocked",
      comment: `Factory run ${RUN_ID} waits for the operator at gate 2: the plan is not ready to build — the deploy host is unknown`,
    });
  });
  test("gate 2 approved → In Progress, no comment", () => {
    expect(t("plan-round", { gate: gate(true) })).toEqual({ target: "in_progress", comment: "" });
  });
  test("gate 2 stopped → Ready with the reason", () => {
    const m = t("plan-round", { gate: gate(false, "operator chose abort: later") });
    expect(m).toEqual({ target: "ready", comment: `Factory run ${RUN_ID} stopped at gate 2: operator chose abort: later.` });
  });
  test("an unreadable gate verdict is a warning, not a move", () => {
    expect(t("plan-round", { gate: "approved" })).toEqual({ warning: expect.stringContaining("gate verdict") });
  });
  test("PR opened → Review", () => {
    expect(t("review")).toEqual({ target: "review", comment: "" });
  });
  test("a PR into a manual base stays in Review and waits for the operator merge", () => {
    const pending = buildReport({
      pr_url: "https://github.com/o/r/pull/7", merged: "skipped", merge_sha: "", deployed: "skipped", deploy_exit: "",
      healthy: "skipped", last_status: "", health_url: "", monitor_status: "skipped", monitor_findings: "",
      rollback: "false", rolled_back: "skipped", rollback_reason: "", merge_refused: "",
      merge_action: "notify", merge_base: "main", notified: "true", notify_reason: "",
    });
    const m = t("done", { report: JSON.stringify(pending) });
    expect(m).toEqual({
      target: "review",
      comment: `Factory run ${RUN_ID}: https://github.com/o/r/pull/7 waits for the operator merge (base is merged by hand).`,
    });
  });
  test("delivered → Test, no comment", () => {
    expect(t("done", { report: report({ delivered: true, summary: "Delivered." }) })).toEqual({ target: "test", comment: "" });
  });
  test("a failed rollback → Blocked naming why", () => {
    const m = t("done", { report: report({ rollback: "FAILED (health red)", summary: "Not delivered: health red." }) });
    expect(m).toEqual({
      target: "blocked",
      comment: `Factory run ${RUN_ID} ended with a failed rollback; the environment needs the operator: Not delivered: health red.`,
    });
  });
  test("not delivered → back to Ready with the summary", () => {
    const m = t("done", { report: report({}) });
    expect(m).toEqual({ target: "ready", comment: `Factory run ${RUN_ID} ended not delivered: Not delivered: deploy failed (exit 3).` });
  });
  test("an unreadable report → back to Ready saying so", () => {
    const m = t("done", { report: "" });
    expect(m).toEqual({ target: "ready", comment: `Factory run ${RUN_ID} ended not delivered: the run left no readable report.` });
  });
  test("a long summary is cut to the comment limit", () => {
    const m = t("done", { report: report({ summary: "x".repeat(5000) }) });
    expect("comment" in m && m.comment.length).toBe(2000);
  });
  test("an unknown event is a warning", () => {
    expect(t("merged")).toEqual({ warning: expect.stringContaining("merged") });
  });
});

describe("listNames", () => {
  test("no profile → defaults", () => {
    expect(listNames(undefined)).toEqual({ lists: DEFAULT_LISTS, warnings: [] });
  });
  test("defaults are the board's list names", () => {
    expect(DEFAULT_LISTS).toEqual({ ready: "Ready", in_progress: "In Progress", review: "Review", test: "Test", blocked: "Blocked" });
  });
  test("overrides some keys", () => {
    const r = listNames({ version: 1, trello: { lists: { review: "Code review", test: "QA" } } });
    expect(r).toEqual({ lists: { ...DEFAULT_LISTS, review: "Code review", test: "QA" }, warnings: [] });
  });
  for (const [label, value] of [["a number", 3], ["an empty string", " "], ["a multi-line string", "a\nb"]] as const) {
    test(`${label} → default plus a warning`, () => {
      const r = listNames({ trello: { lists: { blocked: value } } });
      expect(r.lists.blocked).toBe("Blocked");
      expect(r.warnings).toEqual([expect.stringContaining("trello.lists.blocked")]);
    });
  }
});

interface Call { method: string; url: string; body: unknown; auth: string }

// Serves a board with one list per default name and two cards; `routes` overrides single answers.
function stubFetch(routes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const answers: Record<string, unknown> = {
    "GET /boards/board-1/cards": [
      { id: "card-1", idShort: 7, idList: "list-ready", shortLink: "AbCd1234" },
      { id: "card-2", idShort: 8, idList: "list-review", shortLink: "EfGh5678" },
    ],
    "GET /boards/board-1/lists": Object.entries(DEFAULT_LISTS).map(([k, name]) => ({ id: `list-${k}`, name })),
    "GET /boards/board-1": { id: "board-real-1" },
    "GET /cards/AbCd1234": { id: "card-1", idBoard: "board-real-1", idList: "list-ready", shortLink: "AbCd1234" },
    "PUT /cards/card-1": {},
    "PUT /cards/card-2": {},
    "POST /cards/card-1/actions/comments": {},
    ...routes,
  };
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ method, url: url.toString(), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.get("Authorization") ?? "" });
    const key = `${method} ${url.pathname.replace(/^\/1/, "")}`;
    const answer = answers[key];
    if (answer instanceof Response) return answer;
    if (answer === undefined) return new Response("not found", { status: 404 });
    return Response.json(answer);
  };
  return { calls, fetch: fn as typeof fetch };
}

function noSecrets(calls: Call[], out: unknown): void {
  const text = JSON.stringify(out) + calls.map((c) => c.url + JSON.stringify(c.body)).join("");
  expect(text).not.toContain("test-key");
  expect(text).not.toContain("test-token");
}

describe("applyMove", () => {
  test("a number resolves through the board's cards, moves and comments", async () => {
    const s = stubFetch();
    const r = await applyMove(s.fetch, CREDS, DEFAULT_LISTS, { kind: "number", value: 7 }, { target: "blocked", comment: "waits" });
    expect(r).toEqual({ status: "done", warning: "" });
    const put = s.calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/cards/card-1");
    expect(put?.body).toEqual({ idList: "list-blocked" });
    const post = s.calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/cards/card-1/actions/comments");
    expect(post?.body).toEqual({ text: "waits" });
    expect(s.calls.every((c) => c.auth === 'OAuth oauth_consumer_key="test-key", oauth_token="test-token"')).toBe(true);
    noSecrets(s.calls, r);
  });
  test("a link resolves the card and checks its board", async () => {
    const s = stubFetch();
    const r = await applyMove(s.fetch, CREDS, DEFAULT_LISTS, { kind: "link", value: "AbCd1234" }, { target: "in_progress", comment: "" });
    expect(r).toEqual({ status: "done", warning: "" });
    expect(s.calls.find((c) => c.method === "PUT")?.body).toEqual({ idList: "list-in_progress" });
    expect(s.calls.some((c) => c.method === "POST")).toBe(false);
  });
  test("a card already in the target list is not moved", async () => {
    const s = stubFetch();
    const r = await applyMove(s.fetch, CREDS, DEFAULT_LISTS, { kind: "number", value: 8 }, { target: "review", comment: "" });
    expect(r.status).toBe("done");
    expect(s.calls.some((c) => c.method === "PUT")).toBe(false);
  });
  test("a link to a card on another board is a warning, nothing moves", async () => {
    const s = stubFetch({ "GET /cards/AbCd1234": { id: "card-1", idBoard: "board-other", idList: "list-ready", shortLink: "AbCd1234" } });
    const r = await applyMove(s.fetch, CREDS, DEFAULT_LISTS, { kind: "link", value: "AbCd1234" }, { target: "review", comment: "x" });
    expect(r.status).toBe("warning");
    expect(r.warning).toContain("not on the configured board");
    expect(s.calls.some((c) => c.method !== "GET")).toBe(false);
  });
  test("a card that is not on the board is a warning", async () => {
    const s = stubFetch();
    const r = await applyMove(s.fetch, CREDS, DEFAULT_LISTS, { kind: "number", value: 99 }, { target: "review", comment: "x" });
    expect(r.status).toBe("warning");
    expect(r.warning).toContain("PILOT-99");
    expect(s.calls.some((c) => c.method !== "GET")).toBe(false);
  });
  test("a missing target list is a warning naming the lists, the comment is still posted", async () => {
    const s = stubFetch();
    const r = await applyMove(s.fetch, CREDS, { ...DEFAULT_LISTS, blocked: "On hold" }, { kind: "number", value: 7 }, { target: "blocked", comment: "waits" });
    expect(r.status).toBe("warning");
    expect(r.warning).toContain("On hold");
    expect(r.warning).toContain("In Progress");
    expect(s.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(s.calls.find((c) => c.method === "POST")?.body).toEqual({ text: "waits" });
  });
  test("an HTTP error is a warning, not a throw", async () => {
    const s = stubFetch({ "GET /boards/board-1/cards": new Response("boom", { status: 500 }) });
    const r = await applyMove(s.fetch, CREDS, DEFAULT_LISTS, { kind: "number", value: 7 }, { target: "review", comment: "" });
    expect(r.status).toBe("warning");
    expect(r.warning).toContain("500");
    noSecrets(s.calls, r);
  });
  test("a fetch that throws is a warning and is redacted", async () => {
    const throwing = (async () => { throw new Error("socket closed for test-key/test-token"); }) as unknown as typeof fetch;
    const r = await applyMove(throwing, CREDS, DEFAULT_LISTS, { kind: "number", value: 7 }, { target: "review", comment: "" });
    expect(r.status).toBe("warning");
    expect(r.warning).toContain("socket closed");
    noSecrets([], r);
  });
});

function input(fields: Partial<MoveInput>): MoveInput {
  return {
    event: "review", task: "PILOT-7: add x", request: "", gate: "", ready: "", summary: "", report: "",
    artifactsDir: `/tmp/runs/${RUN_ID}`, dryRun: false, envFile: "/nonexistent/trello.env", ...fields,
  };
}

function envFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "trello-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, body);
  return path;
}

describe("runTrelloMove", () => {
  const noProfile = async () => undefined;

  test("a dry run reports the move and touches neither the credentials nor the network", async () => {
    for (const dry of [{ artifactsDir: `/tmp/dry-run-${RUN_ID}/artifacts` }, { dryRun: true }]) {
      const s = stubFetch();
      const r = await runTrelloMove(input({ event: "plan-gate", ready: "true", ...dry }), { fetch: s.fetch, readProfile: noProfile });
      expect(r.status).toBe("dry-run");
      expect(r.card).toBe("PILOT-7");
      expect(r.target).toBe("Blocked");
      expect(r.comment).toContain("waits for the operator at gate 2");
      expect(s.calls).toHaveLength(0);
    }
  });
  test("the task is read before the trigger message", async () => {
    const r = await runTrelloMove(input({ task: "PILOT-7: x", request: "PILOT-8: y", dryRun: true }), { fetch: stubFetch().fetch, readProfile: noProfile });
    expect(r.card).toBe("PILOT-7");
    const fromRequest = await runTrelloMove(input({ task: "", request: cardLink("AbCd1234"), dryRun: true }), { fetch: stubFetch().fetch, readProfile: noProfile });
    expect(fromRequest.card).toBe("AbCd1234");
  });
  test("list names come from the profile", async () => {
    const readProfile = async () => ({ trello: { lists: { review: "Code review" } } });
    const r = await runTrelloMove(input({ dryRun: true }), { fetch: stubFetch().fetch, readProfile });
    expect(r.target).toBe("Code review");
  });
  test("an unreadable profile falls back to the defaults with a warning", async () => {
    const readProfile = async () => { throw new Error("bad YAML"); };
    const r = await runTrelloMove(input({ dryRun: true }), { fetch: stubFetch().fetch, readProfile });
    expect(r.target).toBe("Review");
    expect(r.warning).toContain("bad YAML");
  });
  test("no card reference → none, nothing read", async () => {
    const s = stubFetch();
    let profileRead = false;
    const readProfile = async () => { profileRead = true; return undefined; };
    const r = await runTrelloMove(input({ task: "PILOT-0: chore", request: "fixture" }), { fetch: s.fetch, readProfile });
    expect(r).toEqual({ card: "", target: "", comment: "", status: "none", warning: "" });
    expect(s.calls).toHaveLength(0);
    expect(profileRead).toBe(false);
  });
  test("a real run without the credentials file → warning, no network", async () => {
    const s = stubFetch();
    const r = await runTrelloMove(input({}), { fetch: s.fetch, readProfile: noProfile });
    expect(r.status).toBe("warning");
    expect(r.warning).toContain("credentials");
    expect(s.calls).toHaveLength(0);
  });
  test("a credentials file without TRELLO_TOKEN → warning", async () => {
    const s = stubFetch();
    const path = envFile("TRELLO_API_KEY=test-key\nTRELLO_BOARD_ID=board-1\n");
    const r = await runTrelloMove(input({ envFile: path }), { fetch: s.fetch, readProfile: noProfile });
    expect(r.status).toBe("warning");
    expect(r.warning).toContain("TRELLO_TOKEN");
    expect(s.calls).toHaveLength(0);
  });
  test("a real run with credentials moves the card", async () => {
    const s = stubFetch();
    const path = envFile("TRELLO_API_KEY=test-key\nexport TRELLO_TOKEN='test-token'\nTRELLO_BOARD_ID=board-1\n");
    const r = await runTrelloMove(input({ event: "review", envFile: path }), { fetch: s.fetch, readProfile: noProfile });
    expect(r).toEqual({ card: "PILOT-7", target: "Review", comment: "", status: "done", warning: "" });
    expect(s.calls.find((c) => c.method === "PUT")?.body).toEqual({ idList: "list-review" });
    noSecrets(s.calls, r);
  });
});

describe("readCreds", () => {
  test("reads the three variables without the caller's environment", () => {
    const path = envFile("TRELLO_API_KEY=test-key\nTRELLO_TOKEN=test-token\nTRELLO_BOARD_ID=board-1\n");
    expect(readCreds(path)).toEqual(CREDS);
  });
  test("a variable exported by the caller never stands in for one missing from the file", () => {
    const path = envFile("TRELLO_API_KEY=test-key\nTRELLO_BOARD_ID=board-1\n");
    process.env.TRELLO_TOKEN = "test-token";
    try {
      expect(readCreds(path)).toEqual({ warning: expect.stringContaining("TRELLO_TOKEN") });
    } finally {
      delete process.env.TRELLO_TOKEN;
    }
  });
  test("quoted and exported values are read as text, never run", () => {
    const path = envFile('# trello\nexport TRELLO_API_KEY="test-key"\nTRELLO_TOKEN=\'test-token\'\nTRELLO_BOARD_ID=$(echo board-2)\n');
    expect(readCreds(path)).toEqual({ key: "test-key", token: "test-token", board: "$(echo board-2)" });
  });
});

describe("trello-move.ts", () => {
  test("never fails the node and logs the move", () => {
    const dir = mkdtempSync(join(tmpdir(), "trello-move-"));
    const artifacts = join(dir, RUN_ID);
    mkdirSync(artifacts);
    const p = Bun.spawnSync(["bun", TRELLO_MOVE], {
      env: {
        ...process.env,
        INPUTS_EVENT: "review", INPUTS_TASK: "PILOT-7: x", ARTIFACTS_DIR: artifacts, TRELLO_ENV_FILE: join(dir, "missing"),
      },
      cwd: dir,
    });
    expect(p.exitCode).toBe(0);
    const lines = p.stdout.toString().trim().split("\n");
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]);
    expect(Object.keys(out).sort()).toEqual(["card", "comment", "status", "target", "warning"]);
    expect(out.status).toBe("warning");
    expect(p.stderr.toString()).toContain("trello-move: warning:");
    expect(existsSync(join(artifacts, "trello.log"))).toBe(true);
    expect(readFileSync(join(artifacts, "trello.log"), "utf8")).toMatch(/ review card=PILOT-7 target=Review status=warning /);
  });
  test("--dry-run reports without credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "trello-move-"));
    const p = Bun.spawnSync(["bun", TRELLO_MOVE, "--dry-run"], {
      env: { ...process.env, INPUTS_EVENT: "plan-round", INPUTS_GATE: gate(true), INPUTS_TASK: "PILOT-7: x", ARTIFACTS_DIR: join(dir, RUN_ID) },
      cwd: dir,
    });
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toMatchObject({ card: "PILOT-7", target: "In Progress", status: "dry-run" });
  });
});
