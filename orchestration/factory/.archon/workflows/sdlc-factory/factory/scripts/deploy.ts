import { appendFileSync } from "node:fs";
import { emit, fail } from "./_lib/io.ts";
import { parseSecretNames, runLogged } from "./_lib/exec.ts";

// Bindings (see factory.yaml `deploy` node): command, secret_names (JSON array
// string), remote, merge_sha. ARTIFACTS_DIR is engine-provided.
const command = process.env.INPUTS_COMMAND ?? "";
const secretNames = parseSecretNames(process.env.INPUTS_SECRET_NAMES ?? "[]");
const remote = process.env.INPUTS_REMOTE ?? "origin";
const mergeSha = process.env.INPUTS_MERGE_SHA ?? "";
const artifacts = process.env.ARTIFACTS_DIR ?? ".";
const logPath = `${artifacts}/deploy.log`;

// Both values are interpolated into a shell command below, so their shape is
// checked first: a git remote name or URL path, and a hex object name.
const REMOTE = /^[A-Za-z0-9._\/-]+$/;
const SHA = /^[0-9a-f]{7,40}$/;

if (command.trim() === "") {
  fail("deploy: the profile's deploy.command is empty");
} else if (!REMOTE.test(remote) || (mergeSha !== "" && !SHA.test(mergeSha))) {
  // A real failure, not a deploy outcome: nothing was attempted, and the
  // malformed value is the operator's profile or the merge node's output.
  fail("deploy: refusing malformed remote or merge_sha");
} else {
  // Put the checkout on the merged commit so a directory-based deploy (flyctl,
  // docker build, rsync) ships exactly what was merged.
  const checkout = mergeSha
    ? await runLogged(`git fetch ${remote} && git checkout --detach ${mergeSha}`, { logPath, secretNames, timeoutMs: 120_000 })
    : { exit_code: 0 };
  if (checkout.exit_code !== 0) {
    // A failed checkout is a deploy outcome, not a node failure: failing here
    // would block `report` (trigger_rule none_failed_min_one_success) and the
    // run would end with no report at all. Nothing was deployed, so
    // decide-rollback sees deployed=false and the report says so.
    appendFileSync(
      logPath,
      `\n[deploy] could not check out merge commit ${mergeSha} from ${remote} (exit ${checkout.exit_code}); the deploy command was not run\n`,
    );
    emit({ deployed: false, exit_code: checkout.exit_code, deployed_at: new Date().toISOString(), log: logPath });
  } else {
    const deployed_at = new Date().toISOString();
    const r = await runLogged(command, { logPath, secretNames, timeoutMs: 1_500_000 });
    emit({ deployed: r.exit_code === 0, exit_code: r.exit_code, deployed_at, log: logPath });
  }
}
