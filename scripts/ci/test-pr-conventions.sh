#!/usr/bin/env bash
# Behaviour test for pr-conventions.sh with a stub gh on PATH; no network.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/pr-conventions.sh"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

cat > "${tmp}/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "${STUB_LOG}"
[ "${STUB_EXIT:-0}" -eq 0 ] || exit "${STUB_EXIT}"
printf '%s\n' "${STUB_OUT:-1}"
STUB
chmod +x "${tmp}/gh"
unset STUB_OUT STUB_EXIT
export PATH="${tmp}:${PATH}" STUB_LOG="${tmp}/calls" REPO=owner/repo BASE_REF=develop \
  HEAD_REF=feature/PILOT-12-add-login PR_TITLE='PILOT-12: Add login' PR_BODY=$'What and why\n\nType: feat'

fail() { echo "FAIL $1: $2" >&2; exit 1; }

# run_case <name> <expected exit> [VAR=value...] -- [<expected output substring>...]
out=""
run_case() {
  local name=$1 want=$2 rc=0 vars=()
  shift 2
  while [ "$1" != "--" ]; do vars+=("$1"); shift; done
  shift
  : > "${STUB_LOG}"
  out=$(env "${vars[@]}" bash "${script}" 2>&1) || rc=$?
  [ "${rc}" -eq "${want}" ] || fail "${name}" "exit ${rc}, want ${want}: ${out}"
  local s
  for s in "$@"; do
    grep -qF -- "${s}" <<<"${out}" || fail "${name}" "output lacks '${s}': ${out}"
  done
  echo "PASS ${name}"
}

run_case "conventions kept" 0 -- "pr-conventions: ok"
grep -qF 'repos/owner/repo/git/matching-refs/heads/develop' "${STUB_LOG}" || fail "conventions kept" "develop not looked up"

for pair in hotfix/PILOT-3-fix-crash:main archon/task-factory-1792086449826:develop \
  archon/task-factory-test:develop develop:main; do
  run_case "accepts ${pair%%:*} into ${pair##*:}" 0 HEAD_REF="${pair%%:*}" BASE_REF="${pair##*:}" --
done

for pair in wip-test:develop feature/PILOT-12-Add_Login:develop feature/pilot-12-add-login:develop \
  feature/add-login:develop develop:develop main:develop; do
  run_case "rejects ${pair%%:*} into ${pair##*:}" 1 HEAD_REF="${pair%%:*}" BASE_REF="${pair##*:}" -- \
    "::error::pr-conventions: branch"
done

for title in 'feat: add login' 'PILOT-12:'; do
  run_case "rejects the title '${title}'" 1 PR_TITLE="${title}" -- 'PR title must match ^PILOT-[0-9]+: .+$'
done

run_case "no Type line" 1 PR_BODY='What and why' -- "exactly one Type: line" "found 0"
run_case "two Type lines" 1 PR_BODY=$'What\n\nType: feat\nType: fix' -- "found 2"
run_case "unknown Type" 1 PR_BODY=$'What\n\nType: feature' -- \
  "Type: line must be one of feat, fix, chore, docs, refactor, test, ci"
run_case "CRLF body" 0 PR_BODY="$(printf 'What\r\n\r\nType: fix\r\n')" --

# A release PR PILOT-<n>: Release vX.Y.Z carries a non-empty changelog section of X.Y.Z (decision 64).
release=(HEAD_REF=develop BASE_REF=main PR_TITLE='PILOT-9: Release v1.2.3' CHANGELOG_FILE="${tmp}/none")
needs="needs in its body '## Changelog"
printf '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-10-22\n\n### Added\n\n- A thing\n\n## [1.2.2] - 2026-10-20\n\n- Old\n' \
  > "${tmp}/CHANGELOG.md"
printf '# Changelog\n\n## [1.2.2] - 2026-10-20\n\n- Old\n' > "${tmp}/older.md"
printf '# Changelog\n\n## [1.2.3] - 2026-10-22\n\n### Added\n\n### Fixed\n' > "${tmp}/empty.md"
bare=$'Sync\nTags: v1.2.3\n\nChangelog of v1.2.3:\n\n## Changelog\n\n### Added\n\n- A thing\n\nType: chore'
run_case "release: bare heading with the CHANGELOG.md section" 0 "${release[@]}" CHANGELOG_FILE="${tmp}/CHANGELOG.md" \
  PR_BODY="${bare}" -- "pr-conventions: ok"
