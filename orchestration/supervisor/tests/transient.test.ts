import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { LedgerEntry } from "../src/ledger.ts";
import { loadPolicy, type Policy, tick } from "../src/main.ts";
import type { RunView } from "../src/runs.ts";
import { type Host, readHost } from "../src/resources.ts";
import {
  classifyFailure, decideFailure, ownerAlive, resumeDetached, type TransientRule, transientRule,
} from "../src/transient.ts";
import { fixtureDb, insertEvent, insertRun } from "./fixtures/db.ts";

const POLICY = join(import.meta.dir, "..", "policy.yaml");

// Real texts from ~/.archon/archon.db: 69aea63f (SIGTERM, first event), 99d0a351, c28d5553, 6d2a88ea, e2d5980d.
const SIGTERM = "DAG workflow 'factory' completed with failures: 'review__code': Node 'review__code' failed: the " +
  "provider's configuration must be fixed before it can run; retrying will not help: Cannot list Claude plugins " +
  "(`claude plugin list --json` via ~/.local/bin/claude failed): killed by SIGTERM";
const FIRST_EVENT = "provider reported transient: Claude Code subprocess produced no output within 60000ms";
const DB_LOCKED = "Detached run failed to start: Failed to get workflow run: database is locked";
const SESSION_LIMIT = "Claude API error (rate_limit): You've hit your session limit · resets 8:30pm (Europe/Kyiv)";
const OAUTH = "provider reported auth: Failed to authenticate: OAuth session expired and could not be refreshed";
const OAUTH_PREFLIGHT = "Credential preflight failed for provider 'claude' (vendor 'anthropic'): " +
  "could not verify native authentication";
const RED_GATE = "The project gate is red and declared no usable red_cause, so the run stops here.";

const failed = (error: string, status = "failed"): RunView => ({
  id: "run-1", workflow: "factory", status, cwd: "", message: "m", lastError: error,
});

const RULE: TransientRule = {
  classes: ["session-limit", "oauth", "github-5xx", "network", "sigterm", "first-event-timeout", "db-locked"],
  backoffMinutes: [2, 5, 15], maxAgeMinutes: 60,
};
const AT = "2026-10-31 10:00:00";
const minutesAfter = (m: number) => new Date(Date.parse("2026-10-31T10:00:00Z") + m * 60_000);
const IDLE: Host = { memAvailableMb: 8000, load1: 1 };
const failedAt = (): RunView => ({ ...failed(SIGTERM), failure: { eventId: "f1", at: AT } });
const decide = (m: number, attempts: number, extra: { ownerAlive?: boolean; host?: Host } = {}) =>
  decideFailure(failedAt(), "sigterm", RULE, {
    now: minutesAfter(m), attempts, ownerAlive: extra.ownerAlive ?? false, host: () => extra.host ?? IDLE,
  });

// A child whose /proc cmdline starts with `archon`, like Archon's own `archon workflow run` owner.
async function spawnArchonLike() {
  const child = Bun.spawn(["bash", "-c", "exec -a archon sleep 30"]);
  for (let i = 0; i < 20; i++) {
    if (readFileSync(`/proc/${child.pid}/cmdline`, "utf8").startsWith("archon\0")) break;
    await Bun.sleep(100);
  }
  return child;
}

