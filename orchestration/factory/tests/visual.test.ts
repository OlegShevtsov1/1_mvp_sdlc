import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FILES,
  ROUND_CAP,
  shotsVerdict,
  visualRound,
  visualScope,
  visualTurn,
} from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/visual.ts";

const SCRIPTS = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory", "scripts");
const PR_URL = "https://github.com/example/repo/pull/3";
const DELIVERY = { ready: true, reason: "delivered", pr_url: PR_URL, summary: "delivered" };
const DIR = "docs/screenshots/PILOT-279";
const HEAD = "a".repeat(40);
const ALL_SIX = [`${DIR}/home-desktop-light-data.png`, `${DIR}/home-mobile-dark-empty.png`];

describe("visualScope", () => {
  test("a ui layer without a visual reference is not ready and names the missing line", () => {
    const s = visualScope("PILOT-279: landing page\nLayer: ui.\n", "");
    expect(s.visual).toBe(true);
    expect(s.ready).toBe(false);
    expect(s.reason).toContain("Visual reference:");
    expect(s.reference).toBe("");
  });
  test("a dod-item visual reference makes a ui task ready and reaches the brief", () => {
    const s = visualScope("PILOT-279: landing page\nLayer: ui.\nDefinition of Done:\n- Visual reference: https://linear.app\n", "");
    expect(s).toMatchObject({ visual: true, ready: true, reason: "", reference: "https://linear.app" });
    expect(s.brief).toContain("https://linear.app");
    expect(s.brief).toContain(`${DIR}/`);
    for (const word of ["desktop", "mobile", "light", "dark", "data", "empty"]) expect(s.brief).toContain(word);
  });
  test("a brief that asks for a visual review is visual on any layer", () => {
    const s = visualScope("PILOT-12: report\nLayer: app.\n- Visual review: required\n", "");
    expect(s.visual).toBe(true);
    expect(s.ready).toBe(false);
  });
  test("a non-ui layer is not visual and adds nothing to the work order", () => {
    const s = visualScope("PILOT-12: endpoint\nLayer: app.\n", "");
    expect(s).toMatchObject({ visual: false, ready: true, reason: "", brief: "" });
  });
  test("prose that only mentions the words is not a ui task", () => {
    expect(visualScope("PILOT-12: tasks whose layer is ui get a visual review", "").visual).toBe(false);
  });
  test("the screenshots folder is named after the task's card", () => {
    expect(visualScope("PILOT-279: landing page\nLayer: ui.", "").screenshots_dir).toBe(DIR);
    expect(visualScope("", "PILOT-279: landing page").card).toBe("PILOT-279");
  });
  test("a task without a card uses no-card", () => {
    const s = visualScope("landing page\nLayer: ui.", "");
    expect(s.card).toBe("no-card");
    expect(s.screenshots_dir).toBe("docs/screenshots/no-card");
  });
});

describe("shotsVerdict", () => {
  const facts = { delivery: DELIVERY, files: ALL_SIX, body: `![home](${DIR}/home-desktop-light-data.png)`, dir: DIR, head: HEAD };

  test("no screenshot files is not ready", () => {
    const v = shotsVerdict({ ...facts, files: [] });
    expect(v.ready).toBe(false);
    expect(v.summary).toContain(`no screenshots under ${DIR}/ at ${HEAD}`);
  });
  test("a revision that ended not ready is not ready and quotes its reason", () => {
    const v = shotsVerdict({ ...facts, delivery: { ...DELIVERY, ready: false, reason: "review_open", summary: "two findings open" } });
    expect(v.ready).toBe(false);
    expect(v.summary).toContain("the revision ended not ready (review_open): two findings open");
  });
  test("every variant shot and embedded is ready with nothing to note", () => {
    const v = shotsVerdict(facts);
    expect(v.ready).toBe(true);
    expect(v.summary).toBe("2 screenshots, every variant covered, embedded in the PR body");
  });
  test("a missing variant is listed but does not block", () => {
    const v = shotsVerdict({ ...facts, files: [`${DIR}/home-desktop-light-data.png`, `${DIR}/home-mobile-dark-data.png`] });
    expect(v.ready).toBe(true);
    expect(v.summary).toContain("no file name contains: empty");
  });
  test("a PR body that does not embed the folder is listed but does not block", () => {
    const v = shotsVerdict({ ...facts, body: "## Problem\nno images" });
    expect(v.ready).toBe(true);
    expect(v.summary).toContain(`the PR body does not mention ${DIR}/`);
    expect(shotsVerdict({ ...facts, body: null }).summary).toContain(`the PR body does not mention ${DIR}/`);
  });
  test("links use the pull request's owner/repo and the head commit", () => {
    const v = shotsVerdict(facts);
    expect(v.pr_url).toBe(PR_URL);
    expect(v.pr_number).toBe(3);
    expect(v.links).toBe(ALL_SIX.map((f) => `- https://github.com/example/repo/blob/${HEAD}/${f}?raw=true`).join("\n"));
  });
  test("a delivery without a GitHub pull request URL is not ready and prints no link", () => {
    const v = shotsVerdict({ ...facts, delivery: { ...DELIVERY, pr_url: "" } });
    expect(v.ready).toBe(false);
    expect(v.links).toBe("");
  });
});

