import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runChild } from "./_lib/child-run.ts";
import { redact, secretNamesFor } from "./_lib/exec.ts";
import { emit, parseJsonObject } from "./_lib/io.ts";
import { MERGE_GATE_TIMEOUT_MS, PR_STATE_TIMEOUT_MS } from "./_lib/merge-decision.ts";
import { readChecks } from "./_lib/pr-checks.ts";
import {
  FILES, LABEL, WAIT_NODE, appendLog, approvalMessage, checksVerdict, labelApproves, lastGatedSha, prSummary,
  readPaused, roundVerdict, scopeVerdict, turnFor, untilVerdict, watchStep, type Facts, type WatchRun,
} from "./_lib/approval.ts";
import { runIdFrom } from "./_lib/trello.ts";
import { readSaved } from "./_lib/visual.ts";

// The PR approval (merge_approval operator, PILOT-572). One script for every node of it, chosen by
// the `mode` binding (INPUTS_MODE) or, where until_bash or the watcher runs it, by argv[2]:
//
// - scope (pr-approve-scope): bindings merge_approval, already_merged, pr_url. Whether this pull
//   request pauses: auto calls nothing; operator reads its title and files (a bookkeeping PR merges)
//   and the gated head, `git rev-parse HEAD` (merge-gate passed only with the checkout at the head).
// - turn (pr-approve-turn): binding pr_url. The round and the previous answer until saved, plus the
//   bun and the script path until_bash runs.
// - facts (pr-approve-facts): bindings pr_url, gated_sha, revision (the round's delivery, "" when it
//   did not revise), remote and the merge gate's own (flaky_patterns, test_command, lint_command,
//   build_command, test_timeout_seconds, secret_names, manual_merge_bases, preflight), which reach the
//   child runs unchanged through the environment. Every GitHub read and write of the approval: a
//   head that moved since it was last gated is fast-forwarded and gated again (pr-body-sync,
//   pr-state, merge-gate), so every head offered passed merge-gate; the label is removed so only one
//   added while this head is paused counts.
// - ask (pr-approve-ask): bindings facts, round. Writes pr-approve.json and the pause text, and in a
//   real run starts the label watcher detached.
// - round (pr-approve-round): bindings scope, gate (the loop's output, "" when it was skipped). The
//   saved answer wins over the loop's output (PILOT-217); proceeds with the paused head on approve.
// - argv `until <dir> <decision> <text>`: until_bash. Saves the answer; exit 0 ends the loop, exit 1
//   asks again (a reject, or an approve of a head that is no longer the live one).
// - argv `watch`: the detached label watcher (env PR_APPROVE_RUN, _URL, _HEAD, _ROUND). It answers
//   approve when the label is on the paused head and exits when the run left that pause.
//
// ARTIFACTS_DIR, WORKFLOW_ID and ARCHON_CLI_COMMAND are engine-provided. Every mode but until
// prints one JSON line and exits 0; steps go to pr-approve.log.
const env = process.env;
const dir = env.ARTIFACTS_DIR ?? ".";
const log = (line: string) => appendLog(dir, FILES.log, line);
const GH_TIMEOUT_MS = 120_000;
// err reaches the pause text (the Review line) and the logs.
const SECRET_NAMES = secretNamesFor(env);

function run(argv: string[], timeout = GH_TIMEOUT_MS): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: redact(p.stderr.toString().trim(), SECRET_NAMES) };
}

const ghJson = (url: string, fields: string): Record<string, unknown> | null => {
  const r = run(["gh", "pr", "view", url, "--json", fields]);
  return r.ok ? parseJsonObject(r.out) : null;
};
const gitHead = (): string => run(["git", "rev-parse", "HEAD"]).out;
const liveHead = (url: string): string | null => {
  const r = run(["gh", "pr", "view", url, "--json", "headRefOid", "--jq", ".headRefOid"]);
  return r.ok && r.out !== "" ? r.out : null;
};
const answersSaved = (at: string): number =>
  (readSaved(at, FILES.decisions) ?? "").split("\n").filter((l) => l !== "").length;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const labelNames = (labels: unknown): string[] =>
  Array.isArray(labels) ? labels.map((l) => text((l as Record<string, unknown> | null)?.name)) : [];

