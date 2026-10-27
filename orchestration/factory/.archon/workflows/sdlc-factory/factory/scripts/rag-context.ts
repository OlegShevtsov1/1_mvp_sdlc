import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit } from "./_lib/io.ts";
import { formatContext, queryFrom, ragSearch, type RagHit, type RagSource, type RagStatus } from "./_lib/rag.ts";
import { runIdFrom } from "./_lib/trello.ts";

// Searches mvp-rag for the task and leaves $ARTIFACTS_DIR/rag-context.md for the plan stage. The
// knowledge server must never fail a delivery: every outcome, including an unexpected throw, is a
// JSON line and exit 0. A dry run (no run id in ARTIFACTS_DIR) makes no request.
const env = process.env;
const artifactsDir = env.ARTIFACTS_DIR ?? "";
const query = queryFrom(env.INPUTS_TASK ?? "", env.INPUTS_REQUEST ?? "");
let result: { status: RagStatus; sources: RagSource[]; hits: RagHit[]; warning: string };
try {
  result = process.argv.includes("--dry-run") || runIdFrom(artifactsDir) === null
    ? { status: "dry-run", sources: [], hits: [], warning: "" }
    : await ragSearch(query, { k: 5 }, env);
} catch (e) {
  result = { status: "unavailable", sources: [], hits: [], warning: `unexpected: ${e instanceof Error ? e.name : String(e)}` };
}

if (result.status === "unavailable") process.stderr.write(`rag-context: warning: ${result.warning}\n`);
if (artifactsDir) {
  try {
    writeFileSync(join(artifactsDir, "rag-context.md"), formatContext(query, result.status, result.hits, result.warning));
    const line = `${new Date().toISOString()} rag-context status=${result.status} sources=${result.sources.length} ${result.warning}`;
    appendFileSync(join(artifactsDir, "rag.log"), line.trimEnd() + "\n");
  } catch (e) {
    process.stderr.write(`rag-context: warning: rag-context.md not written: ${(e as Error).message}\n`);
  }
}
emit({ status: result.status, query, sources: result.sources, warning: result.warning });