describe("visualTurn", () => {
  test("the first round revises nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-visual-turn-"));
    expect(visualTurn(dir, JSON.stringify(DELIVERY))).toEqual({ round: 1, revise: false, feedback: "", pr_number: 3 });
  });
  test("after a needs-revision answer the next round revises with the operator's words", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-visual-turn-"));
    writeFileSync(join(dir, "visual-gate.decisions"), "needs-revision\n");
    writeFileSync(join(dir, "visual-gate.decision"), "needs-revision");
    writeFileSync(join(dir, "visual-gate.text"), "make the header blue");
    expect(visualTurn(dir, JSON.stringify(DELIVERY))).toEqual({
      round: 2, revise: true, feedback: "make the header blue", pr_number: 3,
    });
  });
});

describe("visualRound", () => {
  const readyShots = JSON.stringify({ ready: true, summary: "2 screenshots" });
  const base = { visual: "true", gate: '{"decision":"approve","text":""}', saved: null, shots: readyShots, delivery: JSON.stringify(DELIVERY) };

  test("a task that is not visual proceeds without a gate", () => {
    expect(visualRound({ ...base, visual: "false", gate: "", shots: null })).toEqual({
      proceed: true, decision: "none", stop_reason: "", pr_url: PR_URL,
    });
  });
  test("approve on a ready round proceeds", () => {
    expect(visualRound(base)).toEqual({ proceed: true, decision: "approve", stop_reason: "", pr_url: PR_URL });
  });
  test("approve without a shots file refuses", () => {
    const v = visualRound({ ...base, shots: null });
    expect(v.proceed).toBe(false);
    expect(v.stop_reason).toBe("approved, but the visual round was not ready: no visual-shots.json was written");
  });
  test("approve on a round that was not ready refuses with its summary", () => {
    const v = visualRound({ ...base, shots: JSON.stringify({ ready: false, summary: `no screenshots under ${DIR}/` }) });
    expect(v).toMatchObject({ proceed: false, decision: "approve" });
    expect(v.stop_reason).toBe(`approved, but the visual round was not ready: no screenshots under ${DIR}/`);
  });
  test("abort stops with the operator's words", () => {
    expect(visualRound({ ...base, gate: '{"decision":"abort","text":"too dark"}' })).toEqual({
      proceed: false, decision: "abort", stop_reason: "operator chose abort: too dark", pr_url: PR_URL,
    });
  });
  test("the saved decision and text win over the loop output (PILOT-217)", () => {
    const v = visualRound({ ...base, gate: '{"round":1,"revise":false}', saved: { decision: "abort", text: "later" } });
    expect(v).toMatchObject({ proceed: false, decision: "abort", stop_reason: "operator chose abort: later" });
    expect(visualRound({ ...base, gate: '{"round":1}', saved: { decision: "approve", text: "" } }).proceed).toBe(true);
  });
  test("needs-revision after the last round stops with the cap", () => {
    const v = visualRound({ ...base, saved: { decision: "needs-revision", text: "bigger logo" } });
    expect(v).toMatchObject({ proceed: false, decision: "needs-revision" });
    expect(v.stop_reason).toBe(`operator chose needs-revision after the last visual round (${ROUND_CAP}): bigger logo`);
  });
});

