#!/usr/bin/env bash
# CHANGELOG discipline (R-C9): a pull request whose body has "Type: feat" or "Type: fix" (the
# squash commit's Type trailer, decision 25) changes the [Unreleased] section of CHANGELOG.md, or
# adds a new version section (a hotfix PR into main adds ## [X.Y.Z] directly). Not applicable to
# the release PR develop -> main, to PRs labelled skip-changelog and to other Type values; a
# missing or duplicate Type: line is pr-conventions-check's finding.
# The PR body is data: it is only matched, never printed or executed.
# Env: BASE_REF, HEAD_REF, BASE_SHA, HEAD_SHA (40 hex), LABELS (comma-separated), PR_BODY.
# Exit 0: kept or not applicable. Exit 1: missing entry. Exit 2: bad input or git error.
set -uo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
base_ref=${BASE_REF:-}
head_ref=${HEAD_REF:-}
base_sha=${BASE_SHA:-}
head_sha=${HEAD_SHA:-}
body=${PR_BODY:-}

[[ "${base_sha}" =~ ^[0-9a-f]{40}$ ]] || { echo "changelog-check: invalid BASE_SHA" >&2; exit 2; }
[[ "${head_sha}" =~ ^[0-9a-f]{40}$ ]] || { echo "changelog-check: invalid HEAD_SHA" >&2; exit 2; }

if [ "${head_ref}" = develop ] && [ "${base_ref}" = main ]; then
  echo "changelog-check: not applicable (release PR)"
  exit 0
fi
if [[ ",${LABELS:-}," == *,skip-changelog,* ]]; then
  echo "changelog-check: not applicable (label skip-changelog)"
  exit 0
fi
body=${body//$'\r'/}
types=$(printf '%s\n' "${body}" | grep -c '^Type:')
type=$(printf '%s\n' "${body}" | sed -nE 's/^Type: (feat|fix)$/\1/p')
if [ "${types}" -ne 1 ] || [ -z "${type}" ]; then
  echo "changelog-check: not applicable (not Type: feat or Type: fix)"
  exit 0
fi

merge_base=$(git merge-base "${base_sha}" "${head_sha}") || exit 2

# Prints the [Unreleased] body and the version headings of CHANGELOG.md at a commit.
summary() {
  local file
  file=$(mktemp)
  git show "$1:CHANGELOG.md" >"${file}" 2>/dev/null || { rm -f "${file}"; return 1; }
  CHANGELOG_FILE=${file} "${here}/release-notes.sh" Unreleased 2>/dev/null
  echo '---'
  grep -E '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "${file}" | sed -E 's/^## \[([^]]*)\].*/\1/' | sort
  rm -f "${file}"
}

if ! after=$(summary "${head_sha}"); then
  echo "::error::changelog-check: Type: ${type} needs CHANGELOG.md, which the head of this PR does not have"
  exit 1
fi
before=$(summary "${merge_base}") || before=''
unreleased_after=${after%%$'\n'---*}
unreleased_before=${before%%$'\n'---*}
new_versions=$(comm -13 <(sed '1,/^---$/d' <<<"${before}") <(sed '1,/^---$/d' <<<"${after}"))

if [ "${unreleased_after}" != "${unreleased_before}" ] || [ -n "${new_versions}" ]; then
  echo "changelog-check: ok (Type: ${type} with a CHANGELOG.md entry)"
  exit 0
fi
echo "::error::changelog-check: Type: feat/fix needs an entry under [Unreleased] in CHANGELOG.md (or the label skip-changelog)"
exit 1
