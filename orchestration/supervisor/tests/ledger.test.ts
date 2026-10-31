import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { alreadyActed, appendLedger, type LedgerEntry, readLedger, redact } from "../src/ledger.ts";

const entry = (runId: string, eventId: string): LedgerEntry => ({
  ts: new Date().toISOString(), run_id: runId, workflow: "factory", kind: "plan-gate", rule: "default-escalate",
  action: "escalate", evidence: { event_id: eventId, node: "plan-cycle.plan-gate", text: "GATE 2" },
});

let ledger: string;
beforeEach(() => {
  ledger = join(mkdtempSync(join(tmpdir(), "supervisor-ledger-")), "state", "ledger.jsonl");
  process.env.SDLC_AUTOPILOT_LEDGER = ledger;
});

describe("ledger", () => {
  test("ledger line has ts, run_id, workflow, kind, rule, action, evidence", () => {
    appendLedger(entry("run-a", "event-1"));
    const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(Object.keys(line).sort()).toEqual(["action", "evidence", "kind", "rule", "run_id", "ts", "workflow"]);
    expect(Number.isNaN(Date.parse(line.ts))).toBe(false);
  });

  test("alreadyActed matches run and pause event", () => {
    expect(alreadyActed("run-a", "event-1")).toBe(false);
    appendLedger(entry("run-a", "event-1"));
    expect(alreadyActed("run-a", "event-1")).toBe(true);
    expect(alreadyActed("run-a", "event-2")).toBe(false);
    expect(alreadyActed("run-b", "event-1")).toBe(false);
  });

  test("a garbage line does not stop alreadyActed from reading the lines after it", () => {
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, "{not json\n");
    appendLedger(entry("run-a", "event-1"));
    expect(alreadyActed("run-a", "event-1")).toBe(true);
  });

  test("readLedger returns parsed entries and skips garbage lines", () => {
    expect(readLedger()).toEqual([]);
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, "{not json\n");
    appendLedger(entry("run-a", "event-1"));
    appendLedger(entry("run-b", "event-2"));
    expect(readLedger().map((e) => [e.run_id, e.evidence.event_id]))
      .toEqual([["run-a", "event-1"], ["run-b", "event-2"]]);
  });

  // Built at runtime so that no token-shaped literal reaches git history (gitleaks).
  test("appendLedger masks token-like strings in evidence.text and evidence.message", () => {
    const tokens = [
      `ghp_${"a1B2".repeat(9)}`, "x".repeat(40), `xoxb-${"1234-".repeat(3)}abc`, `AKIA${"Q".repeat(16)}`,
      "0f".repeat(20), `${"Ab1".repeat(12)}==`,
    ];
    const text = `gh failed: Authorization: Bearer ${tokens[1]} token ${tokens[0]} slack ${tokens[2]} ` +
      `aws ${tokens[3]} sha ${tokens[4]} blob ${tokens[5]}`;
    appendLedger({
      ...entry("run-a", "event-1"), evidence: { event_id: "event-1", node: "n", text, message: `Збій: ${text}` },
    });
    const line = readFileSync(ledger, "utf8");
    for (const token of tokens) expect(line).not.toContain(token);
    expect(line).toContain("Bearer [REDACTED]");
    expect(JSON.parse(line)).toMatchObject({ run_id: "run-a", evidence: { event_id: "event-1", node: "n" } });
  });

  test("redact keeps ordinary error text", () => {
    const texts = [
      "Node 'review__code' failed: Cannot list Claude plugins (`claude plugin list --json` via ~/.local/bin/claude " +
        "failed): killed by SIGTERM",
      "/home/operator/.archon/workspaces/OlegShevtsov1/1_mvp_sdlc/worktrees/archon/task-factory-1793469185220",
      "run 69aea63f-1c2d-4e5f-8a9b-0c1d2e3f4a5b failed",
      "gh: HTTP 502: Bad Gateway (https://api.github.com/repos/OlegShevtsov1/1_mvp_sdlc/pulls)",
    ];
    for (const text of texts) expect(redact(text)).toBe(text);
  });
});
