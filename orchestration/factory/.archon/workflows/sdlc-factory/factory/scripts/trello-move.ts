import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emit } from "./_lib/io.ts";
import { PROFILE_PATH } from "./_lib/profile.ts";
import { runTrelloMove, type MoveResult } from "./_lib/trello.ts";

// Moves the task's Trello card for one point of the run (INPUTS_EVENT). Trello must never fail a
// delivery: every outcome, including an unexpected throw, is a JSON line and exit 0.
async function readProfile(): Promise<unknown> {
  const file = Bun.file(PROFILE_PATH);
  return (await file.exists()) ? Bun.YAML.parse(await file.text()) : undefined;
}

const env = process.env;
const event = env.INPUTS_EVENT ?? "";
const artifactsDir = env.ARTIFACTS_DIR ?? "";
let result: MoveResult;
try {
  result = await runTrelloMove(
    {
      event,
      task: env.INPUTS_TASK ?? "",
      request: env.INPUTS_REQUEST ?? "",
      gate: env.INPUTS_GATE ?? "",
      ready: env.INPUTS_READY ?? "",
      summary: env.INPUTS_SUMMARY ?? "",
      report: env.INPUTS_REPORT ?? "",
      artifactsDir,
      dryRun: process.argv.includes("--dry-run"),
      envFile: env.TRELLO_ENV_FILE || join(homedir(), ".config", "trello", ".env"),
    },
    { fetch, readProfile },
  );
} catch (e) {
  result = { card: "", target: "", comment: "", status: "warning", warning: `unexpected: ${e instanceof Error ? e.message : String(e)}` };
}

if (result.status === "warning") process.stderr.write(`trello-move: warning: ${result.warning}\n`);
if (artifactsDir) {
  try {
    const line = `${new Date().toISOString()} ${event} card=${result.card || "-"} target=${result.target || "-"} status=${result.status} ${result.warning}`;
    appendFileSync(join(artifactsDir, "trello.log"), line.trimEnd() + "\n");
  } catch (e) {
    process.stderr.write(`trello-move: warning: trello.log not written: ${(e as Error).message}\n`);
  }
}
emit(result);
