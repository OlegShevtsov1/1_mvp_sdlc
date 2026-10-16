import { emit, fail } from "./_lib/io.ts";
import { parseSecretNames, runLogged } from "./_lib/exec.ts";

const command = process.env.INPUTS_COMMAND ?? "";
const secretNames = parseSecretNames(process.env.INPUTS_SECRET_NAMES ?? "[]");
const artifacts = process.env.ARTIFACTS_DIR ?? ".";
const logPath = `${artifacts}/rollback.log`;

if (command.trim() === "") {
  fail("rollback: the profile's deploy.rollback_command is empty");
} else {
  const r = await runLogged(command, { logPath, secretNames, timeoutMs: 1_500_000 });
  emit({ rolled_back: r.exit_code === 0, exit_code: r.exit_code, log: logPath });
}
