#!/usr/bin/env bash
# Prints the semantic version the next release tag on <ref> must have (decision 25, R-C9).
# Usage: scripts/next-version.sh [<ref>]              (default HEAD; prints X.Y.Z)
#        scripts/next-version.sh --previous [<ref>]   (prints the previous release tag, empty if none)
#
# The previous release is the highest vX.Y.Z tag reachable from <ref> that is not on <ref>'s own
# commit, so for a tagged commit this prints the version that tag should have. Every non-merge
# commit since then is a squash commit whose body is its pull request body, with exactly one
# Type: line: any BREAKING CHANGE: (or BREAKING-CHANGE:) footer → MAJOR, else any feat → MINOR,
# else any fix → PATCH. Merge commits (release PRs, back-merges) are skipped. Without a previous
# release tag the version is 0.1.0, whatever the history: it predates the Type: line.
#
# Exit 0: version printed. 1: commits without a Type: line, with several, or with an invalid
# value (listed on stderr; nothing is guessed). 2: usage error. 3: nothing to release (only
# chore, docs, ci, refactor and test since the previous tag).
set -euo pipefail

mode=next
if [[ "${1:-}" == '--previous' ]]; then
  mode=previous
  shift
fi
(( $# <= 1 )) || { echo "usage: $0 [--previous] [<ref>]" >&2; exit 2; }
ref="${1:-HEAD}"
commit="$(git rev-parse --verify --quiet "${ref}^{commit}")" || { echo "error: unknown ref ${ref}" >&2; exit 2; }

release_tag='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
previous="$(comm -23 <(git tag --merged "${commit}" --list 'v*' | grep -E "${release_tag}" | sort) \
                     <(git tag --points-at "${commit}" | sort) \
            | sort -V | tail -1)"

if [[ "${mode}" == previous ]]; then
  echo "${previous}"
  exit 0
fi
if [[ -z "${previous}" ]]; then
  echo '0.1.0'
  exit 0
fi

major=0 minor=0 patch=0
bad=()
while read -r sha; do
  body="$(git log -1 --format=%B "${sha}" | tr -d '\r')"
  mapfile -t types < <(grep -E '^Type:' <<< "${body}" || true)
  describe="${sha:0:7} $(git log -1 --format=%s "${sha}" | tr -d '\r')"
  if (( ${#types[@]} == 0 )); then
    bad+=("${describe} (no Type: line)")
    continue
  elif (( ${#types[@]} > 1 )); then
    bad+=("${describe} (${#types[@]} Type: lines)")
    continue
  fi
  if ! [[ "${types[0]}" =~ ^Type:\ (feat|fix|chore|docs|refactor|test|ci)[[:space:]]*$ ]]; then
    bad+=("${describe} (invalid ${types[0]})")
    continue
  fi
  case "${BASH_REMATCH[1]}" in
    feat) minor=1 ;;
    fix) patch=1 ;;
  esac
  if grep -qE '^BREAKING[ -]CHANGE: ' <<< "${body}"; then
    major=1
  fi
done < <(git rev-list --no-merges "${previous}..${commit}")

if (( ${#bad[@]} > 0 )); then
  echo "error: every commit since ${previous} needs exactly one valid Type: line (decision 25):" >&2
  printf '  %s\n' "${bad[@]}" >&2
  exit 1
fi

IFS=. read -r x y z <<< "${previous#v}"
if (( major )); then
  echo "$(( x + 1 )).0.0"
elif (( minor )); then
  echo "${x}.$(( y + 1 )).0"
elif (( patch )); then
  echo "${x}.${y}.$(( z + 1 ))"
else
  echo "error: nothing to release since ${previous} (no feat, fix or BREAKING CHANGE)" >&2
  exit 3
fi
