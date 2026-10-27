import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALERT_RESULTS, NODE_STATUSES } from "../.archon/workflows/sdlc-factory/factory/scripts/_lib/claude-login.ts";

const PACK = join(import.meta.dir, "..", ".archon", "workflows", "sdlc-factory", "factory");
const SCRIPT = join(PACK, "scripts", "claude-auth.ts");
const NOTIFY = join(import.meta.dir, "..", "..", "..", "scripts", "ci", "notify-telegram.sh");
const RUN_ID = "9dd3e089-1111-4222-8333-4444aaaa6666";
const TOKEN = "dummy-bot-token-not-a-secret";

const EXPIRED = JSON.stringify({
  type: "result", is_error: true, total_cost_usd: 0,
  result: "Failed to authenticate: OAuth session expired and could not be refreshed",
});
const AUTH_ERROR = JSON.stringify({
  type: "node_error", step: "implement__implement",
  error: "Node 'implement__implement' failed: provider reported auth: Failed to authenticate: OAuth session expired and could not be refreshed",
});
// Tool output the agent printed: the same words, but not the engine's classification.
const TOOL_OUTPUT = JSON.stringify({ type: "provider_event", step: "plan__plan", content: "grep found: OAuth session expired" });
const OTHER_ERROR = JSON.stringify({ type: "node_error", step: "sync-base", error: "Node 'sync-base' failed: exit 1" });

