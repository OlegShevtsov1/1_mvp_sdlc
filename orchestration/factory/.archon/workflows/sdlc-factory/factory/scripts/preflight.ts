import { emit } from "./_lib/io.ts";
import { parseSecretNames } from "./_lib/exec.ts";
import { checkPreflight, hostPreflightDeps, preflightMessage, type PreflightStatus } from "./_lib/host-check.ts";

// Bindings (see factory.yaml `preflight` node): preflight (load-profile's
// stack.preflight as JSON text, "" when the profile has none) and secret_names.
// ARTIFACTS_DIR is engine-provided; every step is logged to preflight.log.
// Always exits 0 with one {status, problems, message} line: `preflight-stop`
// cancels the run on failed, as `claude-auth-stop` does on auth_failed.
const secretNames = parseSecretNames(process.env.INPUTS_SECRET_NAMES ?? "[]");
const logPath = `${process.env.ARTIFACTS_DIR ?? "."}/preflight.log`;

async function check(): Promise<{ status: PreflightStatus; problems: string[]; message: string }> {
  const r = await checkPreflight(process.env.INPUTS_PREFLIGHT ?? "", () => hostPreflightDeps({ logPath, secretNames }));
  if (r === null) return { status: "skipped", problems: [], message: "" };
  return r.ok ? { status: "ok", problems: [], message: "" } : { status: "failed", problems: r.problems, message: preflightMessage(r.problems) };
}

emit(await check());
