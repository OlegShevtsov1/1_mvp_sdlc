import { describe, expect, test } from "bun:test";
import { readRuns } from "../src/runs.ts";
import { FIXTURES, fixtureDb, insertEvent, insertRun } from "./fixtures/db.ts";

describe("readRuns", () => {
  test("classifies paused plan gate / install gate / post-merge gate from events", () => {
    const runs = readRuns(fixtureDb(...FIXTURES), 24);
    const pause = (prefix: string) => runs.find((r) => r.id.startsWith(prefix))?.pause;

    const plan = pause("4a7a0367");
    expect(plan).toMatchObject({
      kind: "plan-gate", node: "plan-cycle.plan-gate", eventId: "d6a22205-db96-458e-bc4e-9cb47d316fff",
    });
    expect(plan?.text).toContain("Ready to build: true");
    expect(plan).toMatchObject({ occurrence: "9b4fd859-c1f4-49c7-a3f4-fe5c4bf1dbc7", iteration: 1 });
    expect(plan?.plan?.ready).toBe(true);
    expect(plan?.plan?.openQuestions).toHaveLength(2);
    expect(plan?.plan?.openQuestions.every((q) => q.startsWith("Non-blocking"))).toBe(true);

    const install = pause("ec459894");
    expect(install).toMatchObject({
      kind: "install-gate", node: "install-cycle.install-gate", eventId: "605b2e52-dac0-43e2-a2ce-278af04d9dce",
    });
    expect(install?.text).toContain("встановлення чекає");
    expect(install).toMatchObject({ occurrence: "a97da343-d733-48d8-ad18-6f73c2be65b3", iteration: 1 });
    expect(install?.plan).toBeUndefined();

    const postMerge = pause("c2154fea");
    expect(postMerge).toMatchObject({
      kind: "post-merge-gate", node: "execute-cycle.gate", eventId: "d13280fe-8b0d-4de6-a014-87abfce50625",
    });
    expect(postMerge?.text).toContain("Тип: checkout");
    expect(postMerge?.text).not.toContain("Тип: mismatch");
    expect(postMerge).toMatchObject({ occurrence: "c968c8ad-4ca9-4e01-b5d3-a4273190566c", iteration: 9 });

    const factory = runs.find((r) => r.id.startsWith("4a7a0367"));
    expect(factory).toMatchObject({ workflow: "factory", status: "paused" });
    expect(factory?.cwd).toContain("task-factory-");
    expect(factory?.message).toContain("PILOT-499");
    expect(factory?.owner).toEqual({ host: "operator-host", pid: 2810274 });
  });

  test("pause carries its declared decisions", () => {
    const runs = readRuns(fixtureDb(...FIXTURES), 24);
    const decisions = (prefix: string) => runs.find((r) => r.id.startsWith(prefix))?.pause?.decisions;
    expect(decisions("c2154fea")).toEqual([
      { id: "approve", label: "Approve — виконати/прийняти" },
      { id: "skip", label: "Skip — пропустити крок" },
      { id: "abort", label: "Abort — зупинити" },
    ]);
    expect(decisions("ec459894")).toEqual([
      { id: "retry", label: "Retry — чекати знову" },
      { id: "abort", label: "Abort — не встановлювати" },
    ]);
    expect(decisions("4a7a0367")).toEqual([
      { id: "approve", label: "Approve" },
      { id: "needs-revision", label: "Needs revision" },
      { id: "abort", label: "Abort" },
    ]);
  });

  test("plan output is the newest plan node before the pause", () => {
    const db = fixtureDb(...FIXTURES);
    const run = "4a7a0367-d50c-4828-95e1-3d36b9a736bb";
    const planNode = (id: string, event_order: number) => insertEvent(db, {
      id, workflow_run_id: run, event_order, event_type: "node_completed", step_name: "plan-cycle.plan__plan",
      data: JSON.stringify({
        node: { id: "plan__plan", kind: "agent" },
        node_output: JSON.stringify({ ready: false, open_questions: [], summary: "s", report: {} }),
      }),
    });
    planNode("older-plan", 100);
    planNode("after-the-pause", 999999);

    const plan = readRuns(db, 24).find((r) => r.id === run)?.pause?.plan;
    expect(plan?.ready).toBe(true);
    expect(plan?.openQuestions).toHaveLength(2);
  });

  test("malformed plan output leaves the plan unread", () => {
    const run = "4a7a0367-d50c-4828-95e1-3d36b9a736bb";
    const outputs = [
      { ready: true },
      { ready: true, open_questions: "x" },
      { ready: true, open_questions: [1] },
      { ready: "true", open_questions: [] },
    ];
    for (const output of outputs) {
      const db = fixtureDb(...FIXTURES);
      insertEvent(db, {
        id: "malformed-plan", workflow_run_id: run, event_order: 346845, event_type: "node_completed",
        step_name: "plan-cycle.plan__plan",
        data: JSON.stringify({ node: { id: "plan__plan", kind: "agent" }, node_output: JSON.stringify(output) }),
      });
      const pause = readRuns(db, 24).find((r) => r.id === run)?.pause;
      expect(pause?.kind).toBe("plan-gate");
      expect(pause?.plan).toBeUndefined();
    }
  });

  test("a pause's iteration is its innermost loop's", () => {
    const db = fixtureDb(...FIXTURES);
    const run = "ec459894-e870-46d3-a37a-bed2af487528";
    insertEvent(db, {
      id: "nested-suspension", workflow_run_id: run, event_order: 999999, event_type: "node_suspended",
      step_name: "outer.install-cycle.install-gate", data: JSON.stringify({
        node: { id: "install-gate", kind: "gate" },
        invocation: { loopPath: [{ groupId: "outer", iteration: 7 }, { groupId: "install-cycle", iteration: 3 }] },
      }),
    });
    expect(readRuns(db, 24).find((r) => r.id === run)?.pause).toMatchObject({
      eventId: "nested-suspension", kind: "install-gate", iteration: 3,
    });
  });

  test("reads lastError of a failed run and cancelReason of a cancelled run", () => {
    const db = fixtureDb();
    insertRun(db, {
      id: "failed-run", workflow_name: "factory", user_message: "m", status: "failed",
      metadata: JSON.stringify({ execution_owner: { host: "h", pid: 42, uid: 1000 } }),
    });
    insertEvent(db, {
      id: "e1", workflow_run_id: "failed-run", event_order: 1, event_type: "workflow_failed", step_name: null,
      data: JSON.stringify({ error: "Node 'implement' timed out" }), created_at: "2026-10-31 10:31:16",
    });
    insertRun(db, { id: "cancelled-run", workflow_name: "factory", user_message: "m", status: "cancelled" });
    insertEvent(db, {
      id: "e2", workflow_run_id: "cancelled-run", event_order: 2, event_type: "workflow_cancelled", step_name: null,
      data: JSON.stringify({ reason: "Run stopped — Not delivered: review", cancel_reason: "halt_node" }),
    });

    const runs = readRuns(db, 24);
    const failed = runs.find((r) => r.id === "failed-run");
    const cancelled = runs.find((r) => r.id === "cancelled-run");
    expect(failed?.lastError).toBe("Node 'implement' timed out");
    expect(cancelled?.cancelReason).toBe("Run stopped — Not delivered: review");
    expect(failed?.failure).toEqual({ eventId: "e1", at: "2026-10-31 10:31:16" });
    expect(failed?.owner).toEqual({ host: "h", pid: 42 });
    expect(cancelled?.failure).toBeUndefined();
    expect(cancelled?.owner).toBeUndefined();
    expect(failed?.pause).toBeUndefined();
    expect(cancelled?.pause).toBeUndefined();
  });

  test("finished runs older than sinceHours are left out, paused runs are not", () => {
    const db = fixtureDb(...FIXTURES);
    insertRun(db, {
      id: "old-completed", workflow_name: "factory", user_message: "m", status: "completed",
      last_activity_at: "2026-01-01 00:00:00",
    });
    insertRun(db, { id: "fresh-completed", workflow_name: "factory", user_message: "m", status: "completed" });

    const ids = readRuns(db, 1).map((r) => r.id);
    expect(ids).not.toContain("old-completed");
    expect(ids).toContain("fresh-completed");
    for (const prefix of ["4a7a0367", "ec459894", "c2154fea"]) {
      expect(ids.some((id) => id.startsWith(prefix))).toBe(true);
    }
  });
});
