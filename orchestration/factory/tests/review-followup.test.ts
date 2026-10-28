import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFollowUp, type FollowUpInput } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/follow-up.ts";
import { createFollowUpCards, DEFAULT_LISTS } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/trello.ts";

const RUN_ID = "abcdef01-2345-4a6b-8c9d-0123456789ef";
const PR_URL = "https://github.com/example/repo/pull/3";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const REVIEW_URL = `${PR_URL}#issuecomment-42`;
const CREDS = { key: "test-key", token: "test-token", board: "board-1" };
const BODY = "## Problem\nfixture body\n";

const DELIVERY = {
  ready: false,
  reason: "replan",
  pr_url: PR_URL,
  ci_rerun: "none",
  threads_checked: false,
  summary: `Not ready: Round 3: replan. R6 re-raised.\n${PR_URL}\n\nLeft open, so the pull request does not close its issue:\n- Required outcome: unmet — R6`,
};

function state(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pr_url: PR_URL, round: 3, review_round: 4, read: true, head: HEAD, is_draft: true,
    checks: [{ name: "Tests", bucket: "pass" }], checks_read: true,
    review_url: REVIEW_URL, review_commit: HEAD, findings_read: true,
    findings: [
      { id: "R6", severity: "blocking", sources: ["code"], claim: "The guard misses the empty list.\nMore detail.", status: "open", round: 2 },
    ],
    ...fields,
  });
}

function judge(verdict = "narrower"): string {
  return JSON.stringify({
    findings: [{ id: "R6", verdict, earlier_id: "R6", why: "a narrower trigger of the R6 invariant" }],
    left_open: [{ item: "Required outcome: unmet — R6", finding_ids: ["R6"], only_followups: true }],
  });
}

function artifacts(runId: string | null, files: Array<[string, string]> = [["pr-body.md", BODY]]): string {
  const base = mkdtempSync(join(tmpdir(), "factory-followup-"));
  const dir = join(base, runId ?? "artifacts");
  mkdirSync(dir);
  for (const [name, text] of files) writeFileSync(join(dir, name), text);
  return dir;
}

function credsFile(text = "TRELLO_API_KEY=test-key\nTRELLO_TOKEN=test-token\nTRELLO_BOARD_ID=board-1\n"): string {
  const path = join(mkdtempSync(join(tmpdir(), "factory-followup-env-")), ".env");
  writeFileSync(path, text);
  return path;
}

function input(fields: Partial<FollowUpInput> = {}): FollowUpInput {
  return {
    delivery: JSON.stringify(DELIVERY), state: state(), judge: judge(),
    task: "PILOT-300: fixture", request: "", artifactsDir: artifacts(RUN_ID), envFile: credsFile(), ...fields,
  };
}

interface Call { method: string; path: string; body: Record<string, unknown> | undefined; auth: string }

// A board with the default lists and a `Task` label; `routes` overrides single answers.
function stubFetch(routes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  let created = 0;
  const answers: Record<string, unknown> = {
    "GET /boards/board-1/lists": Object.entries(DEFAULT_LISTS).map(([k, name]) => ({ id: `list-${k}`, name })),
    "GET /boards/board-1/labels": [{ id: "label-bug", name: "bug" }, { id: "label-task", name: "Task" }],
    ...routes,
  };
  const fn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const path = u.pathname.replace(/^\/1/, "");
    calls.push({
      method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("Authorization") ?? "",
    });
    const answer = answers[`${method} ${path}`];
    if (answer instanceof Response) return answer;
    if (method === "POST" && path === "/cards" && answer === undefined) {
      created += 1;
      return Response.json({ id: `new-${created}`, shortUrl: `https://example.test/c/new${created}` });
    }
    if (answer === undefined) return new Response("not found", { status: 404 });
    return Response.json(answer);
  };
  return { calls, fetch: fn as typeof fetch };
}

function fakeGh(fail: string | null = null) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    return fail === null ? { ok: true, err: "" } : { ok: false, err: fail };
  };
  return { calls, gh };
}

const noProfile = async () => undefined;

function noSecrets(out: unknown): void {
  const text = JSON.stringify(out);
  expect(text).not.toContain("test-key");
  expect(text).not.toContain("test-token");
}

