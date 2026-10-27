import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit, parseJsonObject } from "./_lib/io.ts";
import { newestBody } from "./_lib/pr-body.ts";
import { FILES, shotsVerdict, type Shots } from "./_lib/visual.ts";

// Binding: revision (the revise block's report, empty when this round revised nothing), initial
// (the top-level deliver report) and screenshots_dir. Lists the screenshots committed at HEAD as
// links for the visual gate and saves the round's readiness to visual-shots.json for visual-round.
// Owner and repo come from the pull request URL, never from the remote, so no token-bearing URL is
// printed. It never fails the run: every outcome is one JSON line and exit 0.
const env = process.env;
const artifactsDir = env.ARTIFACTS_DIR ?? ".";
const dir = (env.INPUTS_SCREENSHOTS_DIR ?? "").replace(/\/+$/, "");

function git(args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args[0]} exited ${p.exitCode}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString();
}

let shots: Shots;
try {
  const head = git(["rev-parse", "HEAD"]).trim();
  shots = shotsVerdict({
    delivery: parseJsonObject(env.INPUTS_REVISION || env.INPUTS_INITIAL || "") ?? {},
    files: git(["ls-tree", "-r", "--name-only", "HEAD", "--", `${dir}/`]).split("\n").filter((line) => line !== ""),
    body: newestBody(artifactsDir)?.body ?? null,
    dir,
    head,
  });
} catch (e) {
  shots = { ready: false, pr_url: "", pr_number: 0, head: "", files: [], links: "", summary: `unexpected: ${e instanceof Error ? e.message : String(e)}` };
}

try {
  const { ready, pr_url, head, files, summary } = shots;
  // Removed first: if the write fails, visual-round finds no file instead of the last round's.
  rmSync(join(artifactsDir, FILES.shots), { force: true });
  writeFileSync(join(artifactsDir, FILES.shots), JSON.stringify({ ready, pr_url, head, files, summary }, null, 2) + "\n");
  appendFileSync(join(artifactsDir, FILES.log), `${new Date().toISOString()} visual-shots ready=${ready} head=${head || "-"} files=${files.length} ${summary}\n`);
} catch (e) {
  process.stderr.write(`visual-shots: warning: ${FILES.shots} not written: ${(e as Error).message}\n`);
}
emit({ ready: shots.ready, pr_url: shots.pr_url, pr_number: shots.pr_number, head: shots.head, links: shots.links, summary: shots.summary });
