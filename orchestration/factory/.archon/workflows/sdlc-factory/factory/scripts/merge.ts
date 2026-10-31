import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { emit, parseJsonObject } from "./_lib/io.ts";
import {
  isMergeConflict, MERGE_GATE_TIMEOUT_MS, originRepo, PR_STATE_TIMEOUT_MS, PR_URL,
} from "./_lib/merge-decision.ts";

// Bindings (see factory.yaml `merge` node): pr_url, head, base and
// already_merged from merge-gate, merge_strategy; remote, flaky_patterns,
// body_sync, test_command, lint_command, build_command, test_timeout_seconds,
// secret_names, manual_merge_bases and preflight reach the child runs of pr-state.ts and
// merge-gate.ts unchanged through the environment. ARTIFACTS_DIR is
// engine-provided; every step is logged to merge.log.
//
// When `gh pr merge` fails because the pull request became conflicting after
// pr-state (another pull request merged during the gate), it is rebased once:
// pr-state.ts runs again with merge_conflict, then merge-gate.ts on the new
// head, and only a gate that answers merge leads to one more `gh pr merge`.
// Nothing loops: one rebase per merge attempt. A pull request another process
// already merged at this run's head is reported merged.
//
// A squash merge passes --subject "<PR title> (#<n>)" read from the live pull
// request (decision 25): GitHub's default subject for a one-commit pull
// request is that commit's subject. The body is left to GitHub.
//
// A merge that did not happen is a reported state, never a node failure: the
// engine never applies if_skipped to a failed producer, so a failed merge node
// would fail the report and every node that reads it. Always exits 0 with one
// {merged, merge_sha, head, error} line; a refusal also goes to stderr.
const url = process.env.INPUTS_PR_URL ?? "";
const head = process.env.INPUTS_HEAD ?? "";
const base = process.env.INPUTS_BASE ?? "";
const alreadyMerged = process.env.INPUTS_ALREADY_MERGED === "true";
const strategy = process.env.INPUTS_MERGE_STRATEGY ?? "";
const artifactsDir = process.env.ARTIFACTS_DIR ?? ".";

const STRATEGIES = ["squash", "merge", "rebase"];
const GH_TIMEOUT_MS = 120_000;
// GitHub is eventually consistent about mergeCommit: for a few seconds after a
// successful merge the field still reads null.
const MERGE_COMMIT_READS = 5;
const MERGE_COMMIT_RETRY_MS = 3000;

interface Outcome {
  merged: boolean;
  merge_sha: string;
  head: string;
  error: string;
}

function log(line: string): void {
  mkdirSync(artifactsDir, { recursive: true });
  appendFileSync(`${artifactsDir}/merge.log`, `${line}\n`);
}

function run(argv: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: GH_TIMEOUT_MS });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function refuse(message: string): Outcome {
  process.stderr.write(`${message}\n`);
  log(message);
  return { merged: false, merge_sha: "", head, error: message.replace(/[\x00-\x1f\x7f]+/g, " ") };
}

// A child run of a sibling script with the node's own bindings plus env; its
// last stdout line, or null when it reported nothing readable.
function child(script: string, env: Record<string, string>, timeoutMs: number): Record<string, unknown> | null {
  log(`${script}: running after the conflict`);
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, script)], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: timeoutMs,
  });
  const stderr = p.stderr.toString().trim();
  if (stderr !== "") log(`${script} stderr: ${stderr}`);
  const doc = parseJsonObject(p.stdout.toString().trim().split("\n").at(-1) ?? "");
  log(`${script}: ${doc === null ? `no report (exit ${p.exitCode})` : JSON.stringify(doc)}`);
  return doc;
}