describe("runFollowUp", () => {
  test("a delivery the rule does not consider passes through unchanged, with no call", async () => {
    const s = stubFetch();
    const g = fakeGh();
    const delivered = { ready: true, reason: "delivered", pr_url: PR_URL, ci_rerun: "none", threads_checked: true, summary: "Ready: Round 1: delivered." };
    const r = await runFollowUp(input({ delivery: JSON.stringify(delivered), state: "", judge: "" }), { fetch: s.fetch, gh: g.gh, readProfile: noProfile });
    expect(r).toEqual({ ...delivered, followed_up: false, cards: [], warning: "" });
    expect(s.calls).toEqual([]);
    expect(g.calls).toEqual([]);
  });

  test("a delivery the rule declines stays not ready and says why", async () => {
    const s = stubFetch();
    const g = fakeGh();
    const r = await runFollowUp(input({ judge: judge("new") }), { fetch: s.fetch, gh: g.gh, readProfile: noProfile });
    expect(r).toEqual({
      ...DELIVERY,
      summary: `${DELIVERY.summary}\n\nNot followed up: the judge found R6 new, not a narrower case of an earlier finding.`,
      followed_up: false, cards: [], warning: "",
    });
    expect(s.calls).toEqual([]);
    expect(g.calls).toEqual([]);
  });

  test("a dry run marks the cards dry-run and writes nothing", async () => {
    const dir = artifacts(null);
    const s = stubFetch();
    const g = fakeGh();
    const r = await runFollowUp(input({ artifactsDir: dir }), { fetch: s.fetch, gh: g.gh, readProfile: noProfile });
    expect(r.ready).toBe(true);
    expect(r.reason).toBe("follow_up");
    expect(r.followed_up).toBe(true);
    expect(r.cards).toEqual([{ finding: "R6", url: "", status: "dry-run" }]);
    expect(r.summary).toBe(`Ready: follow-up after round 3: R6 re-raised on a narrower case of an earlier finding; follow-up cards: R6 (dry run).\n${PR_URL}`);
    expect(r.pr_url).toBe(PR_URL);
    expect(s.calls).toEqual([]);
    expect(g.calls).toEqual([]);
    expect(readFileSync(join(dir, "pr-body.md"), "utf8")).toBe(BODY);
  });

  test("a real run creates the card in Ready with the task label, links it in the body and marks the draft ready", async () => {
    const dir = artifacts(RUN_ID);
    const s = stubFetch();
    const g = fakeGh();
    const r = await runFollowUp(input({ artifactsDir: dir }), { fetch: s.fetch, gh: g.gh, readProfile: noProfile });
    expect(r.ready).toBe(true);
    expect(r.reason).toBe("follow_up");
    expect(r.warning).toBe("");
    expect(r.cards).toEqual([{ finding: "R6", url: "https://example.test/c/new1", status: "created" }]);
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /boards/board-1/lists", "GET /boards/board-1/labels", "POST /cards"]);
    const post = s.calls[2].body ?? {};
    expect(post.idList).toBe("list-ready");
    expect(post.idLabels).toEqual(["label-task"]);
    expect(post.name).toBe("Follow-up PILOT-300: R6 The guard misses the empty list.");
    for (const part of ["The guard misses the empty list.\nMore detail.", "a narrower trigger of the R6 invariant", "R6", PR_URL, REVIEW_URL]) {
      expect(String(post.desc)).toContain(part);
    }
    for (const c of s.calls) {
      expect(c.path + JSON.stringify(c.body ?? "")).not.toContain("test-token");
      expect(c.auth).toContain("test-token");
    }
    expect(readFileSync(join(dir, "pr-body.md"), "utf8"))
      .toBe(`${BODY}\n## Follow-up cards\n\n- R6: https://example.test/c/new1 — The guard misses the empty list.\n`);
    expect(g.calls).toEqual([["pr", "ready", PR_URL]]);
    expect(r.summary).toContain("follow-up cards: R6 https://example.test/c/new1.");
  });

  test("a pull request that is already ready is not marked again", async () => {
    const g = fakeGh();
    const r = await runFollowUp(input({ state: state({ is_draft: false }) }), { fetch: stubFetch().fetch, gh: g.gh, readProfile: noProfile });
    expect(r.ready).toBe(true);
    expect(g.calls).toEqual([]);
  });

  test("a renamed Ready list is used", async () => {
    const s = stubFetch({ "GET /boards/board-1/lists": [{ id: "list-backlog", name: "Backlog" }] });
    const readProfile = async () => ({ trello: { lists: { ready: "Backlog" } } });
    const r = await runFollowUp(input(), { fetch: s.fetch, gh: fakeGh().gh, readProfile });
    expect(r.ready).toBe(true);
    expect(s.calls[2].body?.idList).toBe("list-backlog");
  });

  test("a board without a task label creates nothing and keeps today's behaviour", async () => {
    const dir = artifacts(RUN_ID);
    const s = stubFetch({ "GET /boards/board-1/labels": [{ id: "label-bug", name: "bug" }] });
    const g = fakeGh();
    const r = await runFollowUp(input({ artifactsDir: dir }), { fetch: s.fetch, gh: g.gh, readProfile: noProfile });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("replan");
    expect(r.followed_up).toBe(false);
    expect(r.warning).toBe("label 'task' not found on the board");
    expect(r.cards).toEqual([{ finding: "R6", url: "", status: "failed" }]);
    expect(r.summary).toBe(`${DELIVERY.summary}\n\nNot followed up: label 'task' not found on the board.`);
    expect(s.calls.some((c) => c.method === "POST")).toBe(false);
    expect(g.calls).toEqual([]);
    expect(readFileSync(join(dir, "pr-body.md"), "utf8")).toBe(BODY);
  });

  test("a Trello error keeps today's behaviour and never names the secrets", async () => {
    const s = stubFetch({ "POST /cards": new Response("boom test-token", { status: 500 }) });
    const g = fakeGh();
    const r = await runFollowUp(input(), { fetch: s.fetch, gh: g.gh, readProfile: noProfile });
    expect(r.ready).toBe(false);
    expect(r.warning).toBe("POST /cards: HTTP 500");
    expect(g.calls).toEqual([]);
    noSecrets(r);
  });

  test("a fetch that throws with a secret in its message is redacted", async () => {
    const throwing = (async () => { throw new Error("socket closed for test-key/test-token"); }) as unknown as typeof fetch;
    const r = await runFollowUp(input(), { fetch: throwing, gh: fakeGh().gh, readProfile: noProfile });
    expect(r.ready).toBe(false);
    noSecrets(r);
  });

  test("gh pr ready failing keeps today's behaviour and lists the card already created", async () => {
    const r = await runFollowUp(input(), { fetch: stubFetch().fetch, gh: fakeGh("HTTP 502").gh, readProfile: noProfile });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe("replan");
    expect(r.warning).toBe("gh pr ready failed: HTTP 502");
    expect(r.cards).toEqual([{ finding: "R6", url: "https://example.test/c/new1", status: "created" }]);
    expect(r.summary).toContain("Not followed up: gh pr ready failed: HTTP 502.");
  });

  test("a missing credentials file creates nothing", async () => {
    const s = stubFetch();
    const r = await runFollowUp(input({ envFile: "/nonexistent/.env" }), { fetch: s.fetch, gh: fakeGh().gh, readProfile: noProfile });
    expect(r.ready).toBe(false);
    expect(r.warning).toBe("credentials file /nonexistent/.env not found");
    expect(s.calls).toEqual([]);
  });

  test("a run with no body file creates nothing", async () => {
    const s = stubFetch();
    const r = await runFollowUp(input({ artifactsDir: artifacts(RUN_ID, []) }), { fetch: s.fetch, gh: fakeGh().gh, readProfile: noProfile });
    expect(r.ready).toBe(false);
    expect(r.warning).toBe("no pr-body file in the run's artifacts to link the follow-up cards in");
    expect(s.calls).toEqual([]);
  });
});

describe("createFollowUpCards", () => {
  const cards = [
    { finding: "R6", name: "Follow-up PILOT-300: R6 a", desc: "a" },
    { finding: "R7", name: "Follow-up PILOT-300: R7 b", desc: "b" },
  ];

  test("creates one card per finding", async () => {
    const s = stubFetch();
    const r = await createFollowUpCards(s.fetch, CREDS, DEFAULT_LISTS, cards);
    expect(r).toEqual({
      cards: [
        { finding: "R6", url: "https://example.test/c/new1", status: "created" },
        { finding: "R7", url: "https://example.test/c/new2", status: "created" },
      ],
      warning: "",
    });
  });

  test("a missing Ready list creates nothing", async () => {
    const s = stubFetch({ "GET /boards/board-1/lists": [{ id: "l", name: "Doing" }] });
    const r = await createFollowUpCards(s.fetch, CREDS, DEFAULT_LISTS, cards);
    expect(r.warning).toBe("list 'Ready' not found on the board (lists: Doing)");
    expect(r.cards.map((c) => c.status)).toEqual(["failed", "failed"]);
    expect(s.calls.some((c) => c.method === "POST")).toBe(false);
  });
});
