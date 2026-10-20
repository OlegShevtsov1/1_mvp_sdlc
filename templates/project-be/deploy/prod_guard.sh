#!/usr/bin/env bash
# Dual control for the prod workflows, before anything touches prod.
# Usage: deploy/prod_guard.sh deploy|manage
# Env: REF (github.ref), CONFIRM, and ENVIRONMENT + VERSION (deploy) or ACTION + VERSION (manage).
# deploy: VERSION must be a release tag vX.Y.Z, never a sha (R-C9); prints tag=<tag>, and
# deploy/release_tag_check.sh then checks that the tag is annotated and on main.
# manage: prints version=sha-<40 hex> (or version= without one), the rollback target on the host.
# Output is ready for GITHUB_OUTPUT.
set -euo pipefail

fail() {
  echo "::error::$1" >&2
  exit 1
}

# A rollback version is a 40-hex git sha, with or without the sha- prefix.
normalize_version() {
  local sha="${1#sha-}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'version must be a 40-hex git sha (optionally sha-<sha>)'
  echo "sha-${sha}"
}

MODE="${1:-}"
[[ "${REF:-}" == 'refs/heads/main' ]] || fail "prod runs only from main (got ${REF:-no ref})"

case "$MODE" in
  deploy)
    [[ "${ENVIRONMENT:-}" == 'prod' ]] || fail "environment must be 'prod'"
    [[ "${CONFIRM:-}" == 'prod' ]] || fail "confirm must be exactly 'prod'"
    [[ ! "${VERSION:-}" =~ ^(sha-)?[0-9a-f]{40}$ ]] ||
      fail 'a bare sha is refused: prod deploys only a release tag vX.Y.Z (annotated, on main)'
    [[ "${VERSION:-}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
      fail "version must be a release tag vX.Y.Z (got '${VERSION:-}')"
    echo "tag=${VERSION}"
    ;;
  manage)
    case "${ACTION:-}" in
      status|logs) ;;
      restart) [[ "${CONFIRM:-}" == 'prod' ]] || fail 'restart needs confirm=prod' ;;
      rollback) [[ "${CONFIRM:-}" == 'ROLLBACK-prod' ]] || fail 'rollback needs confirm=ROLLBACK-prod' ;;
      remove) [[ "${CONFIRM:-}" == 'remove-prod' ]] || fail 'remove needs confirm=remove-prod' ;;
      *) fail 'unknown action (supported: status, logs, restart, rollback, remove)' ;;
    esac
    version=''
    [[ -z "${VERSION:-}" ]] || version="$(normalize_version "$VERSION")"
    echo "version=${version}"
    ;;
  *)
    echo 'usage: deploy/prod_guard.sh deploy|manage' >&2
    exit 2
    ;;
esac
