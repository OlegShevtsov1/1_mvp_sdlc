import { existsSync, readFileSync } from "node:fs";
import { parseJsonObject } from "./io.ts";
import { runIdFrom } from "./keeper.ts";

// The lists of decision 53 the factory moves a card to; the profile may rename them under trello.lists.
export const DEFAULT_LISTS = {
  ready: "Ready",
  in_progress: "In Progress",
  review: "Review",
  test: "Test",
  blocked: "Blocked",
} as const;
export type ListKey = keyof typeof DEFAULT_LISTS;
export type Lists = Record<ListKey, string>;

export type CardRef = { kind: "link"; value: string } | { kind: "number"; value: number };

// The hygiene check bans card and board links in tracked files; this is the API host, neither of those.
const API_BASE = "https://api.trello" + ".com/1";
const REQUEST_TIMEOUT_MS = 10_000;
const COMMENT_LIMIT = 2000;

const CARD_LINK = /https?:\/\/(?:www\.)?trello\.com\/c\/([A-Za-z0-9]{8})(?![A-Za-z0-9])/;
// PILOT-0 is this repository's "no card" marker, so a card number never starts with 0.
const TITLE_LINE = /^\s*PILOT-([1-9]\d{0,5}):/m;
const BARE_NUMBER = /(?<![A-Za-z0-9-])PILOT-([1-9]\d{0,5})(?![A-Za-z0-9])/;

// task-brief's title line names the task's own card; a bare number elsewhere may be a dependency,
// so it only counts when the text has no title line.
export function parseCardRef(text: string): CardRef | null {
  const link = CARD_LINK.exec(text);
  if (link) return { kind: "link", value: link[1] };
  const number = TITLE_LINE.exec(text) ?? BARE_NUMBER.exec(text);
  return number ? { kind: "number", value: Number(number[1]) } : null;
}

export function cardLabel(ref: CardRef): string {
  return ref.kind === "link" ? ref.value : `PILOT-${ref.value}`;
}

export interface Facts {
  gate?: string;
  ready?: string;
  summary?: string;
  report?: string;
}

export type Transition = { target: ListKey; comment: string } | { warning: string };

function cut(text: string): string {
  return text.length > COMMENT_LIMIT ? text.slice(0, COMMENT_LIMIT) : text;
}

function roundMove(gateRaw: string | undefined, gateNo: 1 | 2, proceedTo: ListKey, runId: string): Transition {
  const verdict = parseJsonObject(gateRaw ?? "");
  if (verdict === null || typeof verdict.proceed !== "boolean") return { warning: `unreadable gate verdict at gate ${gateNo}` };
  if (verdict.proceed) return { target: proceedTo, comment: "" };
  return { target: "ready", comment: cut(`Factory run ${runId} stopped at gate ${gateNo}: ${String(verdict.stop_reason ?? "")}.`) };
}

// Blocked means the run is paused waiting for a person; a run that has ended goes back to Ready,
// except after a failed rollback, which leaves an environment only the operator can repair.
function doneMove(reportRaw: string | undefined, runId: string): Transition {
  const doc = parseJsonObject(reportRaw ?? "");
  if (doc === null) return { target: "ready", comment: `Factory run ${runId} ended not delivered: the run left no readable report.` };
  const summary = String(doc.summary ?? "");
  if (doc.status === "delivered-pending-operator") {
    return { target: "review", comment: cut(`Factory run ${runId}: ${String(doc.pr_url ?? "")} waits for the operator merge (base is merged by hand).`) };
  }
  if (doc.delivered === true) return { target: "test", comment: "" };
  if (String(doc.rollback ?? "").startsWith("FAILED")) {
    return { target: "blocked", comment: cut(`Factory run ${runId} ended with a failed rollback; the environment needs the operator: ${summary}`) };
  }
  return { target: "ready", comment: cut(`Factory run ${runId} ended not delivered: ${summary}`) };
}

