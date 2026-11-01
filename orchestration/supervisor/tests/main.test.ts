import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Decision, respondArgv, runDetached } from "../src/act.ts";
import type { LedgerEntry } from "../src/ledger.ts";
import { loadPolicy, tick } from "../src/main.ts";
import { gateRules } from "../src/policy.ts";
import { readRuns, type RunView } from "../src/runs.ts";
import { FIXTURES, fixtureDb, insertEvent, insertRun } from "./fixtures/db.ts";

const POLICY = join(import.meta.dir, "..", "policy.yaml");
const PLAN_RUN = "4a7a0367-d50c-4828-95e1-3d36b9a736bb";
const INSTALL_RUN = "ec459894";
const BLOCKER = "7bb98ecd-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let dir: string;
let ledger: string;
let calls: [string, Decision["action"]][];
const respond = (run: RunView, d: Decision) => {
  calls.push([run.id, d.action]);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supervisor-main-"));
  ledger = join(dir, "ledger.jsonl");
  process.env.SDLC_AUTOPILOT_LEDGER = ledger;
  calls = [];
});

const lines = (): LedgerEntry[] =>
  existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

describe("tick", () => {
  test("first tick handles pre-existing pauses", async () => {
    await tick({ db: fixtureDb(...FIXTURES), policy: loadPolicy(POLICY), respond });

    const byRun = new Map(lines().map((l) => [l.run_id.slice(0, 8), l]));
    expect(lines()).toHaveLength(3);
    // The install gate's blocker 7bb98ecd is not a run in the fixture database, so it is not an active factory.
    const want = {
      "4a7a0367": ["plan-gate", "approve", "d6a22205-db96-458e-bc4e-9cb47d316fff"],
      ec459894: ["install-gate", "escalate", "605b2e52-dac0-43e2-a2ce-278af04d9dce"],
      c2154fea: ["post-merge-gate", "escalate", "d13280fe-8b0d-4de6-a014-87abfce50625"],
    };
    for (const [run, [kind, action, eventId]] of Object.entries(want)) {
      expect(byRun.get(run)).toMatchObject({ action, rule: kind, kind, evidence: { event_id: eventId } });
    }
    expect(byRun.get("c2154fea")?.evidence.message).toContain("схвалює лише оператор");
    expect(calls).toEqual([[PLAN_RUN, "approve"]]);
  });

  test("actions are idempotent per pause event", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, respond });
    await tick({ db, policy, respond });
    expect(lines()).toHaveLength(3);
    expect(calls).toHaveLength(1);

    insertEvent(db, {
      id: "re-pause-at-plan-gate", workflow_run_id: PLAN_RUN, event_order: 999999, event_type: "node_suspended",
      step_name: "plan-cycle.plan-gate", data: JSON.stringify({ node: { id: "plan-gate", kind: "wait" } }),
    });
    await tick({ db, policy, respond });
    expect(lines()).toHaveLength(4);
    expect(lines()[3]).toMatchObject({ run_id: PLAN_RUN, evidence: { event_id: "re-pause-at-plan-gate" } });

    await tick({ db, policy, respond });
    expect(lines()).toHaveLength(4);
    expect(calls).toHaveLength(2);
  });

  test("install gate is retried only while its blocking factory run is open", async () => {
    const policy = loadPolicy(POLICY);
    const install = () => lines().find((l) => l.run_id.startsWith(INSTALL_RUN));
    for (const [status, action] of [["running", "retry"], ["completed", "escalate"]] as const) {
      writeFileSync(ledger, "");
      calls = [];
      const db = fixtureDb(...FIXTURES);
      insertRun(db, { id: BLOCKER, workflow_name: "factory", user_message: "m", status });
      await tick({ db, policy, respond });
      expect(install()).toMatchObject({ action, rule: "install-gate" });
      expect(calls.some(([run, a]) => run.startsWith(INSTALL_RUN) && a === "retry")).toBe(action === "retry");
    }
  });

  test("a respond that throws is recorded as an escalation", async () => {
    const db = fixtureDb(...FIXTURES);
    const policy = loadPolicy(POLICY);
    const failing = () => {
      throw new Error("spawn failed");
    };
    await tick({ db, policy, respond: failing });
    expect(lines().find((l) => l.run_id === PLAN_RUN)).toMatchObject({ action: "escalate", rule: "plan-gate" });

    await tick({ db, policy, respond: failing });
    expect(lines()).toHaveLength(3);
  });
});

describe("loadPolicy", () => {
  test("loadPolicy reads the shipped policy and rejects a file without version", () => {
    expect(loadPolicy(POLICY).rules).toContainEqual(expect.objectContaining({ id: "transient-resume" }));
    expect(Object.keys(gateRules(loadPolicy(POLICY).rules)).sort())
      .toEqual(["install-gate", "plan-gate", "post-merge-allowlist"]);
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "rules: []\n");
    expect(() => loadPolicy(bad)).toThrow();
  });
});

describe("respondArgv", () => {
  test("respondArgv answers the pause's occurrence", () => {
    const run = readRuns(fixtureDb(...FIXTURES), 24).find((r) => r.id === PLAN_RUN);
    if (!run) throw new Error("no plan fixture run");
    expect(respondArgv(run, { action: "approve", rule: "plan-gate", text: "ok" })).toEqual([
      "archon", "workflow", "respond", PLAN_RUN, "approve", "ok",
      "--occurrence", "9b4fd859-c1f4-49c7-a3f4-fe5c4bf1dbc7",
    ]);
    for (const action of ["retry", "skip", "abort"] as const) {
      expect(respondArgv(run, { action, rule: "operator", text: "again" })[4]).toBe(action);
    }
    expect(() => respondArgv(run, { action: "escalate", rule: "plan-gate", text: "" })).toThrow();
    const unpinned = { ...run, pause: run.pause && { ...run.pause, occurrence: "" } };
    expect(() => respondArgv(unpinned, { action: "approve", rule: "plan-gate", text: "ok" })).toThrow();
  });
});

describe("runDetached", () => {
  test("runDetached starts the command in its own session with stdin /dev/null", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "supervisor-cwd-"));
    const log = join(dir, "logs", "detached.log");
    runDetached(["sh", "-c", 'echo pid=$$ sid=$(ps -o sid= -p $$ | tr -d " "); readlink /proc/$$/fd/0; pwd'], cwd, log);

    let out = "";
    for (let i = 0; i < 50 && out.split("\n").filter(Boolean).length < 3; i++) {
      await Bun.sleep(100);
      out = existsSync(log) ? readFileSync(log, "utf8") : "";
    }
    const [ids, stdin, pwd] = out.split("\n");
    const m = ids.match(/^pid=(\d+) sid=(\d+)$/);
    expect(m?.[1]).toBe(m?.[2]);
    expect(stdin).toBe("/dev/null");
    expect(pwd).toBe(cwd);
  });
});
