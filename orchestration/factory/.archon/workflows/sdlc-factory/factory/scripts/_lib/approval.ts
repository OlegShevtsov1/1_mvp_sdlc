import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseGate } from "./gate.ts";
import { parseJsonObject } from "./io.ts";
import { isRed, type CiCheck } from "./merge-decision.ts";
import { readSaved } from "./visual.ts";

// The pr-approve-cycle loop's until ends a reject once this many answers are saved, one below its
// max_iterations, so the cap ends typed instead of failing the loop.
export const ROUND_CAP = 4;
// The fallback approve: on the pull request while its head is paused (GitHub cannot approve one's own PR).
export const LABEL = "operator-approved";
// The wait node's id: the supervisor reads its pause by this name (E3 Task 2).
export const WAIT_NODE = "pr-approve";

// Run artifacts of the PR approval. until writes the three answer files (PILOT-217: a resumed loop
// hands back the wrong node's output); ask writes the paused head to `paused`.
export const FILES = {
  decision: "pr-approve.decision",
  text: "pr-approve.text",
  decisions: "pr-approve.decisions",
  paused: "pr-approve.json",
  log: "pr-approve.log",
  watchLog: "pr-approve-watch.log",
} as const;

const PR_NUMBER = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/([0-9]+)$/;

export function appendLog(dir: string, name: string, line: string): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, name), `${new Date().toISOString()} ${line}\n`);
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// A bookkeeping pull request (a tracker or an execution log) merges as it does today. Only the title
// AND the paths together say so: a stage docs PR (E3 Task 5) touches the same files and needs approval.
const BOOKKEEPING_TITLES = [/^docs\(plan\):/i, /execution log$/i, / tracker — T\d+ done$/];
const BOOKKEEPING_PATHS = [/^docs\/superpowers\/plans\//, /^docs\/features\/[^/]+\/tasks\/(?:tasks\.json|tracker\.md)$/];

export function isBookkeeping(pr: { title: string; files: string[] }): boolean {
  return BOOKKEEPING_TITLES.some((re) => re.test(pr.title.trim()))
    && pr.files.length > 0
    && pr.files.every((path) => BOOKKEEPING_PATHS.some((re) => re.test(path)));
}

export interface Scope {
  pause: boolean;
  reason: string;
  gated_sha: string;
}

// Everything but auto takes the operator's path: an unknown mode goes to the human.
export function scopeVerdict(i: {
  mergeApproval: string;
  alreadyMerged: boolean;
  readPr: () => { title: string; files: string[] } | null;
  gatedSha: () => string;
}): Scope {
  if (i.mergeApproval === "auto") return { pause: false, reason: "merge_approval auto", gated_sha: "" };
  if (i.alreadyMerged) return { pause: false, reason: "already merged at this run's head", gated_sha: "" };
  const pr = i.readPr();
  if (pr !== null && isBookkeeping(pr)) return { pause: false, reason: `bookkeeping: ${pr.title}`, gated_sha: "" };
  return {
    pause: true,
    reason: pr === null ? "the pull request could not be read, so the operator decides" : `merge_approval ${i.mergeApproval}`,
    gated_sha: i.gatedSha(),
  };
}

const lines = (raw: string | null): string[] => (raw ?? "").split("\n").filter((line) => line !== "");

export interface Turn {
  round: number;
  revise: boolean;
  feedback: string;
  pr_number: number;
}

// A reject without text asks again and runs no round: there is nothing to deliver.
export function turnFor(dir: string, prUrl: string): Turn {
  const feedback = (readSaved(dir, FILES.text) ?? "").trim();
  const revise = readSaved(dir, FILES.decision) === "reject" && feedback !== "";
  return {
    round: lines(readSaved(dir, FILES.decisions)).length + 1,
    revise,
    feedback: revise ? feedback : "",
    pr_number: Number(PR_NUMBER.exec(prUrl)?.[1] ?? 0),
  };
}

const NOISE = [/^#/, /^<!--.*-->$/, /^[-*]\s+\[[ xX]\]/, /^(?:Type|Refs|Closes|Fixes|Co-Authored-By):?\s/i];
const SUMMARY_SENTENCES = 3;
const SUMMARY_CHARS = 300;

// The first paragraph of prose in a pull request body, at most three sentences.
export function prSummary(body: string): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  const paragraph: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    if (NOISE.some((re) => re.test(line))) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }
  const prose = oneLine(paragraph.join(" "));
  if (prose === "") return "(no description)";
  const sentences = prose.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [prose];
  const kept = oneLine(sentences.slice(0, SUMMARY_SENTENCES).join(" "));
  return kept.length <= SUMMARY_CHARS ? kept : `${kept.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`;
}

export interface Facts {
  ready: boolean;
  reason: string;
  pr_url: string;
  pr_number: number;
  head_sha: string;
  files: number;
  additions: number;
  deletions: number;
  checks_pass: number;
  summary: string;
  regated: boolean;
}

// A check that failed, was cancelled or has not finished keeps the head from the operator.
export function checksVerdict(checks: CiCheck[]): { pass: number; problem: string } {
  const bad = checks.find((c) => isRed(c) || c.bucket === "pending");
  return {
    pass: checks.filter((c) => c.bucket === "pass").length,
    problem: bad === undefined ? "" : `CI check ${bad.name} is ${bad.bucket} on the head`,
  };
}

