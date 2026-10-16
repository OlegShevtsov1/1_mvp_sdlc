import { emit, fail } from "./_lib/io.ts";
import { PROFILE_PATH, flattenProfile, validateProfile } from "./_lib/profile.ts";

// Reads the profile from the checkout and hands the rest of the run a flat map
// of the values the nodes bind, so no other script parses YAML.
const file = Bun.file(PROFILE_PATH);
if (!(await file.exists())) {
  fail(`load-profile: ${PROFILE_PATH} not found in the checkout`);
} else {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(await file.text());
  } catch (e) {
    fail(`load-profile: ${PROFILE_PATH} is not valid YAML: ${(e as Error).message}`);
  }
  if (doc !== undefined) {
    const v = validateProfile(doc);
    if (!v.ok) fail(`load-profile: ${PROFILE_PATH} is invalid:\n- ` + v.errors.join("\n- "));
    else emit(flattenProfile(v.profile));
  }
}
