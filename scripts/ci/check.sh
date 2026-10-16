#!/usr/bin/env bash
# Runs locally exactly what CI runs. Usage: check.sh [<check>|--list] (default: all checks, in order).
# gitleaks and the hygiene check see committed/tracked content only, so run this after committing.
# Every check listed here needs its own step in .github/workflows/ci.yml; test-check.sh enforces that.
set -euo pipefail
checks=(actionlint tests plugins mvp_sdlc docs factory archon hygiene gitleaks)

run_actionlint() { actionlint -color; }
run_tests() {
  local t
  for t in scripts/ci/test-*.sh; do bash "${t}"; done
}
run_plugins() { python3 scripts/test_lint_plugins.py && python3 scripts/lint_plugins.py && python3 scripts/test_evals.py; }
run_mvp_sdlc() { bash plugins/mvp-sdlc/tests/run.sh; }
run_docs() {
  python3 scripts/test_check_links.py && python3 scripts/test_check_docs.py &&
    python3 scripts/check_links.py README.md docs/sdlc templates/github orchestration/docs && python3 scripts/check_docs.py
}
run_factory() { (cd orchestration/factory && bun test); }
run_archon() { bash scripts/ci/tools.sh archon && bash scripts/ci/archon-check.sh; }
run_hygiene() { bash scripts/ci/hygiene-check.sh; }
run_gitleaks() { gitleaks git --redact --exit-code 1 --verbose .; }

case "${1:-all}" in
  --list) printf '%s\n' "${checks[@]}"; exit 0 ;;
  all) selected=("${checks[@]}") ;;
  *)
    selected=()
    for c in "${checks[@]}"; do [ "${c}" != "$1" ] || selected=("$1"); done
    [ "${#selected[@]}" -eq 1 ] || { (IFS='|'; echo "usage: check.sh [${checks[*]}|--list]" >&2); exit 2; }
    ;;
esac

root=$(git rev-parse --show-toplevel)
cd "${root}"
bash scripts/ci/tools.sh
export PATH="${root}/.tools/bin:${PATH}"
for c in "${selected[@]}"; do "run_${c}"; done
