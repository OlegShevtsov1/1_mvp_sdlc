#!/usr/bin/env bash
# Checks that a release tag may go to prod (annotated, published, on main; resolve_release_tag in
# deploy/_common.sh) and prints version=sha-<40 hex>, ready for GITHUB_OUTPUT.
# Usage: deploy/release_tag_check.sh vX.Y.Z   (in a clone whose origin is the repository)
# Exit 0: the tag qualifies. 1: it does not (the reason is on stderr). 2: not vX.Y.Z.
set -euo pipefail

# shellcheck source=deploy/_common.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

[[ $# -eq 1 ]] || { echo "usage: $0 vX.Y.Z" >&2; exit 2; }
version="$(resolve_release_tag "$1")"
echo "version=${version}"
