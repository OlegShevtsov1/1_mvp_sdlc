import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseJsonObject } from "./io.ts";

// GitHub may store CRLF, and `gh --jq` appends a newline.
export function normaliseBody(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

function readCandidate(path: string, name: string): string | null {
  const text = readFileSync(path, "utf8");
  if (!name.endsWith(".json")) return text;
  const doc = parseJsonObject(text);
  return typeof doc?.body === "string" ? doc.body : null;
}

// The bundled delivery's body files: the gh source writes pr-body-final.md, the
// forge source pr-body-final.json {ref, body}. On equal mtimes the earlier wins.
// scripts/ci/archon-check.sh reads both lists and fails when the pinned Archon
// stops naming one of them.
export const CANDIDATES = ["pr-body-final.md", "pr-body-final.json", "pr-body.md"];

// Bundled publish-pr.ts writes it once, right before it opens the PR with pr-body.md.
export const PR_CREATE_STARTED = "pr-create-started";

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// The run's latest body. This run's pr-body.md is a body the live PR never
// received, unless the PR was opened with it and no round rewrote it since (it
// is not newer than pr-create-started): bundled publish-pr writes no body to a
// PR it continues. Bundled update-pr-body builds pr-body-final.* from that stale
// live body, so pr-body.md wins over them, and what update-pr-body added to them
// is not published. Otherwise the newest file wins. An unreadable file counts
// as absent.
export function newestBody(dir: string): { source: string; body: string } | null {
  const opened = mtimeOf(join(dir, PR_CREATE_STARTED));
  let newest: { source: string; body: string; mtime: number } | null = null;
  for (const name of CANDIDATES) {
    const path = join(dir, name);
    let mtime: number;
    let body: string | null;
    try {
      mtime = statSync(path).mtimeMs;
      body = readCandidate(path, name);
    } catch {
      continue;
    }
    if (body === null) continue;
    if (name === "pr-body.md" && (opened === null || mtime > opened)) return { source: name, body };
    if (newest === null || mtime > newest.mtime) newest = { source: name, body, mtime };
  }
  return newest && { source: newest.source, body: newest.body };
}
