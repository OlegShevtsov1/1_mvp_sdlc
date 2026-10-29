#!/usr/bin/env bash
# Every check that check.sh knows must have its own step in a workflow, or CI would silently skip it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
workflows="${here}/../../.github/workflows"

fail() { echo "FAIL $1: $2" >&2; exit 1; }

checks=$(bash "${here}/check.sh" --list)
[ -n "${checks}" ] || fail "check list" "check.sh --list printed nothing"
while read -r c; do
  grep -qE "^ +run: bash scripts/ci/check\.sh ${c}\$" "${workflows}"/*.yml || fail "workflows" "no workflow runs 'check.sh ${c}'"
done <<<"${checks}"
echo "PASS the workflows run every check.sh check"

[ "$(grep -cxF '    branches: [develop, main]' "${workflows}/ci.yml")" -eq 2 ] \
  || fail "ci.yml" "must run on pull requests into and pushes to develop and main"
echo "PASS CI runs on pull requests into and pushes to develop and main"
[ "$(grep -cxF '    timeout-minutes: 30' "${workflows}/ci.yml")" -eq 2 ] \
  || fail "ci.yml" "both jobs need timeout-minutes: 30 (a shared runner under load runs them 2-3x slower)"
echo "PASS both CI jobs have a 30-minute limit"

rc=0
bash "${here}/check.sh" no-such-check 2>/dev/null || rc=$?
[ "${rc}" -eq 2 ] || fail "unknown check" "exit ${rc}, want 2"
echo "PASS unknown check is rejected"
