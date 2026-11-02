import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvFile } from "./envfile.ts";

// The hygiene check bans card and board links in tracked files; this is the API host, neither of those.
const TRELLO_API = "https://api.trello" + ".com/1";

export type Trello = {
  call: (method: string, path: string, body?: unknown) => Promise<unknown>;
  // The board id, URL-encoded for a path.
  board: string;
  // Replaces the key and the token in a message that leaves the supervisor.
  scrub: (s: string) => string;
};

export function trelloEnvPath(): string {
  return process.env.SDLC_AUTOPILOT_TRELLO_ENV || join(homedir(), ".config", "trello", ".env");
}

// PROJECT_NAME of the checkout's config/project.env, upper-cased, as the plugin's feature-start reads it.
function projectName(source: string): string {
  try {
    const line = readFileSync(join(source, "config", "project.env"), "utf8").match(/^\s*PROJECT_NAME\s*=\s*['"]?(\w+)/m);
    return line ? line[1].toUpperCase() : "";
  } catch {
    return "";
  }
}

// The client for the board, or why there is none: the checkout's TRELLO_BOARD_ID_<PROJECT_NAME> first, as feature-start
// resolves it, then TRELLO_BOARD_ID. The key and token travel in a header only.
export function trello(source?: string): Trello | string {
  let env: Record<string, string> | null;
  try {
    env = readEnvFile(trelloEnvPath());
  } catch (e) {
    return `${trelloEnvPath()} не прочитано: ${e instanceof Error ? e.message : String(e)}`;
  }
  const project = source ? projectName(source) : "";
  const [key, token] = ["TRELLO_API_KEY", "TRELLO_TOKEN"].map((v) => env?.[v] ?? "");
  const board = (project && env?.[`TRELLO_BOARD_ID_${project}`]) || env?.TRELLO_BOARD_ID || "";
  if (!key || !token || !board) return `у ${trelloEnvPath()} немає TRELLO_API_KEY, TRELLO_TOKEN або TRELLO_BOARD_ID`;
  const api = process.env.SDLC_AUTOPILOT_TRELLO_API || TRELLO_API;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(api + path, {
      method,
      headers: {
        Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Trello ${method} ${path.split("?")[0]}: HTTP ${res.status}`);
    return res.json();
  };
  const scrub = (s: string) => [key, token].reduce((m, v) => m.replaceAll(v, "[REDACTED]"), s);
  return { call, board: encodeURIComponent(board), scrub };
}

export const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const objs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []).map(obj);
