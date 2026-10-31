import { DEFAULT_MANUAL_MERGE_BASES } from "./profile.ts";

// The merge gate's limit for one run of the lint or of the build command.
export const OTHER_COMMAND_TIMEOUT_SECONDS = 1000;

// Mirror the `pr-state` and `merge-gate` node timeouts in factory.yaml; merge.ts
// gives its child runs of both scripts the same budgets.
export const PR_STATE_TIMEOUT_MS = 5_700_000;
export const MERGE_GATE_TIMEOUT_MS = 10_800_000;

// Only a GitHub pull request URL of this shape reaches gh as a selector.
export const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/;

// A check's latest run on the head (pr-checks.ts); bucket is gh's: pass, fail,
// pending, skipping or cancel.
export interface CiCheck {
  name: string;
  bucket: string;
}

// "Lint" and "Rails CI / Lint" name a lint job; "Actionlint" and "ESLint" do not.
const LINT_CHECK = /(^|[^a-z0-9])lint([^a-z0-9]|$)/i;

// The passing CI check that stands for the profile's lint command, if any.
export function lintCheck(checks: CiCheck[]): string | null {
  return checks.find((c) => c.bucket === "pass" && LINT_CHECK.test(c.name))?.name ?? null;
}

export const isRed = (c: CiCheck): boolean => c.bucket === "fail" || c.bucket === "cancel";

export function ciRefusal(checks: CiCheck[]): string | null {
  const red = checks.find(isRed);
  return red ? `CI check ${red.name} is ${red.bucket} on the pull request head` : null;
}

// Every merge-gate refusal names one of these first, so the report, the card
// comment and the Telegram cancel message tell the cause at a glance.
export const REFUSAL_CLASSES = ["pending", "flaky-after-rerun", "failure", "timeout", "conflict", "preflight"] as const;
export type RefusalClass = (typeof REFUSAL_CLASSES)[number];

export function refusalReason(cls: RefusalClass, detail: string): string {
  return `${cls}: ${detail.replace(/\s+/g, " ").trim()}`;
}

// Ignored build caches the merge gate removes before it runs the profile's
// commands: left over from an earlier run they fail tests and the read-only review guard.
export const LEFTOVER_DIRS: readonly string[] = ["__pycache__", ".terraform"];

// `git ls-files -z -o -i --exclude-standard --directory` output → the entries to
// remove. Exact entries only: a pathspec-limited `git clean -X` also removes
// unrelated ignored directories such as node_modules/ and .tools/.
export function leftoverPaths(lsFilesZ: string): string[] {
  return lsFilesZ.split("\0").filter((entry) => entry.endsWith("/") && LEFTOVER_DIRS.includes(entry.slice(0, -1).split("/").at(-1) ?? ""));
}

// Removes ignored build caches (LEFTOVER_DIRS) from the checkout, one exact
// entry at a time: before the merge gate's commands, and when the preflight
// finds the disk low. Never refuses: a git that cannot list them is logged.
export function removeLeftovers(log: (text: string) => void): void {
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const listing = git("ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory");
  if (listing.exitCode !== 0) {
    log(`\nleftovers: not cleaned, git ls-files failed: ${listing.stderr.toString().trim()}\n`);
    return;
  }
  for (const entry of leftoverPaths(listing.stdout.toString())) {
    const clean = git("clean", "-fdX", "--", entry);
    log(clean.exitCode === 0 ? `\nleftovers: removed ignored ${entry}\n` : `\nleftovers: could not remove ${entry}: ${clean.stderr.toString().trim()}\n`);
  }
}

// The binding is load-profile's stack.flaky_patterns as a JSON string; an
// unreadable one reruns nothing.
export function parseFlakyPatterns(raw: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(doc) ? doc.filter((x): x is string => typeof x === "string" && x !== "") : [];
}

// The binding is load-profile's list as a JSON string; an unreadable one keeps
// the default, so a broken binding never lets the factory merge into main.
export function parseManualMergeBases(raw: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return [...DEFAULT_MANUAL_MERGE_BASES];
  }
  return Array.isArray(doc) ? doc.filter((x): x is string => typeof x === "string") : [...DEFAULT_MANUAL_MERGE_BASES];
}

export function isManualBase(base: string, manualBases: string[]): boolean {
  return manualBases.includes(base);
}

// gh's GraphQL error ("Pull Request has merge conflicts"), its own wording
// ("the merge commit cannot be cleanly created"), or GitHub's re-read state.
export function isMergeConflict(ghOutput: string, mergeable: string): boolean {
  return /merge conflicts|cannot be cleanly created/i.test(ghOutput) || mergeable === "CONFLICTING";
}

// `git remote get-url origin` → owner/repo, or null when it has another shape.
// Only the normalised form is passed on, so a token-bearing URL
// (https://<token>@host/...) never reaches a command line or a message.
export function originRepo(url: string): string | null {
  const repo = url.replace(/^.*[:/]([^/]+\/[^/]+)$/, "$1").replace(/\.git$/, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null;
}

// A pull request another process already merged at this run's head (the
// checkout), or whose merge commit introduced that head: this run delivered it.
export function deliveredByEarlierMerge(pr: Record<string, unknown>): boolean {
  return pr.state === "MERGED" && (pr.checkout_is_head === true || pr.merge_contains_checkout === true);
}