// Fakes first on PATH: claude and archon record their argv (one argument per line) and print
// what the case gives them; curl is the stub of test-notify-telegram.sh.
function fakes(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const scripts: Record<string, string> = {
    claude: `printf '%s\\n' "$@" > "${dir}/claude.args"
env | grep -c '^TELEGRAM_MVP_VPN_ALERTS_' > "${dir}/claude.telegram-vars" || true
printf '%s\\n' "$FAKE_CLAUDE_OUT"
exit "\${FAKE_CLAUDE_EXIT:-0}"`,
    archon: `printf '%s\\n' "$@" > "${dir}/archon.args"
printf '%s\\n' "$FAKE_TRANSCRIPT"
exit "\${FAKE_ARCHON_EXIT:-0}"`,
    curl: `printf '%s\\n' "$@" >> "${dir}/curl.argv"
cat >> "${dir}/curl.stdin"
printf '%s' '{"ok":true,"result":{"message_thread_id":7}}'`,
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

interface Run {
  doc: Record<string, unknown>;
  dir: string;
  artifacts: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

function workspace(): { dir: string; artifacts: string; envFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "factory-claude-auth-"));
  const artifacts = join(dir, "workspaces", "o", "r", "artifacts", "runs", RUN_ID);
  mkdirSync(artifacts, { recursive: true });
  const envFile = join(dir, "telegram.env");
  writeFileSync(envFile, `TELEGRAM_MVP_VPN_ALERTS_BOT_TOKEN=${TOKEN}\nTELEGRAM_MVP_VPN_ALERTS_CHAT_ID=42\n`);
  return { dir, artifacts, envFile };
}

function run(args: string[], env: Record<string, string>, ws = workspace(), path?: string): Run {
  const bin = existsSync(join(ws.dir, "bin")) ? join(ws.dir, "bin") : fakes(ws.dir);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TELEGRAM_")));
  const p = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: {
      ...inherited,
      PATH: path ?? `${bin}:${process.env.PATH}`,
      ARTIFACTS_DIR: ws.artifacts,
      NOTIFY_TELEGRAM_SH: NOTIFY,
      TELEGRAM_ENV_FILE: ws.envFile,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = p.stdout.toString();
  const lines = stdout.trim().split("\n").filter((l) => l !== "");
  return {
    doc: lines.length === 1 ? JSON.parse(lines[0]) : {},
    dir: ws.dir,
    artifacts: ws.artifacts,
    stdout,
    stderr: p.stderr.toString(),
    exitCode: p.exitCode ?? -1,
  };
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function curlCalls(dir: string): number {
  return read(join(dir, "curl.stdin")).split("\n").filter((l) => l.startsWith("url = ")).length;
}

describe("claude-auth preflight", () => {
  test("a working login proceeds without an alert, after one minimal model call", () => {
    const r = run(["preflight", "factory"], { FAKE_CLAUDE_OUT: JSON.stringify({ is_error: false, result: "OK" }) });
    expect(r.exitCode).toBe(0);
    expect(r.doc).toEqual({ status: "ok", node: "", alert: "none", message: "" });
    expect(curlCalls(r.dir)).toBe(0);
    const args = read(join(r.dir, "claude.args")).split("\n");
    expect(args).toContain("-p");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
    expect(args).not.toContain("--bare");
  });

  test("an expired login stops with one alert that names the fix", () => {
    const r = run(["preflight", "factory"], { FAKE_CLAUDE_OUT: EXPIRED, FAKE_CLAUDE_EXIT: "1" });
    expect(r.exitCode).toBe(0);
    expect(r.doc.status).toBe("auth_failed");
    expect(r.doc.alert).toBe("sent");
    expect(String(r.doc.message)).toContain("claude /login");
    const argv = read(join(r.dir, "curl.argv"));
    expect(argv).toContain("claude /login");
    expect(argv).toContain(RUN_ID.slice(0, 8));
    expect(argv).toContain("o/r");
    expect(argv).toContain("chat_id=42");
    expect(existsSync(join(r.artifacts, "claude-auth.alerted"))).toBe(true);
    expect(read(join(r.artifacts, "claude-auth.log"))).toContain("preflight status=auth_failed");
  });

  test("no login at all is an auth failure", () => {
    const out = JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" });
    const r = run(["preflight", "factory"], { FAKE_CLAUDE_OUT: out, FAKE_CLAUDE_EXIT: "1" });
    expect(r.doc.status).toBe("auth_failed");
  });

  test("a non-auth API error proceeds without an alert", () => {
    const out = JSON.stringify({ is_error: true, result: "API Error: 529 overloaded" });
    const r = run(["preflight", "factory"], { FAKE_CLAUDE_OUT: out, FAKE_CLAUDE_EXIT: "1" });
    expect(r.doc).toEqual({ status: "unknown", node: "", alert: "none", message: "" });
    expect(curlCalls(r.dir)).toBe(0);
    expect(r.stderr).toContain("529 overloaded");
  });

  test("a missing claude binary proceeds as unknown", () => {
    const empty = mkdtempSync(join(tmpdir(), "factory-claude-auth-path-"));
    const r = run(["preflight", "factory"], {}, workspace(), empty);
    expect(r.exitCode).toBe(0);
    expect(r.doc.status).toBe("unknown");
    expect(r.doc.alert).toBe("none");
  });
});

describe("claude-auth scan", () => {
  test("a node the engine classified as a provider auth failure is named and alerted", () => {
    const r = run(["scan", "factory"], { FAKE_TRANSCRIPT: [TOOL_OUTPUT, OTHER_ERROR, AUTH_ERROR].join("\n") });
    expect(r.doc.status).toBe("auth_failed");
    expect(r.doc.node).toBe("implement__implement");
    expect(r.doc.alert).toBe("sent");
    expect(read(join(r.dir, "archon.args")).trim().split("\n")).toEqual(["workflow", "logs", RUN_ID]);
    expect(read(join(r.dir, "curl.argv"))).toContain("implement__implement");
  });

  test("the same words in tool output or a non-auth failure are not an auth failure", () => {
    const r = run(["scan", "factory"], { FAKE_TRANSCRIPT: ["not json", TOOL_OUTPUT, OTHER_ERROR].join("\n") });
    expect(r.doc).toEqual({ status: "ok", node: "", alert: "none", message: "" });
    expect(curlCalls(r.dir)).toBe(0);
  });

  test("an unreadable transcript proceeds as unknown", () => {
    const r = run(["scan", "factory"], { FAKE_TRANSCRIPT: "", FAKE_ARCHON_EXIT: "1" });
    expect(r.exitCode).toBe(0);
    expect(r.doc.status).toBe("unknown");
    expect(r.doc.alert).toBe("none");
  });

  test("a run alerts once, however many checks find the failure", () => {
    const ws = workspace();
    const first = run(["preflight", "factory"], { FAKE_CLAUDE_OUT: EXPIRED, FAKE_CLAUDE_EXIT: "1" }, ws);
    expect(first.doc.alert).toBe("sent");
    const second = run(["scan", "factory"], { FAKE_TRANSCRIPT: AUTH_ERROR }, ws);
    expect(second.doc.status).toBe("auth_failed");
    expect(second.doc.alert).toBe("already");
    expect(curlCalls(ws.dir)).toBe(1);
  });
});

describe("claude-auth", () => {
  test("a dry run calls neither claude nor archon", () => {
    const ws = workspace();
    const artifacts = join(ws.dir, "dry", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    for (const mode of ["preflight", "scan"]) {
      const r = run([], { ARTIFACTS_DIR: artifacts, INPUTS_MODE: mode, INPUTS_WORKFLOW: "factory" }, ws);
      expect(r.doc).toEqual({ status: "dry-run", node: "", alert: "none", message: "" });
    }
    expect(existsSync(join(ws.dir, "claude.args"))).toBe(false);
    expect(existsSync(join(ws.dir, "archon.args"))).toBe(false);
  });

  test("an alert marker that cannot be written still stops the run", () => {
    const ws = workspace();
    // A dangling link: the marker does not exist, and writing it fails even as root.
    symlinkSync(join(ws.dir, "missing", "marker"), join(ws.artifacts, "claude-auth.alerted"));
    const r = run(["preflight", "factory"], { FAKE_CLAUDE_OUT: EXPIRED, FAKE_CLAUDE_EXIT: "1" }, ws);
    expect(r.doc.status).toBe("auth_failed");
    expect(r.doc.alert).toBe("sent");
    expect(r.stderr).toContain("alert marker not written");
    expect(curlCalls(r.dir)).toBe(1);
  });

  test("factory.yaml accepts exactly the statuses and alert results the script emits", () => {
    const yaml = Bun.YAML.parse(readFileSync(join(PACK, "factory.yaml"), "utf8")) as {
      nodes: { id: string; output_format?: { properties: Record<string, { enum?: string[] }> } }[];
    };
    for (const id of ["claude-auth", "claude-auth-scan"]) {
      const props = yaml.nodes.find((n) => n.id === id)?.output_format?.properties;
      expect(props?.status.enum).toEqual([...NODE_STATUSES]);
      expect(props?.alert.enum).toEqual([...ALERT_RESULTS]);
    }
  });

  test("without the Telegram settings the run still stops and the alert is skipped", () => {
    const ws = workspace();
    writeFileSync(ws.envFile, "");
    const r = run(["preflight", "factory"], { FAKE_CLAUDE_OUT: EXPIRED, FAKE_CLAUDE_EXIT: "1" }, ws);
    expect(r.doc.status).toBe("auth_failed");
    expect(r.doc.alert).toBe("skipped");
    expect(existsSync(join(r.artifacts, "claude-auth.alerted"))).toBe(false);
    expect(curlCalls(r.dir)).toBe(0);
  });

  test("the bot token never leaves the helper's stdin, and claude never sees the Telegram settings", () => {
    const r = run(["preflight", "factory"], { FAKE_CLAUDE_OUT: EXPIRED, FAKE_CLAUDE_EXIT: "1" });
    expect(r.doc.alert).toBe("sent");
    for (const text of [r.stdout, r.stderr, read(join(r.artifacts, "claude-auth.log")), read(join(r.dir, "curl.argv"))]) {
      expect(text).not.toContain(TOKEN);
    }
    expect(read(join(r.dir, "curl.stdin"))).toContain(TOKEN);
    expect(read(join(r.dir, "claude.telegram-vars")).trim()).toBe("0");
  });

  test("an unknown mode is a usage error", () => {
    const r = run(["bogus"], {});
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("usage");
  });
});
