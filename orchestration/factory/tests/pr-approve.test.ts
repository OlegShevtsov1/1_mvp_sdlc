import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILES, ROUND_CAP, approvalMessage, isBookkeeping, prSummary, roundVerdict, scopeVerdict, turnFor, untilVerdict,
  watchStep, type Facts, type Paused,
} from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/approval.ts";

const PACK = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory");
const SCRIPT = join(PACK, "scripts", "pr-approve.ts");
const PR_URL = "https://github.com/example/repo/pull/3";
const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

const facts: Facts = {
  ready: true, reason: "", pr_url: PR_URL, pr_number: 3, head_sha: SHA, files: 3, additions: 10, deletions: 2,
  checks_pass: 2, summary: "Adds the health endpoint. It answers 200.", regated: false,
};
const paused = (over: Partial<Paused> = {}): Paused => ({ round: 1, pr_url: PR_URL, head_sha: SHA, ready: true, reason: "", ...over });

function artifacts(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pr-approve-art-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const operatorScope = (pr: { title: string; files: string[] } | null) => {
  let read = 0;
  const verdict = scopeVerdict({
    mergeApproval: "operator", alreadyMerged: false, readPr: () => (read++, pr), gatedSha: () => SHA,
  });
  return { verdict, read };
};

// Below the cap the round never reads the live head: until already refused a head that moved.
const roundOf = (i: Omit<Parameters<typeof roundVerdict>[0], "answers" | "liveHead"> & Partial<Parameters<typeof roundVerdict>[0]>) =>
  roundVerdict({ answers: 1, liveHead: () => { throw new Error("the live head was read below the cap"); }, ...i });

describe("pr-approve logic", () => {
  test("operator mode pauses instead of merging", () => {
    const { verdict } = operatorScope({ title: "PILOT-9: add health", files: ["app/health.rb"] });
    expect(verdict).toEqual({ pause: true, reason: "merge_approval operator", gated_sha: SHA });
    // An unreadable pull request is an unknown state: the operator decides.
    expect(operatorScope(null).verdict.pause).toBe(true);
    const lines = approvalMessage(facts, 1).split("\n");
    expect(lines[0]).toBe(`PR APPROVAL — round 1 of ${ROUND_CAP}.`);
    expect(lines.filter((l) => /^[A-Z][A-Za-z]*: /.test(l))).toEqual([
      `PR: ${PR_URL}`,
      `Head: ${SHA}`,
      "Diff: 3 files, +10 −2",
      "Checks: 2 pass",
      "Review: ready",
      "Summary: Adds the health endpoint. It answers 200.",
    ]);
  });

  test("a round that is not ready says why on its Review line, in one line", () => {
    const message = approvalMessage({ ...facts, ready: false, reason: "merge-gate: failure:\ntests red" }, 2);
    expect(message.split("\n")).toContain("Review: not ready — merge-gate: failure: tests red");
  });

  test("auto mode merges as today", () => {
    let calls = 0;
    const verdict = scopeVerdict({
      mergeApproval: "auto", alreadyMerged: false, readPr: () => (calls++, null), gatedSha: () => (calls++, SHA),
    });
    expect(verdict).toEqual({ pause: false, reason: "merge_approval auto", gated_sha: "" });
    expect(calls).toBe(0);
    expect(roundOf({ scope: JSON.stringify(verdict), gate: "", saved: null, paused: null })).toEqual({
      proceed: true, decision: "none", head_sha: "", approved_by: "merge_approval auto", stop_reason: "",
    });
  });

  test("a pull request already merged at this run's head does not pause", () => {
    const verdict = scopeVerdict({ mergeApproval: "operator", alreadyMerged: true, readPr: () => null, gatedSha: () => SHA });
    expect(verdict.pause).toBe(false);
  });

  test("approve merges the paused head", () => {
    const scope = JSON.stringify({ pause: true, reason: "merge_approval operator", gated_sha: SHA });
    expect(roundOf({ scope, gate: "", saved: { decision: "approve", text: "" }, paused: paused({ head_sha: NEW_SHA }) })).toEqual({
      proceed: true, decision: "approve", head_sha: NEW_SHA, approved_by: "operator", stop_reason: "",
    });
    // The dry run's loop output, when until never saved an answer.
    expect(roundOf({ scope, gate: JSON.stringify({ decision: "approve", text: "" }), saved: null, paused: paused() }).head_sha).toBe(SHA);
    expect(untilVerdict({ decision: "approve", answers: 1, paused: paused(), liveHead: () => SHA }).end).toBe(true);
  });

  test("the last round says that a reject or a new commit ends the run", () => {
    expect(approvalMessage(facts, ROUND_CAP - 1)).toContain("this run delivers it on the same pull request and asks again");
    const last = approvalMessage(facts, ROUND_CAP);
    expect(last).not.toContain("asks again");
    expect(last).toContain("reject  → this is the last round: the run stops without merging");
    expect(last).toContain("A new commit needs a new approval: in this last round it stops the run.");
  });

  test("approve in the last round merges only the live head", () => {
    const scope = JSON.stringify({ pause: true });
    const saved = { decision: "approve", text: "" };
    expect(untilVerdict({ decision: "approve", answers: ROUND_CAP, paused: paused(), liveHead: () => NEW_SHA }).end).toBe(true);
    expect(roundOf({ scope, gate: "", saved, answers: ROUND_CAP, paused: paused(), liveHead: () => SHA })).toMatchObject({
      proceed: true, head_sha: SHA,
    });
    expect(roundOf({ scope, gate: "", saved, answers: ROUND_CAP, paused: paused(), liveHead: () => NEW_SHA })).toEqual({
      proceed: false, decision: "approve", head_sha: "", approved_by: "",
      stop_reason: `approved ${SHA} in the last approval round (${ROUND_CAP}), but the live head is ${NEW_SHA}; start a new run to approve its current head`,
    });
    expect(roundOf({ scope, gate: "", saved, answers: ROUND_CAP, paused: paused(), liveHead: () => null }).stop_reason)
      .toContain("the live head is unreadable");
  });

  test("approve on a stale head refuses and re-asks", () => {
    expect(untilVerdict({ decision: "approve", answers: 1, paused: paused(), liveHead: () => NEW_SHA })).toEqual({
      end: false, why: `approve of ${SHA}, but the live head is ${NEW_SHA}: asking again`,
    });
    expect(untilVerdict({ decision: "approve", answers: 1, paused: paused(), liveHead: () => null }).end).toBe(false);
    const dir = artifacts({ [FILES.decision]: "approve", [FILES.text]: "", [FILES.decisions]: "approve\n" });
    expect(turnFor(dir, PR_URL)).toEqual({ round: 2, revise: false, feedback: "", pr_number: 3 });
  });

  test("reject text starts a new round on the same PR", () => {
    expect(untilVerdict({ decision: "reject", answers: 1, paused: paused(), liveHead: () => SHA }).end).toBe(false);
    const dir = artifacts({ [FILES.decision]: "reject", [FILES.text]: "  rename the button\n", [FILES.decisions]: "reject\n" });
    expect(turnFor(dir, PR_URL)).toEqual({ round: 2, revise: true, feedback: "rename the button", pr_number: 3 });
  });

  test("a reject without text asks again and runs no round", () => {
    const dir = artifacts({ [FILES.decision]: "reject", [FILES.text]: "  ", [FILES.decisions]: "reject\n" });
    expect(turnFor(dir, PR_URL)).toEqual({ round: 2, revise: false, feedback: "", pr_number: 3 });
  });

  test("the cap ends a reject typed", () => {
    expect(untilVerdict({ decision: "reject", answers: ROUND_CAP, paused: paused(), liveHead: () => SHA }).end).toBe(true);
    const scope = JSON.stringify({ pause: true });
    expect(roundOf({ scope, gate: "", saved: { decision: "reject", text: "still wrong" }, paused: paused() })).toMatchObject({
      proceed: false, stop_reason: `operator chose reject after the last approval round (${ROUND_CAP}): still wrong`,
    });
  });

  test("approve of a round that was not ready stops, and so does a missing record", () => {
    const scope = JSON.stringify({ pause: true });
    const saved = { decision: "approve", text: "" };
    expect(untilVerdict({ decision: "approve", answers: 1, paused: paused({ ready: false }), liveHead: () => SHA }).end).toBe(true);
    expect(roundOf({ scope, gate: "", saved, paused: paused({ ready: false, reason: "CI check Tests is fail on the head" }) })).toMatchObject({
      proceed: false, stop_reason: "approved, but the pull request was not ready: CI check Tests is fail on the head",
    });
    expect(roundOf({ scope, gate: "", saved, paused: null }).proceed).toBe(false);
    expect(roundOf({ scope, gate: "", saved: { decision: "", text: "" }, paused: paused() }).stop_reason).toBe("operator chose nothing");
  });

  test("docs-only bookkeeping PR merges without a pause", () => {
    const files = ["docs/features/login/tasks/tasks.json", "docs/features/login/tasks/tracker.md"];
    const tracker = operatorScope({ title: "PILOT-12: login tracker — T3 done", files });
    expect(tracker.verdict).toEqual({ pause: false, reason: "bookkeeping: PILOT-12: login tracker — T3 done", gated_sha: "" });
    expect(isBookkeeping({ title: "docs(plan): E3 execution log", files: ["docs/superpowers/plans/releases.md"] })).toBe(true);
    // A stage docs PR touches the same files and needs the approval (E3 Task 5).
    expect(operatorScope({ title: "PILOT-12: login — tasks", files }).verdict.pause).toBe(true);
    // A bookkeeping title with a code change pauses too.
    expect(operatorScope({ title: "PILOT-12: login tracker — T3 done", files: [...files, "app/x.rb"] }).verdict.pause).toBe(true);
  });

  test("the summary is the body's first prose paragraph, at most three sentences", () => {
    const body = "## Problem\n<!-- template -->\n\nOne. Two!  Three?\nFour.\n\n## More\nignored\n\nType: feat\nRefs PILOT-1";
    expect(prSummary(body)).toBe("One. Two! Three?");
    expect(prSummary("## Only a heading\n- [ ] a task\nType: feat")).toBe("(no description)");
    expect(prSummary("x".repeat(400)).length).toBe(300);
  });

  test("the watcher checks the label only while the run is paused at its own pause", () => {
    const mine = { round: 1, head: SHA };
    const at = (status: string, bodyWaitId = "pr-approve", pauseId = "P") => ({ status, bodyWaitId, pauseId });
    expect(watchStep(null, at("running", ""), paused(), mine)).toEqual({ action: "wait", pauseId: null });
    expect(watchStep(null, null, paused(), mine)).toEqual({ action: "wait", pauseId: null });
    expect(watchStep(null, at("paused"), paused(), mine)).toEqual({ action: "check", pauseId: "P" });
    expect(watchStep("P", at("paused", "pr-approve", "Q"), paused(), mine).action).toBe("exit");
    expect(watchStep("P", at("completed"), paused(), mine).action).toBe("exit");
    expect(watchStep(null, at("paused"), paused({ round: 2, head_sha: NEW_SHA }), mine).action).toBe("exit");
  });
});

const rollup = (conclusion: string) =>
  JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "Tests", status: "COMPLETED", conclusion }] });
