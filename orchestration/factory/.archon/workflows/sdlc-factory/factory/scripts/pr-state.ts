import { appendFileSync, mkdirSync } from "node:fs";
import { emit, parseJsonObject } from "./_lib/io.ts";
import { type CiCheck, isRed, parseFlakyPatterns, PR_URL } from "./_lib/merge-decision.ts";
import {
  actionsJob, CHECKS_POLL_MS, CHECKS_WAIT_MS, failedJobLog, isKnownFlaky, readChecks, rerunFailed, waitForChecks,
} from "./_lib/pr-checks.ts";
import { mergeContains, rebaseOntoBase, type RebaseResult } from "./_lib/rebase.ts";

// Bindings (see factory.yaml `pr-state` node): delivery (the whole deliver
// report), remote and flaky_patterns (a JSON array string). ARTIFACTS_DIR is
// engine-provided. Reads the facts merge-gate decides on, and performs the merge
// guard's GitHub-side remedies, each at most once: a second CI wait when the
// first ends with checks still pending, one `gh run rerun --failed` of a
// known-flaky failure, one rebase onto the base pushed with a lease when the
// pull request conflicts. merge_conflict is "false" on the node and "true" only
// in merge.ts's child run: gh refused the merge on a conflict, so the pull request is
// rebased even while GitHub's mergeable still lags. A MERGED pull request is
// read with its merge commit and never rebased or waited for. Always exits 0
// with one line; every remedy is logged to pr-state.log.
const delivery = parseJsonObject(process.env.INPUTS_DELIVERY ?? "") ?? {};
const remote = process.env.INPUTS_REMOTE || "origin";
const flakyPatterns = parseFlakyPatterns(process.env.INPUTS_FLAKY_PATTERNS ?? "");
const mergeConflict = process.env.INPUTS_MERGE_CONFLICT === "true";
const artifactsDir = process.env.ARTIFACTS_DIR ?? ".";
// A body edit just before this node restarts the head's CI; tests shorten both.
const POLL_MS = Number(process.env.PR_STATE_POLL_MS || CHECKS_POLL_MS);
const WAIT_MS = Number(process.env.PR_STATE_WAIT_MS || CHECKS_WAIT_MS);
// GitHub can take a few seconds to report a just-pushed head on the pull request.
const HEAD_REREADS = 10;

interface PrState {
  pr_url: string;
  read: boolean;
  head: string;
  base: string;
  state: string;
  mergeable: string;
  is_draft: boolean;
  checkout_is_head: boolean;
  checkout_clean: boolean;
  checks: CiCheck[];
  checks_read: boolean;
  checks_settled: boolean;
  waited_minutes: number;
  rerun_checks: string[];
  rebase: "none" | RebaseResult["status"];
  conflict_files: string[];
  rebase_detail: string;
  merge_sha: string;
  merge_contains_checkout: boolean;
}

interface View {
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  isDraft: unknown;
  state: unknown;
  mergeable: unknown;
  mergeSha: string;
}

function log(line: string): void {
  mkdirSync(artifactsDir, { recursive: true });
  appendFileSync(`${artifactsDir}/pr-state.log`, `${line}\n`);
}

function capture(argv: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
}

function mergeCommitOid(mergeCommit: unknown): string {
  const oid = mergeCommit !== null && typeof mergeCommit === "object" ? (mergeCommit as { oid?: unknown }).oid : undefined;
  return typeof oid === "string" ? oid : "";
}

// The URL is the selector, so gh infers no repository from the checkout.
function readView(url: string): View | null {
  const p = capture(["gh", "pr", "view", url, "--json", "headRefOid,headRefName,isDraft,state,baseRefName,mergeable,mergeCommit"]);
  const pr = p.ok ? parseJsonObject(p.out) : null;
  if (!pr || typeof pr.headRefOid !== "string" || typeof pr.headRefName !== "string" || typeof pr.baseRefName !== "string") {
    return null;
  }
  return {
    headRefOid: pr.headRefOid, headRefName: pr.headRefName, baseRefName: pr.baseRefName,
    isDraft: pr.isDraft, state: pr.state, mergeable: pr.mergeable,
    mergeSha: mergeCommitOid(pr.mergeCommit),
  };
}

function readCheckout(view: View): { checkout_is_head: boolean; checkout_clean: boolean } {
  const checkout = capture(["git", "rev-parse", "HEAD"]);
  // Untracked files are ignored: Archon scaffolds an untracked .archon/ in every run.
  const status = capture(["git", "status", "--porcelain", "--untracked-files=no"]);
  return { checkout_is_head: checkout.ok && checkout.out === view.headRefOid, checkout_clean: status.ok && status.out === "" };
}

// One window, and a second when checks are still pending at its end.
async function waitTwice(url: string, headSha: string, requireAny: boolean, started: number) {
  const opts = { pollMs: POLL_MS, waitMs: WAIT_MS, requireAny };
  const first = await waitForChecks(url, headSha, opts);
  if (first.settled) return first;
  log(`checks still pending after ${Math.round((Date.now() - started) / 60_000)} min; waiting once more`);
  return waitForChecks(url, headSha, opts);
}