export function transition(event: string, facts: Facts, runId: string): Transition {
  switch (event) {
    case "profile-gate":
      return { target: "blocked", comment: `Factory run ${runId} waits for the operator at gate 1 (project profile).` };
    case "profile-round":
      return roundMove(facts.gate, 1, "ready", runId);
    case "plan-gate":
      return {
        target: "blocked",
        comment: facts.ready === "true"
          ? `Factory run ${runId} waits for the operator at gate 2 (plan approval).`
          : cut(`Factory run ${runId} waits for the operator at gate 2: the plan is not ready to build — ${facts.summary ?? ""}`),
      };
    case "plan-round":
      return roundMove(facts.gate, 2, "in_progress", runId);
    case "review":
      return { target: "review", comment: "" };
    case "done":
      return doneMove(facts.report, runId);
    default:
      return { warning: `unknown event '${event}'` };
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// A wrong list name must never stop a delivery, so a bad value falls back to its default.
export function listNames(profile: unknown): { lists: Lists; warnings: string[] } {
  const configured = obj(obj(obj(profile).trello).lists);
  const lists: Lists = { ...DEFAULT_LISTS };
  const warnings: string[] = [];
  for (const key of Object.keys(DEFAULT_LISTS) as ListKey[]) {
    const v = configured[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() !== "" && !v.includes("\n")) lists[key] = v;
    else warnings.push(`trello.lists.${key} must be a non-empty single-line string; using '${DEFAULT_LISTS[key]}'`);
  }
  return { lists, warnings };
}

export interface Creds {
  key: string;
  token: string;
  board: string;
}

const CRED_VARS = ["TRELLO_API_KEY", "TRELLO_TOKEN", "TRELLO_BOARD_ID"] as const;

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

// Only the file counts, never the caller's environment, so an exported variable cannot stand in
// for one missing from the file; the file holds flat assignments, as feature-start reads it too.
export function readCreds(envFile: string): Creds | { warning: string } {
  let text: string;
  try {
    text = readFileSync(envFile, "utf8");
  } catch {
    return { warning: existsSync(envFile) ? `credentials file ${envFile} could not be read` : `credentials file ${envFile} not found` };
  }
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = ASSIGNMENT.exec(line);
    if (m) values.set(m[1], m[2].replace(/^['"]|['"]$/g, ""));
  }
  const [key, token, board] = CRED_VARS.map((name) => values.get(name) ?? "");
  const missing = CRED_VARS.filter((_, i) => [key, token, board][i] === "");
  if (missing.length > 0) return { warning: `credentials file ${envFile} lacks ${missing.join(", ")}` };
  return { key, token, board };
}

function redact(text: string, creds: Creds): string {
  let out = text;
  for (const secret of [creds.key, creds.token]) if (secret) out = out.split(secret).join("[redacted]");
  return out;
}

interface Card {
  id: string;
  idList: string;
}

export type Move = { target: ListKey; comment: string };
export type ApplyResult = { status: "done" | "warning"; warning: string };

// The key and token travel in a header only, never in a URL that an error message might repeat.
export async function applyMove(fetchFn: typeof fetch, creds: Creds, lists: Lists, ref: CardRef, move: Move): Promise<ApplyResult> {
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await fetchFn(API_BASE + path, {
      method,
      headers: {
        Authorization: `OAuth oauth_consumer_key="${creds.key}", oauth_token="${creds.token}"`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${method} ${path.split("?")[0]}: HTTP ${res.status}`);
    return res.json();
  };
  const board = encodeURIComponent(creds.board);
  try {
    let card: Card | undefined;
    if (ref.kind === "link") {
      const found = obj(await call("GET", `/cards/${encodeURIComponent(ref.value)}?fields=id,idBoard,idList,shortLink`));
      // TRELLO_BOARD_ID may be the board's short link, so compare against the board's real id.
      const boardDoc = obj(await call("GET", `/boards/${board}?fields=id`));
      if (found.idBoard !== boardDoc.id) return { status: "warning", warning: `card ${ref.value} is not on the configured board` };
      card = { id: String(found.id), idList: String(found.idList) };
    } else {
      const cards = await call("GET", `/boards/${board}/cards?fields=id,idShort,idList,shortLink`);
      const found = (Array.isArray(cards) ? cards : []).map(obj).find((c) => c.idShort === ref.value);
      if (found) card = { id: String(found.id), idList: String(found.idList) };
    }
    if (card === undefined) return { status: "warning", warning: `card ${cardLabel(ref)} not found on the configured board` };

    const boardLists = await call("GET", `/boards/${board}/lists?fields=name`);
    const named = (Array.isArray(boardLists) ? boardLists : []).map(obj);
    const list = named.find((l) => l.name === lists[move.target]);
    let warning = "";
    if (list === undefined) {
      warning = `list '${lists[move.target]}' not found on the board (lists: ${named.map((l) => String(l.name)).join(", ")})`;
    } else if (card.idList !== list.id) {
      await call("PUT", `/cards/${card.id}`, { idList: list.id });
    }
    if (move.comment !== "") await call("POST", `/cards/${card.id}/actions/comments`, { text: move.comment });
    return warning === "" ? { status: "done", warning: "" } : { status: "warning", warning };
  } catch (e) {
    return { status: "warning", warning: redact(e instanceof Error ? e.message : String(e), creds) };
  }
}

export interface MoveInput {
  event: string;
  task: string;
  request: string;
  gate: string;
  ready: string;
  summary: string;
  report: string;
  artifactsDir: string;
  dryRun: boolean;
  envFile: string;
}

export interface MoveDeps {
  fetch: typeof fetch;
  // Returns the parsed profile, or undefined when there is none.
  readProfile: () => Promise<unknown>;
}

export interface MoveResult {
  card: string;
  target: string;
  comment: string;
  status: "none" | "dry-run" | "done" | "warning";
  warning: string;
}

export async function runTrelloMove(input: MoveInput, deps: MoveDeps): Promise<MoveResult> {
  const ref = parseCardRef(input.task) ?? parseCardRef(input.request);
  if (ref === null) return { card: "", target: "", comment: "", status: "none", warning: "" };
  const card = cardLabel(ref);

  const warnings: string[] = [];
  let lists: Lists = { ...DEFAULT_LISTS };
  try {
    const named = listNames(await deps.readProfile());
    lists = named.lists;
    warnings.push(...named.warnings);
  } catch (e) {
    warnings.push(`profile unreadable, using the default list names: ${e instanceof Error ? e.message : String(e)}`);
  }

  const runId = runIdFrom(input.artifactsDir);
  const move = transition(input.event, input, runId ?? "dry-run");
  if ("warning" in move) return { card, target: "", comment: "", status: "warning", warning: [...warnings, move.warning].join("; ") };
  const result = { card, target: lists[move.target], comment: move.comment };
  if (runId === null || input.dryRun) return { ...result, status: "dry-run", warning: warnings.join("; ") };

  const creds = readCreds(input.envFile);
  if ("warning" in creds) return { ...result, status: "warning", warning: [...warnings, creds.warning].join("; ") };
  const applied = await applyMove(deps.fetch, creds, lists, ref, move);
  if (applied.warning !== "") warnings.push(applied.warning);
  return { ...result, status: warnings.length > 0 ? "warning" : applied.status, warning: warnings.join("; ") };
}
