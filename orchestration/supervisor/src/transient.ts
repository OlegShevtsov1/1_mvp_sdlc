import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Decision, runDetached } from "./act.ts";
import { appendLedger, ledgerPath, readLedger } from "./ledger.ts";
import type { Policy } from "./main.ts";
import { type Host, hostIdle } from "./resources.ts";
import { isForbiddenRepo, repoOf, type RunView } from "./runs.ts";

export type TransientClass =
  | "session-limit" | "oauth" | "github-5xx" | "network" | "sigterm" | "first-event-timeout" | "db-locked";
export type TransientRule = {
  classes: TransientClass[];
  backoffMinutes: number[];
  maxAgeMinutes: number;
};

// The first match wins. SIGTERM is often only the symptom of a timeout or overload that killed the child, so the more
// specific classes come first. Archon's "retrying will not help" wording is no veto: the 69aea63f reviewers were killed
// under host load, not by a configuration fault. SIGINT is an operator's Ctrl-C and is not transient.
const PATTERNS: [TransientClass, RegExp][] = [
  ["session-limit", /hit your session limit|\(rate_limit\)/i],
  ["oauth", /OAuth session expired|could not verify native authentication/i],
  ["first-event-timeout", /produced no output within \d+ ?ms/],
  ["db-locked", /database is locked/i],
  ["github-5xx", /\bHTTP 50[0234]\b|\b50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i],
  [
    "network",
    /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b|Could not resolve host|connection reset by peer|TLS handshake timeout/i,
  ],
  ["sigterm", /\bSIGTERM\b/],
];
const CLASSES = PATTERNS.map(([cls]) => cls);

const RECOMMENDATIONS: Record<TransientClass, string> = {
  "session-limit": "дочекатися скидання ліміту сесії Claude і виконати `archon workflow resume <id>`",
  oauth: "оновити вхід Claude (`claude /login`) і виконати resume",
  "github-5xx": "перевірити githubstatus.com і після відновлення виконати resume",
  network: "перевірити мережу хоста і виконати resume",
  sigterm: "перевірити навантаження хоста (load, MemAvailable) і хто надсилає SIGTERM, потім resume",
  "first-event-timeout": "перевірити навантаження хоста і дамп `claude.first_event_timeout` у логах, потім resume",
  "db-locked": "перевірити, хто тримає `~/.archon/archon.db`, потім resume",
};

const RULE_ID = "transient-resume";

// `archon workflow resume` takes failed runs only; a cancelled run is never resumed here.
export function classifyFailure(run: RunView): TransientClass | null {
  if (run.status !== "failed" || !run.lastError) return null;
  const error = run.lastError;
  return PATTERNS.find(([, re]) => re.test(error))?.[0] ?? null;
}

export function transientRule(policy: Policy): TransientRule | null {
  const raw = policy.rules.find((r) => (r as { id?: unknown } | null)?.id === RULE_ID) as
    | Record<string, unknown>
    | undefined;
  if (!raw) return null;
  const bad = (what: string): never => {
    throw new Error(`policy.yaml: rule ${RULE_ID}: ${what}`);
  };
  const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const { classes, backoff_minutes: backoff, max_age_minutes: maxAge } = raw;
  if (!Array.isArray(classes) || !classes.every((c) => CLASSES.includes(c))) {
    bad(`classes must be some of ${CLASSES.join(", ")}`);
  }
  if (!Array.isArray(backoff) || backoff.length === 0 || !backoff.every((m) => isNumber(m) && m > 0)) {
    bad("backoff_minutes must be a non-empty list of positive numbers");
  }
  if (!isNumber(maxAge)) bad("max_age_minutes must be a number");
  return {
    classes: classes as TransientClass[], backoffMinutes: backoff as number[], maxAgeMinutes: maxAge as number,
  };
}

// Waiting (backoff, live owner, busy host) is not a decision, so it returns null and leaves no ledger line.
export function decideFailure(run: RunView, cls: TransientClass, rule: TransientRule,
  ctx: { now: Date; attempts: number; lastResumeAt?: Date; ownerAlive: boolean; host: () => Host }): Decision | null {
  const max = rule.backoffMinutes.length;
  const recommendation = `Рекомендація: ${RECOMMENDATIONS[cls].replace("<id>", run.id)}.`;
  const subject = `Транзієнтний збій ${cls} у прогоні ${run.id.slice(0, 8)} (${run.workflow})`;
  if (ctx.attempts >= max) {
    return {
      action: "escalate", rule: "transient-exhausted",
      text: `${subject} повторився після ${max} спроб resume — автоматичних спроб більше не буде. ${recommendation}`,
    };
  }
  const minutesSince = (ctx.now.getTime() - failedAt(run)) / 60_000;
  if (!Number.isFinite(minutesSince)) {
    return {
      action: "escalate", rule: "transient-stale",
      text: `${subject}: час збою невідомий (created_at не розпізнано) — не відновлюю автоматично. ${recommendation}`,
    };
  }
  if (minutesSince > rule.maxAgeMinutes) {
    return {
      action: "escalate", rule: "transient-stale",
      text: `${subject} старший за ${rule.maxAgeMinutes} хв — не відновлюю автоматично. ${recommendation}`,
    };
  }
  // A resume that left no new failure event is retried on the same event, and its backoff counts from that resume.
  const minutesWaited = ctx.lastResumeAt ? (ctx.now.getTime() - ctx.lastResumeAt.getTime()) / 60_000 : minutesSince;
  if (minutesWaited < rule.backoffMinutes[ctx.attempts] || ctx.ownerAlive) return null;
  if (!hostIdle(ctx.host())) return null;
  return { action: "resume", rule: RULE_ID, text: `Resume після ${cls}, спроба ${ctx.attempts + 1} з ${max}` };
}

