#!/usr/bin/env bash
# Prints the body of one CHANGELOG.md section verbatim: the lines after its heading up to the next
# "## " heading, without leading or trailing blank lines. The draft GitHub Release of a tag carries
# exactly this text.
# Usage: scripts/release-notes.sh vX.Y.Z|Unreleased
# Env: CHANGELOG_FILE (default CHANGELOG.md in the current directory).
# Exit 0: printed. Exit 1: no such section, or it is empty. Exit 2: bad usage.
set -euo pipefail

case ${1:-} in
  Unreleased) heading='## [Unreleased]' ;;
  v[0-9]*.[0-9]*.[0-9]*)
    [[ $1 =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "release-notes: expected vX.Y.Z or Unreleased (got '$1')" >&2; exit 1; }
    heading="## [${1#v}]"
    ;;
  *) echo "release-notes: expected vX.Y.Z or Unreleased (got '${1:-}')" >&2; exit 1 ;;
esac
file=${CHANGELOG_FILE:-CHANGELOG.md}
[ -f "$file" ] || { echo "release-notes: $file not found" >&2; exit 1; }

notes=$(awk -v heading="$heading" '
  index($0, "## ") == 1 { if (inside) exit; inside = ($0 == heading || index($0, heading " ") == 1); next }
  inside { print }
' "$file")
# $(...) already dropped the trailing blank lines.
notes=$(sed '/./,$!d' <<<"$notes")
[ -n "$notes" ] || { echo "release-notes: no section ${heading#'## '} in $file (or it is empty)" >&2; exit 1; }
printf '%s\n' "$notes"
