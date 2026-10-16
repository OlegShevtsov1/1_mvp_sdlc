#!/usr/bin/env bash
# Single entry for the mvp-sdlc plugin tests: hook tests, unittest discovery under tests/, the scripts/ tests.
# Every glob must match, so a misplaced or renamed test file fails here instead of silently not running.
set -euo pipefail
tests="$(cd "$(dirname "$0")" && pwd)"
plugin="$(dirname "${tests}")"

shopt -s nullglob
hook_tests=("${tests}"/hooks/test-*.sh)
unit_tests=("${tests}"/test_*.py)
script_tests=("${plugin}/scripts/test_lint_prd.py" "${plugin}/scripts/test_feature_state.py")
[ "${#hook_tests[@]}" -gt 0 ] || { echo "no tests/hooks/test-*.sh found" >&2; exit 1; }
[ "${#unit_tests[@]}" -gt 0 ] || { echo "no tests/test_*.py found" >&2; exit 1; }

for t in "${hook_tests[@]}"; do bash "${t}"; done
python3 -m unittest discover -s "${tests}" -p 'test_*.py'
for t in "${script_tests[@]}"; do
  [ -f "${t}" ] || { echo "missing ${t#"${plugin}/"}" >&2; exit 1; }
  python3 "${t}"
done