describe("classifyFailure", () => {
  test("killed by SIGTERM is sigterm", () => {
    expect(classifyFailure(failed(SIGTERM))).toBe("sigterm");
    expect(classifyFailure(failed("Process terminated (SIGTERM)"))).toBe("sigterm");
  });

  test("produced no output within 60000ms is first-event-timeout", () => {
    expect(classifyFailure(failed(FIRST_EVENT))).toBe("first-event-timeout");
  });

  test("database is locked is db-locked", () => {
    expect(classifyFailure(failed(DB_LOCKED))).toBe("db-locked");
  });

  test("HTTP 502 and 503 from gh are github-5xx", () => {
    const gh502 = "gh: HTTP 502: Bad Gateway (https://api.github.com/repos/o/r/pulls)";
    expect(classifyFailure(failed(gh502))).toBe("github-5xx");
    expect(classifyFailure(failed("HTTP 503: Service Unavailable"))).toBe("github-5xx");
  });

  test("session limit is session-limit", () => {
    expect(classifyFailure(failed(SESSION_LIMIT))).toBe("session-limit");
  });

  test("expired OAuth is oauth", () => {
    expect(classifyFailure(failed(OAUTH))).toBe("oauth");
    expect(classifyFailure(failed(OAUTH_PREFLIGHT))).toBe("oauth");
  });

  test("ECONNRESET is network", () => {
    expect(classifyFailure(failed("fetch failed: read ECONNRESET"))).toBe("network");
  });

  test("non-transient error returns null", () => {
    expect(classifyFailure(failed(RED_GATE))).toBeNull();
    expect(classifyFailure(failed("post-merge: run PILOT469 has no section in the plan"))).toBeNull();
    expect(classifyFailure(failed("Process terminated (SIGINT)"))).toBeNull();
  });

  test("only failed runs are classified", () => {
    expect(classifyFailure(failed(SIGTERM, "cancelled"))).toBeNull();
  });
});

describe("transientRule", () => {
  test("the shipped policy has the transient-resume rule", () => {
    expect(transientRule(loadPolicy(POLICY))).toEqual(RULE);
    const unknownClass: Policy = {
      version: 1,
      rules: [{ id: "transient-resume", classes: ["sigkill"], backoff_minutes: [2], max_age_minutes: 60 }],
    };
    expect(() => transientRule(unknownClass)).toThrow(/transient-resume/);
    expect(transientRule({ version: 1, rules: [] })).toBeNull();
  });

  test("loadPolicy rejects a malformed transient-resume rule", () => {
    const bad = join(mkdtempSync(join(tmpdir(), "supervisor-policy-")), "policy.yaml");
    writeFileSync(bad, readFileSync(POLICY, "utf8").replace("backoff_minutes: [2, 5, 15]", "backoff_minutes: 2"));
    expect(() => loadPolicy(bad)).toThrow(/transient-resume: backoff_minutes/);
  });
});

describe("decideFailure", () => {
  test("resume waits for the backoff", () => {
    for (const [early, due, attempts] of [[1, 2, 0], [4, 5, 1], [14, 15, 2]]) {
      expect(decide(early, attempts)).toBeNull();
      expect(decide(due, attempts)).toMatchObject({ action: "resume", rule: "transient-resume" });
    }
  });

  test("resume waits while the host is over the resource threshold", () => {
    expect(decide(2, 0, { host: { memAvailableMb: 1499, load1: 1 } })).toBeNull();
    expect(decide(2, 0, { host: { memAvailableMb: 4000, load1: 8.5 } })).toBeNull();
    expect(decide(2, 0, { host: { memAvailableMb: 1500, load1: 8 } })).toMatchObject({ action: "resume" });
  });

  test("resume waits while the owner is alive", () => {
    expect(decide(2, 0, { ownerAlive: true })).toBeNull();
  });

  test("a failure older than max_age escalates as stale", () => {
    expect(decide(61, 0)).toMatchObject({ action: "escalate", rule: "transient-stale" });
  });

  test("an unparsable failure time escalates as stale", () => {
    for (const attempts of [0, 1]) {
      const d = decideFailure({ ...failedAt(), failure: { eventId: "f1", at: "not a date" } }, "sigterm", RULE, {
        now: minutesAfter(3), attempts, ownerAlive: false, host: () => IDLE,
      });
      expect(d).toMatchObject({ action: "escalate", rule: "transient-stale" });
      expect(d?.text).toContain("час збою невідомий");
    }
  });

  test("the exhausted escalation names the class and a recommendation", () => {
    const d = decide(16, 3);
    expect(d).toMatchObject({ action: "escalate", rule: "transient-exhausted" });
    expect(d?.text).toContain("sigterm");
    expect(d?.text).toContain("3 спроб");
    expect(d?.text).toContain("Рекомендація:");
  });
});

describe("ownerAlive", () => {
  test("ownerAlive recognises a live archon owner", async () => {
    const child = await spawnArchonLike();
    try {
      expect(ownerAlive({ host: hostname(), pid: child.pid })).toBe(true);
      expect(ownerAlive({ host: hostname(), pid: process.pid })).toBe(false);
      expect(ownerAlive({ host: `not-${hostname()}`, pid: process.pid })).toBe(true);
      expect(ownerAlive(undefined)).toBe(false);
      child.kill();
      await child.exited;
      expect(ownerAlive({ host: hostname(), pid: child.pid })).toBe(false);
    } finally {
      child.kill();
    }
  });
});

