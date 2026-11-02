#!/usr/bin/env bash
# Behaviour test for release.sh: a bare repo stands in for origin and another for the mirror, a fake gh on PATH for
# the primary's GitHub API (PRs, checks, merge), a fake archon for the run list and a fake claude for the plugin
# commands. The fixture repo's install.sh and publish-mirror.sh are stubs that log their argv. No network.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

fail() { echo "FAIL $1: $2" >&2; exit 1; }

g() { git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"; }
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export GIT_CONFIG_GLOBAL="${tmp}/gitconfig"
printf '[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n' > "${GIT_CONFIG_GLOBAL}"

mkdir -p "${tmp}/bin"
cat > "${tmp}/bin/gh" <<'PY'
#!/usr/bin/env python3
# The fake gh: repo view, pr list|create|checks|view|merge and the pr-conventions api call, each logged to calls.log.
# `--jq` runs through the real jq. FAKE_GH_CHECKS: pass | fail. FAKE_GH_PREP: the merged release-prep PR titles.
import json, os, subprocess, sys, tempfile
state, origin = os.environ["FAKE_GH_STATE"], os.environ["FAKE_GH_ORIGIN"]
args = sys.argv[1:]
with open(os.path.join(state, "calls.log"), "a") as f:
    f.write(" ".join(args) + "\n")
def opt(name):
    return args[args.index(name) + 1] if name in args else None
prs_file = os.path.join(state, "prs.json")
prs = json.load(open(prs_file)) if os.path.exists(prs_file) else []
def git(*a, cwd=None):
    return subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()
def out(value):
    if opt("--jq") is None:
        print(json.dumps(value))
    else:
        subprocess.run(["jq", "-r", opt("--jq")], input=json.dumps(value), text=True, check=True)
def find(n):
    return next(p for p in prs if p["number"] == int(n))
cmd = args[:2]
if cmd == ["repo", "view"]:
    out({"nameWithOwner": "o/sdlc"})
elif cmd == ["api", "repos/o/sdlc/git/matching-refs/heads/develop"]:
    out([{"ref": "refs/heads/develop"}])
elif cmd == ["pr", "list"] and opt("--base") == "develop":
    out([{"title": t} for t in os.environ.get("FAKE_GH_PREP", "PILOT-7: Release 0.9.9 changelog").split("\n") if t])
elif cmd == ["pr", "list"] and opt("--base") == "main" and opt("--head") == "develop":
    out([{k: p[k] for k in ("number", "state", "title")} for p in prs])
elif cmd == ["pr", "create"]:
    pr = {"number": 120 + len(prs), "state": "OPEN", "title": opt("--title"), "body": open(opt("--body-file")).read(),
          "headRefOid": git("-C", origin, "rev-parse", "develop"), "mergeCommit": None}
    prs.append(pr)
    json.dump(prs, open(prs_file, "w"))
    print(f"https://github.com/o/sdlc/pull/{pr['number']}")
elif cmd == ["pr", "checks"]:
    if os.environ.get("FAKE_GH_CHECKS", "pass") != "pass":
        print("CI\tfail")
        sys.exit(1)
    print("CI\tpass")
elif cmd == ["pr", "view"]:
    out(find(args[2]))
elif cmd == ["pr", "merge"]:
    pr = find(args[2])
    if pr["state"] != "OPEN" or "--merge" not in args or opt("--match-head-commit") != pr["headRefOid"]:
        sys.exit(1)
    work = tempfile.mkdtemp()
    git("clone", "-q", origin, work)
    git("-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "origin/develop", "-m",
        f"Merge pull request #{pr['number']} from o/develop", cwd=work)
    git("push", "-q", "origin", "main", cwd=work)
    pr.update(state="MERGED", mergeCommit={"oid": git("-C", work, "rev-parse", "HEAD")})
    json.dump(prs, open(prs_file, "w"))
else:
    sys.exit(97)
PY
cat > "${tmp}/bin/archon" <<'SH'
#!/usr/bin/env bash
# The fake archon: `workflow status --all --json` lists FAKE_ARCHON_RUNNING (`<id> <workflow>` per line) as running.
echo '{"level":"info","msg":"noise"}'
python3 -c '
import json, os
lines = [l.split() for l in os.environ.get("FAKE_ARCHON_RUNNING", "").split("\n") if l]
print(json.dumps({"runs": [{"id": i, "workflow_name": w, "status": "running"} for i, w in lines]}))'
SH
cat > "${tmp}/bin/claude" <<'PY'
#!/usr/bin/env python3
# The fake claude: plugin marketplace update | update | list, each logged to claude.log as `<argv> | <cwd>`, state in
# CLAUDE_CONFIG_DIR. Like the real CLI, an update from a cwd matching no project updates the first one and exits 0.
# FAKE_CLAUDE_SERVES: the marketplace's version. FAKE_CLAUDE_STALE: basenames of projects an update leaves as they
# are. FAKE_CLAUDE_UPDATE_RC: the update's exit code.
import json, os, subprocess, sys
cfg = os.environ["CLAUDE_CONFIG_DIR"]
args = sys.argv[1:]
with open(os.path.join(os.path.dirname(cfg), "claude.log"), "a") as f:
    f.write(" ".join(args) + " | " + os.getcwd() + "\n")
state_file = os.path.join(cfg, "state.json")
state = json.load(open(state_file)) if os.path.exists(state_file) else {"served": None, "projects": {}}
def cache(v):
    return os.path.join(cfg, "plugins", "cache", "mvp", "mvp-sdlc", v)
if args == ["plugin", "marketplace", "update", "mvp"]:
    state["served"] = os.environ.get("FAKE_CLAUDE_SERVES", "0.9.9")
elif args == ["plugin", "update", "mvp-sdlc@mvp", "--scope", "project", "--json"]:
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
    project = top if top in state["projects"] else next(iter(state["projects"]))
    old, new = state["projects"][project], state["served"]
    if os.path.basename(project) not in os.environ.get("FAKE_CLAUDE_STALE", "").split():
        os.makedirs(os.path.join(cache(new), ".claude-plugin"), exist_ok=True)
        json.dump({"name": "mvp-sdlc", "version": new}, open(os.path.join(cache(new), ".claude-plugin", "plugin.json"), "w"))
        state["projects"][project] = new
    print(json.dumps({"outcome": "ok", "updateOutcome": "up_to_date" if old == new else "updated",
                      "oldVersion": old, "newVersion": new}))
    json.dump(state, open(state_file, "w"))
    sys.exit(int(os.environ.get("FAKE_CLAUDE_UPDATE_RC", "0")))
elif args == ["plugin", "list", "--json"]:
    print(json.dumps([{"id": "mvp-sdlc@mvp", "version": v, "scope": "project", "enabled": True,
                       "installPath": cache(v), "projectPath": p} for p, v in state["projects"].items()], indent=2))
else:
    sys.exit(97)
json.dump(state, open(state_file, "w"))
PY
chmod +x "${tmp}/bin/gh" "${tmp}/bin/archon" "${tmp}/bin/claude"
export PATH="${tmp}/bin:${PATH}"
export FAKE_GH_STATE="${tmp}/gh" FAKE_GH_ORIGIN="${tmp}/origin.git" MIRROR_TARGET_URL="${tmp}/mirror.git"
export ARCHON_HOME="${tmp}/archon" STUB_LOG="${tmp}/stub.log"
export CLAUDE_CONFIG_DIR="${tmp}/claude/config" RELEASE_PLUGIN_PROJECTS="${tmp}/projects/be ${tmp}/projects/fe"

# new_fixture: origin with main (v0.9.8) and develop (the 0.9.9 release prep), a clone of it to release from, an
# empty mirror and empty fake GitHub state.
new_fixture() {
  rm -rf "${tmp}/origin.git" "${tmp}/mirror.git" "${tmp}/repo" "${tmp}/gh" "${ARCHON_HOME}" "${STUB_LOG}"
  mkdir "${tmp}/gh"
  git init -q --bare -b main "${tmp}/origin.git"
  git init -q --bare -b main "${tmp}/mirror.git"
  local r="${tmp}/repo"
  git init -q -b main "${r}"
  mkdir -p "${r}/scripts/ci" "${r}/plugins/mvp-sdlc/.claude-plugin" "${r}/orchestration/workflows" \
    "${r}/orchestration/supervisor/src" "${r}/orchestration/factory/.archon/workflows/sdlc-factory/factory/scripts/_lib"
  cp "${here}/scripts/release.sh" "${r}/scripts/release.sh"
  cp "${here}/scripts/ci/pr-conventions.sh" "${r}/scripts/ci/pr-conventions.sh"
  echo "notify" > "${r}/scripts/ci/notify-telegram.sh"
  echo "name: one" > "${r}/orchestration/workflows/one.yaml"
  echo "tick" > "${r}/orchestration/supervisor/src/main.ts"
  echo "node" > "${r}/orchestration/factory/.archon/workflows/sdlc-factory/factory/node.yaml"
  echo "lib" > "${r}/orchestration/factory/.archon/workflows/sdlc-factory/factory/scripts/_lib/lib.sh"
  cat > "${r}/install.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "install.sh $* in $(pwd)" >> "${STUB_LOG}"
f="${ARCHON_HOME}/workflows/sdlc-factory/factory"
rm -rf "${f}" "${ARCHON_HOME}/supervisor"
mkdir -p "${ARCHON_HOME}/workflows/sdlc-factory"
cp -R orchestration/factory/.archon/workflows/sdlc-factory/factory "${f}"
cp scripts/ci/notify-telegram.sh "${f}/scripts/_lib/notify-telegram.sh"
cp orchestration/workflows/*.yaml "${ARCHON_HOME}/workflows/"
cp -R orchestration/supervisor "${ARCHON_HOME}/supervisor"
SH
  cat > "${r}/scripts/publish-mirror.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "publish-mirror.sh $* timeout=${MIRROR_CHECKS_TIMEOUT:-}" >> "${STUB_LOG}"
case " $* " in *" --dry-run "*) exit "${FAKE_MIRROR_DRY_RC:-0}" ;; esac
git -C "$(dirname "$0")" push -q "${MIRROR_TARGET_URL}" --tags
SH
  chmod +x "${r}/install.sh" "${r}/scripts/publish-mirror.sh"
  printf '{\n  "name": "mvp-sdlc",\n  "version": "0.9.8",\n}\n' > "${r}/plugins/mvp-sdlc/.claude-plugin/plugin.json"
  printf '# Changelog\n\n## [Unreleased]\n\n## [0.9.8] - 2026-10-30\n\n### Fixed\n\n- Old fix (PILOT-5).\n' > "${r}/CHANGELOG.md"
  g -C "${r}" add -A
  g -C "${r}" commit -q -m "v0.9.8"
  git -C "${r}" remote add origin "${tmp}/origin.git"
  git -C "${r}" push -q origin main
  g -C "${r}" checkout -q -b develop
  printf '{\n  "name": "mvp-sdlc",\n  "version": "0.9.9",\n}\n' > "${r}/plugins/mvp-sdlc/.claude-plugin/plugin.json"
  printf '# Changelog\n\n## [Unreleased]\n\n## [0.9.9] - 2026-11-01\n\n### Fixed\n\n- New fix (PILOT-6).\n\n## [0.9.8] - 2026-10-30\n\n### Fixed\n\n- Old fix (PILOT-5).\n' > "${r}/CHANGELOG.md"
  g -C "${r}" commit -q -am "PILOT-7: Release 0.9.9 changelog (#119)"
  git -C "${r}" push -q origin develop
  g -C "${r}" checkout -q main
}

# new_plugin_projects: the be and fe checkouts, each with a committed .claude/settings.json, both at mvp-sdlc 0.9.8 in
# the fake claude's state, and an empty claude.log.
new_plugin_projects() {
  rm -rf "${tmp}/projects" "${tmp}/claude"
  mkdir -p "${CLAUDE_CONFIG_DIR}"
  : > "${tmp}/claude/claude.log"
  local p
  for p in be fe; do
    git init -q -b main "${tmp}/projects/${p}"
    mkdir "${tmp}/projects/${p}/.claude"
    echo '{"enabledPlugins": {"mvp-sdlc@mvp": true}}' > "${tmp}/projects/${p}/.claude/settings.json"
    g -C "${tmp}/projects/${p}" add -A
    g -C "${tmp}/projects/${p}" commit -q -m init
  done
  python3 -c '
import json, sys
json.dump({"served": None, "projects": {p: "0.9.8" for p in sys.argv[2:]}}, open(sys.argv[1], "w"))' \
    "${CLAUDE_CONFIG_DIR}/state.json" "$(git -C "${tmp}/projects/be" rev-parse --show-toplevel)" \
    "$(git -C "${tmp}/projects/fe" rev-parse --show-toplevel)"
}

rc=0 out="" err=""
release() {
  rc=0
  out=$(cd "${tmp}/repo" && bash scripts/release.sh "$@" 2>"${tmp}/err") || rc=$?
  err=$(cat "${tmp}/err")
}
calls() { cat "${tmp}/gh/calls.log" 2>/dev/null || true; }
expect_rc() { [ "${rc}" -eq "$2" ] || fail "$1" "exit ${rc}, want $2; stdout: ${out}; stderr: ${err}"; }
merge_of() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["mergeCommit"]["oid"])' "${tmp}/gh/prs.json"; }

# Usage.
new_fixture
for a in "tag 0.9.9" "tag v0.9.9-rc1" "publish v0.9.9" "tag" ""; do
  # shellcheck disable=SC2086 # each case is a word list
  release ${a}
  expect_rc "usage '${a}'" 64
done
[ -z "$(calls)" ] || fail usage "gh was called"

# plugin refuses a tag that is not on origin before any claude call.
new_plugin_projects
release plugin v0.9.9
expect_rc "plugin untagged" 1
grep -q "v0.9.9 is not on origin" <<<"${err}" || fail "plugin untagged" "${err}"
[ ! -s "${tmp}/claude/claude.log" ] || fail "plugin untagged" "claude was called: $(cat "${tmp}/claude/claude.log")"

# merge-release-pr creates the PR with the changelog body and merges it with a merge commit at its head.
release merge-release-pr v0.9.9
expect_rc "merge-release-pr" 0
m=$(merge_of)
[ "${out##*$'\n'}" = "merged: #120 ${m}" ] || fail "merge-release-pr" "stdout: ${out}"
grep -qx "ok release PR #120 is MERGED" <<<"${out}" || fail "merge-release-pr proof" "${out}"
grep -q "^pr create -R o/sdlc --base main --head develop --title PILOT-7: Release v0.9.9 --body-file " <<<"$(calls)" ||
  fail "merge-release-pr create" "$(calls)"
grep -q "^pr merge 120 -R o/sdlc --merge --match-head-commit $(git -C "${tmp}/origin.git" rev-parse develop)$" <<<"$(calls)" ||
  fail "merge-release-pr merge" "$(calls)"
body=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["body"])' "${tmp}/gh/prs.json")
for line in "## Changelog" "- New fix (PILOT-6)." "Type: chore"; do
  grep -qx -- "${line}" <<<"${body}" || fail "merge-release-pr body" "no '${line}': ${body}"
done
! grep -q "Old fix" <<<"${body}" || fail "merge-release-pr body" "carries the 0.9.8 section"
[ "$(git -C "${tmp}/origin.git" rev-list --parents -n 1 main | wc -w)" -eq 3 ] || fail "merge-release-pr" "main is not a merge"

# A rerun on the merged PR proves it again and neither creates nor merges.
: > "${tmp}/gh/calls.log"
release merge-release-pr v0.9.9
expect_rc "merge-release-pr rerun" 0
! grep -qE "^pr (create|merge)" <<<"$(calls)" || fail "merge-release-pr rerun" "$(calls)"

# tag creates an annotated tag on the merge commit and pushes it; a rerun pushes nothing.
release tag v0.9.9
expect_rc "tag" 0
[ "${out##*$'\n'}" = "tagged: v0.9.9 ${m}" ] || fail "tag" "${out}"
[ "$(git -C "${tmp}/origin.git" cat-file -t v0.9.9)" = tag ] || fail "tag" "not annotated on origin"
[ "$(git -C "${tmp}/origin.git" rev-parse 'v0.9.9^{commit}')" = "${m}" ] || fail "tag" "not on the merge commit"
[ "$(git -C "${tmp}/origin.git" for-each-ref --format='%(contents:subject)' refs/tags/v0.9.9)" = "mvp-sdlc 0.9.9" ] ||
  fail "tag" "message"
before=$(git -C "${tmp}/origin.git" rev-parse v0.9.9)
release tag v0.9.9
expect_rc "tag rerun" 0
[ "$(git -C "${tmp}/origin.git" rev-parse v0.9.9)" = "${before}" ] || fail "tag rerun" "the tag changed"

# mirror runs the dry run, then the real run from the tag, and leaves no worktree.
release mirror v0.9.9
expect_rc "mirror" 0
[ "$(cat "${STUB_LOG}")" = $'publish-mirror.sh 1_mvp_sdlc --dry-run timeout=\npublish-mirror.sh 1_mvp_sdlc timeout=1200' ] ||
  fail "mirror" "$(cat "${STUB_LOG}")"
git -C "${tmp}/mirror.git" rev-parse -q --verify refs/tags/v0.9.9 >/dev/null || fail "mirror" "no tag on the mirror"
[ "$(git -C "${tmp}/repo" worktree list | wc -l)" -eq 1 ] || fail "mirror" "a worktree was left behind"

# install waits for running factory runs and gives up with 75, then installs from the tag and proves it.
FAKE_ARCHON_RUNNING="aaaaaaaa-1 factory" RELEASE_INSTALL_WAIT=0 release install v0.9.9
expect_rc "install busy" 75
grep -q "still running: aaaaaaaa" <<<"${err}" || fail "install busy" "${err}"
! grep -q install.sh "${STUB_LOG}" || fail "install busy" "install.sh ran"
FAKE_ARCHON_RUNNING="bbbbbbbb-1 post-merge" release install v0.9.9
expect_rc "install" 0
grep -q "^install.sh  in .*/wt$" "${STUB_LOG}" || fail "install" "$(cat "${STUB_LOG}")"
grep -qx "ok installed supervisor equals v0.9.9" <<<"${out}" || fail "install proofs" "${out}"
! grep -q "^DIFF" <<<"${out}" || fail "install proofs" "${out}"
[ "$(git -C "${tmp}/repo" worktree list | wc -l)" -eq 1 ] || fail "install" "a worktree was left behind"

# verify proves the whole release and writes nothing.
: > "${tmp}/gh/calls.log"
release verify v0.9.9
expect_rc "verify" 0
! grep -q "^DIFF" <<<"${out}" || fail "verify" "${out}"
grep -q "^ok origin v0.9.9 is the merge of #120" <<<"${out}" || fail "verify" "${out}"
! grep -qE "^pr (create|merge)" <<<"$(calls)" || fail "verify" "$(calls)"

# plugin refreshes the marketplace, updates be and fe from their top level, proves the cache and each project's entry,
# and leaves both checkouts untouched; a rerun proves the same.
be=$(git -C "${tmp}/projects/be" rev-parse --show-toplevel) fe=$(git -C "${tmp}/projects/fe" rev-parse --show-toplevel)
heads="$(git -C "${be}" rev-parse HEAD) $(git -C "${fe}" rev-parse HEAD)"
for run in "plugin" "plugin rerun"; do
  : > "${tmp}/claude/claude.log"
  release plugin v0.9.9
  expect_rc "${run}" 0
  [ "$(cat "${tmp}/claude/claude.log")" = "plugin marketplace update mvp | ${tmp}/repo
plugin update mvp-sdlc@mvp --scope project --json | ${be}
plugin update mvp-sdlc@mvp --scope project --json | ${fe}
plugin list --json | ${tmp}/repo" ] || fail "${run}" "claude calls: $(cat "${tmp}/claude/claude.log")"
  for line in "ok the cache has mvp-sdlc 0.9.9" "ok ${be} resolves mvp-sdlc@mvp 0.9.9" "ok ${fe} resolves mvp-sdlc@mvp 0.9.9"; do
    grep -qx -- "${line}" <<<"${out}" || fail "${run}" "no '${line}': ${out}"
  done
  ! grep -q "^DIFF" <<<"${out}" || fail "${run}" "${out}"
done
[ -z "$(git -C "${be}" status --porcelain --ignored)$(git -C "${fe}" status --porcelain --ignored)" ] ||
  fail "plugin" "a checkout changed"
[ "$(git -C "${be}" rev-parse HEAD) $(git -C "${fe}" rev-parse HEAD)" = "${heads}" ] || fail "plugin" "a HEAD moved"

# plugin fails when a project does not resolve the release, a project is not a checkout, or an update fails.
new_plugin_projects
FAKE_CLAUDE_STALE=fe release plugin v0.9.9
expect_rc "plugin stale fe" 1
grep -qx "ok ${be} resolves mvp-sdlc@mvp 0.9.9" <<<"${out}" || fail "plugin stale fe" "${out}"
grep -qx "DIFF ${fe} resolves mvp-sdlc@mvp 0.9.9" <<<"${out}" || fail "plugin stale fe" "${out}"
new_plugin_projects
RELEASE_PLUGIN_PROJECTS="${tmp}/projects/be ${tmp}/nowhere" release plugin v0.9.9
expect_rc "plugin not a checkout" 1
grep -q "${tmp}/nowhere is not a git checkout" <<<"${err}" || fail "plugin not a checkout" "${err}"
[ ! -s "${tmp}/claude/claude.log" ] || fail "plugin not a checkout" "claude was called"
FAKE_CLAUDE_UPDATE_RC=1 release plugin v0.9.9
expect_rc "plugin update fails" 1
grep -q "claude plugin update mvp-sdlc@mvp failed in ${be}" <<<"${err}" || fail "plugin update fails" "${err}"

# A tampered install fails install's and verify's proofs.
echo tampered > "${ARCHON_HOME}/workflows/one.yaml"
release verify v0.9.9
expect_rc "verify tampered" 1
grep -qx "DIFF installed one.yaml equals v0.9.9" <<<"${out}" || fail "verify tampered" "${out}"

# Failing checks stop before the merge; an open PR is reused.
new_fixture
FAKE_GH_CHECKS=fail release merge-release-pr v0.9.9
expect_rc "checks fail" 3
grep -q "checks of #120 failed" <<<"${err}" || fail "checks fail" "${err}"
! grep -q "^pr merge" <<<"$(calls)" || fail "checks fail" "merged"
release merge-release-pr v0.9.9
expect_rc "open PR reused" 0
[ "$(grep -c "^pr create" <<<"$(calls)")" -eq 1 ] || fail "open PR reused" "$(calls)"

# tag refuses an existing tag on another commit.
g -C "${tmp}/repo" tag -a v0.9.9 -m "mvp-sdlc 0.9.9" "$(git -C "${tmp}/repo" rev-parse origin/develop)"
git -C "${tmp}/repo" push -q origin v0.9.9
release tag v0.9.9
expect_rc "tag elsewhere" 1
grep -q "v0.9.9 is not on the release merge" <<<"${err}" || fail "tag elsewhere" "${err}"

# A failing mirror dry run stops before the real run.
new_fixture
release merge-release-pr v0.9.9
release tag v0.9.9
FAKE_MIRROR_DRY_RC=2 release mirror v0.9.9
expect_rc "mirror dry run fails" 2
[ "$(grep -c publish-mirror "${STUB_LOG}")" -eq 1 ] || fail "mirror dry run fails" "$(cat "${STUB_LOG}")"
[ "$(git -C "${tmp}/repo" worktree list | wc -l)" -eq 1 ] || fail "mirror dry run fails" "a worktree was left behind"

# merge-release-pr refuses a develop whose plugin version is not the release, and an ambiguous release-prep card.
new_fixture
g -C "${tmp}/repo" checkout -q develop
sed -i 's/0\.9\.9/0.9.8/' "${tmp}/repo/plugins/mvp-sdlc/.claude-plugin/plugin.json"
g -C "${tmp}/repo" commit -q -am "plugin back to 0.9.8"
git -C "${tmp}/repo" push -q origin develop
g -C "${tmp}/repo" checkout -q main
release merge-release-pr v0.9.9
expect_rc "plugin version mismatch" 1
grep -q "plugin.json is not version 0.9.9" <<<"${err}" || fail "plugin version mismatch" "${err}"
new_fixture
FAKE_GH_PREP=$'PILOT-7: Release 0.9.9 changelog\nPILOT-8: Release 0.9.9 changelog' release merge-release-pr v0.9.9
expect_rc "two release-prep PRs" 1
grep -q "want exactly one merged release-prep PR" <<<"${err}" || fail "two release-prep PRs" "${err}"
! grep -q "^pr create" <<<"$(calls)" || fail "refusals" "created a PR"

echo "release: ok"