function sh(cmd: string, cwd: string, env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bash", "-c", cmd], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("visual-shots.ts", () => {
  function repo(files: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "factory-visual-shots-"));
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), "");
    }
    sh("git init -q && git add -A && git -c user.email=t@e.com -c user.name=t commit -q --allow-empty -m shots", dir);
    return dir;
  }

  test("emits the committed screenshots as links at HEAD and writes visual-shots.json", () => {
    const cwd = repo([...ALL_SIX, `${DIR}/notes.txt`]);
    const artifacts = mkdtempSync(join(tmpdir(), "factory-visual-art-"));
    writeFileSync(join(artifacts, "pr-body.md"), `![home](${DIR}/home-desktop-light-data.png)\n`);
    const head = sh("git rev-parse HEAD", cwd).out.trim();
    const r = sh(`bun ${SCRIPTS}/visual-shots.ts`, cwd, {
      ARTIFACTS_DIR: artifacts, INPUTS_REVISION: "", INPUTS_INITIAL: JSON.stringify(DELIVERY), INPUTS_SCREENSHOTS_DIR: DIR,
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out).toMatchObject({ ready: true, pr_url: PR_URL, pr_number: 3, head });
    expect(out.links).toBe(ALL_SIX.map((f) => `- https://github.com/example/repo/blob/${head}/${f}?raw=true`).join("\n"));
    const saved = JSON.parse(readFileSync(join(artifacts, "visual-shots.json"), "utf8"));
    expect(saved).toMatchObject({ ready: true, pr_url: PR_URL, head, files: ALL_SIX });
    expect(readFileSync(join(artifacts, "visual.log"), "utf8")).toContain("ready=true");
  });

  test("a round never leaves the previous round's visual-shots.json behind", () => {
    const cwd = repo(ALL_SIX);
    const artifacts = mkdtempSync(join(tmpdir(), "factory-visual-art-"));
    const stale = join(artifacts, "visual-shots.json");
    writeFileSync(stale, JSON.stringify({ ready: true, pr_url: PR_URL, head: HEAD, files: ALL_SIX, summary: "round 1" }));
    chmodSync(stale, 0o444);
    const r = sh(`bun ${SCRIPTS}/visual-shots.ts`, cwd, {
      ARTIFACTS_DIR: artifacts,
      INPUTS_REVISION: JSON.stringify({ ...DELIVERY, ready: false, reason: "ci_pr_caused", summary: "tests red" }),
      INPUTS_INITIAL: JSON.stringify(DELIVERY),
      INPUTS_SCREENSHOTS_DIR: DIR,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(stale, "utf8")).ready).toBe(false);
  });

  test("a revision's report wins over the initial delivery", () => {
    const cwd = repo(ALL_SIX);
    const artifacts = mkdtempSync(join(tmpdir(), "factory-visual-art-"));
    const r = sh(`bun ${SCRIPTS}/visual-shots.ts`, cwd, {
      ARTIFACTS_DIR: artifacts,
      INPUTS_REVISION: JSON.stringify({ ...DELIVERY, ready: false, reason: "ci_pr_caused", summary: "tests red" }),
      INPUTS_INITIAL: JSON.stringify(DELIVERY),
      INPUTS_SCREENSHOTS_DIR: DIR,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ready: false, summary: expect.stringContaining("(ci_pr_caused): tests red") });
  });
});

describe("factory.yaml conformance", () => {
  type Node = { id: string; loop_group?: { until_bash: string; max_iterations: number; nodes: Node[] }; wait?: { attention: string } };
  const workflow = Bun.YAML.parse(
    readFileSync(join(SCRIPTS, "..", "factory.yaml"), "utf8"),
  ) as { nodes: Node[] };
  const cycle = workflow.nodes.find((n) => n.id === "visual-cycle")!.loop_group!;

  test("the visual-cycle loop saves the gate files visual.ts reads", () => {
    for (const name of [FILES.decision, FILES.text, FILES.decisions]) {
      expect(cycle.until_bash).toContain(`"$ARTIFACTS_DIR/${name}"`);
    }
  });

  test("the visual-cycle loop caps rounds at ROUND_CAP, one below max_iterations", () => {
    expect(cycle.until_bash.endsWith(`-ge ${ROUND_CAP}`)).toBe(true);
    expect(cycle.max_iterations).toBe(ROUND_CAP + 1);
    const attention = cycle.nodes.find((n) => n.id === "visual-gate")!.wait!.attention;
    expect(attention).toContain(`of ${ROUND_CAP}.`);
    expect(attention).toContain(`answer in round ${ROUND_CAP}`);
  });
});
