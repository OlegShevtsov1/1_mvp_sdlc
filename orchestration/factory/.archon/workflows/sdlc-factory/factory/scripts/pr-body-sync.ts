import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./_lib/exec.ts";
import { emit, parseJsonObject } from "./_lib/io.ts";
import { PR_URL } from "./_lib/merge-decision.ts";
import { newestBody, normaliseBody } from "./_lib/pr-body.ts";

// Binding (see factory.yaml `pr-body-sync` node): delivery (the whole deliver
// report). ARTIFACTS_DIR is engine-provided. Puts the run's latest body
// (_lib/pr-body.ts) on the live pull request; always exits 0 with one
// {pr_url, action, source, reason} line, and merge-gate judges the action. The body travels in a file
// and no token is read or printed. The live body is read before the files are
// looked for: the CI harness's fake gh seeds them on that first read.
const delivery = parseJsonObject(process.env.INPUTS_DELIVERY ?? "") ?? {};
const artifactsDir = process.env.ARTIFACTS_DIR ?? ".";

type Action = "updated" | "unchanged" | "skipped" | "failed";

interface Sync {
  pr_url: string;
  action: Action;
  source: string;
  reason: string;
}

// The URL is the selector, so gh infers no repository or host from the checkout or GH_HOST.
function gh(args: string[]): { ok: boolean; code: number; out: string; err: string } {
  const p = Bun.spawnSync(["gh", "pr", ...args], { stdout: "pipe", stderr: "pipe" });
  const err = redact(p.stderr.toString().trim().split("\n")[0] ?? "", ["GH_TOKEN", "GITHUB_TOKEN"]);
  return { ok: p.exitCode === 0, code: p.exitCode ?? -1, out: p.stdout.toString(), err };
}

function sync(): Sync {
  const url = typeof delivery.pr_url === "string" ? delivery.pr_url : "";
  if (!PR_URL.test(url)) {
    return { pr_url: "", action: "skipped", source: "", reason: "delivery did not return a GitHub pull request URL" };
  }
  const result = (action: Action, source: string, reason: string): Sync => ({ pr_url: url, action, source, reason });
  const readLive = () => gh(["view", url, "--json", "body", "--jq", ".body"]);

  const live = readLive();
  if (!live.ok) return result("failed", "", `could not read the pull request description from GitHub: ${live.err}`);

  const newest = newestBody(artifactsDir);
  if (newest === null) return result("skipped", "", "no pr-body file in the run's artifacts");
  const { source, body } = newest;
  if (normaliseBody(body) === "") return result("skipped", source, `${source} is empty`);
  if (normaliseBody(body) === normaliseBody(live.out)) return result("unchanged", source, "");

  const input = join(artifactsDir, "pr-body-sync.md");
  writeFileSync(input, body);
  const edit = gh(["edit", url, "--body-file", input]);
  if (!edit.ok) return result("failed", source, `gh pr edit exited ${edit.code}: ${edit.err}`);

  const after = readLive();
  if (!after.ok || normaliseBody(after.out) !== normaliseBody(body)) {
    return result("failed", source, `the pull request description still differs from ${source} after the update`);
  }
  return result("updated", source, "");
}

emit(sync());