function scope(): void {
  const url = env.INPUTS_PR_URL ?? "";
  emit(scopeVerdict({
    mergeApproval: env.INPUTS_MERGE_APPROVAL ?? "",
    alreadyMerged: env.INPUTS_ALREADY_MERGED === "true",
    readPr: () => {
      const doc = ghJson(url, "title,files");
      if (doc === null || !Array.isArray(doc.files)) return null;
      return { title: text(doc.title), files: doc.files.map((f) => text((f as Record<string, unknown> | null)?.path)) };
    },
    gatedSha: gitHead,
  }));
}

function turn(): void {
  emit({ ...turnFor(dir, env.INPUTS_PR_URL ?? ""), script: import.meta.path, bun: process.execPath });
}

// Brings the checkout to the live head when that only adds commits; anything else is the head
// rewritten outside this run, which this run does not chase.
function fastForward(remote: string, branch: string, live: string): string {
  if (gitHead() === live) return "";
  if (run(["git", "status", "--porcelain", "--untracked-files=no"]).out !== "") return "the checkout has uncommitted changes";
  const fetched = run(["git", "fetch", remote, branch]);
  if (!fetched.ok) return `git fetch ${remote} ${branch} failed: ${fetched.err}`;
  if (run(["git", "rev-parse", "FETCH_HEAD"]).out !== live) return `${remote}/${branch} is not the head GitHub reports`;
  if (!run(["git", "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]).ok) {
    return "the head was rewritten outside this run (the checkout is not its ancestor)";
  }
  const merged = run(["git", "merge", "--ff-only", "FETCH_HEAD"]);
  return merged.ok ? "" : `git merge --ff-only failed: ${merged.err}`;
}

function regate(url: string): string {
  const sync = runChild("pr-body-sync.ts", { INPUTS_DELIVERY: JSON.stringify({ pr_url: url }) }, GH_TIMEOUT_MS, log);
  if (sync === null) return "pr-body-sync did not report (see pr-approve.log)";
  const pr = runChild("pr-state.ts", { INPUTS_DELIVERY: JSON.stringify({ pr_url: url }), INPUTS_MERGE_CONFLICT: "false" }, PR_STATE_TIMEOUT_MS, log);
  if (pr === null) return "pr-state did not report (see pr-approve.log)";
  const gate = runChild("merge-gate.ts", { INPUTS_PR: JSON.stringify(pr), INPUTS_BODY_SYNC: JSON.stringify(sync) }, MERGE_GATE_TIMEOUT_MS, log);
  if (gate === null) return "merge-gate did not report (see pr-approve.log)";
  return gate.action === "merge" && gate.already_merged !== true ? "" : `merge-gate: ${text(gate.reason) || text(gate.action)}`;
}

function facts(): Facts {
  const url = env.INPUTS_PR_URL ?? "";
  const remote = env.INPUTS_REMOTE || "origin";
  const base: Facts = {
    ready: false, reason: "", pr_url: url, pr_number: turnFor(dir, url).pr_number, head_sha: "",
    files: 0, additions: 0, deletions: 0, checks_pass: 0, summary: "(no description)", regated: false,
  };
  const notReady = (reason: string, f: Facts = base): Facts => {
    log(`facts: not ready: ${reason}`);
    return { ...f, ready: false, reason };
  };

  const revision = parseJsonObject(env.INPUTS_REVISION ?? "");
  if (revision !== null && revision.ready !== true) {
    return notReady(`the revision ended not ready (${text(revision.reason) || "no reason given"}): ${text(revision.summary)}`.trimEnd());
  }
  const FIELDS = "headRefOid,headRefName,state,body,additions,deletions,changedFiles,labels";
  const read = (): { facts: Facts; branch: string; labels: string[] } | string => {
    const pr = ghJson(url, FIELDS);
    if (pr === null) return "the pull request could not be read";
    if (pr.state !== "OPEN") return `the pull request is ${text(pr.state) || "in an unknown state"}, not open`;
    return {
      facts: {
        ...base, head_sha: text(pr.headRefOid), files: Number(pr.changedFiles) || 0,
        additions: Number(pr.additions) || 0, deletions: Number(pr.deletions) || 0, summary: prSummary(text(pr.body)),
      },
      branch: text(pr.headRefName),
      labels: labelNames(pr.labels),
    };
  };
  let live = read();
  if (typeof live === "string") return notReady(live);
  let f = live.facts;

  const gated = lastGatedSha(readPaused(dir), env.INPUTS_GATED_SHA ?? "");
  if (f.head_sha !== gated) {
    log(`facts: the head ${f.head_sha} is not the last gated ${gated || "(none)"}: gating it`);
    const behind = fastForward(remote, live.branch, f.head_sha);
    if (behind !== "") return notReady(`${behind}; the head ${f.head_sha} was not gated`, f);
    const refused = regate(url);
    if (refused !== "") return notReady(refused, f);
    live = read();
    if (typeof live === "string") return notReady(live, f);
    if (live.facts.head_sha !== gitHead()) return notReady(`the head moved to ${live.facts.head_sha} during the merge gate`, live.facts);
    f = { ...live.facts, regated: true };
  }

  const checks = readChecks(url);
  if (!checks.checks_read) return notReady("the pull request's checks could not be read", f);
  const verdict = checksVerdict(checks.checks);
  f = { ...f, checks_pass: verdict.pass };
  if (verdict.problem !== "") return notReady(verdict.problem, f);

  if (live.labels.includes(LABEL)) {
    const removed = run(["gh", "pr", "edit", url, "--remove-label", LABEL]);
    log(`facts: ${LABEL} removed before this pause: ${removed.ok ? "ok" : removed.err}`);
    if (!removed.ok) return notReady(`the label ${LABEL} from an earlier head could not be removed: ${removed.err}`, f);
  }
  return { ...f, ready: true, reason: "" };
}

// The watcher outlives this node: a detached child the paused run does not wait for. A dry run
// (workflow test) has no run to answer and starts nothing.
function startWatcher(round: number, url: string, head: string): void {
  const runId = env.WORKFLOW_ID ?? "";
  if (runIdFrom(dir) === null || runId === "") return;
  try {
    const child = spawn(process.execPath, [import.meta.path, "watch"], {
      cwd: process.cwd(), detached: true, stdio: "ignore",
      env: { ...env, PR_APPROVE_RUN: runId, PR_APPROVE_URL: url, PR_APPROVE_HEAD: head, PR_APPROVE_ROUND: String(round) },
    });
    child.on("error", (e) => log(`ask: the label watcher failed: ${e.message}`));
    child.unref();
    log(`ask: label watcher ${child.pid} started for ${head}`);
  } catch (e) {
    log(`ask: the label watcher could not start: ${(e as Error).message}`);
  }
}

function ask(): void {
  const f = parseJsonObject(env.INPUTS_FACTS ?? "") as Facts | null;
  const round = Number(env.INPUTS_ROUND) || 1;
  const facts: Facts = f ?? {
    ready: false, reason: "pr-approve-facts reported nothing readable", pr_url: "", pr_number: 0, head_sha: "",
    files: 0, additions: 0, deletions: 0, checks_pass: 0, summary: "(no description)", regated: false,
  };
  writeFileSync(join(dir, FILES.paused), JSON.stringify({
    round, pr_url: facts.pr_url, head_sha: facts.head_sha, ready: facts.ready === true, reason: facts.reason,
  }) + "\n");
  if (facts.ready === true) startWatcher(round, facts.pr_url, facts.head_sha);
  emit({ message: approvalMessage(facts, round), ready: facts.ready === true, head_sha: facts.head_sha });
}

function round(): void {
  const decision = readSaved(dir, FILES.decision);
  const paused = readPaused(dir);
  emit(roundVerdict({
    scope: env.INPUTS_SCOPE ?? "",
    gate: env.INPUTS_GATE ?? "",
    saved: decision === null ? null : { decision, text: readSaved(dir, FILES.text) ?? "" },
    answers: answersSaved(dir),
    paused,
    liveHead: () => liveHead(paused?.pr_url ?? ""),
  }));
}

function until(argv: string[]): number {
  const [at = dir, decision = "", answer = ""] = argv;
  try {
    writeFileSync(join(at, FILES.decision), decision);
    writeFileSync(join(at, FILES.text), answer);
    appendFileSync(join(at, FILES.decisions), `${decision}\n`);
    const paused = readPaused(at);
    const verdict = untilVerdict({
      decision, answers: answersSaved(at), paused, liveHead: () => liveHead(paused?.pr_url ?? ""),
    });
    appendLog(at, FILES.log, `until: ${decision}: ${verdict.why} → ${verdict.end ? "end" : "again"}`);
    return verdict.end ? 0 : 1;
  } catch (e) {
    // A crash must end the loop typed, never repeat it until max_iterations fails it.
    appendLog(at, FILES.log, `until: ${(e as Error).message} → end`);
    return 0;
  }
}

function archonCli(): string[] {
  try {
    const argv: unknown = JSON.parse(env.ARCHON_CLI_COMMAND ?? "");
    if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === "string")) return argv;
  } catch {}
  return ["archon"];
}

