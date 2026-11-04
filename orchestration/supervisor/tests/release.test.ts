import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Chain, ExecResult, IntakeDeps } from "../src/intake.ts";
import type { LedgerEntry } from "../src/ledger.ts";
import { knownNames, pathTokens, type QueuedTask } from "../src/queue.ts";
import { fixtureDb } from "./fixtures/db.ts";
import { loadPolicy, queueStage, tick } from "../src/main.ts";
import { NOTHING_TO_RELEASE, parseReleaseBrief, type Run, runRelease, runRollback, UNCHANGED } from "../src/release-run.ts";
import {
  qaProdViews, readReleases, readReleaseShots, refreshReleases, releaseArgv, type ReleaseResult, releaseRule,
} from "../src/release.ts";

const BE = "1_mvp_pilot_be";
const FE = "1_mvp_pilot_fe";
const RULE = { mirrorOwner: "OlegShevtsov1" };
const SHA = "1111111111111111111111111111111111111111";
const LAUNCH = "stage-00000000-0000-4000-8000-00000000000a--";

let dir: string;
let ledger: string;
let queue: string;
let be: string;
let server: ReturnType<typeof Bun.serve>;
let trelloCalls: { method: string; path: string; body: unknown }[];
// card number → list id
let board: Map<number, string>;
let nextCard: number;
// feature slug → tasks.json tasks
let tasks: Record<string, unknown[]>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-release-"));
  ledger = join(dir, "state", "ledger.jsonl");
  queue = join(dir, "queue");
  process.env.SDLC_AUTOPILOT_LEDGER = ledger;
  process.env.SDLC_AUTOPILOT_QUEUE = queue;
  process.env.ARCHON_HOME = join(dir, "archon");
  [be] = [BE, FE].map((repo) => {
    const source = join(dir, "archon", "workspaces", "OlegShevtsov1", repo, "source");
    mkdirSync(join(source, ".archon"), { recursive: true });
    writeFileSync(join(source, ".archon", "factory-profile.yaml"), "repo:\n  base_branch: develop\n");
    return source;
  });
  writeFileSync(join(dir, "trello.env"), "TRELLO_API_KEY=test-key\nTRELLO_TOKEN=test-token\nTRELLO_BOARD_ID=board-1\n");
  process.env.SDLC_AUTOPILOT_TRELLO_ENV = join(dir, "trello.env");
  trelloCalls = [];
  board = new Map();
  nextCard = 950;
  tasks = {};
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.json();
      trelloCalls.push({ method: req.method, path: url.pathname, body });
      if (url.pathname === "/1/boards/board-1/lists") {
        return Response.json([{ id: "list-progress", name: "In Progress" }, { id: "list-rtr", name: "Ready to Release" }]);
      }
      if (url.pathname === "/1/boards/board-1/cards") {
        return Response.json([...board].map(([idShort, idList]) => ({ id: `card-${idShort}`, idShort, idList })));
      }
      if (req.method === "POST" && url.pathname === "/1/cards") {
        const idShort = nextCard++;
        return Response.json({ id: `card-${idShort}`, idShort });
      }
      if (req.method === "PUT" && url.pathname.startsWith("/1/cards/")) return Response.json({});
      return new Response("not found", { status: 404 });
    },
  });
  process.env.SDLC_AUTOPILOT_TRELLO_API = `${server.url.origin}/1`;
});

afterEach(() => {
  server.stop(true);
});

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

const deps: IntakeDeps = {
  exec: (argv) => {
    if (argv[0] === "git" && argv[3] === "show") {
      const slug = argv[4].match(/docs\/features\/([^/]+)\//)?.[1] ?? "";
      return tasks[slug] ? ok(JSON.stringify({ slug, tasks: tasks[slug] })) : { code: 128, stdout: "", stderr: "no such path" };
    }
    return ok();
  },
};

// `/task` chains straight into stages.json, as intake keeps them; each feature card n has the slug t<n>.
function setChains(...chains: { n: number; kind?: "be" | "fe"; state?: Chain["state"] }[]): void {
  const all: Record<string, Chain> = {};
  for (const c of chains) {
    all[`PILOT-${c.n}`] = {
      card: `PILOT-${c.n}`, cardId: `card-${c.n}`, slug: `t${c.n}`, kind: c.kind ?? "be", text: "Фіча", stage: "task-cards",
      attempt: 1, state: c.state ?? "done", created: "2026-11-02T00:00:00.000Z",
    };
  }
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "stages.json"), JSON.stringify({ chains: all }));
}

// A feature t<n> whose tasks have these cards and repos, each card on the board in `list`.
function feature(n: number, cards: [number, string][], list = "list-rtr"): void {
  tasks[`t${n}`] = cards.map(([card, repo], i) => ({
    id: `T${i + 1}`, repo, status: "done", ...(card === n ? {} : { trello_card_id_short: card }),
  }));
  for (const [card] of cards) board.set(card, list);
}

const lines = (): LedgerEntry[] =>
  existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const queued = (repo: string) => (existsSync(join(queue, repo)) ? readdirSync(join(queue, repo)).sort() : []);
const brief = (repo: string, name: string) => readFileSync(join(queue, repo, name), "utf8");
const posts = () => trelloCalls.filter((c) => c.method === "POST");

