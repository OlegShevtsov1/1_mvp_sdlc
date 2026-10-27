import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emit, fail } from "./_lib/io.ts";
import { PROFILE_COMMIT_MESSAGE, PROFILE_PATH, commitIfChanged, profileToYaml, validateProfile } from "./_lib/profile.ts";

// Reads the approved draft the intake node wrote, validates it, writes the YAML
// profile into the checkout, and commits it on the run's branch.
const artifacts = process.env.ARTIFACTS_DIR ?? "";

if (artifacts.trim() === "") {
  // Without the guard the draft path would resolve to "/factory-profile.json"
  // and the node would report a missing draft instead of a broken environment.
  fail("write-profile: ARTIFACTS_DIR is not set");
} else {
  const draftPath = `${artifacts}/factory-profile.json`;
  const draftFile = Bun.file(draftPath);

  if (!(await draftFile.exists())) {
    fail(`write-profile: draft not found at ${draftPath}`);
  } else {
    let draft: unknown;
    try {
      draft = JSON.parse(await draftFile.text());
    } catch (e) {
      fail(`write-profile: draft is not valid JSON: ${(e as Error).message}`);
    }
    if (draft !== undefined) {
      const v = validateProfile(draft);
      if (!v.ok) {
        fail("write-profile: the draft profile is invalid:\n- " + v.errors.join("\n- "));
      } else {
        mkdirSync(dirname(PROFILE_PATH), { recursive: true });
        writeFileSync(PROFILE_PATH, profileToYaml(v.profile));
        const committed = commitIfChanged(PROFILE_PATH, PROFILE_COMMIT_MESSAGE);
        if (!committed.ok) {
          fail(`write-profile: profile written but the commit failed: ${committed.err}`);
        } else {
          // Read the sha in its own process: hooks and `git` wrappers print on the
          // commit's stdout, and only this output may become `commit`.
          const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
          if (head.exitCode !== 0) {
            fail(`write-profile: profile committed but HEAD could not be read: ${head.stderr.toString().trim()}`);
          } else {
            emit({ written: true, path: PROFILE_PATH, commit: head.stdout.toString().trim() });
          }
        }
      }
    }
  }
}