// Rerun only when every red check is a failed Actions job a pattern names:
// a rerun could not make a pull request with any other red check green.
function rerunKnownFlaky(url: string, read: Awaited<ReturnType<typeof waitForChecks>>): string[] {
  if (flakyPatterns.length === 0) return [];
  const red = read.runs.filter(isRed);
  if (red.length === 0) return [];
  const runIds = new Set<string>();
  for (const check of red) {
    const job = actionsJob(check.detailsUrl);
    if (check.bucket !== "fail" || job === null) return [];
    if (!isKnownFlaky(check.name, failedJobLog(url, job.jobId), flakyPatterns)) return [];
    runIds.add(job.runId);
  }
  for (const runId of runIds) {
    const r = rerunFailed(url, runId);
    log(r.ok ? `gh run rerun ${runId} --failed: known flaky failure, rerun once` : `gh run rerun ${runId} --failed failed: ${r.err}`);
    if (!r.ok) return [];
  }
  return red.map((c) => c.name);
}

async function read(): Promise<PrState> {
  // archon-deliver-block's report carries the URL as pr_url.
  const url = typeof delivery.pr_url === "string" ? delivery.pr_url : "";
  const unread: PrState = {
    pr_url: PR_URL.test(url) ? url : "",
    read: false,
    head: "",
    base: "",
    state: "",
    mergeable: "",
    is_draft: false,
    checkout_is_head: false,
    checkout_clean: false,
    checks: [],
    checks_read: false,
    checks_settled: false,
    waited_minutes: 0,
    rerun_checks: [],
    rebase: "none",
    conflict_files: [],
    rebase_detail: "",
    merge_sha: "",
    merge_contains_checkout: false,
  };
  if (!PR_URL.test(url)) return unread;

  let view = readView(url);
  if (view === null) return unread;
  let checkout = readCheckout(view);
  const started = Date.now();

  // Only a definite conflict on a clean checkout of the head is rebased:
  // GitHub reports UNKNOWN for a while after every push.
  let rebase: RebaseResult | null = null;
  let requireAny = false;
  let before: ReturnType<typeof readChecks> | null = null;
  const conflicting = view.state === "OPEN" && (view.mergeable === "CONFLICTING" || mergeConflict);
  if (conflicting && checkout.checkout_is_head && checkout.checkout_clean) {
    before = readChecks(url);
    // A just-pushed head has an empty rollup until its CI starts.
    requireAny = before.checks.length > 0;
    rebase = rebaseOntoBase({ remote, base: view.baseRefName, head: view.headRefName, headOid: view.headRefOid }, log);
    if (rebase.status === "rebased") {
      const local = capture(["git", "rev-parse", "HEAD"]).out;
      for (let i = 0; i < HEAD_REREADS; i++) {
        const next = readView(url);
        if (next !== null) view = next;
        if (view.headRefOid === local) break;
        await Bun.sleep(POLL_MS);
      }
      checkout = readCheckout(view);
    }
  }

  const facts = {
    pr_url: url,
    read: true,
    head: view.headRefName,
    base: view.baseRefName,
    state: String(view.state),
    mergeable: typeof view.mergeable === "string" ? view.mergeable : "",
    is_draft: view.isDraft !== false,
    ...checkout,
    rebase: rebase?.status ?? "none",
    conflict_files: rebase?.files ?? [],
    rebase_detail: rebase?.detail ?? "",
    merge_sha: view.mergeSha,
    merge_contains_checkout: view.state === "MERGED" && !checkout.checkout_is_head && view.mergeSha !== "" &&
      mergeContains({ remote, base: view.baseRefName, mergeSha: view.mergeSha }, log),
  };
  // CI no longer decides anything for a merged pull request.
  if (view.state === "MERGED") {
    log("pull request is already merged; CI not waited for");
    return { ...facts, checks: [], checks_read: true, checks_settled: true, waited_minutes: 0, rerun_checks: [] };
  }
  // A head the rebase could not move cannot merge: its CI is not waited for.
  if (before !== null && rebase?.status !== "rebased") {
    return { ...facts, checks: before.checks, checks_read: before.checks_read, checks_settled: false, waited_minutes: 0, rerun_checks: [] };
  }

  let checks = await waitTwice(url, view.headRefOid, requireAny, started);
  const rerun = checks.settled ? rerunKnownFlaky(url, checks) : [];
  if (rerun.length > 0) {
    // So the first read after the rerun sees the run re-queued, not the old failure.
    await Bun.sleep(POLL_MS);
    checks = await waitTwice(url, view.headRefOid, true, started);
  }
  return {
    ...facts,
    checks: checks.checks,
    checks_read: checks.checks_read,
    checks_settled: checks.settled,
    waited_minutes: Math.round((Date.now() - started) / 60_000),
    rerun_checks: rerun,
  };
}

emit(await read());
