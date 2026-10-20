#!/usr/bin/env bash
# Fails unless every JS and CSS file of the bundle lives in assets/ with a content hash in its name,
# and index.html loads only such files (plus the runtime /config.js). nginx caches /assets as
# immutable and makes browsers revalidate index.html, so a new release reaches an open tab on a
# normal reload only while every bundle name changes with its content.
# Usage: scripts/check-asset-hashes.sh <dist dir>
# Exit 0: hashed. Exit 1: an unhashed name. Exit 2: bad usage.
set -uo pipefail
dist=${1:-}
[ -d "${dist}" ] || { echo "check-asset-hashes: no such directory '${dist}'" >&2; exit 2; }
[ -f "${dist}/index.html" ] || { echo "check-asset-hashes: ${dist}/index.html not found" >&2; exit 2; }
hashed='^assets/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css)$'
status=0

while read -r file; do
  if ! [[ "${file}" =~ ${hashed} ]]; then
    echo "::error::check-asset-hashes: ${file} has no content hash in its name (or is outside assets/)"
    status=1
  fi
done < <(cd "${dist}" && find . -type f \( -name '*.js' -o -name '*.css' \) | sed 's|^\./||' | sort)

while read -r ref; do
  if [ "${ref}" != /config.js ] && ! [[ "${ref#/}" =~ ${hashed} ]]; then
    echo "::error::check-asset-hashes: index.html loads ${ref}, which is not a hashed file in /assets/"
    status=1
  fi
done < <(grep -oE '(src|href)="[^"]+\.(js|css)"' "${dist}/index.html" | sed -E 's/^[a-z]+="//; s/"$//')

[ "${status}" -ne 0 ] || echo "check-asset-hashes: every bundle file name carries a content hash"
exit "${status}"
