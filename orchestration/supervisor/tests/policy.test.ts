import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadPolicy } from "../src/main.ts";
import { decide, gateRules } from "../src/policy.ts";
import { type Pause, readRuns, type RunView } from "../src/runs.ts";
import { FIXTURES, fixtureDb } from "./fixtures/db.ts";

const POLICY = loadPolicy(join(import.meta.dir, "..", "policy.yaml"));
const RUNS = readRuns(fixtureDb(...FIXTURES), 24);
const BLOCKER = "7bb98ecd-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCK_HEADING = "Крок: 3 — A3 — 🔒 Mirror sync (approved-by: decision-84)";

function view(prefix: string, pause: Partial<Pause> = {}): RunView {
  const run = RUNS.find((r) => r.id.startsWith(prefix));
  if (!run?.pause) throw new Error(`no paused fixture run ${prefix}`);
  return { ...run, pause: { ...run.pause, ...pause } };
}

const plan = (ready: boolean, openQuestions: string[]) => view("4a7a0367", { plan: { ready, openQuestions } });
const install = (pause: Partial<Pause> = {}) => view("ec459894", pause);
const postMerge = (edit: (text: string) => string) => {
  const run = view("c2154fea");
  return view("c2154fea", { text: edit(run.pause?.text ?? "") });
};
const lockStep = (text: string) => text.replace("Тип: checkout", "Тип: approval").replace(/^Крок: .*$/m, LOCK_HEADING);
const none = { activeFactoryRuns: [] };

describe("decide", () => {
  test("plan gate with only Non-blocking questions approves", () => {
    const approve = {
      action: "approve", rule: "plan-gate",
      text: "Approved by sdlc-autopilot policy plan-gate (ready, non-blocking only).",
    };
    expect(decide(view("4a7a0367"), POLICY, none)).toEqual(approve);
    expect(decide(plan(true, []), POLICY, none)).toEqual(approve);
  });

  test("plan gate with a blocking question escalates", () => {
    const d = decide(plan(true, ["Non-blocking: a", "Which database? (blocks)"]), POLICY, none);
    expect(d).toMatchObject({ action: "escalate", rule: "plan-gate" });
    expect(d.text).toContain("Which database?");
  });

  test("ready false escalates", () => {
    expect(decide(plan(false, []), POLICY, none)).toMatchObject({ action: "escalate", rule: "plan-gate" });
    expect(decide(view("4a7a0367", { plan: undefined }), POLICY, none))
      .toMatchObject({ action: "escalate", rule: "plan-gate" });
  });

  test("install gate retries while a factory run is active", () => {
    expect(decide(install(), POLICY, { activeFactoryRuns: [BLOCKER] }))
      .toMatchObject({ action: "retry", rule: "install-gate" });
    expect(decide(install(), POLICY, none)).toMatchObject({ action: "escalate", rule: "install-gate" });
    const unreadLine = "Блокують: перелік прогонів не прочитано";
    const unread = install({ text: install().pause?.text.replace(/^Блокують: .*$/m, unreadLine) });
    expect(decide(unread, POLICY, { activeFactoryRuns: [BLOCKER] }))
      .toMatchObject({ action: "escalate", rule: "install-gate" });
    const mixedLine = "Блокують: 7bb98ecd factory a/b; deadbeef post-merge a/b";
    const mixed = install({ text: install().pause?.text.replace(/^Блокують: .*$/m, mixedLine) });
    expect(decide(mixed, POLICY, { activeFactoryRuns: [BLOCKER] }))
      .toMatchObject({ action: "escalate", rule: "install-gate" });
  });

  test("install gate escalates after 4 retries", () => {
    const ctx = { activeFactoryRuns: [BLOCKER] };
    expect(decide(install({ iteration: 4 }), POLICY, ctx)).toMatchObject({ action: "retry" });
    const d = decide(install({ iteration: 5 }), POLICY, ctx);
    expect(d).toMatchObject({ action: "escalate", rule: "install-gate" });
    expect(d.text).toContain("4");
  });

  test("every post-merge lock step escalates, with or without approved-by", () => {
    const steps = [
      postMerge(lockStep),
      postMerge((t) => lockStep(t).replace(" (approved-by: decision-84)", "")),
      postMerge((t) => lockStep(t).replace(/^Причина: /m, "Причина: approved-by: decision-84. ")),
      postMerge((t) => `${lockStep(t)}\nClean up old RDS snapshots`),
    ];
    for (const run of steps) {
      const d = decide(run, POLICY, none);
      expect(d).toMatchObject({ action: "escalate", rule: "post-merge-gate" });
      expect(d.text).toContain("Mirror sync");
    }
  });

  test("checkout and mismatch escalate", () => {
    const checkout = decide(view("c2154fea"), POLICY, none);
    expect(checkout).toMatchObject({ action: "escalate", rule: "post-merge-gate" });
    expect(checkout.text).toContain("тип checkout");
    const mismatch = postMerge((t) => lockStep(t).replace("Тип: approval", "Тип: mismatch"));
    expect(decide(mismatch, POLICY, none)).toMatchObject({ action: "escalate", rule: "post-merge-gate" });
  });

  test("unknown pause escalates", () => {
    expect(decide(view("4a7a0367", { kind: "other" }), POLICY, none))
      .toMatchObject({ action: "escalate", rule: "default-escalate" });
    const noPlanRule = { ...POLICY, rules: POLICY.rules.filter((r) => (r as { id?: unknown }).id !== "plan-gate") };
    expect(decide(view("4a7a0367"), noPlanRule, none)).toMatchObject({ action: "escalate", rule: "default-escalate" });
  });
});

describe("gateRules", () => {
  test("gateRules rejects a malformed gate rule and ignores other ids", () => {
    expect(() => gateRules([{ id: "install-gate", max_retries: "4" }])).toThrow();
    const plan = { id: "plan-gate", approve_text: "ok", open_question_prefix: "Non-blocking" };
    expect(() => gateRules([plan, plan])).toThrow();
    expect(gateRules([{ id: "transient", anything: 1 }])).toEqual({});
  });
});
