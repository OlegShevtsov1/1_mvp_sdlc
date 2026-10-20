#!/usr/bin/env bash
# Prints the next release version X.Y.Z (no v) from the Type: line of every squash commit since the
# previous release tag (decision 25): a BREAKING CHANGE footer bumps MAJOR, else a feat bumps MINOR,
# else a fix bumps PATCH. Without a previous tag the first release is 0.1.0: the history before
# the branch model has no Type: lines. Merge commits (release PRs, back-merges) are skipped.
# Usage: scripts/next-version.sh [<rev>]                 (default HEAD)
#        scripts/next-version.sh --previous-tag [<rev>]  prints the previous release tag, or nothing
# The previous tag is the highest vX.Y.Z merged into <rev> that does not point at <rev> itself, so
# the answer is the same before tagging and on the tagged commit.
# Exit 0: printed. Exit 1: a commit without exactly one valid Type: line, or nothing to release.
# Exit 2: bad usage.
set -euo pipefail

mode=next
if [ "${1:-}" = --previous-tag ]; then
  mode=previous
  shift
fi
[ $# -le 1 ] || { echo 'usage: scripts/next-version.sh [--previous-tag] [<rev>]' >&2; exit 2; }
rev=$(git rev-parse --verify --quiet "${1:-HEAD}^{commit}") || { echo "next-version: unknown revision '${1:-HEAD}'" >&2; exit 2; }

semver_tag='^v[0-9]+\.[0-9]+\.[0-9]+$'
previous=$(comm -23 \
  <(git tag --merged "$rev" --list 'v*' | grep -E "$semver_tag" | sort) \
  <(git tag --points-at "$rev" --list 'v*' | sort) |
  sort -V | tail -n 1)

if [ "$mode" = previous ]; then
  [ -z "$previous" ] || echo "$previous"
  exit 0
fi
if [ -z "$previous" ]; then
  echo 0.1.0
  exit 0
fi

bump='none' invalid=()
while read -r commit; do
  [ -n "$commit" ] || continue
  message=$(git log -1 --format=%B "$commit")
  types=$(grep -c '^Type:' <<<"$message" || true)
  type=$(sed -nE 's/^Type: (feat|fix|chore|docs|refactor|test|ci)$/\1/p' <<<"$message")
  if [ "$types" -ne 1 ] || [ -z "$type" ]; then
    invalid+=("$(git log -1 --format='%h %s' --abbrev=7 "$commit")")
    continue
  fi
  if grep -qE '^BREAKING[ -]CHANGE: ' <<<"$message"; then
    bump='major'
  elif [ "$type" = feat ] && [ "$bump" != major ]; then
    bump='minor'
  elif [ "$type" = fix ] && [ "$bump" = none ]; then
    bump='patch'
  fi
done < <(git rev-list --no-merges "$previous..$rev")

if [ ${#invalid[@]} -gt 0 ]; then
  echo "next-version: commits since $previous without exactly one Type: line (feat, fix, chore, docs, refactor, test, ci):" >&2
  printf '  %s\n' "${invalid[@]}" >&2
  exit 1
fi

IFS=. read -r major minor patch <<<"${previous#v}"
case $bump in
  major) echo "$((major + 1)).0.0" ;;
  minor) echo "$major.$((minor + 1)).0" ;;
  patch) echo "$major.$minor.$((patch + 1))" ;;
  none)
    echo "next-version: nothing to release since $previous (only chore/docs/refactor/test/ci)" >&2
    exit 1
    ;;
esac
