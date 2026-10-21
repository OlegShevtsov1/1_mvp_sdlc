import { DEFAULT_MANUAL_MERGE_BASES } from "./profile.ts";

// `merge` interpolates the URL into a shell script, so only this shape passes.
export const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/;

// One entry of `gh pr checks --json name,bucket`; bucket is pass, fail,
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

export function ciRefusal(checks: CiCheck[]): string | null {
  const red = checks.find((c) => c.bucket === "fail" || c.bucket === "cancel");
  return red ? `CI check ${red.name} is ${red.bucket} on the pull request head` : null;
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
