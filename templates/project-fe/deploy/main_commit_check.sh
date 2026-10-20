#!/usr/bin/env bash
# Fails unless VERSION (sha-<40 hex>) is a commit in main's history, so an image built from a
# throwaway branch cannot reach prod from CI.
# Env: GH_REPO (owner/name), VERSION; needs gh with a token that can read the repository.
set -euo pipefail

: "${GH_REPO:?}" "${VERSION:?}"

status=$(gh api "repos/$GH_REPO/compare/${VERSION#sha-}...main" --jq .status 2>/dev/null || true)
case $status in
  ahead | identical) echo "$VERSION is a commit on main" ;;
  *)
    echo "::error::$VERSION is not a commit on main (compare status: ${status:-unknown commit})"
    exit 1
    ;;
esac
