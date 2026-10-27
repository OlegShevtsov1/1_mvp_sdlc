import { appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  alertMessage, alertOnce, capture, classifyProbe, findAuthFailure, repoFromArtifacts,
  type AlertResult, type AuthStatus, type NodeStatus,
} from "./_lib/claude-login.ts";
import { emit } from "./_lib/io.ts";
import { runIdFrom } from "./_lib/trello.ts";

// Checks the Claude CLI login of the Archon host and, when it has expired or is missing, sends one
// Telegram alert per run to MVP_VPN_ALERTS naming the fix (`claude /login`).
//   preflight — one minimal Haiku call (about $0.0001). `claude auth status` reads local state only
//               and reports an expired, unrefreshable login as logged in, so it cannot see this failure.
//   scan      — reads this run's transcript (`archon workflow logs <run-id>`) for a node the engine
//               failed with a provider auth error.
// Usage, also for the mvp-ops post-merge workflow:
//   bun <pack>/scripts/claude-auth.ts preflight|scan [workflow] [--dry-run]
// It prints one JSON line {status, node, alert, message} and exits 0; only a bad mode exits 2. Only a
// confirmed auth failure is auth_failed: a probe that cannot tell is unknown and the run proceeds. It
// never reads Claude's credential files, and the Telegram settings reach only the notify helper.
const MODES = ["preflight", "scan"] as const;
type Mode = (typeof MODES)[number];
const PROBE = [
  "claude", "-p", "--model", "haiku", "--tools", "", "--setting-sources", "", "--strict-mcp-config",
  "--no-session-persistence", "--system-prompt", "Reply with the single word OK.", "--output-format", "json", "ping",
];
const PROBE_TIMEOUT_MS = 90_000;
const SCAN_TIMEOUT_MS = 60_000;

const env = process.env;
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const mode = positional[0] ?? env.INPUTS_MODE ?? "";
const workflow = positional[1] ?? env.INPUTS_WORKFLOW ?? "";
const artifactsDir = env.ARTIFACTS_DIR ?? "";

interface Result {
  status: NodeStatus;
  node: string;
  alert: AlertResult;
  message: string;
  warning: string;
}

async function probe(): Promise<{ status: AuthStatus; node: string; warning: string }> {
  const r = await capture(PROBE, { env, cwd: tmpdir(), timeoutMs: PROBE_TIMEOUT_MS });
  if (r.timedOut) return { status: "unknown", node: "", warning: "the login probe timed out" };
  const c = classifyProbe(r.exitCode, r.stdout, r.stderr);
  return { status: c.status, node: "", warning: c.status === "ok" ? "" : c.detail };
}

async function scan(runId: string): Promise<{ status: AuthStatus; node: string; warning: string }> {
  const r = await capture(["archon", "workflow", "logs", runId], { env, timeoutMs: SCAN_TIMEOUT_MS });
  if (r.timedOut) return { status: "unknown", node: "", warning: "archon workflow logs timed out" };
  if (r.exitCode !== 0) {
    const said = r.stderr.split("\n").find((l) => l.trim() !== "") ?? "";
    return { status: "unknown", node: "", warning: `archon workflow logs exited ${r.exitCode}: ${said.trim()}` };
  }
  const node = findAuthFailure(r.stdout);
  return node ? { status: "auth_failed", node, warning: "" } : { status: "ok", node: "", warning: "" };
}

async function check(m: Mode): Promise<Result> {
  const runId = runIdFrom(artifactsDir);
  if (process.argv.includes("--dry-run") || runId === null) {
    return { status: "dry-run", node: "", alert: "none", message: "", warning: "" };
  }
  const found = m === "preflight" ? await probe() : await scan(runId);
  if (found.status !== "auth_failed") return { ...found, alert: "none", message: "" };
  const message = alertMessage({ workflow, runId, repo: repoFromArtifacts(artifactsDir), node: found.node });
  const sent = await alertOnce({
    marker: join(artifactsDir, "claude-auth.alerted"),
    helper: env.NOTIFY_TELEGRAM_SH || join(import.meta.dir, "_lib", "notify-telegram.sh"),
    message,
    envFile: env.TELEGRAM_ENV_FILE || join(homedir(), ".config", "telegram-bots", ".env"),
  });
  return { ...found, alert: sent.alert, message, warning: [found.warning, sent.warning].filter(Boolean).join("; ") };
}

if (!(MODES as readonly string[]).includes(mode)) {
  process.stderr.write("usage: claude-auth.ts preflight|scan [workflow] [--dry-run]\n");
  process.exitCode = 2;
} else {
  let result: Result;
  try {
    result = await check(mode as Mode);
  } catch (e) {
    result = { status: "unknown", node: "", alert: "none", message: "", warning: `unexpected: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (result.warning) process.stderr.write(`claude-auth: warning: ${result.warning}\n`);
  if (artifactsDir) {
    try {
      const line = `${new Date().toISOString()} ${mode} status=${result.status} node=${result.node || "-"} alert=${result.alert} ${result.warning}`;
      appendFileSync(join(artifactsDir, "claude-auth.log"), line.trimEnd() + "\n");
    } catch (e) {
      process.stderr.write(`claude-auth: warning: claude-auth.log not written: ${(e as Error).message}\n`);
    }
  }
  emit({ status: result.status, node: result.node, alert: result.alert, message: result.message });
}
