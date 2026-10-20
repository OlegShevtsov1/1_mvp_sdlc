#!/usr/bin/env bash
# Prints the CHANGELOG.md section of a version verbatim, without its heading and the blank lines
# around it: the body of the GitHub Release, so the published notes equal the CHANGELOG.
# Usage: scripts/release-notes.sh vX.Y.Z|X.Y.Z|Unreleased [<changelog>]   (default: CHANGELOG.md of this repository)
# Exit 0: printed (nothing for an empty section). 1: no such section. 2: usage error.
set -euo pipefail

(( $# >= 1 && $# <= 2 )) || { echo "usage: $0 vX.Y.Z|X.Y.Z|Unreleased [<changelog>]" >&2; exit 2; }
version="${1#v}"
changelog="${2:-$(dirname "${BASH_SOURCE[0]}")/../CHANGELOG.md}"

awk -v heading="## [${version}]" '
  index($0, "## ") == 1 { if (found) exit; if ($0 == heading || index($0, heading " ") == 1) { found = 1; next } }
  found { lines[++n] = $0 }
  END {
    if (!found) exit 1
    first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
    last = n; while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
    for (i = first; i <= last; i++) print lines[i]
  }
' "${changelog}" || { echo "error: no section [${version}] in ${changelog}" >&2; exit 1; }