async function watch(): Promise<void> {
  const runId = env.PR_APPROVE_RUN ?? "";
  const url = env.PR_APPROVE_URL ?? "";
  const mine = { round: Number(env.PR_APPROVE_ROUND) || 0, head: env.PR_APPROVE_HEAD ?? "" };
  const pollMs = Number(env.PR_APPROVE_POLL_MS) || 60_000;
  const deadline = Date.now() + (Number(env.PR_APPROVE_WATCH_MS) || 7 * 24 * 3_600_000);
  const wlog = (line: string) => appendLog(dir, FILES.watchLog, `${runId} round ${mine.round}: ${line}`);
  const cli = archonCli();
  let pauseId: string | null = null;
  wlog(`watching ${url} at ${mine.head}`);
  while (Date.now() < deadline) {
    const got = run([...cli, "workflow", "get", runId, "--json"]);
    const doc = got.ok ? parseJsonObject(got.out.split("\n").filter((l) => !l.startsWith('{"level"')).join("\n")) : null;
    const wait = (doc?.metadata as Record<string, unknown> | undefined)?.wait as Record<string, unknown> | undefined;
    const observed: WatchRun | null = doc === null
      ? null
      : { status: text(doc.status), bodyWaitId: text(wait?.bodyWaitId), pauseId: text(wait?.pauseId) };
    const step = watchStep(pauseId, observed, readPaused(dir), mine);
    if (step.action === "exit") return wlog(`exit: ${step.why}`);
    pauseId = step.pauseId;
    if (step.action === "check") {
      const pr = ghJson(url, "labels,headRefOid");
      if (pr !== null && labelApproves(labelNames(pr.labels), text(pr.headRefOid), mine.head)) {
        wlog(`${LABEL} on ${mine.head}: answering approve at ${WAIT_NODE} ${step.pauseId}`);
        // The resumed run continues inside this process, as it does in the supervisor's respond.
        const p = Bun.spawnSync(
          [...cli, "workflow", "respond", runId, "approve", `${LABEL} label on ${mine.head}`, "--occurrence", step.pauseId],
          { stdout: "ignore", stderr: "pipe" },
        );
        return wlog(`respond exited ${p.exitCode}${p.exitCode === 0 ? "" : `: ${redact(p.stderr.toString().trim(), SECRET_NAMES)}`}`);
      }
    }
    await Bun.sleep(pollMs);
  }
  wlog("exit: the watch lifetime ended");
}

const command = process.argv[2] ?? "";
if (command === "until") {
  process.exitCode = until(process.argv.slice(3));
} else if (command === "watch") {
  await watch();
} else {
  const modes: Record<string, () => void> = { scope, turn, facts: () => emit(facts()), ask, round };
  const mode = modes[env.INPUTS_MODE ?? ""];
  if (mode === undefined) {
    process.stderr.write(`pr-approve: unknown mode '${env.INPUTS_MODE ?? ""}'\n`);
    process.exitCode = 2;
  } else {
    mode();
  }
}
