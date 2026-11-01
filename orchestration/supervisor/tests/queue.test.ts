import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry } from "../src/ledger.ts";
import { loadPolicy, tick } from "../src/main.ts";
import type { PostMergeDeps } from "../src/postmerge.ts";
import { pathTokens, type QueueDeps } from "../src/queue.ts";
import { fixtureDb, insertEvent, insertRun } from "./fixtures/db.ts";

const POLICY = join(import.meta.dir, "..", "policy.yaml");
const MINUTE = 60_000;

let ledger: string;
let archonHome: string;
let queue: string;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-queue-"));
  ledger = join(dir, "ledger.jsonl");
  archonHome = join(dir, "archon");
  queue = join(dir, "queue");
  for (const repo of ["1_mvp_sdlc", "1_mvp_prompt"]) mkdirSync(join(archonHome, "workspaces", "OlegShevtsov1", repo, "source"), { recursive: true });
  process.env.SDLC_AUTOPILOT_LEDGER = ledger;
  process.env.ARCHON_HOME = archonHome;
  process.env.SDLC_AUTOPILOT_QUEUE = queue;
});

const lines = (): LedgerEntry[] =>
  existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function brief(repo: string, name: string, text: string, ageMinutes = 10): string {
  const path = join(queue, repo, name);
  mkdirSync(join(queue, repo), { recursive: true });
  writeFileSync(path, `${text}\n`);
  const t = new Date(Date.now() - ageMinutes * MINUTE);
  utimesSync(path, t, t);
  return path;
}

type Fake = QueueDeps & { launches: { argv: string[]; cwd: string }[] };

function fake(host = { memAvailableMb: 8000, load1: 1 }): Fake {
  const f: Fake = { launches: [], launch: (argv, cwd) => void f.launches.push({ argv, cwd }), host: () => host };
  return f;
}

const launched = (f: Fake) => f.launches.map((l) => l.argv.at(-1)?.split(":")[0]);
const marker = (f: Fake, i: number) => f.launches[i].argv.at(-1)?.split("\n").at(-1) ?? "";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

let seq = 0;
function factoryRun(db: Database, repo: string, message: string, status = "running"): string {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  insertRun(db, {
    id, workflow_name: "factory", user_message: message, status,
    working_path: join(archonHome, "workspaces", "OlegShevtsov1", repo, "worktrees", "archon", `task-factory-${seq}`),
  });
  return id;
}

const complete = (db: Database, id: string) =>
  db.run(`UPDATE remote_agent_workflow_runs SET status = 'completed' WHERE id = ?`, [id]);

const run = (db: Database, q: QueueDeps) => tick({ db, policy: loadPolicy(POLICY), respond: () => {}, queue: q });

const logged = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.map((c) => String(c[0]));

