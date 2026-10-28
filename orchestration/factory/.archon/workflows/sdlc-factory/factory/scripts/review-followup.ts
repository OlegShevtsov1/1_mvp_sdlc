import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./_lib/exec.ts";
import { runFollowUp } from "./_lib/follow-up.ts";
import { emit } from "./_lib/io.ts";
import { PROFILE_PATH } from "./_lib/profile.ts";

// Binding (see factory.yaml `review-followup` node): delivery (the deliver
// report), state and judge (review-state's and followup-judge's outputs, empty
// when skipped), task and request. ARTIFACTS_DIR is engine-provided. Emits the
// deliver report every later node reads, followed up or passed through; always
// exits 0 with one line.
async function readProfile(): Promise<unknown> {
  const file = Bun.file(PROFILE_PATH);
  return (await file.exists()) ? Bun.YAML.parse(await file.text()) : undefined;
}

function gh(args: string[]): { ok: boolean; err: string } {
  const p = Bun.spawnSync(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, err: redact(p.stderr.toString().trim().split("\n")[0] ?? "", ["GH_TOKEN", "GITHUB_TOKEN"]) };
}

const env = process.env;
emit(
  await runFollowUp(
    {
      delivery: env.INPUTS_DELIVERY ?? "",
      state: env.INPUTS_STATE ?? "",
      judge: env.INPUTS_JUDGE ?? "",
      task: env.INPUTS_TASK ?? "",
      request: env.INPUTS_REQUEST ?? "",
      artifactsDir: env.ARTIFACTS_DIR ?? "",
      envFile: env.TRELLO_ENV_FILE || join(homedir(), ".config", "trello", ".env"),
    },
    { fetch, gh, readProfile },
  ),
);
