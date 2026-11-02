import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendLog } from "./_lib/approval.ts";
import { alertOnce } from "./_lib/claude-login.ts";
import { redact, secretNamesFor } from "./_lib/exec.ts";
import { emit } from "./_lib/io.ts";
import {
  FILES, SHOT_TIMEOUT_MS, alertText, collectEvidence, qaMessage, repoOfPr, type Evidence, type QaDeps,
} from "./_lib/qa-evidence.ts";
import { runIdFrom } from "./_lib/trello.ts";

// The QA dev evidence after the deploy (PILOT-574). One script for every node of it, chosen by the
// `mode` binding (INPUTS_MODE) or, where until_bash runs it, by argv[2]:
//
// - evidence (qa-dev-evidence): bindings qa_dev ("" without the profile key), pr_url, merge_sha,
//   deployed, deploy_log, healthy, last_status, health_url, rollback, secret_names. off without qa_dev
//   or a merge, and then it calls nothing; else it waits for the e2e of the commit on dev, shoots the
//   changed pages with the checkout's Playwright and writes qa-dev.json (ready), or alerts the
//   operator once in Telegram and writes none (escalated).
// - turn (qa-dev-turn): the bun and the script path until_bash runs.
// - argv `until <dir> <decision> <text>`: until_bash. Saves the answer; always exit 0, one answer
//   ends the loop. The supervisor acts on it (E3 Task 4), nothing in the factory reads it.
//
// ARTIFACTS_DIR is engine-provided. evidence and turn print one JSON line and exit 0; steps go to
// qa-dev.log.
const env = process.env;
const dir = env.ARTIFACTS_DIR ?? ".";
const log = (line: string) => appendLog(dir, FILES.log, line);
const GH_TIMEOUT_MS = 120_000;
const SECRET_NAMES = secretNamesFor(env);
const PLAYWRIGHT = join("node_modules", ".bin", "playwright");

const deps: QaDeps = {
  gh(args) {
    const p = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe", timeout: GH_TIMEOUT_MS });
    return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: redact(p.stderr.toString().trim(), SECRET_NAMES) };
  },
  // The Playwright of the project's own e2e, from the checkout the merge gate installed.
  shoot(url, width, height, file) {
    if (!existsSync(PLAYWRIGHT)) return { ok: false, err: `${PLAYWRIGHT} is missing in the checkout (run npm ci)` };
    mkdirSync(dirname(file), { recursive: true });
    const p = Bun.spawnSync(
      [PLAYWRIGHT, "screenshot", "-b", "chromium", "--viewport-size", `${width}, ${height}`, "--wait-for-timeout", "2000", url, file],
      { stdout: "pipe", stderr: "pipe", timeout: SHOT_TIMEOUT_MS },
    );
    const said = redact(p.stderr.toString().trim().split("\n").at(-1) ?? "", SECRET_NAMES);
    return { ok: p.exitCode === 0, err: p.exitCode === 0 ? "" : `playwright exited ${p.exitCode ?? "on timeout"}${said ? `: ${said}` : ""}` };
  },
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
  log,
};

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function alert(e: Evidence, prUrl: string): Promise<string> {
  const runId = runIdFrom(dir);
  if (runId === null) return "dry-run";
  const sent = await alertOnce({
    marker: join(dir, FILES.alerted),
    helper: env.NOTIFY_TELEGRAM_SH || join(import.meta.dir, "_lib", "notify-telegram.sh"),
    message: alertText({ repo: repoOfPr(prUrl), cause: e.cause, link: e.link, prUrl, runId }),
    envFile: env.TELEGRAM_ENV_FILE || join(homedir(), ".config", "telegram-bots", ".env"),
  });
  if (sent.warning) log(`alert: ${sent.warning}`);
  return sent.alert;
}

async function evidence(): Promise<void> {
  const prUrl = env.INPUTS_PR_URL ?? "";
  const deployLogPath = env.INPUTS_DEPLOY_LOG ?? "";
  const e = await collectEvidence({
    qaDev: env.INPUTS_QA_DEV ?? "",
    prUrl,
    mergeSha: env.INPUTS_MERGE_SHA ?? "",
    deployed: env.INPUTS_DEPLOYED ?? "skipped",
    deployLog: deployLogPath === "" ? "" : readText(deployLogPath),
    deployLogPath,
    healthy: env.INPUTS_HEALTHY ?? "skipped",
    lastStatus: env.INPUTS_LAST_STATUS ?? "",
    healthUrl: env.INPUTS_HEALTH_URL ?? "",
    rollback: env.INPUTS_ROLLBACK ?? "",
    artifactsDir: dir,
  }, deps);
  const evidencePath = e.status === "ready" ? join(dir, FILES.evidence) : "";
  const sent = e.status === "escalated" ? await alert(e, prUrl) : "none";
  log(`evidence: ${e.status}${e.reason ? ` (${e.reason})` : ""}${e.sha ? ` sha ${e.sha}` : ""} alert ${sent}`);
  emit({
    status: e.status, reason: e.reason, sha: e.sha, url: e.url, e2e_conclusion: e.e2e.conclusion, e2e_run_url: e.e2e.run_url,
    shots: e.shots.length, evidence: evidencePath,
    message: e.status === "ready" ? qaMessage(e, prUrl, evidencePath) : "", alert: sent,
  });
}

function until(argv: string[]): number {
  const [at = dir, decision = "", answer = ""] = argv;
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, FILES.decision), decision);
  writeFileSync(join(at, FILES.text), answer);
  appendLog(at, FILES.log, `until: ${decision || "(none)"}${answer ? `: ${answer.replace(/\s+/g, " ").trim()}` : ""}`);
  return 0;
}

const command = process.argv[2] ?? "";
if (command === "until") {
  process.exitCode = until(process.argv.slice(3));
} else if (env.INPUTS_MODE === "evidence") {
  await evidence();
} else if (env.INPUTS_MODE === "turn") {
  emit({ script: import.meta.path, bun: process.execPath });
} else {
  process.stderr.write(`qa-dev: unknown mode '${env.INPUTS_MODE ?? ""}'\n`);
  process.exitCode = 2;
}