describe("readHost", () => {
  test("readHost parses MemAvailable in MB and load1", () => {
    const meminfo = "MemTotal:       32000000 kB\nMemFree:  1000 kB\nMemAvailable:    1536000 kB\n";
    expect(readHost({ meminfo, loadavg: "8.52 7.10 6.00 3/1234 5678\n" }))
      .toEqual({ memAvailableMb: 1500, load1: 8.52 });
    expect(() => readHost({ meminfo: "MemTotal: 1 kB\n", loadavg: "1 1 1" })).toThrow();
  });
});

describe("tick on failed runs", () => {
  let ledger: string;
  let db: Database;
  let resumed: string[];
  const NOW = new Date("2026-10-31T12:00:00Z");
  const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const lines = (): LedgerEntry[] =>
    existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  let order = 0;
  const fail = (id: string, error: string, minutesAgo: number, runId = "run-1") =>
    insertEvent(db, {
      id, workflow_run_id: runId, event_order: ++order, event_type: "workflow_failed", step_name: null,
      data: JSON.stringify({ error }), created_at: ago(minutesAgo),
    });
  const run = () => tick({
    db, policy: loadPolicy(POLICY), now: () => NOW, host: () => IDLE, resume: (r) => resumed.push(r.id),
  });

  beforeEach(() => {
    ledger = join(mkdtempSync(join(tmpdir(), "supervisor-transient-")), "ledger.jsonl");
    process.env.SDLC_AUTOPILOT_LEDGER = ledger;
    db = fixtureDb();
    resumed = [];
  });
  afterEach(() => db.close());

  test("three attempts of one class then one escalation with the class named", async () => {
    insertRun(db, { id: "run-1", workflow_name: "factory", user_message: "m", status: "failed" });
    fail("f1", SIGTERM, 3);
    await run();
    expect(resumed).toEqual(["run-1"]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      run_id: "run-1", workflow: "factory", action: "resume", kind: "sigterm", rule: "transient-resume",
      evidence: { event_id: "f1", text: SIGTERM },
    });

    await run();
    expect(resumed).toHaveLength(1);
    expect(lines()).toHaveLength(1);

    fail("f2", SIGTERM, 6);
    await run();
    fail("f3", SIGTERM, 16);
    await run();
    expect(resumed).toHaveLength(3);

    fail("f4", SIGTERM, 16);
    await run();
    expect(resumed).toHaveLength(3);
    expect(lines()).toHaveLength(4);
    expect(lines()[3]).toMatchObject({
      action: "escalate", kind: "sigterm", rule: "transient-exhausted", evidence: { event_id: "f4" },
    });
    expect(lines()[3].evidence.message).toContain("sigterm");
    expect(lines()[3].evidence.message).toContain("Рекомендація:");

    await run();
    expect(lines()).toHaveLength(4);
  });

  test("a resume whose child dies without a new failure event is retried, then escalated", async () => {
    insertRun(db, { id: "run-1", workflow_name: "factory", user_message: "m", status: "failed" });
    fail("f1", SIGTERM, 3);
    const policy = loadPolicy(POLICY);
    const at = (m: number) =>
      tick({ db, policy, now: () => minutesLater(m), host: () => IDLE, resume: (r) => resumed.push(r.id) });
    const minutesLater = (m: number) => new Date(NOW.getTime() + m * 60_000);
    await at(0);
    await at(4);
    expect(resumed).toHaveLength(1);
    await at(5);
    await at(19);
    expect(resumed).toHaveLength(2);
    await at(20);
    expect(resumed).toHaveLength(3);
    await at(21);
    await at(22);
    expect(resumed).toHaveLength(3);
    expect(lines().map((l) => [l.action, l.evidence.event_id])).toEqual([
      ["resume", "f1"], ["resume", "f1"], ["resume", "f1"], ["escalate", "f1"],
    ]);
    expect(lines()[3]).toMatchObject({ rule: "transient-exhausted" });
  });

  test("a class the rule does not list is not resumed", async () => {
    const policy: Policy = {
      version: 1,
      rules: loadPolicy(POLICY).rules.map((r) =>
        (r as { id?: string }).id === "transient-resume" ? { ...(r as object), classes: ["network"] } : r),
    };
    insertRun(db, { id: "run-1", workflow_name: "factory", user_message: "m", status: "failed" });
    insertRun(db, { id: "run-2", workflow_name: "factory", user_message: "m", status: "failed" });
    fail("f1", SIGTERM, 3);
    fail("n1", "fetch failed: read ECONNRESET", 3, "run-2");
    await tick({ db, policy, now: () => NOW, host: () => IDLE, resume: (r) => resumed.push(r.id) });
    expect(resumed).toEqual(["run-2"]);
    expect(lines().map((l) => l.run_id)).toEqual(["run-2"]);
  });

  test("a different class has its own three attempts", async () => {
    insertRun(db, { id: "run-1", workflow_name: "factory", user_message: "m", status: "failed" });
    for (const [id, m] of [["f1", 3], ["f2", 6], ["f3", 16]] as const) {
      fail(id, SIGTERM, m);
      await run();
    }
    fail("n1", "fetch failed: read ECONNRESET", 3);
    await run();
    expect(resumed).toHaveLength(4);
    expect(lines()[3]).toMatchObject({ action: "resume", kind: "network", evidence: { event_id: "n1" } });
  });

  test("resume is skipped while the run has a live execution owner", async () => {
    const child = await spawnArchonLike();
    try {
      insertRun(db, {
        id: "run-1", workflow_name: "factory", user_message: "m", status: "failed",
        metadata: JSON.stringify({ execution_owner: { host: hostname(), pid: child.pid, uid: 1000 } }),
      });
      fail("f1", SIGTERM, 3);
      await run();
      expect(lines()).toHaveLength(0);
      expect(resumed).toHaveLength(0);

      child.kill();
      await child.exited;
      await run();
      expect(resumed).toEqual(["run-1"]);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatchObject({ action: "resume" });
    } finally {
      child.kill();
    }
  });

  test("a resume that does not start escalates once on the same event", async () => {
    insertRun(db, { id: "run-1", workflow_name: "factory", user_message: "m", status: "failed" });
    fail("f1", SIGTERM, 3);
    const policy = loadPolicy(POLICY);
    const resume = () => {
      throw new Error("spawn archon ENOENT");
    };
    await tick({ db, policy, now: () => NOW, host: () => IDLE, resume });
    await tick({ db, policy, now: () => NOW, host: () => IDLE, resume });
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toMatchObject({
      action: "escalate", kind: "sigterm", rule: "transient-resume-failed",
      evidence: { event_id: "f1", text: "resume did not start: spawn archon ENOENT" },
    });
    expect(lines()[1].evidence.message).toContain("не стартував (resume did not start: spawn archon ENOENT)");
  });

  test("a resume whose working directory is missing escalates once with the reason", async () => {
    insertRun(db, { id: "run-1", workflow_name: "factory", user_message: "m", status: "failed" });
    fail("f1", SIGTERM, 3);
    const policy = loadPolicy(POLICY);
    await tick({ db, policy, now: () => NOW, host: () => IDLE });
    await tick({ db, policy, now: () => NOW, host: () => IDLE });
    expect(lines()).toHaveLength(2);
    expect(lines()[0]).toMatchObject({ action: "resume", evidence: { event_id: "f1" } });
    expect(lines()[1]).toMatchObject({
      action: "escalate", rule: "transient-resume-failed", evidence: { event_id: "f1" },
    });
    expect(lines()[1].evidence.text).toMatch(/resume did not start: run has no working directory/);
  });

  test("a run in a forbidden repo is escalated once, never resumed", async () => {
    for (const [id, repo] of [["run-1", "1_hrss_pilot"], ["run-2", "pilot-srv-api"]]) {
      insertRun(db, {
        id, workflow_name: "factory", user_message: "m", status: "failed",
        working_path: `/home/operator/.archon/workspaces/OlegShevtsov1/${repo}/worktrees/archon/task-${id}`,
      });
      fail(`f-${id}`, SIGTERM, 3, id);
    }
    await run();
    await run();
    expect(resumed).toHaveLength(0);
    expect(lines().map((l) => [l.run_id, l.action, l.rule])).toEqual([
      ["run-1", "escalate", "transient-forbidden-repo"], ["run-2", "escalate", "transient-forbidden-repo"],
    ]);
    expect(lines()[0].evidence.message).toContain("OlegShevtsov1/1_hrss_pilot");
  });

  test("one run's error does not stop the runs after it", async () => {
    insertRun(db, {
      id: "run-0", workflow_name: "factory", user_message: "m", status: "failed", started_at: "2026-10-31 09:00:00",
    });
    insertRun(db, {
      id: "run-1", workflow_name: "factory", user_message: "m", status: "failed", started_at: "2026-10-31 10:00:00",
    });
    fail("f0", SIGTERM, 3, "run-0");
    fail("f1", SIGTERM, 3);
    let calls = 0;
    const host = () => {
      if (calls++ === 0) throw new Error("cannot read MemAvailable and load1 from /proc");
      return IDLE;
    };
    await tick({ db, policy: loadPolicy(POLICY), now: () => NOW, host, resume: (r) => resumed.push(r.id) });
    expect(resumed).toEqual(["run-1"]);
  });

  test("non-transient failure writes nothing", async () => {
    insertRun(db, { id: "run-1", workflow_name: "factory", user_message: "m", status: "failed" });
    fail("f1", RED_GATE, 3);
    await run();
    expect(lines()).toHaveLength(0);
    expect(resumed).toHaveLength(0);
  });
});

