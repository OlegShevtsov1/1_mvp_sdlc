import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderEscalation } from "../src/humanize.ts";
import { appendLedger } from "../src/ledger.ts";
import { loadPolicy } from "../src/main.ts";
import { decide, gateRules } from "../src/policy.ts";
import { type Pause, readRuns, type RunView } from "../src/runs.ts";
import { FIXTURES, fixtureDb } from "./fixtures/db.ts";

const POLICY = loadPolicy(join(import.meta.dir, "..", "policy.yaml"));
const RUNS = readRuns(fixtureDb(...FIXTURES, "post-merge-gate-8275c6ec.json"), 24);
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

// No test reads the host's ~/.archon or ledger.
let archonHome: string;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-policy-"));
  archonHome = join(dir, "archon");
  process.env.ARCHON_HOME = archonHome;
  process.env.SDLC_AUTOPILOT_LEDGER = join(dir, "ledger.jsonl");
});

type Steps = { preamble: string; steps: { n: string; title: string; text: string }[] };
const RELEASE_RUN = "8275c6ec";
const steps = (f: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", f), "utf8")) as Steps;
const RELEASE_SH = steps("steps-8275c6ec-release-sh.json");

// The v0.9.3 release run paused at step `n` with gate type `type`, its steps.json being `file`.
function release(n: string, type: string, file: Steps = RELEASE_SH, edit: (t: string) => string = (t) => t): RunView {
  const run = view(RELEASE_RUN);
  const dir = join(archonHome, "workspaces", "OlegShevtsov1", "1_mvp_sdlc", "artifacts", "runs", run.id);
  mkdirSync(dir, { recursive: true });
  const changed = { ...file, steps: file.steps.map((s) => (s.n === n ? { ...s, text: edit(s.text) } : s)) };
  writeFileSync(join(dir, "steps.json"), JSON.stringify(changed));
  const title = file.steps.find((s) => s.n === n)?.title ?? "";
  const text = (run.pause?.text ?? "").replace(/^Крок: .*$/m, `Крок: ${n} — ${title}`).replace(/^Тип: .*$/m, `Тип: ${type}`);
  return view(RELEASE_RUN, { text });
}
const extraLine = (line: string) => (t: string) => t.replace("\n```\n\nExpected:", `\n${line}\n\`\`\`\n\nExpected:`);
const SUBCOMMAND: Record<string, string> = { 1: "merge-release-pr", 2: "tag", 3: "mirror", 4: "install" };

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
    const html = renderEscalation({
      workflow: "post-merge", runId: install().id, repo: "OlegShevtsov1/1_mvp_sdlc", runMessage: "", kind: "install-gate",
      rule: d.rule, text: install().pause?.text ?? "", reason: d.text ?? "", prTitle: "", lastStep: "",
    }, { needsRevision: false });
    expect(html).toContain("<b>Що рекомендую:</b> натисни «Чекати ще»");
  });

  test("a post-merge lock step without a readable step definition escalates, with or without approved-by", () => {
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

  test("the release.sh A1–A4 approve, naming the matched entry of each command", () => {
    for (const n of ["1", "2", "3", "4"]) {
      const d = decide(release(n, "approval"), POLICY, none);
      expect(d).toMatchObject({ action: "approve", rule: "post-merge-allowlist" });
      expect(d.text).toStartWith("Approved by sdlc-autopilot policy post-merge-allowlist: cd ");
      expect(d.text).toContain("→ cd run worktree; git fetch origin --tags → read-only git fetch; ");
      expect(d.text).toContain(`bash scripts/release.sh ${SUBCOMMAND[n]} v0.9.3 → release.sh ${SUBCOMMAND[n]}`);
    }
    expect(decide(release("2", "manual"), POLICY, none)).toMatchObject({ action: "approve" });
  });

  test("a mismatch or checkout gate on an allowlisted step escalates", () => {
    for (const type of ["mismatch", "checkout", ""]) {
      const d = decide(release("2", type), POLICY, none);
      expect(d).toMatchObject({ action: "escalate", rule: "post-merge-gate" });
      expect(d.text).toContain("Annotated tag v0.9.3");
    }
  });

  test("a step that is not one release.sh line escalates, saying why", () => {
    const cases: [() => RunView, string][] = [
      [() => release("1", "approval", steps("steps-8275c6ec.json")), "не розібрано"],
      [() => release("2", "approval", steps("steps-8275c6ec.json")), "не розібрано"],
      [() => release("2", "approval", RELEASE_SH, extraLine("git push --force origin v0.9.3")), "«--force»"],
      [() => release("3", "approval", RELEASE_SH, extraLine("rm -rf /tmp/x")), "«rm»"],
      [() => release("1", "approval", RELEASE_SH, extraLine("gh pr merge 120 --merge")), "не в allowlist: gh pr merge"],
      [() => release("4", "approval", RELEASE_SH, extraLine("make deploy")), "не в allowlist: make deploy"],
    ];
    for (const [run, why] of cases) {
      const d = decide(run(), POLICY, none);
      expect(d).toMatchObject({ action: "escalate", rule: "post-merge-gate" });
      expect(d.text).toContain(why);
      expect(d.text).toEndWith(" — потрібне рішення оператора.");
    }
  });

  test("read-only lines mixed in still approve", () => {
    const run = release("2", "approval", RELEASE_SH, extraLine("gh pr view 111 -R o/r --json state | jq -r .state"));
    const d = decide(run, POLICY, none);
    expect(d).toMatchObject({ action: "approve", rule: "post-merge-allowlist" });
    expect(d.text).toContain("gh pr view 111 -R o/r --json state → read-only gh pr view; jq -r .state → read-only jq");
  });

  test("another repo, a missing steps.json, or no allowlist rule escalates", () => {
    const other = release("2", "approval");
    other.cwd = other.cwd.replace("/1_mvp_sdlc/", "/1_mvp_pilot_be/");
    expect(decide(other, POLICY, none)).toMatchObject({ action: "escalate", rule: "post-merge-gate" });
    const run = release("2", "approval");
    const noRule = { ...POLICY, rules: POLICY.rules.filter((r) => (r as { id?: unknown }).id !== "post-merge-allowlist") };
    expect(decide(run, noRule, none)).toMatchObject({ action: "escalate", rule: "post-merge-gate" });
    process.env.ARCHON_HOME = join(archonHome, "elsewhere");
    expect(decide(run, POLICY, none).text).toContain("визначення кроку не прочитано");
  });

  test("a step is approved at most once per run", () => {
    const run = release("4", "approval");
    const d = decide(run, POLICY, none);
    expect(d).toMatchObject({ action: "approve" });
    appendLedger({
      ts: "2026-11-01T08:00:00Z", run_id: run.id, workflow: run.workflow, kind: "post-merge-gate", rule: d.rule,
      action: d.action, evidence: { event_id: "earlier", node: run.pause?.node, text: run.pause?.text, message: d.text },
    });
    const again = decide(run, POLICY, none);
    expect(again).toMatchObject({ action: "escalate", rule: "post-merge-gate" });
    expect(again.text).toContain("крок уже раз схвалено автоматично");
    expect(decide(release("3", "approval"), POLICY, none)).toMatchObject({ action: "approve" });
  });

  test("pr-approve escalates as a card", () => {
    const run = readRuns(fixtureDb("pr-approve-7b3c1d2e.json"), 24)[0];
    expect(decide(run, POLICY, none)).toEqual({
      action: "escalate", rule: "pr-approve", text: "PR чекає апруву оператора — потрібне рішення оператора.",
    });
    const noRule = { ...POLICY, rules: POLICY.rules.filter((r) => (r as { id?: unknown }).id !== "pr-approve") };
    expect(decide(run, noRule, none)).toMatchObject({ action: "escalate", rule: "default-escalate" });
  });

  test("qa-dev escalates as a card", () => {
    const run = readRuns(fixtureDb("qa-dev-5e6f7a8b.json"), 24)[0];
    expect(decide(run, POLICY, none)).toEqual({
      action: "escalate", rule: "qa-dev", text: "Робота на dev чекає перевірки оператора — потрібне рішення оператора.",
    });
    const noRule = { ...POLICY, rules: POLICY.rules.filter((r) => (r as { id?: unknown }).id !== "qa-dev") };
    expect(decide(run, noRule, none)).toMatchObject({ action: "escalate", rule: "default-escalate" });
    expect(() => gateRules([{ id: "qa-dev", action: "ok" }])).toThrow("policy: rule qa-dev is malformed");
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
    expect(() => gateRules([{ id: "pr-approve", action: "approve" }])).toThrow("policy: rule pr-approve is malformed");
    expect(gateRules([{ id: "pr-approve", action: "escalate-as-card" }]))
      .toEqual({ "pr-approve": { id: "pr-approve", action: "escalate-as-card" } });
  });

  test("gateRules rejects a post-merge-allowlist that names what release.sh lacks or no repo", () => {
    const rule = { id: "post-merge-allowlist", repo: "o/r", subcommands: ["tag", "install"] };
    expect(gateRules([rule])).toEqual({ "post-merge-allowlist": rule });
    for (const bad of [
      { subcommands: ["tag", "deploy"] }, { subcommands: [] }, { subcommands: ["tag", "tag"] }, { subcommands: "tag" },
      { repo: "r" }, { repo: "o/r/x" }, { repo: undefined },
    ]) {
      expect(() => gateRules([{ ...rule, ...bad }])).toThrow();
    }
  });
});