// The queue launched the brief and the runner finished with this result.
function launchAndFinish(repo: string, name: string, result: Partial<ReleaseResult> | null): string {
  const started = join(queue, "started", repo, `${LAUNCH}${name}`);
  mkdirSync(join(queue, "started", repo), { recursive: true });
  renameSync(join(queue, repo, name), started);
  if (result) {
    writeFileSync(`${started}.result.json`, JSON.stringify({ finished_at: "2026-11-03T00:00:00Z", error: "", version: "", lines: [], ...result }));
  }
  return started;
}

const task = (repo: string, name: string): QueuedTask => ({ repo: `OlegShevtsov1/${repo}`, cwd: "", briefFile: join(queue, repo, name), card: "" });

describe("release queue", () => {
  test("a task still in dev blocks the release", async () => {
    setChains({ n: 901 }, { n: 920, state: "briefs" });
    feature(901, [[902, BE], [903, BE]]);
    feature(920, [[920, BE]]);
    board.set(903, "list-progress");

    expect(await refreshReleases(deps, RULE)).toBe(0);
    expect(queued(BE)).toEqual([]);
    expect(lines()).toEqual([]);
    expect(posts()).toEqual([]);
    expect(readReleases().releases).toEqual([]);

    board.delete(903);
    await refreshReleases(deps, RULE);
    expect(queued(BE)).toEqual([]);

    board.set(903, "list-rtr");
    await refreshReleases(deps, RULE);
    expect(queued(BE)).toEqual(["sdlc-release.1.1.md"]);
    expect(readReleases().releases[0].features).toEqual(["PILOT-901"]);
  });

  test("all tasks qa-ok queues release be then fe", async () => {
    setChains({ n: 901, kind: "fe" });
    feature(901, [[902, BE], [903, FE]]);

    expect(await refreshReleases(deps, RULE)).toBe(1);
    expect(posts()).toEqual([
      { method: "POST", path: "/1/cards", body: { idList: "list-rtr", name: `Release ${BE} for PILOT-901` } },
    ]);
    expect(queued(BE)).toEqual(["sdlc-release.1.1.md"]);
    expect(queued(FE)).toEqual([]);
    const text = brief(BE, "sdlc-release.1.1.md");
    expect(text.match(/PILOT-\d+/)?.[0]).toBe("PILOT-950");
    expect(text).toContain(`Repo-dir: ${be}\nBase: develop\nCard: PILOT-950\nMirror: OlegShevtsov1/${BE}\n`);
    expect(text).toContain("Features: PILOT-901\nRelease: 1\n");
    // No repo-relative path: the queue holds the brief while any factory run of its repo is open.
    expect(pathTokens(text, knownNames())).toEqual([]);
    expect(lines().map((l) => [l.run_id, l.workflow, l.kind, l.rule, l.action])).toEqual([
      ["release:1", "release", "release", "release-queued", "none"],
    ]);

    launchAndFinish(BE, "sdlc-release.1.1.md", { exit: 0, version: "0.5.0", lines: ["prep: PILOT-950 0.5.0 #12", `shipped: v0.5.0 ${SHA}`] });
    await refreshReleases(deps, RULE);
    const r = readReleases().releases[0];
    expect(r.steps[0]).toMatchObject({ repo: BE, state: "shipped", version: "0.5.0", sha: SHA });
    expect(r.state).toBe("open");
    expect(lines().map((l) => l.rule)).toEqual(["release-queued", "release-shipped", "release-queued"]);
    // The ledger redacts the sha; releases.json keeps it.
    expect(lines()[1].evidence.message).toBe("shipped: v0.5.0 [REDACTED]");
    expect(queued(FE)).toEqual(["sdlc-release.1.1.md"]);
    expect(brief(FE, "sdlc-release.1.1.md")).toStartWith(`PILOT-951: Release ${FE} for PILOT-901\n`);
    expect(existsSync(join(queue, "started", BE))).toBe(true);
    expect(readdirSync(join(queue, "started", BE))).toEqual([]);

    launchAndFinish(FE, "sdlc-release.1.1.md", { exit: 0, lines: ["shipped: v0.7.0 2222222222222222222222222222222222222222"] });
    await refreshReleases(deps, RULE);
    expect(readReleases().releases[0].state).toBe("shipped");
    expect(lines().map((l) => l.rule)).toEqual(["release-queued", "release-shipped", "release-queued", "release-shipped", "qa-prod"]);
    expect(posts()).toHaveLength(2);
  });

  test("concurrent qa-ok events queue one release", async () => {
    setChains({ n: 905 }, { n: 901 });
    feature(901, [[901, BE]]);
    feature(905, [[906, BE]]);

    await refreshReleases(deps, RULE);
    expect([...queued(BE), ...queued(FE)]).toEqual(["sdlc-release.1.1.md"]);
    expect(brief(BE, "sdlc-release.1.1.md")).toContain("Features: PILOT-901, PILOT-905\n");
    expect(posts()).toHaveLength(1);

    // A third feature ready while the brief still waits joins it.
    setChains({ n: 905 }, { n: 901 }, { n: 910, kind: "fe" });
    feature(910, [[911, BE], [912, FE]]);
    await refreshReleases(deps, RULE);
    expect([...queued(BE), ...queued(FE)]).toEqual(["sdlc-release.1.1.md"]);
    expect(brief(BE, "sdlc-release.1.1.md")).toStartWith(`PILOT-950: Release ${BE} for PILOT-901, PILOT-905, PILOT-910\n`);
    expect(posts()).toHaveLength(1);
    expect(trelloCalls.filter((c) => c.method === "PUT")).toEqual([
      { method: "PUT", path: "/1/cards/card-950", body: { name: `Release ${BE} for PILOT-901, PILOT-905, PILOT-910` } },
    ]);
    expect(readReleases().releases[0].repos).toEqual([BE, FE]);

    // Once launched, a fourth waits for the next release.
    launchAndFinish(BE, "sdlc-release.1.1.md", null);
    setChains({ n: 905 }, { n: 901 }, { n: 910, kind: "fe" }, { n: 930 });
    feature(930, [[930, BE]]);
    await refreshReleases(deps, RULE);
    expect([...queued(BE), ...queued(FE)]).toEqual([]);
    expect(readReleases().releases).toHaveLength(1);

    writeFileSync(join(queue, "started", BE, `${LAUNCH}sdlc-release.1.1.md.result.json`), JSON.stringify({ exit: 1, lines: ["release: x"] }));
    await refreshReleases(deps, RULE);
    const [first, second] = readReleases().releases;
    expect(first).toMatchObject({ id: 1, state: "failed" });
    expect(second).toMatchObject({ id: 2, state: "open", features: ["PILOT-930"] });
    expect(queued(BE)).toEqual(["sdlc-release.2.1.md"]);

    // Its work went out with release 1's tag: nothing new on be, so release 2 ends without a deploy.
    launchAndFinish(BE, "sdlc-release.2.1.md", { exit: 0, lines: [UNCHANGED] });
    await refreshReleases(deps, RULE);
    expect(readReleases().releases[1]).toMatchObject({ state: "shipped", steps: [{ repo: BE, state: "unchanged" }] });
    expect(lines().at(-1)).toMatchObject({ rule: "release-unchanged", action: "none" });
    expect([...queued(BE), ...queued(FE)]).toEqual([]);
  });

  test("a be step with nothing to release moves on to fe", async () => {
    setChains({ n: 901, kind: "fe" });
    feature(901, [[901, BE], [902, FE]]);
    await refreshReleases(deps, RULE);
    launchAndFinish(BE, "sdlc-release.1.1.md", { exit: 0, lines: [UNCHANGED] });
    await refreshReleases(deps, RULE);
    expect(readReleases().releases[0]).toMatchObject({ state: "open", steps: [{ state: "unchanged" }, { repo: FE, state: "queued" }] });
    expect(queued(FE)).toEqual(["sdlc-release.1.1.md"]);
  });

  test("results: a rollback or no rollback stops all until the operator closes the release", async () => {
    setChains({ n: 901, kind: "fe" });
    feature(901, [[901, BE], [902, FE]]);
    await refreshReleases(deps, RULE);
    launchAndFinish(BE, "sdlc-release.1.1.md", {
      exit: 3, lines: [`red: v0.5.0 ${SHA} smoke https://example.test/health`, `rolled back: v0.4.0 ${SHA}`],
    });
    setChains({ n: 901, kind: "fe" }, { n: 940 });
    feature(940, [[940, BE]]);
    await refreshReleases(deps, RULE);
    const escalation = lines().find((l) => l.action === "escalate");
    expect(escalation?.rule).toBe("release-rolled-back");
    expect(escalation?.evidence.message).toContain("rolled back: v0.4.0");
    // The rolled-back code is still on develop: no release deploys it again on its own.
    expect(readReleases().releases.map((r) => [r.id, r.state, r.features])).toEqual([[1, "stopped", ["PILOT-901"]]]);
    expect(queued(BE)).toEqual([]);

    const state = join(dir, "state", "releases.json");
    const closed = readReleases();
    closed.releases[0].state = "closed";
    writeFileSync(state, JSON.stringify(closed));
    await refreshReleases(deps, RULE);
    expect(readReleases().releases.map((r) => [r.id, r.state, r.features])).toEqual([
      [1, "closed", ["PILOT-901"]], [2, "open", ["PILOT-940"]],
    ]);
    expect(queued(BE)).toEqual(["sdlc-release.2.1.md"]);

    launchAndFinish(BE, "sdlc-release.2.1.md", {
      exit: 4, lines: [`red: v0.5.0 ${SHA} smoke https://example.test/health`, "no auto-rollback: irreversible migration db/migrate/1_drop.rb"],
    });
    setChains({ n: 901, kind: "fe" }, { n: 940 }, { n: 945 });
    feature(945, [[945, BE]]);
    await refreshReleases(deps, RULE);
    const stopped = lines().filter((l) => l.action === "escalate").at(-1);
    expect(stopped?.rule).toBe("release-no-rollback");
    expect(stopped?.evidence.message).toContain("no auto-rollback: irreversible migration");
    expect(readReleases().releases.map((r) => r.state)).toEqual(["closed", "stopped"]);
    expect(queued(BE)).toEqual([]);
  });

  test("a shipped release is a QA prod card and holds the next release until its answer", async () => {
    setChains({ n: 901 });
    feature(901, [[901, BE], [902, BE]]);
    await refreshReleases(deps, RULE);
    const started = launchAndFinish(BE, "sdlc-release.1.1.md", null);
    mkdirSync(`${started}.shots`);
    writeFileSync(`${started}.shots/1-a-1440.png`, "png");
    writeFileSync(`${started}.result.json`, JSON.stringify({
      exit: 0, finished_at: "2026-11-03T00:00:00Z", error: "", version: "0.5.0", lines: [`shipped: v0.5.0 ${SHA}`],
      previous: "v0.4.0", irreversible: [], url: "https://pilot.example.test/health", shotsTotal: 2,
      shots: [{ page: "https://pilot.example.test/a", width: 1440, path: `${started}.shots/1-a-1440.png` }],
    }));
    setChains({ n: 901 }, { n: 940 });
    feature(940, [[940, BE]]);
    await refreshReleases(deps, RULE);

    const [r] = readReleases().releases;
    const kept = join(dir, "state", "release-shots", "1", BE, "1-a-1440.png");
    expect(r).toMatchObject({ state: "shipped", tasks: ["PILOT-901", "PILOT-902"] });
    expect(r.steps[0]).toMatchObject({
      previous: "v0.4.0", irreversible: [], url: "https://pilot.example.test/health", shotsTotal: 2,
      mirror: `OlegShevtsov1/${BE}`, shots: [{ page: "https://pilot.example.test/a", width: 1440, path: kept }],
    });
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(`${started}.shots`)).toBe(false);
    const card = lines().filter((l) => l.rule === "qa-prod");
    expect(card).toMatchObject([{
      run_id: "release:1", workflow: "release", kind: "qa-prod", action: "escalate",
      evidence: { event_id: "release:1@qa-prod", node: "qa-prod" },
    }]);
    const text = `Shipped: ${BE} v0.5.0 ${SHA} https://pilot.example.test/health previous v0.4.0\nFeatures: PILOT-901\nRelease: 1`;
    expect(qaProdViews()).toMatchObject([{
      id: "release:1", workflow: "release", status: "paused", cwd: be,
      pause: { eventId: "release:1@qa-prod", kind: "qa-prod", text, decisions: [{ id: "ok" }, { id: "reject" }] },
    }]);
    expect(readReleaseShots("release:1")).toEqual({ total: 1, shots: [{ page: "https://pilot.example.test/a", width: 1440, path: kept }] });
    // PILOT-940 is ready, but a reject must roll back to the tag before release 1.
    expect(readReleases().releases).toHaveLength(1);
    expect(queued(BE)).toEqual([]);

    const answered = readReleases();
    answered.releases[0].qa = "ok";
    writeFileSync(join(dir, "state", "releases.json"), JSON.stringify(answered));
    expect(qaProdViews()).toEqual([]);
    await refreshReleases(deps, RULE);
    expect(readReleases().releases.map((x) => [x.id, x.features])).toEqual([[1, ["PILOT-901"]], [2, ["PILOT-940"]]]);
    expect(lines().filter((l) => l.rule === "qa-prod")).toHaveLength(1);
  });

  test("a release that shipped nothing sends no QA prod card", async () => {
    setChains({ n: 901 });
    feature(901, [[901, BE]]);
    await refreshReleases(deps, RULE);
    launchAndFinish(BE, "sdlc-release.1.1.md", { exit: 0, lines: [UNCHANGED] });
    await refreshReleases(deps, RULE);
    expect(readReleases().releases[0].state).toBe("shipped");
    expect(lines().filter((l) => l.kind === "qa-prod")).toEqual([]);
    expect(qaProdViews()).toEqual([]);
  });

  test("a ship failing after the release-prep PR merged stops all", async () => {
    setChains({ n: 901 });
    feature(901, [[901, BE]]);
    await refreshReleases(deps, RULE);
    launchAndFinish(BE, "sdlc-release.1.1.md", {
      exit: 1, version: "0.5.0", error: "bin/release ship v0.5.0 завершився з кодом 1", lines: ["prep: PILOT-950 0.5.0 #12"],
    });
    setChains({ n: 901 }, { n: 940 });
    feature(940, [[940, BE]]);
    await refreshReleases(deps, RULE);
    expect(readReleases().releases.map((r) => [r.id, r.state])).toEqual([[1, "stopped"]]);
    const escalation = lines().find((l) => l.action === "escalate");
    expect(escalation?.rule).toBe("release-unfinished");
    expect(escalation?.evidence.message).toContain("bin/release ship v0.5.0");
    expect(queued(BE)).toEqual([]);
  });

  test("an unreadable releases.json is never overwritten", async () => {
    setChains({ n: 901 });
    feature(901, [[901, BE]]);
    const state = join(dir, "state", "releases.json");
    writeFileSync(state, "{\"releases\": [{\"id\": 1, \"state\": \"stopped\"");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await refreshReleases(deps, RULE)).toBe(0);
      expect(releaseArgv(task(BE, "sdlc-release.1.1.md"), "/started")).toBeNull();
      expect(error.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining("sdlc-autopilot: releases: "), expect.stringContaining("sdlc-autopilot: releases: "),
      ]);
    } finally {
      error.mockRestore();
    }
    expect(readFileSync(state, "utf8")).toBe("{\"releases\": [{\"id\": 1, \"state\": \"stopped\"");
    expect(queued(BE)).toEqual([]);
  });

  test("a feature whose tasks.json cannot be read holds back only itself", async () => {
    setChains({ n: 901 }, { n: 905 });
    feature(905, [[905, BE]]);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await refreshReleases(deps, RULE);
      expect(error.mock.calls[0][0]).toContain("PILOT-901: origin/develop:docs/features/t901/tasks/tasks.json не прочитано");
    } finally {
      error.mockRestore();
    }
    expect(readReleases().releases[0].features).toEqual(["PILOT-905"]);
  });

  test("fe waiting for be on prod is launched again with the merged version, then gives up", async () => {
    setChains({ n: 901, kind: "fe" });
    feature(901, [[901, FE]]);
    await refreshReleases(deps, RULE);
    expect(queued(FE)).toEqual(["sdlc-release.1.1.md"]);
    launchAndFinish(FE, "sdlc-release.1.1.md", { exit: 75, version: "0.6.0" });
    await refreshReleases(deps, RULE);
    expect(queued(FE)).toEqual(["sdlc-release.1.2.md"]);
    expect(brief(FE, "sdlc-release.1.2.md")).toContain("Version: 0.6.0\n");
    expect(lines().filter((l) => l.action === "escalate")).toEqual([]);

    // A rerun brief takes no joiners: its first launch already merged the release-prep PR.
    setChains({ n: 901, kind: "fe" }, { n: 960, kind: "fe" });
    feature(960, [[960, FE]]);
    await refreshReleases(deps, RULE);
    expect(readReleases().releases[0].features).toEqual(["PILOT-901"]);

    launchAndFinish(FE, "sdlc-release.1.2.md", { exit: 75, version: "0.6.0" });
    await refreshReleases(deps, RULE);
    launchAndFinish(FE, "sdlc-release.1.3.md", { exit: 75, version: "0.6.0" });
    await refreshReleases(deps, RULE);
    expect(readReleases().releases[0].state).toBe("stopped");
    expect(lines().filter((l) => l.action === "escalate").map((l) => l.rule)).toEqual(["release-unfinished"]);
  });

  test("a Trello failure is logged and retried on the next tick", async () => {
    setChains({ n: 901 });
    feature(901, [[901, BE]]);
    writeFileSync(join(dir, "trello.env"), "TRELLO_API_KEY=test-key\nTRELLO_TOKEN=test-token\nTRELLO_BOARD_ID=board-2\n");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await refreshReleases(deps, RULE)).toBe(0);
      expect(error.mock.calls[0][0]).toContain("HTTP 404");
      expect(error.mock.calls[0][0]).not.toContain("test-key");
    } finally {
      error.mockRestore();
    }
    expect(queued(BE)).toEqual([]);
    writeFileSync(join(dir, "trello.env"), "TRELLO_API_KEY=test-key\nTRELLO_TOKEN=test-token\nTRELLO_BOARD_ID=board-1\n");
    await refreshReleases(deps, RULE);
    expect(queued(BE)).toEqual(["sdlc-release.1.1.md"]);
  });

  test("only the brief the open release waits for launches as a release run", async () => {
    setChains({ n: 901 });
    feature(901, [[901, BE]]);
    await refreshReleases(deps, RULE);
    const argv = releaseArgv(task(BE, "sdlc-release.1.1.md"), "/started");
    expect(argv?.[0]).toBe("bun");
    expect(argv?.[1]).toEndWith("/src/release-run.ts");
    expect(argv?.[2]).toBe("/started");
    expect(releaseArgv(task(BE, "sdlc-release.1.2.md"), "/started")).toBeNull();
    expect(releaseArgv(task(FE, "sdlc-release.1.1.md"), "/started")).toBeNull();
    expect(releaseArgv(task(BE, "sdlc-release.2.1.md"), "/started")).toBeNull();
    expect(releaseArgv(task(BE, "notes.md"), "/started")).toBeNull();
  });

  test("the shipped policy's tick queues the release brief and launches it as a release run", async () => {
    setChains({ n: 901 });
    feature(901, [[901, BE]]);
    const launches: string[][] = [];
    await tick({
      db: fixtureDb(), policy: loadPolicy(join(import.meta.dir, "..", "policy.yaml")), respond: () => {}, release: deps,
      queue: { launch: (argv) => void launches.push(argv), host: () => ({ memAvailableMb: 8000, load1: 1 }), stage: queueStage },
    });
    expect(launches).toEqual([
      ["bun", expect.stringMatching(/\/src\/release-run\.ts$/), expect.stringMatching(/\/started\/1_mvp_pilot_be\/stage-[0-9a-f-]+--sdlc-release\.1\.1\.md$/)],
    ]);
  });

  test("the policy's release rule", () => {
    expect(releaseRule([{ id: "qa-dev" }])).toBeNull();
    expect(releaseRule([{ id: "release", mirror_owner: "OlegShevtsov1" }])).toEqual(RULE);
    expect(() => releaseRule([{ id: "release", mirror_owner: "a" }, { id: "release", mirror_owner: "b" }]))
      .toThrow("policy: rule release is defined twice");
    expect(() => releaseRule([{ id: "release", mirror_owner: 1 }])).toThrow("policy: rule release is malformed");
  });
});

