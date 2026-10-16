import { appendFileSync, mkdirSync } from "node:fs";
import { emit, parseJsonObject } from "./_lib/io.ts";
import { parseSecretNames, runLogged } from "./_lib/exec.ts";
import { type CiCheck, ciRefusal, lintCheck, PR_URL } from "./_lib/merge-decision.ts";

// Bindings (see factory.yaml `merge-gate` node): pr (the whole pr-state
// output), test_command, lint_command, build_command, secret_names (JSON array
// string). ARTIFACTS_DIR is engine-provided.
// Always exits 0 with one {green, pr_url, head, reason} line: a refusal is a
// reported state, and a node failure would leave `merge`'s condition unreadable.
const pr = parseJsonObject(process.env.INPUTS_PR ?? "") ?? {};
const secretNames = parseSecretNames(process.env.INPUTS_SECRET_NAMES ?? "[]");
const artifactsDir = process.env.ARTIFACTS_DIR ?? ".";
const logPath = `${artifactsDir}/merge-gate.log`;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ciChecks(value: unknown): CiCheck[] {
  if (!Array.isArray(value)) return [];
  return value.map((c: { name?: unknown; bucket?: unknown }) => ({ name: str(c?.name), bucket: str(c?.bucket) }));
}

async function decide(): Promise<{ green: boolean; pr_url: string; head: string; reason: string }> {
  const url = str(pr.pr_url);
  if (!PR_URL.test(url)) {
    return { green: false, pr_url: "", head: "", reason: "delivery did not return a GitHub pull request URL" };
  }
  const refuse = (head: string, reason: string) => ({ green: false, pr_url: url, head, reason });
  if (pr.read !== true) return refuse("", "could not read the pull request from GitHub");

  const head = str(pr.head);
  if (pr.is_draft !== false || pr.state !== "OPEN") {
    return refuse(head, `not an open, ready pull request (state ${String(pr.state)}, draft ${String(pr.is_draft)})`);
  }
  if (pr.checkout_is_head !== true) {
    return refuse(head, "the checkout is not the pull request head, so the checks would not test what would be merged");
  }
  if (pr.checkout_clean !== true) return refuse(head, "the checkout has uncommitted changes to tracked files");
  // An unreadable checks list would otherwise look like a project without CI.
  if (pr.checks_read !== true) return refuse(head, "could not read the pull request's CI checks from GitHub");

  const checks = ciChecks(pr.checks);
  const red = ciRefusal(checks);
  if (red !== null) return refuse(head, red);

  // Lint is the one command whose local result depends on where the checkout
  // lives (RuboCop's excludes miss under the run's .archon/ worktree path), so
  // a passing CI lint job stands in for it. Test and build always re-run: on
  // Archon v0.10.1 the PR can be flipped ready after an introduced red.
  const ciLint = lintCheck(checks);
  const commands: Array<[string, string]> = [
    ["test", process.env.INPUTS_TEST_COMMAND ?? ""],
    ["lint", process.env.INPUTS_LINT_COMMAND ?? ""],
    ["build", process.env.INPUTS_BUILD_COMMAND ?? ""],
  ];
  for (const [label, command] of commands) {
    if (command.trim() === "") continue;
    if (label === "lint" && ciLint !== null) {
      mkdirSync(artifactsDir, { recursive: true });
      appendFileSync(logPath, `\nlint: deferred to the pull request's CI check '${ciLint}' (pass)\n`);
      continue;
    }
    const r = await runLogged(command, { logPath, secretNames, timeoutMs: 1_000_000 });
    if (r.exit_code !== 0) {
      return refuse(head, `${label} command exited ${r.exit_code} on the pull request head; see merge-gate.log`);
    }
  }
  return { green: true, pr_url: url, head, reason: "" };
}

emit(await decide());