// The six `Name: value` lines are the contract the supervisor parses (E3 Task 2); each is one line.
export function approvalMessage(f: Facts, round: number): string {
  return [
    `PR APPROVAL — round ${round} of ${ROUND_CAP}.`,
    `PR: ${f.pr_url}`,
    `Head: ${f.head_sha}`,
    `Diff: ${f.files} files, +${f.additions} −${f.deletions}`,
    `Checks: ${f.checks_pass} pass`,
    f.ready ? "Review: ready" : `Review: not ready — ${oneLine(f.reason)}`,
    `Summary: ${oneLine(f.summary)}`,
    "",
    "approve → merge exactly this head, then deploy and verify as usual",
    round >= ROUND_CAP
      ? "reject  → this is the last round: the run stops without merging, and the pull request stays open"
      : "reject  → say what to change (free text); this run delivers it on the same pull request and asks again",
    `(The label ${LABEL} on the pull request approves this head too. A new commit needs a new approval${
      round >= ROUND_CAP ? ": in this last round it stops the run" : ""}.`,
    "If Review is not ready, approving stops the run; answer reject with what to change.)",
  ].join("\n");
}

export interface Paused {
  round: number;
  pr_url: string;
  head_sha: string;
  ready: boolean;
  reason: string;
}

export function readPaused(dir: string): Paused | null {
  const doc = parseJsonObject(readSaved(dir, FILES.paused) ?? "");
  if (doc === null || typeof doc.head_sha !== "string" || typeof doc.pr_url !== "string") return null;
  return {
    round: Number(doc.round) || 0,
    pr_url: doc.pr_url,
    head_sha: doc.head_sha,
    ready: doc.ready === true,
    reason: String(doc.reason ?? ""),
  };
}

// The head the last approval round offered after it passed the merge gate; the scope's before that.
export function lastGatedSha(paused: Paused | null, scopeSha: string): string {
  return paused !== null && paused.ready ? paused.head_sha : scopeSha;
}

export type UntilVerdict = { end: boolean; why: string };

// liveHead is read only for an approve of a ready round; null means it could not be read.
export function untilVerdict(i: {
  decision: string;
  answers: number;
  paused: Paused | null;
  liveHead: () => string | null;
}): UntilVerdict {
  if (i.answers >= ROUND_CAP) return { end: true, why: `${i.answers} answers saved, the cap` };
  if (i.decision === "reject") return { end: false, why: "reject: another round" };
  if (i.decision !== "approve") return { end: true, why: `decision ${i.decision || "(none)"}` };
  if (i.paused === null || !i.paused.ready) return { end: true, why: "approve of a round that was not ready" };
  const live = i.liveHead();
  if (live === i.paused.head_sha) return { end: true, why: `approve of the live head ${live}` };
  return { end: false, why: `approve of ${i.paused.head_sha}, but the live head is ${live ?? "unreadable"}: asking again` };
}

export interface ApprovalRound {
  proceed: boolean;
  decision: string;
  head_sha: string;
  approved_by: string;
  stop_reason: string;
}

// liveHead is read only for an approve after the last round: below the cap until already refused a
// head that moved, but at the cap it ends the loop on any answer.
export function roundVerdict(i: {
  scope: string;
  gate: string;
  saved: { decision: string; text: string } | null;
  answers: number;
  paused: Paused | null;
  liveHead: () => string | null;
}): ApprovalRound {
  const scope = parseJsonObject(i.scope) ?? {};
  if (scope.pause === false) {
    return { proceed: true, decision: "none", head_sha: "", approved_by: String(scope.reason ?? ""), stop_reason: "" };
  }
  const answer = i.saved ?? parseGate(i.gate);
  const stop = (stop_reason: string): ApprovalRound =>
    ({ proceed: false, decision: answer.decision, head_sha: "", approved_by: "", stop_reason });
  if (answer.decision === "reject") {
    return stop(`operator chose reject after the last approval round (${ROUND_CAP}): ${answer.text}`.trimEnd());
  }
  if (answer.decision !== "approve") return stop(`operator chose ${answer.decision || "nothing"}`);
  if (i.paused === null) return stop(`approved, but no ${FILES.paused} records the paused head`);
  if (!i.paused.ready) return stop(`approved, but the pull request was not ready: ${i.paused.reason}`);
  if (i.answers >= ROUND_CAP) {
    const live = i.liveHead();
    if (live !== i.paused.head_sha) {
      return stop(`approved ${i.paused.head_sha} in the last approval round (${ROUND_CAP}), but the live head is ${live ?? "unreadable"}; start a new run to approve its current head`);
    }
  }
  return {
    proceed: true,
    decision: "approve",
    head_sha: i.paused.head_sha,
    approved_by: answer.text.startsWith(`${LABEL} label`) ? "label" : "operator",
    stop_reason: "",
  };
}

export interface WatchRun {
  status: string;
  bodyWaitId: string;
  pauseId: string;
}

export type WatchStep =
  | { action: "exit"; why: string }
  | { action: "wait"; pauseId: string | null }
  | { action: "check"; pauseId: string };

// One poll of the label watcher: run is null when `archon workflow get` could not be read.
export function watchStep(
  pauseId: string | null,
  run: WatchRun | null,
  paused: Paused | null,
  mine: { round: number; head: string },
): WatchStep {
  if (paused === null || paused.round !== mine.round || paused.head_sha !== mine.head) {
    return { action: "exit", why: "the approval round moved on" };
  }
  if (run === null) return { action: "wait", pauseId };
  if (run.status === "running") return { action: "wait", pauseId };
  if (run.status !== "paused") return { action: "exit", why: `the run is ${run.status}` };
  if (run.bodyWaitId !== WAIT_NODE) return { action: "exit", why: `the run is paused at ${run.bodyWaitId || "another gate"}` };
  if (pauseId !== null && run.pauseId !== pauseId) return { action: "exit", why: "a later pause replaced this one" };
  return { action: "check", pauseId: run.pauseId };
}

export function labelApproves(labels: string[], liveHead: string, head: string): boolean {
  return labels.includes(LABEL) && liveHead === head;
}