describe("queue", () => {
  test("a brief waiting only for host resources names the limit in the log", async () => {
    const db = fixtureDb();
    brief("1_mvp_sdlc", "PILOT-702.md", "PILOT-702: edit docs/c.md");
    const log = spyOn(console, "log");
    try {
      const low = fake({ memAvailableMb: 700, load1: 0.8 });
      await run(db, low);
      expect(low.launches).toHaveLength(0);
      expect(logged(log)).toContain("sdlc-autopilot: 1 queued brief(s) wait for host resources: MemAvailable 700 MB < 800 MB");

      const busy = fixtureDb();
      for (let i = 0; i < 3; i++) factoryRun(busy, "1_mvp_sdlc", "Deliver PILOT-1 in README.md");
      log.mockClear();
      await run(busy, fake({ memAvailableMb: 700, load1: 0.8 }));
      expect(logged(log)).toContain("sdlc-autopilot: 1 queued brief(s) wait for run slots or overlapping runs");
      expect(logged(log).some((l) => l.includes("host resources"))).toBe(false);
    } finally {
      log.mockRestore();
    }

    const idle = fake({ memAvailableMb: 1342, load1: 0.8 });
    await run(db, idle);
    expect(launched(idle)).toEqual(["PILOT-702"]);
  });

  test("sdlc queue drains first", async () => {
    const db = fixtureDb();
    for (const repo of ["x_one", "x_one", "x_two", "x_two"]) factoryRun(db, repo, "Deliver PILOT-1 in README.md");
    brief("1_mvp_prompt", "PILOT-700.md", "PILOT-700: prompt work in docs/a.md", 30);
    brief("1_mvp_sdlc", "PILOT-701.md", "PILOT-701: sdlc work in docs/b.md", 5);
    const f = fake();

    await run(db, f);

    const source = join(archonHome, "workspaces", "OlegShevtsov1", "1_mvp_sdlc", "source");
    expect(f.launches).toHaveLength(1);
    const { argv, cwd } = f.launches[0];
    expect(cwd).toBe(source);
    expect(argv.slice(0, -1)).toEqual(["archon", "workflow", "run", "factory", "--cwd", source]);
    expect(argv.at(-1)).toMatch(new RegExp(`^PILOT-701: sdlc work in docs/b\\.md\n\nsdlc-autopilot-launch: ${UUID}$`));
    expect(existsSync(join(queue, "1_mvp_prompt", "PILOT-700.md"))).toBe(true);
  });

  test("two CHANGELOG-touching tasks in one repo run one at a time", async () => {
    const db = fixtureDb();
    brief("1_mvp_sdlc", "a.md", "PILOT-601: add an entry to `CHANGELOG.md`.", 30);
    brief("1_mvp_sdlc", "b.md", "PILOT-602: fix CHANGELOG.md wording", 20);
    brief("1_mvp_sdlc", "c.md", "PILOT-603: edit docs/other.md", 10);
    const f = fake();

    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-601", "PILOT-603"]);

    const a = factoryRun(db, "1_mvp_sdlc", `PILOT-601: add an entry to \`CHANGELOG.md\`.\n\n${marker(f, 0)}`);
    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-601", "PILOT-603"]);

    complete(db, a);
    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-601", "PILOT-603", "PILOT-602"]);
  });

  test("a paused factory run blocks an overlapping brief in its repo", async () => {
    const db = fixtureDb();
    const paused = factoryRun(db, "1_mvp_sdlc", "PILOT-801: add an entry to CHANGELOG.md", "paused");
    brief("1_mvp_sdlc", "a.md", "PILOT-802: fix CHANGELOG.md wording", 20);
    brief("1_mvp_sdlc", "b.md", "PILOT-803: edit docs/other.md", 10);
    const f = fake();

    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-803"]);

    complete(db, paused);
    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-803", "PILOT-802"]);
  });

  test("two briefs naming files under the same directory run one at a time", async () => {
    const db = fixtureDb();
    brief("1_mvp_sdlc", "a.md", "PILOT-604: create orchestration/supervisor/src/{queue.ts,resources.ts}", 30);
    brief("1_mvp_sdlc", "b.md", "PILOT-605: wire orchestration/supervisor/src/main.ts", 20);
    const f = fake();

    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-604"]);

    const a = factoryRun(db, "1_mvp_sdlc", `PILOT-604: create orchestration/supervisor/src/{queue.ts,resources.ts}\n\n${marker(f, 0)}`);
    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-604"]);

    complete(db, a);
    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-604", "PILOT-605"]);
  });

  test("briefs with disjoint paths run in parallel", async () => {
    const db = fixtureDb();
    brief("1_mvp_sdlc", "a.md", "PILOT-606: Build in THIS repository OlegShevtsov1/1_mvp_sdlc. Edit orchestration/supervisor/src/main.ts.");
    brief("1_mvp_sdlc", "b.md", [
      "PILOT-607: Build in THIS repository OlegShevtsov1/1_mvp_sdlc. Edit plugins/mvp-sdlc/skills/task-brief/SKILL.md,",
      "see https://github.com/OlegShevtsov1/1_mvp_sdlc/blob/7891f7c/orchestration/supervisor/src/main.ts",
    ].join("\n"));
    const f = fake();

    await run(db, f);

    expect(launched(f)).toEqual(["PILOT-606", "PILOT-607"]);
  });

  test("a brief that names no paths runs alone in its repo", async () => {
    const db = fixtureDb();
    const other = factoryRun(db, "1_mvp_sdlc", "PILOT-608: edit README.md");
    brief("1_mvp_sdlc", "p.md", "PILOT-609: tidy things up", 30);
    const f = fake();

    await run(db, f);
    expect(launched(f)).toEqual([]);

    complete(db, other);
    brief("1_mvp_sdlc", "q.md", "PILOT-610: edit docs/q.md", 20);
    brief("1_mvp_prompt", "r.md", "PILOT-611: edit docs/r.md", 10);
    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-609", "PILOT-611"]);
  });

  test("path tokens skip URLs, absolute paths and owner/repo names", () => {
    const known = new Set(["OlegShevtsov1", "1_mvp_prompt", "1_mvp_sdlc"]);
    expect(pathTokens(
      "see ~/.config/x/y.md, /tmp/bun-1 and $TMPDIR/a/b, e.g. 0.8.0 in OlegShevtsov1/1_mvp_prompt at https://example.com/a/b.md",
      known,
    )).toEqual([]);
    expect(pathTokens("sdlc-autopilot-launch: 0d9c2f4e-7a1b-4c3d-9e8f-123456789abc", known)).toEqual([]);
    expect(pathTokens("touch `CHANGELOG.md`. and ./scripts/ci/check.sh and src/{queue.ts,main.ts}", known))
      .toEqual(["CHANGELOG.md", "scripts/ci/check.sh", "src", "queue.ts", "main.ts"]);
  });

  test("started brief moves to queue/started with the run id", async () => {
    const db = fixtureDb();
    brief("1_mvp_sdlc", "PILOT-612.md", "PILOT-612: edit docs/x.md\n\nDetails.");
    const f = fake();

    await run(db, f);
    expect(existsSync(join(queue, "1_mvp_sdlc", "PILOT-612.md"))).toBe(false);
    expect(readdirSync(join(queue, "started", "1_mvp_sdlc"))).toEqual([expect.stringMatching(new RegExp(`^launch-${UUID}--PILOT-612\\.md$`))]);

    const id = factoryRun(db, "1_mvp_sdlc", `PILOT-612: edit docs/x.md\n\nDetails.\n\n${marker(f, 0)}`);
    await run(db, f);
    await run(db, f);

    expect(readdirSync(join(queue, "started", "1_mvp_sdlc"))).toEqual([`${id}--PILOT-612.md`]);
    expect(f.launches).toHaveLength(1);
    expect(lines().map((l) => [l.run_id, l.kind, l.rule, l.action])).toEqual([
      ["queue:1_mvp_sdlc/PILOT-612.md", "queue", "queue-launch", "launch-task"],
    ]);
  });

  test("a started brief is claimed only by the run carrying its launch marker", async () => {
    const db = fixtureDb();
    const text = "PILOT-620: edit docs/x.md";
    // Archon rewrites `started_at` on every resume, so earlier runs of the same text can look newer than the launch.
    factoryRun(db, "1_mvp_sdlc", text, "cancelled");
    factoryRun(db, "1_mvp_sdlc", text, "failed");
    brief("1_mvp_sdlc", "PILOT-620.md", text);
    const f = fake();

    await run(db, f);
    await run(db, f);
    expect(readdirSync(join(queue, "started", "1_mvp_sdlc"))).toEqual([expect.stringMatching(new RegExp(`^launch-${UUID}--PILOT-620\\.md$`))]);

    const id = factoryRun(db, "1_mvp_sdlc", `${text}\n\n${marker(f, 0)}`);
    await run(db, f);
    expect(readdirSync(join(queue, "started", "1_mvp_sdlc"))).toEqual([`${id}--PILOT-620.md`]);
  });

  test("a started brief is claimed by its run that already failed before the next tick", async () => {
    const db = fixtureDb();
    const text = "PILOT-622: edit docs/x.md";
    brief("1_mvp_sdlc", "PILOT-622.md", text);
    brief("1_mvp_sdlc", "PILOT-623.md", "PILOT-623: edit docs/x.md too");
    const f = fake();

    await run(db, f);
    const id = factoryRun(db, "1_mvp_sdlc", `${text}\n\n${marker(f, 0)}`, "failed");
    await run(db, f);

    expect(readdirSync(join(queue, "started", "1_mvp_sdlc")).sort()).toEqual([
      `${id}--PILOT-622.md`, expect.stringMatching(new RegExp(`^launch-${UUID}--PILOT-623\\.md$`)),
    ]);
    expect(launched(f)).toEqual(["PILOT-622", "PILOT-623"]);
  });

  test("post-merge launches and queued briefs share one pool of run slots", async () => {
    const db = fixtureDb();
    for (const repo of ["x_one", "x_one", "x_two", "x_two"]) factoryRun(db, repo, "Deliver PILOT-1 in README.md");
    const merged = factoryRun(db, "1_mvp_prompt", "Deliver the plan", "completed");
    const pr = "https://github.com/OlegShevtsov1/1_mvp_prompt/pull/7";
    insertEvent(db, {
      id: `${merged}-report`, workflow_run_id: merged, event_order: 1, event_type: "node_completed", step_name: "report",
      data: JSON.stringify({ node: { id: "report", kind: "exec" }, structured_output: { status: "delivered", pr_url: pr } }),
    });
    brief("1_mvp_sdlc", "PILOT-621.md", "PILOT-621: edit docs/x.md");
    const q = fake();
    const postMerge: PostMergeDeps = {
      mergedPrs: (repo) => (repo === "OlegShevtsov1/1_mvp_prompt" ? [{ url: pr, title: "PILOT-7: something", mergedAt: "2026-11-01T07:00:00Z" }] : []),
      launch: q.launch,
      host: q.host,
    };

    await tick({ db, policy: loadPolicy(POLICY), respond: () => {}, postMerge, queue: q });

    expect(q.launches).toHaveLength(1);
    expect(q.launches[0].argv.at(-1)).toContain(`pr=${pr}`);
    expect(existsSync(join(queue, "1_mvp_sdlc", "PILOT-621.md"))).toBe(true);
  });

  test("a brief for a forbidden or unknown repo, without a card, or whose launch throws escalates once", async () => {
    const db = fixtureDb();
    brief("1_hrss_pilot", "a.md", "PILOT-613: edit docs/a.md");
    brief("x_unknown", "b.md", "PILOT-614: edit docs/b.md");
    brief("1_mvp_sdlc", "c.md", "no card here, edit docs/c.md");
    brief("1_mvp_prompt", "d.md", "PILOT-615: boom in docs/d.md");
    const f = fake();
    f.launch = (argv) => {
      if (argv.at(-1)?.includes("boom")) throw new Error("spawn archon ENOENT");
      f.launches.push({ argv, cwd: "" });
    };

    await run(db, f);
    await run(db, f);

    expect(f.launches).toEqual([]);
    expect(lines().map((l) => [l.run_id, l.rule, l.action]).sort()).toEqual([
      ["queue:1_hrss_pilot/a.md", "queue-forbidden-repo", "escalate"],
      ["queue:1_mvp_prompt/d.md", "queue-launch-failed", "escalate"],
      ["queue:1_mvp_sdlc/c.md", "queue-no-card", "escalate"],
      ["queue:x_unknown/b.md", "queue-unknown-repo", "escalate"],
    ]);
    expect(existsSync(join(queue, "1_mvp_prompt", "d.md"))).toBe(true);
    expect(readdirSync(join(queue, "started", "1_mvp_prompt"))).toEqual([]);
  });

  test("a launched brief no run picks up escalates once after 15 minutes and frees its slot", async () => {
    const db = fixtureDb();
    factoryRun(db, "1_mvp_sdlc", "PILOT-616: edit docs/one.md");
    factoryRun(db, "1_mvp_sdlc", "PILOT-617: edit docs/two.md");
    brief("1_mvp_sdlc", "a.md", "PILOT-618: edit docs/a.md", 30);
    brief("1_mvp_sdlc", "b.md", "PILOT-619: edit docs/b.md", 20);
    const f = fake();

    await run(db, f);
    expect(launched(f)).toEqual(["PILOT-618"]);

    const t = new Date(Date.now() - 16 * MINUTE);
    const [started] = readdirSync(join(queue, "started", "1_mvp_sdlc"));
    utimesSync(join(queue, "started", "1_mvp_sdlc", started), t, t);
    await run(db, f);
    await run(db, f);

    expect(launched(f)).toEqual(["PILOT-618", "PILOT-619"]);
    expect(lines().filter((l) => l.rule === "queue-launch-unseen").map((l) => l.run_id)).toEqual(["queue:1_mvp_sdlc/a.md"]);
  });
});
