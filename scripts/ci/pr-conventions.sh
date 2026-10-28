#!/usr/bin/env bash
# Enforces the pull request conventions of the develop branch model (decisions 24-26, 29 and,
# for this repository, 54) on PRs into develop and main:
#   1. the head branch is feature/PILOT-<n>-<slug> or hotfix/PILOT-<n>-<slug> (lowercase slug),
#      the factory's archon/task-factory-*, or develop as the head of a release PR into main;
#   2. the title is PILOT-<n>: <card title>;
#   3. the body, which becomes the squash commit body, has exactly one valid Type: line;
#   4. a release PR, titled PILOT-<n>: Release vX.Y.Z (decision 58), has in its body a "## Changelog"
#      block with a non-empty section for X.Y.Z (decision 64): "## Changelog (vX.Y.Z)" followed by the
#      section, or "## Changelog" followed by the CHANGELOG.md heading "## [X.Y.Z]" and its text, or
#      "## Changelog" followed by exactly the version's section of CHANGELOG.md (CHANGELOG_FILE, default
#      CHANGELOG.md), as the mirror sync PR carries it; an entry is a list item;
#   5. a release PR or release-prep PR is titled with the release's own card, never PILOT-0 (decision 91).
# Not applicable until the develop branch exists: before that the repository is on GitHub Flow.
# The title and body are data: they are only matched, never printed or executed.
# Env: REPO (owner/name), BASE_REF, HEAD_REF, PR_TITLE, PR_BODY, CHANGELOG_FILE; GH_TOKEN for gh.
# Exit 0: conventions kept or not applicable. Exit 1: broken. Exit 2: bad input or GitHub API error.
set -uo pipefail

# release_changelog <X.Y.Z> < body: exit 0 when the body has a "## Changelog" block with an entry of X.Y.Z.
# The block ends at the next "## " line, except a "## [X.Y.Z]" heading right inside a bare "## Changelog".
release_changelog() {
  awk -v version="$1" '
    function named_by(line) { return line == "## Changelog (v" version ")" }
    state == 0 && ($0 == "## Changelog" || named_by($0)) { state = 1; named = named_by($0); next }
    state == 1 && /^## / {
      if ($0 == "## [" version "]" || index($0, "## [" version "] ") == 1) { named = 1; next }
      exit
    }
    state == 1 && /^### \[/ { exit }
    state == 1 && named && /^[[:space:]]*[-*+][[:space:]]+[^[:space:]]/ { found = 1; exit }
    END { exit !found }
  '
}

# changelog_section <X.Y.Z> < CHANGELOG.md: the section's text without its heading and the blank lines around it,
# by the same awk as changelog_section in scripts/publish-mirror.sh and the app repos' release-notes.sh; exit 1 when
# there is no section.
changelog_section() {
  awk -v heading="## [$1]" '
    index($0, "## ") == 1 { if (found) exit; if ($0 == heading || index($0, heading " ") == 1) { found = 1; next } }
    found { lines[++n] = $0 }
    END {
      if (!found) exit 1
      first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
      last = n; while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
      for (i = first; i <= last; i++) print lines[i]
    }'
}

# pasted_changelog <X.Y.Z> <changelog file> < body: exit 0 when the first bare "## Changelog" is followed, up to the
# next "## " or Type: line, by exactly the file's section of X.Y.Z with an entry (the mirror sync PR body).
pasted_changelog() {
  local section given
  [ -r "$2" ] || return 1
  section=$(changelog_section "$1" < "$2") || return 1
  grep -qE '^[[:space:]]*[-*+][[:space:]]+[^[:space:]]' <<<"${section}" || return 1
  given=$({ echo "## [$1]"; awk '
    found && (index($0, "## ") == 1 || index($0, "Type:") == 1) { exit }
    found { print }
    !found && $0 == "## Changelog" { found = 1 }'; } | changelog_section "$1")
  [ "${given}" = "${section}" ]
}

repo=${REPO:-}
base_ref=${BASE_REF:-}
head_ref=${HEAD_REF:-}
title=${PR_TITLE:-}
body=${PR_BODY:-}

[[ "${repo}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "pr-conventions: invalid REPO '${repo}'" >&2; exit 2; }
[[ "${base_ref}" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "pr-conventions: invalid BASE_REF '${base_ref}'" >&2; exit 2; }
[[ "${head_ref}" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "pr-conventions: invalid HEAD_REF '${head_ref}'" >&2; exit 2; }

if ! develop=$(gh api "repos/${repo}/git/matching-refs/heads/develop" \
  --jq '[.[] | select(.ref == "refs/heads/develop")] | length'); then
  echo "pr-conventions: GitHub API error; cannot decide" >&2
  exit 2
fi
if [ "${develop}" = 0 ]; then
  echo "pr-conventions: not applicable (no develop branch yet: GitHub Flow until the decision-24 branch model starts)"
  exit 0
fi

card_branch='^(feature|hotfix)/PILOT-[0-9]+-[a-z0-9-]+$'
factory_branch='^archon/task-factory-[A-Za-z0-9._-]+$'
card_title='^PILOT-[0-9]+: .+$'
release_title='^PILOT-[0-9]+: Release v([0-9]+\.[0-9]+\.[0-9]+)$'
no_card_release='^PILOT-0[0-9]*: Release '
failed=0

if ! [[ "${head_ref}" =~ ${card_branch} || "${head_ref}" =~ ${factory_branch} ]] \
  && ! [[ "${head_ref}" = develop && "${base_ref}" = main ]]; then
  echo "::error::pr-conventions: branch '${head_ref}' must match feature/PILOT-<n>-<slug> or hotfix/PILOT-<n>-<slug> (lowercase slug), or be archon/task-factory-* (develop only as the head of a release PR into main)"
  failed=1
fi

if ! [[ "${title}" =~ ${card_title} ]]; then
  echo '::error::pr-conventions: PR title must match ^PILOT-[0-9]+: .+$'
  failed=1
fi

body=${body//$'\r'/}
types=$(printf '%s\n' "${body}" | grep -c '^Type:')
if [ "${types}" -ne 1 ]; then
  echo "::error::pr-conventions: the PR body must have exactly one Type: line (found ${types})"
  failed=1
elif ! grep -qxE 'Type: (feat|fix|chore|docs|refactor|test|ci)' <<<"${body}"; then
  echo '::error::pr-conventions: the Type: line must be one of feat, fix, chore, docs, refactor, test, ci'
  failed=1
fi

if [[ "${title}" =~ ${no_card_release} ]]; then
  echo "::error::pr-conventions: a release PR is titled PILOT-<n>: Release vX.Y.Z (release-prep: PILOT-<n>: Release X.Y.Z changelog) with the release's own card, never PILOT-0 (decision 91: every release has its own card; PILOT-0 is only for card-less chores)"
  failed=1
fi

if [[ "${title}" =~ ${release_title} ]]; then
  version=${BASH_REMATCH[1]}
  if ! release_changelog "${version}" <<<"${body}" &&
    ! pasted_changelog "${version}" "${CHANGELOG_FILE:-CHANGELOG.md}" <<<"${body}"; then
    echo "::error::pr-conventions: a release PR 'PILOT-<n>: Release v${version}' needs in its body '## Changelog (v${version})' followed by the version's CHANGELOG.md section with at least one entry (or '## Changelog' followed by the CHANGELOG.md heading '## [${version}]' and its section, or '## Changelog' followed by exactly the section of ${CHANGELOG_FILE:-CHANGELOG.md})"
    failed=1
  fi
fi

[ "${failed}" -eq 0 ] || exit 1
echo "pr-conventions: ok (branch, title, Type line)"