run_case "release: CRLF bare heading with the CHANGELOG.md section" 0 "${release[@]}" \
  CHANGELOG_FILE="${tmp}/CHANGELOG.md" PR_BODY="${bare//$'\n'/$'\r\n'}" --
for pair in \
  "bare block differs from the section:${tmp}/CHANGELOG.md:"$'## Changelog\n\n### Added\n\n- Another thing\n\nType: chore' \
  "bare block with an extra line:${tmp}/CHANGELOG.md:"$'## Changelog\n\n### Added\n\n- A thing\n- More\n\nType: chore' \
  "bare block, no section in CHANGELOG.md:${tmp}/older.md:${bare}" \
  "bare block, section without an entry:${tmp}/empty.md:"$'## Changelog\n\n### Added\n\n### Fixed\n\nType: chore' \
  "bare block, no CHANGELOG.md:${tmp}/none:${bare}"; do
  rest=${pair#*:}
  run_case "release: ${pair%%:*}" 1 "${release[@]}" CHANGELOG_FILE="${rest%%:*}" PR_BODY="${rest#*:}" -- "${needs}"
done
run_case "release: mirror shape" 0 "${release[@]}" \
  PR_BODY=$'Sync\nTags: v1.2.3\n\n## Changelog (v1.2.3)\n\n### Added\n\n- A thing\n\nType: chore' -- "pr-conventions: ok"
run_case "release: verbatim section" 0 "${release[@]}" \
  PR_BODY=$'What\n\n## Changelog\n\n## [1.2.3] - 2026-10-22\n\n### Fixed\n\n- bug\n\nType: chore' --
run_case "release: CRLF verbatim section" 0 "${release[@]}" \
  PR_BODY="$(printf 'What\r\n\r\n## Changelog\r\n\r\n## [1.2.3] - 2026-10-22\r\n\r\n### Fixed\r\n\r\n- bug\r\n\r\nType: chore\r\n')" --
run_case "release-prep title needs no changelog" 0 "${release[@]}" PR_TITLE='PILOT-9: Release 1.2.3 changelog' \
  PR_BODY=$'What\n\nType: chore' --
for pair in \
  "no changelog:"$'What\n\nType: chore' \
  "headings only:"$'## Changelog (v1.2.3)\n\n### Added\n\n### Fixed\n\nType: chore' \
  "another version:"$'## Changelog\n\n## [1.2.2] - 2026-10-22\n\n### Added\n- x\n\nType: chore' \
  "another named version:"$'## Changelog (v1.2.2)\n\n### Added\n- x\n\nType: chore' \
  "no version heading:"$'## Changelog\n\n### Added\n- x\n\nType: chore' \
  "section before the block:"$'## [1.2.3] - 2026-10-22\n- x\n\n## Changelog\n\nType: chore' \
  "version prefix:"$'## Changelog\n\n## [1.2.30] - 2026-10-22\n- x\n\nType: chore' \
  "Type line only:"$'## Changelog (v1.2.3)\n\nType: chore'; do
  run_case "release: ${pair%%:*}" 1 "${release[@]}" PR_BODY="${pair#*:}" -- "${needs}"
done

# Every release has its own card; PILOT-0 is only for card-less chores (decision 91).
changelog=$'Sync\n\n## Changelog (v1.2.3)\n\n### Added\n\n- A thing\n\nType: chore'
for case in "develop:main:PILOT-0: Release v1.2.3" "archon/task-factory-x:develop:PILOT-0: Release 1.2.3 changelog" \
  "develop:main:PILOT-00: Release v1.2.3"; do
  head=${case%%:*} rest=${case#*:}
  run_case "release card: '${rest#*:}' into ${rest%%:*}" 1 HEAD_REF="${head}" BASE_REF="${rest%%:*}" \
    PR_TITLE="${rest#*:}" PR_BODY="${changelog}" -- "decision 91" "PILOT-<n>: Release vX.Y.Z"
done
run_case "release card: card-less mirror sync" 0 HEAD_REF=develop BASE_REF=main \
  PR_TITLE='PILOT-0: Sync main (abc1234)' PR_BODY=$'Sync\n\nType: chore' -- "pr-conventions: ok"
run_case "release card: card-less chore" 0 PR_TITLE='PILOT-0: Fix a typo' PR_BODY=$'Typo\n\nType: chore' --

run_case "every violated rule" 1 HEAD_REF=wip-test PR_TITLE=wip PR_BODY= --
errors=$(grep '^::error::pr-conventions:' <<<"${out}" || true)
[ "$(wc -l <<<"${errors}")" -eq 3 ] || fail "every violated rule" "want 3 errors: ${out}"
sed -n 1p <<<"${errors}" | grep -qF 'branch' || fail "every violated rule" "first error is not the branch"
sed -n 2p <<<"${errors}" | grep -qF 'PR title' || fail "every violated rule" "second error is not the title"
sed -n 3p <<<"${errors}" | grep -qF 'Type: line' || fail "every violated rule" "third error is not the Type line"

run_case "no develop branch yet" 0 STUB_OUT=0 HEAD_REF=wip-test PR_TITLE=wip -- "not applicable"
run_case "gh error" 2 STUB_EXIT=1 --

marker="${tmp}/pwned"
# shellcheck disable=SC2016 # the PR text must reach the script unexpanded
run_case "PR text is data" 0 PR_TITLE='PILOT-1: $(touch '"${marker}"')' \
  PR_BODY='`touch '"${marker}"'`'$'\n\nType: fix' --
[ ! -e "${marker}" ] || fail "PR text is data" "the title or body was executed"

run_case "bad REPO" 2 REPO='owner/repo; x' --
[ ! -s "${STUB_LOG}" ] || fail "bad REPO" "gh was called"
echo "PASS no gh call on bad REPO"

# The local hook plugins/mvp-sdlc/hooks/guards.py declares the same branch convention for agents;
# its patterns must stay the ones this check enforces.
root="$(dirname "${script}")/../.."
live() { sed -n "s/^$1='\(.*\)'\$/\1/p" "${script}"; }
python3 -B - "${root}/plugins/mvp-sdlc/hooks" "$(live card_branch)" "$(live factory_branch)" <<'PY' \
  || fail "guards.py agreement" "branch patterns differ from plugins/mvp-sdlc/hooks/guards.py"
import sys
sys.path.insert(0, sys.argv[1])
import guards
card_branch, factory_branch = sys.argv[2:]
assert card_branch == "^" + guards.BRANCH_NAME.pattern + "$", (card_branch, guards.BRANCH_NAME.pattern)
assert factory_branch.startswith("^" + guards.FACTORY_BRANCH_PREFIX), (factory_branch, guards.FACTORY_BRANCH_PREFIX)
PY
echo "PASS branch patterns agree with guards.py"

# pr-conventions-check.yml wiring
workflow="${root}/.github/workflows/pr-conventions-check.yml"
grep -qxF '    branches: [develop, main]' "${workflow}" || fail "pr-conventions-check" "not triggered by PRs into develop and main"
grep -qF 'types: [opened, edited, reopened, synchronize]' "${workflow}" \
  || fail "pr-conventions-check" "not re-run when the PR body is edited"
# shellcheck disable=SC2016 # the workflow expressions are matched literally
for mapping in 'REPO: ${{ github.repository }}' 'BASE_REF: ${{ github.event.pull_request.base.ref }}' \
  'HEAD_REF: ${{ github.event.pull_request.head.ref }}' 'PR_TITLE: ${{ github.event.pull_request.title }}' \
  'PR_BODY: ${{ github.event.pull_request.body }}' 'GH_TOKEN: ${{ github.token }}'; do
  grep -qxF "          ${mapping}" "${workflow}" || fail "pr-conventions-check" "lacks env ${mapping}"
done
grep -qxF '        run: bash scripts/ci/pr-conventions.sh' "${workflow}" || fail "pr-conventions-check" "does not run pr-conventions.sh"
echo "PASS pr-conventions-check runs pr-conventions.sh with its inputs on PRs into develop and main"