// Archon's created_at is UTC without a zone.
function failedAt(run: RunView): number {
  return Date.parse(`${run.failure?.at.replace(" ", "T")}Z`);
}

// Archon keeps a dead owner's pid, and the kernel reuses pids, so a pid only counts while its cmdline is `archon …`.
// An owner on another host cannot be checked and is taken as alive.
export function ownerAlive(owner: RunView["owner"]): boolean {
  if (!owner) return false;
  if (owner.host !== hostname()) return true;
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${owner.pid}/cmdline`, "utf8");
  } catch {
    return false;
  }
  return cmdline.split("\0").slice(0, 2).some((arg) => basename(arg) === "archon");
}

// The ledger line is written before the resume starts, so a crash between the two never resumes twice. A resume that
// cannot start throws and is escalated on the same event. A resume whose child dies without a new failure event leaves
// only its `resume` line on the event, so that event stays open and counts the resume as an attempt: the run is never
// left failed and silently marked as handled.
export function handleFailure(run: RunView, policy: Policy,
  deps: { now: Date; host: () => Host; resume: (run: RunView) => void }): boolean {
  const cls = classifyFailure(run);
  const rule = transientRule(policy);
  if (!cls || !rule?.classes.includes(cls) || !run.failure) return false;
  const eventId = run.failure.eventId;
  const lines = readLedger().filter((e) => e.run_id === run.id);
  if (lines.some((e) => e.evidence?.event_id === eventId && e.action !== "resume")) return false;
  const resumes = lines.filter((e) => e.kind === cls && e.action === "resume");
  const sameEvent = resumes.filter((e) => e.evidence?.event_id === eventId).at(-1);
  const repo = repoOf(run.cwd);
  const decision: Decision | null = isForbiddenRepo(repo)
    ? {
      action: "escalate", rule: "transient-forbidden-repo",
      text: `Транзієнтний збій ${cls} у прогоні ${run.id.slice(0, 8)} (${run.workflow}) не відновлено: ` +
        `репозиторій ${repo} поза межами супервізора.`,
    }
    : decideFailure(run, cls, rule, {
      now: deps.now, attempts: resumes.length, lastResumeAt: sameEvent && new Date(sameEvent.ts),
      ownerAlive: ownerAlive(run.owner), host: deps.host,
    });
  if (!decision) return false;
  const record = (d: Decision, text: string | undefined) => appendLedger({
    ts: deps.now.toISOString(), run_id: run.id, workflow: run.workflow, kind: cls, rule: d.rule, action: d.action,
    evidence: { event_id: eventId, node: "", text, message: d.text },
  });
  record(decision, run.lastError);
  if (decision.action !== "resume") return true;
  try {
    deps.resume(run);
  } catch (e) {
    const reason = `resume did not start: ${e instanceof Error ? e.message : String(e)}`;
    record({
      action: "escalate", rule: "transient-resume-failed",
      text: `Resume прогону ${run.id.slice(0, 8)} (${run.workflow}) не стартував (${reason}) — ` +
        "потрібне рішення оператора.",
    }, reason);
  }
  return true;
}

// The detached child's exit is never awaited, so whatever would make `archon workflow resume` fail at once is checked
// here: archon refuses to run outside a git work tree. PATH is passed explicitly because Bun.which otherwise ignores a
// PATH changed at runtime, and the resolved path is spawned so the check and the spawn agree.
export function resumeDetached(run: RunView): void {
  const cwd = run.cwd;
  if (!cwd) throw new Error("run has no working directory");
  if (!existsSync(cwd)) throw new Error(`working directory ${cwd} does not exist`);
  const git = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], { stderr: "ignore" });
  if (git.exitCode !== 0 || git.stdout.toString().trim() !== "true") throw new Error(`${cwd} is not a git work tree`);
  const archon = Bun.which("archon", { PATH: process.env.PATH });
  if (!archon) throw new Error("archon not found on PATH");
  runDetached([archon, "workflow", "resume", run.id], cwd, join(dirname(ledgerPath()), "logs", `${run.id}.log`));
}
