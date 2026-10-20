#!/usr/bin/env bash
# Fast check of templates/project-{be,fe}: render a throwaway project and require that no placeholder is
# left, the word for the source project never ships, gitleaks finds no secret and actionlint passes on
# the rendered workflows. Needs actionlint and gitleaks on PATH (check.sh templates provides them).
# The full be/fe suites are a manual release checklist (templates/README.md), not part of this check.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT
status=0

failed() {
  echo "::error::templates: $1: $2 failed"
  status=1
}

# require_no_match <kind> <check> <grep args...>: a match and a grep error (exit 2) both fail the check.
require_no_match() {
  local kind=$1 check=$2 rc
  shift 2
  grep "$@"
  rc=$?
  case ${rc} in
    0) failed "${kind}" "${check}" ;;
    1) ;;
    *) failed "${kind}" "${check} (grep error ${rc})" ;;
  esac
}

for kind in be fe; do
  dest="${tmp}/${kind}"
  if ! bin/render-template "${kind}" tplcheck "${dest}"; then
    failed "${kind}" "render"
    continue
  fi
  require_no_match "${kind}" "no placeholder left" -rnIE '\{\{[A-Z][A-Z0-9_]*\}\}' "${dest}"
  require_no_match "${kind}" "no word pilot" -rnIiw pilot "${dest}"
  gitleaks dir --redact --exit-code 1 --no-banner "${dest}" || failed "${kind}" "gitleaks"
  git -C "${dest}" init -q
  (cd "${dest}" && actionlint -color) || failed "${kind}" "actionlint"
done

[ "${status}" -ne 0 ] || echo "templates: be and fe clean"
exit "${status}"
