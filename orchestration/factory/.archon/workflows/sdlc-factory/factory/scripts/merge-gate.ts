import { appendFileSync, mkdirSync } from "node:fs";
import { emit, parseJsonObject } from "./_lib/io.ts";
import { parseSecretNames, runLogged } from "./_lib/exec.ts";
import {
  type CiCheck, ciRefusal, deliveredByEarlierMerge, isManualBase, isRed, lintCheck,
  OTHER_COMMAND_TIMEOUT_SECONDS, parseManualMergeBases, PR_URL, type RefusalClass, refusalReason, removeLeftovers,
} from "./_lib/merge-decision.ts";
import { checkPreflight, hostPreflightDeps } from "./_lib/host-check.ts";
import { DEFAULT_TEST_TIMEOUT_SECONDS } from "./_lib/profile.ts";

// Bindings (see factory.yaml `merge-gate` node): pr (the whole pr-state
// output), body_sync (the whole pr-body-sync output), test_command, lint_command, build_command,
// test_timeout_seconds, remote, secret_names and manual_merge_bases (JSON array strings), and preflight
// (load-profile's stack.preflight as JSON text, "" without one). ARTIFACTS_DIR is engine-provided.
// Always exits 0 with one {action, pr_url, head, base, reason, already_merged}
// line: a refusal is a reported state, and a node failure would leave the
// conditions of `merge` and `notify-operator` unreadable. A refusal reason is
// one line that starts with its class: pending, flaky-after-rerun, failure,
// timeout, conflict or preflight. A pull request already merged at this run's
// head passes as action merge with already_merged true and runs no command:
// `merge` then only reads its merge commit.
const pr = parseJsonObject(process.env.INPUTS_PR ?? "") ?? {};
const bodySync = parseJsonObject(process.env.INPUTS_BODY_SYNC ?? "") ?? {};
const secretNames = parseSecretNames(process.env.INPUTS_SECRET_NAMES ?? "[]");
const manualBases = parseManualMergeBases(process.env.INPUTS_MANUAL_MERGE_BASES ?? "");
// load-profile already validated the number; the fallback only keeps a missing binding from running unbounded.
const testTimeoutSeconds = Number(process.env.INPUTS_TEST_TIMEOUT_SECONDS) || DEFAULT_TEST_TIMEOUT_SECONDS;
const remote = process.env.INPUTS_REMOTE || "origin";
const artifactsDir = process.env.ARTIFACTS_DIR ?? ".";
const logPath = `${artifactsDir}/merge-gate.log`;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ciChecks(value: unknown): CiCheck[] {
  if (!Array.isArray(value)) return [];
  return value.map((c: { name?: unknown; bucket?: unknown }) => ({ name: str(c?.name), bucket: str(c?.bucket) }));
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

const CONFLICT_FILES_SHOWN = 20;

function fileList(files: string[]): string {
  const shown = files.slice(0, CONFLICT_FILES_SHOWN).join(", ");
  return files.length > CONFLICT_FILES_SHOWN ? `${shown} and ${files.length - CONFLICT_FILES_SHOWN} more` : shown;
}

function log(text: string): void {
  mkdirSync(artifactsDir, { recursive: true });
  appendFileSync(logPath, text);
}

interface Decision {
  action: "merge" | "notify" | "refuse";
  pr_url: string;
  head: string;
  base: string;
  reason: string;
  already_merged: boolean;
}

async function decide(): Promise<Decision> {
  const url = str(pr.pr_url);
  if (!PR_URL.test(url)) {
    return {
      action: "refuse", pr_url: "", head: "", base: "", reason: refusalReason("failure", "delivery did not return a GitHub pull request URL"),
      already_merged: false,
    };
  }
  const base = str(pr.base);
  const refuse = (head: string, cls: RefusalClass, detail: string): Decision =>
    ({ action: "refuse", pr_url: url, head, base, reason: refusalReason(cls, detail), already_merged: false });
  if (pr.read !== true) return refuse("", "failure", "could not read the pull request from GitHub");
  if (base === "") return refuse(str(pr.head), "failure", "could not read the pull request's base branch");

  const head = str(pr.head);
  // Another process of this run merged it first (a resumed run). Decision 27
  // still holds: a manual base keeps its refusal below.
  if (pr.state === "MERGED" && !isManualBase(base, manualBases)) {
    if (deliveredByEarlierMerge(pr)) return { action: "merge", pr_url: url, head, base, reason: "", already_merged: true };
    return refuse(head, "failure", "the pull request is already merged, but this run's head (the checkout) was not shown to be in the merge (see pr-state.log), so this run did not count it as delivered");
  }
  if (pr.is_draft !== false || pr.state !== "OPEN") {
    return refuse(head, "failure", `not an open, ready pull request (state ${String(pr.state)}, draft ${String(pr.is_draft)})`);
  }
  // pr-state rebased a conflicting pull request once. A rebase that conflicts
  // ends the run not delivered, the factory's replan path: the next run on the
  // card plans again from the current base.
  if (pr.rebase === "conflicted") {
    return refuse(head, "conflict", `rebasing ${head} onto ${remote}/${base} conflicts in ${fileList(strings(pr.conflict_files))}; the change needs a replan against the current ${base}`);
  }
  if (pr.rebase === "failed") {
    return refuse(head, "conflict", `the pull request conflicts with ${base} and the automatic rebase failed: ${str(pr.rebase_detail)}`);
  }
  // Only a definite conflict refuses: GitHub reports UNKNOWN for a while after
  // every push, and a merge gh then refuses is reported by the merge node.
  if (pr.mergeable === "CONFLICTING") return refuse(head, "conflict", `the pull request is not mergeable: it conflicts with ${base}`);
  if (pr.checkout_is_head !== true) {
    return refuse(head, "failure", "the checkout is not the pull request head, so the checks would not test what would be merged");
  }
  if (pr.checkout_clean !== true) return refuse(head, "failure", "the checkout has uncommitted changes to tracked files");
  // An unreadable checks list would otherwise look like a project without CI.
  if (pr.checks_read !== true) return refuse(head, "failure", "could not read the pull request's CI checks from GitHub");
  // The squash commit carries the description, so a stale one must not merge.
  if (!["updated", "unchanged", "skipped"].includes(str(bodySync.action))) {
    return refuse(head, "failure", `the pull request description could not be republished: ${str(bodySync.reason) || "no pr-body-sync result"}`);
  }

  // A concluded red check is definitive, so it is named before a pending one.
  const checks = ciChecks(pr.checks);
  const red = checks.find(isRed);
  if (red !== undefined) {
    if (strings(pr.rerun_checks).includes(red.name)) {
      return refuse(head, "flaky-after-rerun", `CI check ${red.name} failed again after one rerun of a known flaky failure`);
    }
    return refuse(head, "failure", ciRefusal(checks) ?? "");
  }
  // There is no branch protection on the free plan: unfinished CI must not merge.
  const pending = checks.filter((c) => c.bucket === "pending").map((c) => c.name);
  if (pending.length > 0 || pr.checks_settled === false) {
    const what = pending.length > 0
      ? pending.join(", ")
      : checks.length > 0 ? "a workflow run on the head is still queued or in progress" : "no check has reported on the head yet";
    return refuse(head, "pending", `checks still pending after ${Number(pr.waited_minutes) || 0} min (${what})`);
  }

  removeLeftovers(log);

  // The host the commands need (PILOT-499): checked here, right before them, so
  // a database that went down during the run refuses with the fix named
  // instead of failing the test command.
  const pf = await checkPreflight(process.env.INPUTS_PREFLIGHT ?? "", () => hostPreflightDeps({ logPath, secretNames }));
  if (pf !== null && !pf.ok) {
    return refuse(head, "preflight", `${pf.problems.join("; ")}; the pull request stays open — fix it on the Archon host, then start a new run`);
  }

  // Lint is the one command whose local result depends on where the checkout
  // lives (RuboCop's excludes miss under the run's .archon/ worktree path), so
  // a passing CI lint job stands in for it. Test and build always re-run.
  const ciLint = lintCheck(checks);
  const commands: Array<[string, string]> = [
    ["test", process.env.INPUTS_TEST_COMMAND ?? ""],
    ["lint", process.env.INPUTS_LINT_COMMAND ?? ""],
    ["build", process.env.INPUTS_BUILD_COMMAND ?? ""],
  ];
  for (const [label, command] of commands) {
    if (command.trim() === "") continue;
    if (label === "lint" && ciLint !== null) {
      log(`\nlint: deferred to the pull request's CI check '${ciLint}' (pass)\n`);
      continue;
    }
    const seconds = label === "test" ? testTimeoutSeconds : OTHER_COMMAND_TIMEOUT_SECONDS;
    const runOnce = () => runLogged(command, { logPath, secretNames, timeoutMs: seconds * 1000 });
    let r = await runOnce();
    let retried = false;
    // A slow host, not a red suite, is what times a test command out
    // (PILOT-375), so it gets exactly one more run; a failure never does.
    if (label === "test" && r.timed_out) {
      appendFileSync(logPath, `
test: timed out after ${seconds} s; retrying once
`);
      r = await runOnce();
      retried = true;
    }
    if (r.timed_out) {
      const again = retried ? ", and again on its one retry" : "";
      return refuse(head, "timeout", `${label} command timed out after ${seconds} s on the pull request head${again}; see merge-gate.log`);
    }
    if (r.exit_code !== 0) {
      return refuse(head, "failure", `${label} command exited ${r.exit_code} on the pull request head; see merge-gate.log`);
    }
  }
  // Checked last, so only a pull request that passed every check above is
  // handed to the operator (decision 27).
  const action = isManualBase(base, manualBases) ? "notify" : "merge";
  return { action, pr_url: url, head, base, reason: "", already_merged: false };
}

emit(await decide());