describe("release runner", () => {
  const BRIEF = [
    "PILOT-950: Release 1_mvp_pilot_be for PILOT-901", "Repo-dir: /src/be", "Base: develop", "Card: PILOT-950",
    `Mirror: OlegShevtsov1/${BE}`, "Features: PILOT-901", "Release: 1", "",
  ].join("\n");

  type Call = { argv: string[]; env: Record<string, string> };

  function runner(answer: (argv: string[]) => Partial<Run> | undefined) {
    const calls: Call[] = [];
    const exec = (argv: string[], _cwd: string, env: Record<string, string>): Run => {
      calls.push({ argv, env });
      if (argv[3] === "worktree" && argv[4] === "add") mkdirSync(argv[7], { recursive: true });
      return { code: 0, stdout: "", stderr: "", ...answer(argv) };
    };
    return { calls, deps: { exec, sleep: () => {} } };
  }

  function started(text = BRIEF): string {
    const path = join(queue, "started", BE, `${LAUNCH}sdlc-release.1.1.md`);
    mkdirSync(join(queue, "started", BE), { recursive: true });
    writeFileSync(path, text);
    return path;
  }

  const shown = (calls: Call[]) => calls.map((c) => c.argv.map((a) => a.replace(/^.*\/stages\/release-[^/]+/, "<wt>")).join(" "));
  const WT = `<wt>`;

  test("prep, green checks, squash merge at the checked head, then ship", () => {
    const { calls, deps } = runner((argv) => {
      if (argv[1] === "prep") return { stdout: "prep: PILOT-950 0.5.0 #12\n" };
      if (argv[1] === "ship") return { stdout: `shipped: v0.5.0 ${SHA}\n` };
      if (argv.slice(0, 3).join(" ") === "gh pr view") {
        return { stdout: JSON.stringify({ state: "OPEN", headRefOid: SHA, title: "PILOT-950: Release 0.5.0 changelog" }) };
      }
      return undefined;
    });
    const path = started();
    const result = runRelease(path, deps);

    expect(shown(calls)).toEqual([
      "git -C /src/be fetch -q origin develop",
      `git -C /src/be worktree add -q --detach ${WT} origin/develop`,
      `${WT}/scripts/next-version.sh origin/develop`,
      `${WT}/bin/release prep`,
      "gh pr checks 12 --watch",
      "gh pr view 12 --json state,headRefOid,title",
      `gh pr merge 12 --squash --match-head-commit ${SHA} --subject PILOT-950: Release 0.5.0 changelog (#12)`,
      `git -C /src/be worktree remove --force ${WT}`,
      "git -C /src/be fetch -q origin develop",
      `git -C /src/be worktree add -q --detach ${WT} origin/develop`,
      `${WT}/bin/release ship v0.5.0`,
      `git -C /src/be worktree remove --force ${WT}`,
    ]);
    expect(calls[3].env).toEqual({ RELEASE_CARD: "PILOT-950", RELEASE_MIRROR_REPO: `OlegShevtsov1/${BE}` });
    expect(result).toMatchObject({ exit: 0, error: "", version: "0.5.0", lines: ["prep: PILOT-950 0.5.0 #12", `shipped: v0.5.0 ${SHA}`] });
    expect(JSON.parse(readFileSync(`${path}.result.json`, "utf8"))).toMatchObject({ exit: 0, version: "0.5.0" });
  });

  test("a red prep or red checks merge and ship nothing; a red ship is the result", () => {
    const red = runner((argv) => (argv[1] === "prep" ? { code: 1, stdout: "" } : undefined));
    expect(runRelease(started(), red.deps).exit).toBe(1);
    expect(shown(red.calls).filter((c) => c.startsWith("gh") || c.includes("ship"))).toEqual([]);

    const checks = runner((argv) => {
      if (argv[1] === "prep") return { stdout: "prep: PILOT-950 0.5.0 #12\n" };
      if (argv.slice(0, 3).join(" ") === "gh pr checks") return { code: 1, stderr: "ci\tfail" };
      return undefined;
    });
    // Nothing merged: no version, so the release can fail without holding the next one.
    expect(runRelease(started(), checks.deps)).toMatchObject({ exit: 1, version: "" });
    expect(shown(checks.calls).filter((c) => c.startsWith("gh pr merge") || c.includes("ship"))).toEqual([]);

    const rolledBack = runner((argv) => {
      if (argv[1] === "ship") return { code: 3, stdout: `red: v0.5.0 ${SHA} smoke https://example.test/health\nrolled back: v0.4.0 ${SHA}\n` };
      return undefined;
    });
    const result = runRelease(started(BRIEF.replace("Release: 1\n", "Release: 1\nVersion: 0.5.0\n")), rolledBack.deps);
    expect(shown(rolledBack.calls).filter((c) => c.startsWith("gh") || c.includes("prep"))).toEqual([]);
    expect(result).toMatchObject({ exit: 3, version: "0.5.0", lines: [`red: v0.5.0 ${SHA} smoke https://example.test/health`, `rolled back: v0.4.0 ${SHA}`] });
  });

  test("a base with nothing to release since the last tag preps nothing", () => {
    const { calls, deps } = runner((argv) => (argv[0].endsWith("/scripts/next-version.sh") ? { code: NOTHING_TO_RELEASE } : undefined));
    expect(runRelease(started(), deps)).toMatchObject({ exit: 0, version: "", lines: [UNCHANGED] });
    expect(shown(calls).filter((c) => c.includes("bin/release") || c.startsWith("gh"))).toEqual([]);
  });

  test("both templates' next-version.sh exit with the code the runner reads as nothing to release", () => {
    for (const template of ["project-be", "project-fe"]) {
      const repo = mkdtempSync(join(tmpdir(), "next-version-"));
      const git = (...args: string[]) => expect(Bun.spawnSync(["git", "-C", repo, ...args]).exitCode).toBe(0);
      git("init", "-q");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
      git("tag", "v0.1.0");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "APP-2: Docs (#2)\n\nType: docs");
      const script = join(import.meta.dir, "..", "..", "..", "templates", template, "scripts", "next-version.sh");
      expect(Bun.spawnSync([script, "HEAD"], { cwd: repo }).exitCode, template).toBe(NOTHING_TO_RELEASE);
    }
  });

  test("checks not registered yet are waited for", () => {
    let tries = 0;
    const { calls, deps } = runner((argv) => {
      if (argv[1] === "prep") return { stdout: "prep: PILOT-950 0.5.0 #12\n" };
      if (argv.slice(0, 3).join(" ") === "gh pr checks" && tries++ < 2) return { code: 1, stderr: "no checks reported on the 'x' branch" };
      if (argv.slice(0, 3).join(" ") === "gh pr view") return { stdout: JSON.stringify({ state: "MERGED" }) };
      if (argv[1] === "ship") return { stdout: `shipped: v0.5.0 ${SHA}\n` };
      return undefined;
    });
    expect(runRelease(started(), deps).exit).toBe(0);
    expect(shown(calls).filter((c) => c.startsWith("gh pr checks"))).toHaveLength(3);
    expect(shown(calls).filter((c) => c.startsWith("gh pr merge"))).toEqual([]);
  });

  const SHIP_LOG = `release: shipping v0.5.0 = ${SHA} (PILOT-950), previous v0.4.0, deploy repo OlegShevtsov1/${BE}\n`;

  test("ship records the previous tag and irreversible migrations from bin/release's log", () => {
    const ship = (stderr: string) => runner((argv) => (argv[1] === "ship" ? { stdout: `shipped: v0.5.0 ${SHA}\n`, stderr } : undefined));
    const brief = BRIEF.replace("Release: 1\n", "Release: 1\nVersion: 0.5.0\n");
    const migrations = "release: irreversible migrations since v0.4.0: db/migrate/1_drop_x.rb db/migrate/2_drop_y.rb\n";
    expect(runRelease(started(brief), ship(`release: x\n${migrations}${SHIP_LOG}`).deps)).toMatchObject({
      exit: 0, previous: "v0.4.0", irreversible: ["db/migrate/1_drop_x.rb", "db/migrate/2_drop_y.rb"],
    });
    expect(runRelease(started(brief), ship(SHIP_LOG).deps)).toMatchObject({ previous: "v0.4.0", irreversible: [] });
    expect(runRelease(started(brief), ship(SHIP_LOG.replace("previous v0.4.0", "previous none")).deps))
      .toMatchObject({ previous: "", irreversible: [] });
    const unknown = runRelease(started(brief), ship(migrations).deps);
    expect(unknown.previous).toBeUndefined();
    expect(unknown.irreversible).toBeUndefined();
  });

  test("both templates log the previous tag, and be its irreversible migrations, the way the runner reads them", () => {
    for (const template of ["project-be", "project-fe"]) {
      const text = readFileSync(join(import.meta.dir, "..", "..", "..", "templates", template, "bin", "release"), "utf8");
      expect(text, template).toContain(`log() { echo "release: $*" >&2; }`);
      expect(text, template).toContain('log "shipping ${tag} = ${d} (${card}), previous ${prev:-none}, deploy repo ${deploy_repo}"');
    }
    const be = readFileSync(join(import.meta.dir, "..", "..", "..", "templates", "project-be", "bin", "release"), "utf8");
    expect(be).toContain('log "irreversible migrations since ${prev}: ${irreversible[*]}"');
  });

  test("a shipped repo shoots its changed qa_dev pages on prod at 1440 and 360", () => {
    const source = join(dir, "fe-source");
    mkdirSync(join(source, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(source, "node_modules", ".bin", "playwright"), "");
    const profile = [
      "qa_dev:", "  pages:",
      '    - glob: "src/settings/**"', '      url: "https://app.dev.pilot.example.test/settings?tab=theme"',
      '    - glob: "src/**"', '      url: "https://app.dev.pilot.example.test/"',
      '    - glob: "src/**"', '      url: "https://elsewhere.example.test/"',
      '    - glob: "docs/**"', '      url: "https://app.dev.pilot.example.test/docs"', "",
    ].join("\n");
    const calls: string[][] = [];
    const exec = (argv: string[]): Run => {
      calls.push(argv);
      if (argv[3] === "worktree" && argv[4] === "add") {
        mkdirSync(join(argv[7], ".archon"), { recursive: true });
        mkdirSync(join(argv[7], "config"), { recursive: true });
        writeFileSync(join(argv[7], ".archon", "factory-profile.yaml"), profile);
        writeFileSync(join(argv[7], "config", "project.env"), "PROJECT_NAME=pilot\nPROJECT_ZONE=pilot.example.test\n");
      }
      if (argv[1] === "ship") return { code: 0, stdout: `shipped: v0.6.0 ${SHA}\n`, stderr: SHIP_LOG.replace("v0.5.0", "v0.6.0").replace("v0.4.0", "v0.5.0") };
      if (argv[3] === "diff") return { code: 0, stdout: "src/settings/Theme.tsx\nsrc/main.tsx\n", stderr: "" };
      if (argv[0].endsWith("/playwright")) {
        // The 360 shot of the first page fails.
        if (argv[5] === "360, 800" && argv.at(-2)?.includes("settings")) return { code: 1, stdout: "", stderr: "timeout" };
        writeFileSync(argv.at(-1) ?? "", "png");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const path = join(queue, "started", FE, `${LAUNCH}sdlc-release.1.1.md`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, BRIEF.replace("Repo-dir: /src/be", `Repo-dir: ${source}`).replace("Release: 1\n", "Release: 1\nVersion: 0.6.0\n"));

    const result = runRelease(path, { exec, sleep: () => {} });

    expect(calls.filter((a) => a[3] === "diff")).toEqual([["git", "-C", source, "diff", "--name-only", "v0.5.0", SHA]]);
    const shots = calls.filter((a) => a[0].endsWith("/playwright")).map((a) => [...a.slice(1, -1), a.at(-1)?.replace(`${path}.shots/`, "")]);
    expect(shots).toEqual([
      ["screenshot", "-b", "chromium", "--viewport-size", "1440, 900", "--wait-for-timeout", "2000", "https://app.pilot.example.test/settings?tab=theme", "1-app-pilot-example-test-settings-tab-theme-1440.png"],
      ["screenshot", "-b", "chromium", "--viewport-size", "360, 800", "--wait-for-timeout", "2000", "https://app.pilot.example.test/settings?tab=theme", "1-app-pilot-example-test-settings-tab-theme-360.png"],
      ["screenshot", "-b", "chromium", "--viewport-size", "1440, 900", "--wait-for-timeout", "2000", "https://app.pilot.example.test/", "2-app-pilot-example-test-1440.png"],
      ["screenshot", "-b", "chromium", "--viewport-size", "360, 800", "--wait-for-timeout", "2000", "https://app.pilot.example.test/", "2-app-pilot-example-test-360.png"],
    ]);
    expect(result).toMatchObject({
      exit: 0, url: "https://app.pilot.example.test/", previous: "v0.5.0", shotsTotal: 4,
      shots: [
        { page: "https://app.pilot.example.test/settings?tab=theme", width: 1440, path: `${path}.shots/1-app-pilot-example-test-settings-tab-theme-1440.png` },
        { page: "https://app.pilot.example.test/", width: 1440, path: `${path}.shots/2-app-pilot-example-test-1440.png` },
        { page: "https://app.pilot.example.test/", width: 360, path: `${path}.shots/2-app-pilot-example-test-360.png` },
      ],
    });
  });

  test("rollback runs bin/release rollback per repo in order and stops at the first failure", () => {
    const job = join(dir, "state", "rollbacks", "release-1.json");
    mkdirSync(dirname(job), { recursive: true });
    writeFileSync(job, JSON.stringify({
      release: 1, steps: [
        { repo: FE, source: "/src/fe", base: "develop", card: "PILOT-951", mirror: `OlegShevtsov1/${FE}`, to: "v0.5.0" },
        { repo: BE, source: "/src/be", base: "develop", card: "PILOT-950", mirror: "", to: "v0.4.0" },
      ],
    }));
    const rolled = (repo: string) => (argv: string[]) =>
      argv[1] === "rollback" ? (argv[0].includes(repo) ? { code: 1, stdout: "" } : { stdout: `rolled back: ${argv[2]} ${SHA}\n` }) : undefined;
    const tree = (calls: Call[]) => calls.map((c) => c.argv.map((a) => a.replace(/^.*\/stages\/release-rollback-1-/, "<wt>-")).join(" "));

    const green = runner(rolled("none"));
    expect(runRollback(job, green.deps)).toMatchObject({ exit: 0, error: "", lines: [`rolled back: v0.5.0 ${SHA}`, `rolled back: v0.4.0 ${SHA}`] });
    expect(tree(green.calls)).toEqual([
      "git -C /src/fe fetch -q origin develop",
      `git -C /src/fe worktree add -q --detach <wt>-${FE} origin/develop`,
      `<wt>-${FE}/bin/release rollback v0.5.0`,
      `git -C /src/fe worktree remove --force <wt>-${FE}`,
      "git -C /src/be fetch -q origin develop",
      `git -C /src/be worktree add -q --detach <wt>-${BE} origin/develop`,
      `<wt>-${BE}/bin/release rollback v0.4.0`,
      `git -C /src/be worktree remove --force <wt>-${BE}`,
    ]);
    expect(green.calls[2].env).toEqual({ RELEASE_CARD: "PILOT-951", RELEASE_MIRROR_REPO: `OlegShevtsov1/${FE}` });
    expect(green.calls[6].env).toEqual({ RELEASE_CARD: "PILOT-950" });
    expect(JSON.parse(readFileSync(`${job}.result.json`, "utf8"))).toMatchObject({ exit: 0 });

    const red = runner(rolled(FE));
    expect(runRollback(job, red.deps)).toMatchObject({ exit: 1, error: `${FE}: bin/release rollback v0.5.0 завершився з кодом 1`, lines: [] });
    expect(tree(red.calls).filter((c) => c.includes("/src/be"))).toEqual([]);
    expect(tree(red.calls).at(-1)).toBe(`git -C /src/fe worktree remove --force <wt>-${FE}`);
    expect(JSON.parse(readFileSync(`${job}.result.json`, "utf8"))).toMatchObject({ exit: 1 });
  });

  test("a brief without its fields is refused", () => {
    expect(parseReleaseBrief("PILOT-1: x\nRepo-dir: /a\nBase: develop\n")).toBeNull();
    expect(parseReleaseBrief(BRIEF)).toEqual({
      source: "/src/be", base: "develop", card: "PILOT-950", mirror: `OlegShevtsov1/${BE}`, version: "",
    });
  });
});