async function deliver(): Promise<Outcome> {
  if (!STRATEGIES.includes(strategy)) return refuse(`merge: unknown merge_strategy '${strategy}'`);
  if (!PR_URL.test(url)) return refuse("merge: merge-gate did not hand on a GitHub pull request URL.");
  const origin = run(["git", "remote", "get-url", "origin"]);
  if (!origin.ok) return refuse("merge: could not read the origin remote.");
  const repo = originRepo(origin.out);
  if (repo === null) return refuse("merge: origin remote does not resolve to an owner/repo.");

  // --repo pins every gh call to the origin remote: gh's default resolution in
  // a fork clone targets the upstream parent instead. With --repo gh disables
  // inference and REQUIRES an explicit selector — the PR URL is one.
  const gh = (...args: string[]) => run(["gh", ...args]);
  let subject: string[] = [];
  const merge = () => {
    const r = gh("pr", "merge", url, "--repo", repo, `--${strategy}`, ...subject);
    const out = [r.out, r.err].filter((x) => x !== "").join("\n");
    log(`gh pr merge: ${r.ok ? "ok" : "failed"}${out === "" ? "" : `: ${out}`}`);
    return { ok: r.ok, out };
  };
  const mergedState = (): Outcome | null => {
    const state = gh("pr", "view", url, "--repo", repo, "--json", "state", "--jq", ".state").out;
    return state === "MERGED" ? null : refuse(`merge: pull request is not MERGED after the merge (state: ${state}).`);
  };

  // The merge already happened, so a merge commit that cannot be read is
  // reported, not a node failure; an empty merge_sha keeps deploy from running.
  const merged = async (): Promise<Outcome> => {
    // Best effort; a protected or already-deleted branch must not fail the run.
    run(["git", "push", "origin", "--delete", head]);
    let mergeSha = "";
    for (let attempt = 1; attempt <= MERGE_COMMIT_READS && mergeSha === ""; attempt++) {
      if (attempt > 1) await Bun.sleep(MERGE_COMMIT_RETRY_MS);
      mergeSha = gh("pr", "view", url, "--repo", repo, "--json", "mergeCommit", "--jq", '.mergeCommit.oid // ""').out;
    }
    if (mergeSha === "") process.stderr.write("merge: pull request is merged but its merge commit could not be read yet\n");
    const mergedHead = gh("pr", "view", url, "--repo", repo, "--json", "headRefName", "--jq", ".headRefName").out;
    log(`merged: ${mergeSha || "merge commit not readable yet"}`);
    return { merged: true, merge_sha: mergeSha, head: mergedHead || head, error: "" };
  };

  if (alreadyMerged) {
    log("merge-gate found the pull request already merged at this run's head; gh pr merge not called");
    return merged();
  }
  if (strategy === "squash") {
    const title = gh("pr", "view", url, "--repo", repo, "--json", "title", "--jq", ".title").out;
    if (title === "") return refuse("merge: could not read the pull request title.");
    subject = ["--subject", `${title} (#${url.split("/").at(-1)})`];
  }
  const first = merge();
  if (first.ok) return mergedState() ?? merged();

  const failed = `merge: gh pr merge failed: ${first.out}`;
  const view = parseJsonObject(gh("pr", "view", url, "--repo", repo, "--json", "state,headRefOid,mergeable").out) ?? {};
  // Another process merged it while this one waited at the gate, which had
  // just verified that the checkout is the head.
  if (view.state === "MERGED" && view.headRefOid === run(["git", "rev-parse", "HEAD"]).out) {
    log("the pull request was merged at this run's head by another process");
    return merged();
  }
  if (view.state !== "OPEN" || !isMergeConflict(first.out, typeof view.mergeable === "string" ? view.mergeable : "")) {
    return refuse(failed);
  }

  const afterRebase = `${failed}; after one rebase onto ${base}`;
  const facts = child("pr-state.ts", { INPUTS_DELIVERY: JSON.stringify({ pr_url: url }), INPUTS_MERGE_CONFLICT: "true" }, PR_STATE_TIMEOUT_MS);
  if (facts === null) return refuse(`${afterRebase}: pr-state did not report (see merge.log)`);
  const gate = child("merge-gate.ts", { INPUTS_PR: JSON.stringify(facts) }, MERGE_GATE_TIMEOUT_MS);
  if (gate === null) return refuse(`${afterRebase}: merge-gate did not report (see merge.log)`);
  if (gate.already_merged === true) return merged();
  if (gate.action !== "merge") return refuse(`${afterRebase}: ${String(gate.reason)}`);

  const second = merge();
  if (!second.ok) return refuse(`merge: gh pr merge failed after the rebase: ${second.out}`);
  return mergedState() ?? merged();
}

emit(await deliver());
