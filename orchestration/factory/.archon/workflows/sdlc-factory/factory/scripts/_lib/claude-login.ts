import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { redact } from "./exec.ts";
import { parseJsonObject } from "./io.ts";
import { ASSIGNMENT } from "./trello.ts";

// Detects an expired or missing Claude CLI login and tells the operator once per run through the
// MVP_VPN_ALERTS Telegram topic. Nothing here reads Claude's credential files or prints a token.

// factory.yaml enumerates these in the claude-auth output_format; tests/claude-auth.test.ts keeps them equal.
export const AUTH_STATUSES = ["ok", "auth_failed", "unknown"] as const;
export const NODE_STATUSES = [...AUTH_STATUSES, "dry-run"] as const;
export const ALERT_RESULTS = ["none", "sent", "skipped", "failed", "already"] as const;
export type AuthStatus = (typeof AUTH_STATUSES)[number];
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type AlertResult = (typeof ALERT_RESULTS)[number];

// What the Claude CLI prints when it cannot authenticate (an `is_error` result, or a failed exit
// with no JSON at all).
const AUTH_PATTERN = /Failed to authenticate|Not logged in|OAuth (session|token)|Invalid API key|authentication_failed|Please run \/login/i;
// Archon's own classification of a provider auth failure in a node_error line (v0.12.1).
const ENGINE_AUTH = "provider reported auth:";
const DETAIL_LIMIT = 200;

export const TELEGRAM_TOPIC = "MVP_VPN_ALERTS";
export const TELEGRAM_VARS = ["BOT_TOKEN", "CHAT_ID", "THREAD_ID"].map((part) => `TELEGRAM_${TELEGRAM_TOPIC}_${part}`);

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, DETAIL_LIMIT);
}

export function classifyProbe(exitCode: number, stdout: string, stderr: string): { status: AuthStatus; detail: string } {
  const last = stdout.trim().split("\n").pop() ?? "";
  const doc = parseJsonObject(last);
  if (doc !== null && typeof doc.is_error === "boolean") {
    if (!doc.is_error) return { status: "ok", detail: "" };
    const result = String(doc.result ?? "");
    return { status: AUTH_PATTERN.test(result) ? "auth_failed" : "unknown", detail: firstLine(result) };
  }
  const text = `${stdout}\n${stderr}`;
  if (exitCode !== 0 && AUTH_PATTERN.test(text)) return { status: "auth_failed", detail: firstLine(text) };
  return { status: "unknown", detail: firstLine(text) || `claude exited ${exitCode} with no result` };
}

// Only node_error lines count: provider_event lines carry arbitrary tool output, which can hold the same words.
export function findAuthFailure(transcript: string): string {
  for (const line of transcript.split("\n")) {
    const doc = parseJsonObject(line);
    if (doc?.type === "node_error" && typeof doc.error === "string" && doc.error.includes(ENGINE_AUTH)) {
      return String(doc.step ?? "");
    }
  }
  return "";
}

export function repoFromArtifacts(dir: string): string {
  const m = /\/workspaces\/([^/]+)\/([^/]+)\/artifacts\/runs\/[^/]+\/?$/.exec(dir);
  return m ? `${m[1]}/${m[2]}` : "";
}

export function alertMessage(a: { workflow: string; runId: string; repo: string; node: string }): string {
  const where = a.node ? `node ${a.node} failed with a provider auth error` : "pre-flight check";
  return `Archon ${a.workflow ? `${a.workflow} ` : ""}run ${a.runId.slice(0, 8)}${a.repo ? ` in ${a.repo}` : ""} stopped: ` +
    `the Claude CLI login on the Archon host has expired (${where}). Fix: run \`claude /login\` on the host, then start a new run.`;
}

// The environment wins over the file, as bin/project-add reads the same settings.
export function telegramEnv(env: Record<string, string | undefined>, envFile: string): Record<string, string> {
  const file = new Map<string, string>();
  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = ASSIGNMENT.exec(line);
      if (m) file.set(m[1], m[2].replace(/^['"]|['"]$/g, ""));
    }
  } catch {
    // No file: only the environment counts.
  }
  return Object.fromEntries(TELEGRAM_VARS.map((name) => [name, env[name] || file.get(name) || ""]));
}

export interface Captured {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Runs argv without a shell. A command that cannot start is exit -1 with the reason on stderr.
export async function capture(
  argv: string[],
  opts: { env: Record<string, string | undefined>; timeoutMs: number; cwd?: string },
): Promise<Captured> {
  let proc;
  try {
    proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { exitCode: -1, stdout: "", stderr: `${argv[0]} could not start: ${e instanceof Error ? e.message : String(e)}`, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

export interface AlertInput {
  marker: string;
  helper: string;
  message: string;
  envFile: string;
}

// The marker makes it once per run; a skipped or failed alert leaves none, so a later check may retry.
export async function alertOnce(a: AlertInput): Promise<{ alert: Exclude<AlertResult, "none">; warning: string }> {
  if (existsSync(a.marker)) return { alert: "already", warning: "" };
  if (!existsSync(a.helper)) return { alert: "failed", warning: `notify helper ${a.helper} is missing; reinstall the factory with install.sh` };
  const env = { ...process.env, ...telegramEnv(process.env, a.envFile) };
  const r = await capture(["bash", a.helper, TELEGRAM_TOPIC, a.message], { env, timeoutMs: 30_000 });
  const said = redact(firstLine(`${r.stdout}\n${r.stderr}`), TELEGRAM_VARS, env);
  if (r.exitCode === 0 && r.stdout.includes(" sent ")) {
    try {
      writeFileSync(a.marker, `${new Date().toISOString()}\n`);
    } catch (e) {
      return { alert: "sent", warning: `alert marker not written, a later check may alert again: ${(e as Error).message}` };
    }
    return { alert: "sent", warning: "" };
  }
  if (r.exitCode === 0 && r.stdout.includes("skipped")) return { alert: "skipped", warning: said };
  return { alert: "failed", warning: r.timedOut ? "notify helper timed out" : said || `notify helper exited ${r.exitCode}` };
}
