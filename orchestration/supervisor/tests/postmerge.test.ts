import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry } from "../src/ledger.ts";
import { loadPolicy, type Policy, tick } from "../src/main.ts";
import { type MergedPr, type PostMergeDeps, postMergeArgs } from "../src/postmerge.ts";
import { fixtureDb, insertEvent, insertRun } from "./fixtures/db.ts";

const POLICY = join(import.meta.dir, "..", "policy.yaml");
const SDLC = "https://github.com/OlegShevtsov1/1_mvp_sdlc/pull";
const PROMPT = "https://github.com/OlegShevtsov1/1_mvp_prompt/pull";
// After the shipped policy's `post_merge.since`, so a PR given without `mergedAt` is owed.
const AFTER = "2026-11-01T07:00:00Z";

let dir: string;
let ledger: string;
let archonHome: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-postmerge-"));
  ledger = join(dir, "ledger.jsonl");
  archonHome = join(dir, "archon");
  process.env.SDLC_AUTOPILOT_LEDGER = ledger;
  process.env.ARCHON_HOME = archonHome;
});

const lines = (): LedgerEntry[] =>
  existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

type Fake = PostMergeDeps & { launches: { argv: string[]; cwd: string }[]; asked: string[] };
type Pr = Omit<MergedPr, "mergedAt"> & { mergedAt?: string };

function fake(merged: Record<string, Pr[]>, host = { memAvailableMb: 8000, load1: 1 }): Fake {
  const f: Fake = {
    launches: [],
    asked: [],
    mergedPrs: (repo) => {
      f.asked.push(repo);
      return (merged[repo] ?? []).map((p) => ({ mergedAt: AFTER, ...p }));
    },
    launch: (argv, cwd) => void f.launches.push({ argv, cwd }),
    host: () => host,
  };
  return f;
}

let order = 0;
function factoryRun(db: Database, id: string, status: string, repo: string, ...reports: [string, string][]): void {
  insertRun(db, {
    id, workflow_name: "factory", user_message: "Deliver the plan", status,
    working_path: `/home/operator/.archon/workspaces/OlegShevtsov1/${repo}/worktrees/archon/task-${id}`,
  });
  for (const [reportStatus, prUrl] of reports) {
    insertEvent(db, {
      id: `${id}-report-${++order}`, workflow_run_id: id, event_order: order, event_type: "node_completed",
      step_name: "report", data: JSON.stringify({
        node: { id: "report", kind: "exec" },
        structured_output: { status: reportStatus, pr_url: prUrl, merge_sha: "" },
      }),
    });
  }
}

const run = (db: Database, postMerge: PostMergeDeps, policy: Policy = loadPolicy(POLICY), now?: () => Date) =>
  tick({ db, policy, postMerge, now });

describe("postMergeArgs", () => {
  test("release-prep title maps to run=PILOT<n>", () => {
    const release = postMergeArgs({
      url: `${SDLC}/85`, title: "PILOT-502: Release 0.8.0 changelog", repo: "OlegShevtsov1/1_mvp_sdlc",
    });
    expect(release).toEqual({
      cwd: join(archonHome, "workspaces", "OlegShevtsov1", "1_mvp_sdlc", "source"),
      args: `run=PILOT502 pr=${SDLC}/85`,
    });

    const task = postMergeArgs({
      url: `${SDLC}/88`, title: "PILOT-507: sdlc supervisor: Каркас супервізора", repo: "OlegShevtsov1/1_mvp_sdlc",
    });
    expect(task.args).toBe(`run=C8.Tn pr=${SDLC}/88 part=C8.TnP507`);

    const mentionsRelease = postMergeArgs({
      url: `${SDLC}/90`, title: "PILOT-600: docs: describe the Release flow", repo: "OlegShevtsov1/1_mvp_sdlc",
    });
    expect(mentionsRelease.args).toBe(`run=C8.Tn pr=${SDLC}/90 part=C8.TnP600`);

    expect(() => postMergeArgs({ url: `${SDLC}/91`, title: "Release v0.9.0", repo: "OlegShevtsov1/1_mvp_sdlc" })).toThrow();
  });
});

