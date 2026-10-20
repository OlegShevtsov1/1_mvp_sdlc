#!/usr/bin/env bash
# Dual control for the prod workflows, checked before any job can read the prod secrets.
# Usage: deploy/prod_guard.sh deploy|manage
# Env: REF (github.ref), CONFIRM, and ENVIRONMENT + VERSION (deploy) or ACTION + VERSION (manage).
# Prints, ready for GITHUB_OUTPUT: deploy: tag=vX.Y.Z (prod deploys only a release tag; the Kamal
# Deploy guard resolves it with deploy/tag_check.sh); manage: version=sha-<40 hex> and sha=<40 hex>,
# or version=prod-previous and an empty sha, or both empty for a run without a version.
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

is_sha() {
  [[ ${1#sha-} =~ ^[0-9a-f]{40}$ ]]
}

mode=${1:-}
[ "${REF:-}" = refs/heads/main ] || fail "prod runs only from main (got ${REF:-no ref})"

case $mode in
  deploy)
    [ "${ENVIRONMENT:-}" = prod ] || fail "environment must be 'prod'"
    [ "${CONFIRM:-}" = prod ] || fail "confirm must be exactly 'prod'"
    if is_sha "${VERSION:-}"; then
      fail 'prod deploys only a release tag vX.Y.Z (got a commit sha): tag the commit on main first'
    fi
    [[ ${VERSION:-} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'version must be a release tag vX.Y.Z'
    echo "tag=$VERSION"
    ;;
  manage)
    case ${ACTION:-} in
      status | logs) ;;
      restart) [ "${CONFIRM:-}" = prod ] || fail 'restart needs confirm=prod' ;;
      rollback)
        [ "${CONFIRM:-}" = ROLLBACK-prod ] || fail 'rollback needs confirm=ROLLBACK-prod'
        [ -n "${VERSION:-}" ] || fail 'rollback needs a version (prod-previous or the git sha to roll back to)'
        ;;
      remove) [ "${CONFIRM:-}" = remove-prod ] || fail 'remove needs confirm=remove-prod' ;;
      *) fail 'unknown action (supported: status, logs, restart, rollback, remove)' ;;
    esac
    version=${VERSION:-} sha=''
    if is_sha "$version"; then
      sha=${version#sha-} version=sha-${version#sha-}
    elif [ -n "$version" ] && [ "$version" != prod-previous ]; then
      fail 'version must be prod-previous or a 40-hex git sha (optionally sha-<sha>)'
    fi
    echo "version=$version"
    echo "sha=$sha"
    ;;
  *)
    echo 'usage: deploy/prod_guard.sh deploy|manage' >&2
    exit 2
    ;;
esac