describe("resumeDetached", () => {
  // A fake `archon` first on PATH records its argv and working directory.
  async function resumeWithFakeArchon(cwd: string, path?: string): Promise<string | null> {
    const dir = mkdtempSync(join(tmpdir(), "supervisor-resume-"));
    const out = join(dir, "archon.out");
    writeFileSync(join(dir, "archon"), `#!/bin/sh\necho "$@ | $PWD" > ${out}\n`);
    chmodSync(join(dir, "archon"), 0o755);
    const saved = { PATH: process.env.PATH, SDLC_AUTOPILOT_LEDGER: process.env.SDLC_AUTOPILOT_LEDGER };
    process.env.PATH = path ?? `${dir}:${saved.PATH}`;
    process.env.SDLC_AUTOPILOT_LEDGER = join(dir, "ledger.jsonl");
    try {
      resumeDetached({ ...failed(SIGTERM), cwd });
    } finally {
      process.env.PATH = saved.PATH;
      process.env.SDLC_AUTOPILOT_LEDGER = saved.SDLC_AUTOPILOT_LEDGER;
    }
    for (let i = 0; i < 50 && !(existsSync(out) && readFileSync(out, "utf8").endsWith("\n")); i++) await Bun.sleep(100);
    return existsSync(out) ? readFileSync(out, "utf8").trim() : null;
  }
  const gitWorkTree = () => {
    const dir = mkdtempSync(join(tmpdir(), "supervisor-cwd-"));
    expect(Bun.spawnSync(["git", "init", "-q", dir]).exitCode).toBe(0);
    return dir;
  };

  test("resumeDetached runs archon workflow resume in the run's git work tree", async () => {
    const cwd = gitWorkTree();
    expect(await resumeWithFakeArchon(cwd)).toBe(`workflow resume run-1 | ${cwd}`);
  });

  test("resumeDetached throws for a run without a working directory", async () => {
    await expect(resumeWithFakeArchon("")).rejects.toThrow(/run has no working directory/);
  });

  test("resumeDetached throws for a removed working directory", async () => {
    await expect(resumeWithFakeArchon("/nonexistent/worktree")).rejects.toThrow(/does not exist/);
  });

  test("resumeDetached throws outside a git work tree", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "supervisor-cwd-"));
    await expect(resumeWithFakeArchon(cwd)).rejects.toThrow(/not a git work tree/);
  });

  test("resumeDetached throws when archon is not on PATH", async () => {
    await expect(resumeWithFakeArchon(gitWorkTree(), "/usr/bin:/bin")).rejects.toThrow(/archon not found on PATH/);
  });
});
