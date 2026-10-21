#!/usr/bin/env bash
# Behaviour test for main-guard.sh with a stub gh on PATH; no network, no Telegram.
set -euo pipefail
guard="$(cd "$(dirname "$0")" && pwd)/main-guard.sh"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

cat > "${tmp}/gh" <<'STUB'
#!/usr/bin/env bash
echo called >> "${STUB_LOG}"
[ "${STUB_EXIT:-0}" -eq 0 ] || exit "${STUB_EXIT}"
printf '%s\n' "${STUB_OUT:-}"
STUB
chmod +x "${tmp}/gh"
for v in $(compgen -e | grep '^TELEGRAM_' || true); do unset "${v}"; done
unset BRANCH
export PATH="${tmp}:${PATH}" MAIN_GUARD_SLEEP=0 STUB_LOG="${tmp}/calls" REPO=owner/repo

fail() { echo "FAIL $1: $2" >&2; exit 1; }

# run_case <name> <expected exit> <SHA> <stub output> <stub exit> [<expected output substring>...]
run_case() {
  local name=$1 want=$2 sha=$3 stub_out=$4 stub_exit=$5 out rc=0
  shift 5
  : > "${STUB_LOG}"
  out=$(SHA="${sha}" STUB_OUT="${stub_out}" STUB_EXIT="${stub_exit}" bash "${guard}" 2>&1) || rc=$?
  [ "${rc}" -eq "${want}" ] || fail "${name}" "exit ${rc}, want ${want}: ${out}"
  local s
  for s in "$@"; do
    grep -qF -- "${s}" <<<"${out}" || fail "${name}" "output lacks '${s}': ${out}"
  done
  echo "PASS ${name}"
}

run_case "merged PR"        0 abc1234 7 0 "merged PR #7"
run_case "no PR"            1 abc1234 "" 0 "::error::" "reached main without a merged PR" "skipped"
[ "$(wc -l < "${STUB_LOG}")" -eq 5 ] || fail "no PR" "expected 5 gh attempts"
BRANCH=develop run_case "no PR on develop" 1 abc1234 "" 0 "reached develop without a merged PR" "skipped"
BRANCH='dev;x' run_case "bad BRANCH" 2 abc1234 7 0 "invalid BRANCH"
[ ! -s "${STUB_LOG}" ] || fail "bad BRANCH" "gh was called"
run_case "gh error"         2 abc1234 "" 1 "API error"
run_case "bad SHA"          2 'abc;rm' 7 0 "invalid SHA"
[ ! -s "${STUB_LOG}" ] || fail "bad SHA" "gh was called"
echo "PASS no gh call on bad SHA"

# develop-guard.yml wiring
workflows="$(dirname "${guard}")/../../.github/workflows"
develop_guard="${workflows}/develop-guard.yml"
grep -qxF '    branches: [develop]' "${develop_guard}" || fail "develop-guard" "not triggered by pushes to develop"
[ "$(grep -cxF "    if: vars.MIRROR != 'true'" "${develop_guard}")" -eq 1 ] \
  || fail "develop-guard" "not switched off by MIRROR (decision 51)"
grep -qxF '          BRANCH: develop' "${develop_guard}" || fail "develop-guard" "does not pass BRANCH: develop"
grep -qxF '        run: bash scripts/ci/main-guard.sh' "${develop_guard}" || fail "develop-guard" "does not run main-guard.sh"
echo "PASS develop-guard runs main-guard.sh for develop and is off when MIRROR is true"
! grep -q MIRROR "${workflows}/main-guard.yml" || fail "main-guard" "must run in the mirrors too"
echo "PASS main-guard is never switched off"