const GREEN_ROLLUP = rollup("SUCCESS");

// A fake `gh` and a fake `archon` first on PATH; each records its argv. gh answers the pull request
// read from FAKE_GH_PR (JSON), the checks from FAKE_GH_ROLLUP, the head read from FAKE_GH_HEAD, the label edit with FAKE_GH_EDIT_EXIT and FAKE_GH_EDIT_ERR.
// archon's `workflow get` prints FAKE_ARCHON_GET.
function fakeBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "pr-approve-bin-"));
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/gh.args"
case "$*" in
  *"--json headRefOid --jq .headRefOid") echo "\${FAKE_GH_HEAD:-}"; exit "\${FAKE_GH_HEAD_EXIT:-0}" ;;
  *"--json statusCheckRollup") printf '%s' "$FAKE_GH_ROLLUP" ;;
  "pr view "*) printf '%s' "\${FAKE_GH_PR:-}" ;;
  "pr edit "*) printf '%s' "\${FAKE_GH_EDIT_ERR:-}" >&2; exit "\${FAKE_GH_EDIT_EXIT:-0}" ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 1 ;;
esac
`);
  writeFileSync(join(dir, "archon"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/archon.args"
case "$1 $2" in
  "workflow get") printf '%s' "\${FAKE_ARCHON_GET:-}" ;;
  "workflow respond") exit 0 ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(dir, "gh"), 0o755);
  chmodSync(join(dir, "archon"), 0o755);
  return dir;
}

interface Ran { code: number; out: string; bin: string; dir: string }

function runScript(args: string[], env: Record<string, string>, opts: { dir?: string; cwd?: string } = {}): Ran {
  const bin = fakeBin();
  const dir = opts.dir ?? artifacts();
  const p = Bun.spawnSync(["bun", SCRIPT, ...args], {
    cwd: opts.cwd ?? dir,
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, ARTIFACTS_DIR: dir, ARCHON_CLI_COMMAND: JSON.stringify([join(bin, "archon")]),
      FAKE_GH_ROLLUP: GREEN_ROLLUP, ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, out: p.stdout.toString().trim(), bin, dir };
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const pr = (over: Record<string, unknown> = {}) => JSON.stringify({
  headRefOid: SHA, headRefName: "feature-x", state: "OPEN", body: "Adds it.", additions: 10, deletions: 2, changedFiles: 3,
  labels: [], ...over,
});

function git(cwd: string, args: string): string {
  const p = Bun.spawnSync(
    ["bash", "-c", `export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e.com; git ${args}`],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  return p.stdout.toString().trim();
}

// A checkout of feature-x and a bare origin; push() lands one more commit on feature-x from another clone.
function checkout(): { repo: string; head: string; push: () => string } {
  const remote = join(mkdtempSync(join(tmpdir(), "pr-approve-remote-")), "repo.git");
  mkdirSync(remote, { recursive: true });
  git(remote, "init -q --bare -b feature-x");
  const repo = mkdtempSync(join(tmpdir(), "pr-approve-repo-"));
  git(repo, `init -q -b feature-x && git remote add origin ${remote}`);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add -A && git commit -q -m a && git push -q origin feature-x");
  const push = () => {
    const other = mkdtempSync(join(tmpdir(), "pr-approve-other-"));
    git(other, `clone -q -b feature-x ${remote} .`);
    writeFileSync(join(other, "b.txt"), "b\n");
    git(other, "add -A && git commit -q -m b && git push -q origin feature-x");
    return git(other, "rev-parse HEAD");
  };
  return { repo, head: git(repo, "rev-parse HEAD"), push };
}

const FACTS_ENV = { INPUTS_MODE: "facts", INPUTS_PR_URL: PR_URL, INPUTS_REVISION: "", INPUTS_REMOTE: "origin" };

describe("pr-approve script", () => {
  test("facts on the gated head is ready and removes an earlier label before the pause", () => {
    const r = runScript([], { ...FACTS_ENV, INPUTS_GATED_SHA: SHA, FAKE_GH_PR: pr({ labels: [{ name: "operator-approved" }] }) });
    expect(JSON.parse(r.out)).toEqual({ ...facts, summary: "Adds it.", checks_pass: 1 });
    expect(read(join(r.bin, "gh.args"))).toContain(`pr edit ${PR_URL} --remove-label operator-approved`);
  });

  test("facts is not ready when the label cannot be removed, or a check is red", () => {
    const label = runScript([], { ...FACTS_ENV, INPUTS_GATED_SHA: SHA, FAKE_GH_EDIT_EXIT: "1", FAKE_GH_PR: pr({ labels: [{ name: "operator-approved" }] }) });
    expect(JSON.parse(label.out)).toMatchObject({ ready: false, reason: expect.stringContaining("could not be removed") });
    const r = runScript([], { ...FACTS_ENV, INPUTS_GATED_SHA: SHA, FAKE_GH_PR: pr(), FAKE_GH_ROLLUP: rollup("FAILURE") });
    expect(JSON.parse(r.out)).toMatchObject({ ready: false, reason: "CI check Tests is fail on the head" });
  });

  test("facts redacts the profile's secrets and the GitHub token from a command's stderr", () => {
    const r = runScript([], {
      ...FACTS_ENV, INPUTS_GATED_SHA: SHA, FAKE_GH_EDIT_EXIT: "1", FAKE_GH_PR: pr({ labels: [{ name: "operator-approved" }] }),
      INPUTS_SECRET_NAMES: JSON.stringify(["DEV_PASSWORD"]), DEV_PASSWORD: "hunter2-dev", GH_TOKEN: "ghp_faketoken",
      FAKE_GH_EDIT_ERR: "denied for hunter2-dev with ghp_faketoken",
    });
    const reason = JSON.parse(r.out).reason;
    expect(reason).toContain("could not be removed: denied for *** with ***");
    expect(read(join(r.dir, FILES.log))).not.toMatch(/hunter2-dev|ghp_faketoken/);
  });

  test("round after the last answer stops when the approved head is no longer the live one", () => {
    const round = (head: string) => {
      const dir = artifacts({
        [FILES.paused]: JSON.stringify(paused({ round: ROUND_CAP })), [FILES.decision]: "approve", [FILES.text]: "",
        [FILES.decisions]: "reject\n".repeat(ROUND_CAP - 1) + "approve\n",
      });
      return JSON.parse(runScript([], { INPUTS_MODE: "round", INPUTS_SCOPE: JSON.stringify({ pause: true }), INPUTS_GATE: "", FAKE_GH_HEAD: head }, { dir }).out);
    };
    expect(round(SHA)).toMatchObject({ proceed: true, head_sha: SHA });
    expect(round(NEW_SHA)).toMatchObject({ proceed: false, stop_reason: expect.stringContaining(`the live head is ${NEW_SHA}`) });
  });

  test("facts after a revision that ended not ready is not ready and reads nothing", () => {
    const r = runScript([], { ...FACTS_ENV, INPUTS_GATED_SHA: SHA, INPUTS_REVISION: JSON.stringify({ ready: false, reason: "replan", summary: "Round 2." }) });
    expect(JSON.parse(r.out)).toMatchObject({ ready: false, reason: "the revision ended not ready (replan): Round 2." });
    expect(read(join(r.bin, "gh.args"))).toBe("");
  });

  test("facts fast-forwards to a moved head and gates it again before asking", () => {
    const { repo, head, push } = checkout();
    const moved = push();
    // pr-body-sync reads the live body; with no pr-body file it skips, and pr-state's read below is
    // not this fake's, so the gate refuses: the head was fast-forwarded and the gate decided.
    const r = runScript([], { ...FACTS_ENV, INPUTS_GATED_SHA: head, FAKE_GH_PR: pr({ headRefOid: moved }) }, { cwd: repo });
    expect(git(repo, "rev-parse HEAD")).toBe(moved);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ ready: false, head_sha: moved });
    const logged = read(join(r.dir, FILES.log));
    for (const script of ["pr-body-sync.ts", "pr-state.ts", "merge-gate.ts"]) expect(logged).toContain(`${script}: {`);
    expect(doc.reason).toStartWith("merge-gate: ");
  }, 30_000);

  test("facts does not chase a head rewritten outside the run", () => {
    const { repo, head } = checkout();
    const r = runScript([], { ...FACTS_ENV, INPUTS_GATED_SHA: head, FAKE_GH_PR: pr({ headRefOid: NEW_SHA }) }, { cwd: repo });
    expect(JSON.parse(r.out)).toMatchObject({ ready: false, reason: expect.stringContaining(`is not the head GitHub reports; the head ${NEW_SHA} was not gated`) });
    expect(git(repo, "rev-parse HEAD")).toBe(head);
    expect(read(join(r.dir, FILES.log))).not.toContain("merge-gate.ts");
  });

  test("until saves the answer and exits 0 on the live head, 1 on a moved or unreadable one, 1 on a reject", () => {
    const record = JSON.stringify(paused());
    const until = (decision: string, text: string, env: Record<string, string>) => {
      const dir = artifacts({ [FILES.paused]: record });
      return runScript(["until", dir, decision, text], env, { dir });
    };
    const live = until("approve", "", { FAKE_GH_HEAD: SHA });
    expect(live.code).toBe(0);
    expect(read(join(live.dir, FILES.decision))).toBe("approve");
    expect(until("approve", "", { FAKE_GH_HEAD: NEW_SHA }).code).toBe(1);
    expect(until("approve", "", { FAKE_GH_HEAD_EXIT: "1" }).code).toBe(1);
    const rejected = until("reject", "it's $fine; \"q\"", {});
    expect(rejected.code).toBe(1);
    expect(read(join(rejected.dir, FILES.text))).toBe("it's $fine; \"q\"");
    expect(read(join(rejected.dir, FILES.decisions))).toBe("reject\n");
  });

  test("ask writes the paused head and, in a dry run, starts no watcher", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pr-approve-dry-")), "artifacts");
    mkdirSync(dir);
    const r = runScript([], { INPUTS_MODE: "ask", INPUTS_FACTS: JSON.stringify(facts), INPUTS_ROUND: "1", WORKFLOW_ID: "dry" }, { dir });
    const doc = JSON.parse(r.out);
    expect(doc.ready).toBe(true);
    expect(doc.message).toContain(`Head: ${SHA}`);
    expect(JSON.parse(read(join(dir, FILES.paused)))).toEqual({ round: 1, pr_url: PR_URL, head_sha: SHA, ready: true, reason: "" });
    expect(read(join(dir, FILES.log))).not.toContain("watcher");
  });

  const watchEnv = (get: object) => ({
    PR_APPROVE_RUN: "run-1", PR_APPROVE_URL: PR_URL, PR_APPROVE_HEAD: SHA, PR_APPROVE_ROUND: "1", PR_APPROVE_POLL_MS: "50",
    PR_APPROVE_WATCH_MS: "3000", FAKE_ARCHON_GET: JSON.stringify(get),
  });
  const pausedRun = { status: "paused", metadata: { wait: { bodyWaitId: "pr-approve", pauseId: "P" } } };
  const watchDir = () => artifacts({ [FILES.paused]: JSON.stringify(paused()) });

  test("operator-approved label approves", () => {
    const r = runScript(["watch"], { ...watchEnv(pausedRun), FAKE_GH_PR: pr({ labels: [{ name: "operator-approved" }] }) }, { dir: watchDir() });
    expect(r.code).toBe(0);
    expect(read(join(r.bin, "archon.args"))).toContain(`workflow respond run-1 approve operator-approved label on ${SHA} --occurrence P`);
    expect(roundOf({ scope: "{}", gate: "", saved: { decision: "approve", text: `operator-approved label on ${SHA}` }, paused: paused() }).approved_by).toBe("label");
  });

  test("the label on another head never answers, and a run that left the pause ends the watcher", () => {
    const other = runScript(["watch"], { ...watchEnv(pausedRun), PR_APPROVE_WATCH_MS: "300", FAKE_GH_PR: pr({ headRefOid: NEW_SHA, labels: [{ name: "operator-approved" }] }) }, { dir: watchDir() });
    expect(read(join(other.bin, "archon.args"))).not.toContain("respond");
    expect(read(join(other.dir, FILES.watchLog))).toContain("the watch lifetime ended");
    const done = runScript(["watch"], { ...watchEnv({ status: "completed", metadata: {} }), FAKE_GH_PR: pr({ labels: [{ name: "operator-approved" }] }) }, { dir: watchDir() });
    expect(read(join(done.bin, "archon.args"))).not.toContain("respond");
    expect(read(join(done.dir, FILES.watchLog))).toContain("exit: the run is completed");
  });

  test("factory.yaml pauses at the wait node pr-approve, the sole sink of the loop", () => {
    const yaml = Bun.YAML.parse(readFileSync(join(PACK, "factory.yaml"), "utf8")) as {
      nodes: { id: string; loop_group?: { max_iterations: number; nodes: { id: string; depends_on?: string[]; wait?: { options: { id: string }[] } }[] } }[];
    };
    const loop = yaml.nodes.find((n) => n.id === "pr-approve-cycle")?.loop_group;
    expect(loop?.max_iterations).toBe(ROUND_CAP + 1);
    const wait = loop?.nodes.at(-1);
    expect(wait?.id).toBe("pr-approve");
    expect(wait?.wait?.options.map((o) => o.id)).toEqual(["approve", "reject"]);
    expect(loop?.nodes.some((n) => n.depends_on?.includes("pr-approve"))).toBe(false);
  });
});