describe("launchPostMerges", () => {
  test("delivered factory run launches post-merge once", async () => {
    const db = fixtureDb();
    factoryRun(db, "aaaa0088", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/88`]);
    const f = fake({ "OlegShevtsov1/1_mvp_sdlc": [{ url: `${SDLC}/88`, title: "PILOT-507: sdlc supervisor: Каркас" }] });

    await run(db, f);
    await run(db, f);

    const source = join(archonHome, "workspaces", "OlegShevtsov1", "1_mvp_sdlc", "source");
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0].cwd).toBe(source);
    expect(f.launches[0].argv).toContain(join(archonHome, "workflows", "mvp-ops", "post-merge", "scripts", "launch.ts"));
    expect(f.launches[0].argv.slice(-3)).toEqual(["--cwd", source, `run=C8.Tn pr=${SDLC}/88 part=C8.TnP507`]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      run_id: "aaaa0088", workflow: "factory", action: "launch-post-merge", rule: "post-merge-merged-pr",
      kind: "post-merge", evidence: { event_id: `post-merge:${SDLC}/88` },
    });
  });

  test("delivered-pending-operator does not launch until the PR is merged", async () => {
    const db = fixtureDb();
    factoryRun(db, "bbbb0295", "completed", "1_mvp_prompt", ["delivered-pending-operator", `${PROMPT}/295`]);
    const merged: Record<string, Pr[]> = {};
    const f = fake(merged);

    await run(db, f);
    expect(f.launches).toHaveLength(0);
    expect(lines()).toHaveLength(0);

    merged["OlegShevtsov1/1_mvp_prompt"] = [{ url: `${PROMPT}/295`, title: "PILOT-490: prompt: something" }];
    await run(db, f);
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0].argv.at(-1)).toBe(`run=C8.Tn pr=${PROMPT}/295 part=C8.TnP490`);
  });

  test("merged PR after cancelled run triggers post-merge", async () => {
    const db = fixtureDb();
    factoryRun(db, "69aea63f", "cancelled", "1_mvp_sdlc", ["delivered", `${SDLC}/81`], ["not-delivered", `${SDLC}/81`]);
    const f = fake({ "OlegShevtsov1/1_mvp_sdlc": [{ url: `${SDLC}/81`, title: "PILOT-478: sdlc: something" }] });

    await run(db, f);

    expect(f.launches).toHaveLength(1);
    expect(f.launches[0].argv.at(-1)).toBe(`run=C8.Tn pr=${SDLC}/81 part=C8.TnP478`);
    expect(lines().map((l) => l.action)).toEqual(["launch-post-merge"]);
  });

  test("failed post-merge with 'no section ###' is not retried", async () => {
    const db = fixtureDb();
    factoryRun(db, "cccc0282", "completed", "1_mvp_prompt", ["delivered", `${PROMPT}/282`]);
    insertRun(db, {
      id: "43f45bfb", workflow_name: "post-merge", status: "failed",
      user_message: `run=PILOT469 pr=${PROMPT}/282`,
      working_path: "/home/operator/.archon/workspaces/OlegShevtsov1/1_mvp_prompt/source",
    });
    insertEvent(db, {
      id: "43f45bfb-failed", workflow_run_id: "43f45bfb", event_order: 1, event_type: "workflow_failed",
      step_name: null, data: JSON.stringify({
        error: "DAG workflow 'post-merge' completed with failures: 'fetch': plan has no section `### PILOT469 — …`",
      }),
    });
    const f = fake({ "OlegShevtsov1/1_mvp_prompt": [{ url: `${PROMPT}/282`, title: "PILOT-469: prompt: something" }] });

    await run(db, f);
    await run(db, f);

    expect(f.launches).toHaveLength(0);
    expect(f.asked).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });

  test("an overloaded host defers the launch to a later tick", async () => {
    const db = fixtureDb();
    factoryRun(db, "dddd0088", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/88`]);
    const merged = { "OlegShevtsov1/1_mvp_sdlc": [{ url: `${SDLC}/88`, title: "PILOT-507: sdlc supervisor" }] };

    const log = spyOn(console, "log");
    try {
      for (const [host, shortfall] of [
        [{ memAvailableMb: 700, load1: 1 }, "MemAvailable 700 MB < 800 MB"],
        [{ memAvailableMb: 8000, load1: 9 }, "load1 9 > 8"],
      ] as const) {
        const f = fake(merged, host);
        await run(db, f);
        expect(f.launches).toHaveLength(0);
        expect(lines()).toHaveLength(0);
        expect(log.mock.calls.map((c) => String(c[0])))
          .toContain(`sdlc-autopilot: 1 post-merge launch(es) wait for host resources: ${shortfall}`);
      }
    } finally {
      log.mockRestore();
    }

    const f = fake(merged);
    await run(db, f);
    expect(f.launches).toHaveLength(1);
  });

  test("three running runs in the repo defer its launch", async () => {
    const db = fixtureDb();
    factoryRun(db, "eeee0088", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/88`]);
    for (const id of ["run1", "run2", "run3"]) factoryRun(db, id, "running", "1_mvp_sdlc");
    const f = fake({ "OlegShevtsov1/1_mvp_sdlc": [{ url: `${SDLC}/88`, title: "PILOT-507: sdlc supervisor" }] });

    await run(db, f);

    expect(f.launches).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });

  test("a merged PR without a card or in a forbidden repo escalates once", async () => {
    const db = fixtureDb();
    const hrss = "https://github.com/OlegShevtsov1/1_hrss_pilot/pull/7";
    factoryRun(db, "ffff0089", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/89`]);
    factoryRun(db, "ffff0007", "completed", "1_hrss_pilot", ["delivered", hrss]);
    const f = fake({
      "OlegShevtsov1/1_mvp_sdlc": [{ url: `${SDLC}/89`, title: "Bump bun to 1.4.2" }],
      "OlegShevtsov1/1_hrss_pilot": [{ url: hrss, title: "PILOT-1: hrss: something" }],
    });

    await run(db, f);
    await run(db, f);

    expect(f.launches).toHaveLength(0);
    expect(lines().map((l) => [l.run_id, l.action, l.rule])).toEqual([
      ["ffff0089", "escalate", "post-merge-no-card"],
      ["ffff0007", "escalate", "post-merge-forbidden-repo"],
    ]);
  });

  test("a PR merged days after its run ended still launches post-merge", async () => {
    const db = fixtureDb();
    factoryRun(db, "gggg0092", "completed", "1_mvp_sdlc", ["delivered-pending-operator", `${SDLC}/92`]);
    db.run(`UPDATE remote_agent_workflow_runs SET last_activity_at = datetime('now', '-3 days') WHERE id = 'gggg0092'`);
    const f = fake({ "OlegShevtsov1/1_mvp_sdlc": [{ url: `${SDLC}/92`, title: "PILOT-512: sdlc: something" }] });

    await run(db, f);

    expect(f.launches).toHaveLength(1);
    expect(f.launches[0].argv.at(-1)).toBe(`run=C8.Tn pr=${SDLC}/92 part=C8.TnP512`);
  });

  test("a launch that throws escalates once and later launches still run", async () => {
    const db = fixtureDb();
    factoryRun(db, "hhhh0093", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/93`]);
    factoryRun(db, "hhhh0094", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/94`]);
    const f = fake({
      "OlegShevtsov1/1_mvp_sdlc": [
        { url: `${SDLC}/93`, title: "PILOT-513: sdlc: one" },
        { url: `${SDLC}/94`, title: "PILOT-514: sdlc: two" },
      ],
    });
    const launch = f.launch;
    f.launch = (argv, cwd, logFile) => {
      if (argv.at(-1)?.includes(`${SDLC}/93 `)) throw new Error("ENOENT: no such file or directory, chdir");
      launch(argv, cwd, logFile);
    };

    await run(db, f);
    await run(db, f);

    expect(f.launches.map((l) => l.argv.at(-1))).toEqual([`run=C8.Tn pr=${SDLC}/94 part=C8.TnP514`]);
    expect(lines().map((l) => [l.run_id, l.action, l.rule])).toEqual([
      ["hhhh0093", "escalate", "post-merge-launch-failed"],
      ["hhhh0094", "launch-post-merge", "post-merge-merged-pr"],
    ]);
  });

  test("launches in one tick stop at 3 per repo and 5 in all", async () => {
    const db = fixtureDb();
    const merged: Record<string, Pr[]> = {};
    for (const [repo, base] of [["1_mvp_sdlc", SDLC], ["1_mvp_prompt", PROMPT]] as const) {
      merged[`OlegShevtsov1/${repo}`] = [];
      for (let n = 1; n <= 4; n++) {
        factoryRun(db, `${repo}-${n}`, "completed", repo, ["delivered", `${base}/${n}`]);
        merged[`OlegShevtsov1/${repo}`].push({ url: `${base}/${n}`, title: `PILOT-${n}: something` });
      }
    }
    factoryRun(db, "running1", "running", "1_hrss_pilot");
    const f = fake(merged);

    await run(db, f);

    const perRepo = (base: string) => f.launches.filter((l) => l.argv.at(-1)?.includes(`pr=${base}/`)).length;
    expect(f.launches).toHaveLength(4);
    expect([perRepo(SDLC), perRepo(PROMPT)]).toEqual([3, 1]);
  });

  test("a PR merged before the cutoff is skipped and one at or after it launches once", async () => {
    const db = fixtureDb();
    factoryRun(db, "iiii0095", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/95`]);
    factoryRun(db, "iiii0096", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/96`]);
    const f = fake({
      "OlegShevtsov1/1_mvp_sdlc": [
        { url: `${SDLC}/95`, title: "PILOT-515: sdlc: before", mergedAt: "2026-11-01T05:59:59Z" },
        { url: `${SDLC}/96`, title: "PILOT-516: sdlc: at", mergedAt: "2026-11-01T06:00:00Z" },
      ],
    });

    await run(db, f);
    await run(db, f);

    expect(f.launches.map((l) => l.argv.at(-1))).toEqual([`run=C8.Tn pr=${SDLC}/96 part=C8.TnP516`]);
    expect(lines().map((l) => l.run_id)).toEqual(["iiii0096"]);
  });

  test("without post_merge.since the first start is the cutoff and a restart keeps it", async () => {
    const db = fixtureDb();
    const t0 = new Date("2026-12-01T00:00:00Z");
    factoryRun(db, "jjjj0097", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/97`]);
    factoryRun(db, "jjjj0098", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/98`]);
    const f = fake({
      "OlegShevtsov1/1_mvp_sdlc": [
        { url: `${SDLC}/97`, title: "PILOT-517: sdlc: before", mergedAt: "2026-11-30T23:00:00Z" },
        { url: `${SDLC}/98`, title: "PILOT-518: sdlc: after", mergedAt: "2026-12-01T01:00:00Z" },
      ],
    });
    const policy = { ...loadPolicy(POLICY), postMergeSince: undefined };
    const state = join(dir, "state.json");

    await run(db, f, policy, () => t0);
    const recorded = readFileSync(state, "utf8");
    expect(JSON.parse(recorded)).toEqual({ first_start: t0.toISOString() });
    expect(f.launches.map((l) => l.argv.at(-1))).toEqual([`run=C8.Tn pr=${SDLC}/98 part=C8.TnP518`]);

    await run(db, f, policy, () => new Date(t0.getTime() + 24 * 60 * 60 * 1000));
    expect(readFileSync(state, "utf8")).toBe(recorded);
    expect(f.launches).toHaveLength(1);
    expect(lines()).toHaveLength(1);
  });

  test("a post-merge run naming the PR in any form suppresses the launch", async () => {
    const db = fixtureDb();
    const merged: Pr[] = [];
    for (const n of [88, 89, 90, 91]) {
      factoryRun(db, `kkkk00${n}`, "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/${n}`]);
      merged.push({ url: `${SDLC}/${n}`, title: `PILOT-${n}: sdlc: something` });
    }
    factoryRun(db, "kkkk0009", "completed", "1_mvp_sdlc", ["delivered", `${SDLC}/9`]);
    merged.push({ url: `${SDLC}/9`, title: "PILOT-9: sdlc: something" });
    const sdlcCwd = "/home/operator/.archon/workspaces/OlegShevtsov1/1_mvp_sdlc/post-merge/20261101T000000Z-1/repo";
    const postMerges: [string, string][] = [
      [`post-merge for ${SDLC}/88/files`, sdlcCwd],
      ["OlegShevtsov1/1_mvp_sdlc#89", sdlcCwd],
      ["run=C8.Tn pr=#90", sdlcCwd],
      ["run=C8.Tn pr=#91", "/home/operator/.archon/workspaces/OlegShevtsov1/1_mvp_prompt/source"],
      [`run=C8.Tn pr=${SDLC}/92`, sdlcCwd],
    ];
    postMerges.forEach(([message, cwd], i) =>
      insertRun(db, { id: `pm${i}`, workflow_name: "post-merge", status: "completed", user_message: message, working_path: cwd }));
    const f = fake({ "OlegShevtsov1/1_mvp_sdlc": merged });

    await run(db, f);

    expect(f.launches.map((l) => l.argv.at(-1))).toEqual([
      `run=C8.Tn pr=${SDLC}/91 part=C8.TnP91`,
      `run=C8.Tn pr=${SDLC}/9 part=C8.TnP9`,
    ]);
  });

  test("the 17 pre-enable candidates of the first enable launch nothing", async () => {
    const db = fixtureDb();
    const prs: Record<string, number[]> = {
      "1_mvp_prompt": [154, 207],
      "1_mvp_pilot_fe": [44, 52, 55, 56],
      "1_mvp_pilot_be": [93, 98, 103, 114, 128],
      "1_mvp_sdlc": [46, 49, 51, 52, 55, 56],
    };
    const merged: Record<string, Pr[]> = {};
    let i = 0;
    for (const [repo, numbers] of Object.entries(prs)) {
      merged[`OlegShevtsov1/${repo}`] = numbers.map((n) => {
        const url = `https://github.com/OlegShevtsov1/${repo}/pull/${n}`;
        factoryRun(db, `${repo}-${n}`, "completed", repo, ["delivered", url]);
        return { url, title: `PILOT-${n}: something`, mergedAt: `2026-10-${18 + (i++ % 14)}T12:00:00Z` };
      });
    }
    const f = fake(merged);

    await run(db, f);

    expect(Object.values(merged).flat()).toHaveLength(17);
    expect(f.launches).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });
});

describe("post_merge.since", () => {
  const policyWith = (block: string) => {
    const path = join(dir, "policy.yaml");
    writeFileSync(path, readFileSync(POLICY, "utf8").replace(/^post_merge:\n.*\n/m, block));
    return path;
  };

  test("the shipped policy sets it and a policy without it uses the first start", () => {
    expect(loadPolicy(POLICY).postMergeSince?.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(loadPolicy(policyWith("")).postMergeSince).toBeUndefined();
  });

  test("a value without a time zone or not a string stops the start", () => {
    for (const since of ['"2026-11-01T06:00:00"', "5"]) {
      expect(() => loadPolicy(policyWith(`post_merge:\n  since: ${since}\n`))).toThrow(/post_merge.since/);
    }
  });
});
