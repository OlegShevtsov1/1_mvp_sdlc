import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Decision } from "./act.ts";

export type LedgerEntry = {
  ts: string;
  run_id: string;
  workflow: string;
  kind: string;
  rule: string;
  action: Decision["action"];
  evidence: { event_id?: string; node?: string; text?: string; message?: string };
};

// An operator's button answer to the pause `eventId` of run `runId`; a failed answer is logged as an escalation.
export const isOperatorAnswer = (e: LedgerEntry, runId: string, eventId: string): boolean =>
  e.run_id === runId && e.evidence?.event_id === eventId && e.rule === "operator" && e.action !== "escalate";

export function ledgerPath(): string {
  return process.env.SDLC_AUTOPILOT_LEDGER || join(homedir(), ".local", "state", "sdlc-autopilot", "ledger.jsonl");
}

// Evidence text is Archon's error or pause text, and the message may quote it, so either may hold a token. The base64
// run needs upper case, lower case and a digit, and `/` ends it, so paths (mixed-case too) and run ids stay readable.
const SECRETS: [RegExp, string][] = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]"],
  [/\bxox[abposr]-[A-Za-z0-9-]+/g, "[REDACTED]"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\b[0-9a-fA-F]{32,}\b/g, "[REDACTED]"],
  [
    /(?=[A-Za-z0-9+_-]*[A-Z])(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[0-9])[A-Za-z0-9+_-]{32,}={0,2}/g,
    "[REDACTED]",
  ],
];

export function redact(text: string): string {
  return SECRETS.reduce((t, [re, replacement]) => t.replace(re, replacement), text);
}

export function appendLedger(entry: LedgerEntry): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  const { text, message } = entry.evidence;
  const evidence = {
    ...entry.evidence,
    ...(text === undefined ? {} : { text: redact(text) }),
    ...(message === undefined ? {} : { message: redact(message) }),
  };
  const line = { ...entry, evidence };
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

// One unparsable line must not hide the lines after it, so it is skipped.
export function readLedger(): LedgerEntry[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      const e: unknown = JSON.parse(line);
      return e && typeof e === "object" ? [e as LedgerEntry] : [];
    } catch {
      return [];
    }
  });
}

export function alreadyActed(runId: string, eventId: string): boolean {
  return readLedger().some((e) => e.run_id === runId && e.evidence?.event_id === eventId);
}
