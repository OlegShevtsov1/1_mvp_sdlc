#!/usr/bin/env bash
# Roll a deployment back to an earlier version that is still on its host.
# Usage: deploy/rollback.sh dev|prod [sha-<40 hex>]   (defaults to the newest version before the current one)
# prod needs the typed confirm ROLLBACK-prod: env CONFIRM, or typed at the prompt in a terminal.
# Needs the same environment as deploy/deploy.sh: Kamal re-renders the env files on boot. On prod
# the ECR tags follow: prod-current becomes the rolled-back image, prod-previous the one replaced.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source deploy/_common.sh

select_destination "${1:-}"
if [[ "$DESTINATION" == 'prod' && "${CONFIRM:-}" != 'ROLLBACK-prod' ]]; then
  if [[ -t 0 ]]; then
    read -r -p 'Type ROLLBACK-prod to roll prod back: ' CONFIRM
  fi
  if [[ "${CONFIRM:-}" != 'ROLLBACK-prod' ]]; then
    echo 'error: a prod rollback needs the typed confirm ROLLBACK-prod (env CONFIRM or the prompt); nothing was touched' >&2
    exit 1
  fi
fi
load_project_env
resolve_registry
require_secrets

SERVICE="$(service_name)"
VERSION="${2:-}"

if [[ -z "$VERSION" ]]; then
  # Without the running version every container is a candidate, and the "rollback" could pick
  # the very release it is meant to replace.
  if ! current="$(kamal app version -q | tr -d '[:space:]')" || [[ -z "$current" ]]; then
    echo 'error: could not determine the running version.' >&2
    echo "       inspect 'bundle exec kamal app containers -c $CONFIG' and pass one explicitly." >&2
    exit 1
  fi
  # docker ps lists newest first; take the first container version that is not the running one.
  # Kamal renames a superseded container to <name>_replaced_<hash>; that suffix is not part of
  # the version, so strip it rather than rolling back to a tag that was never built.
  VERSION="$(kamal app containers -q 2>/dev/null \
    | grep -oE "${SERVICE}-web-[A-Za-z0-9_.-]+" \
    | sed -e "s/^${SERVICE}-web-//" -e 's/_replaced_.*$//' \
    | awk '!seen[$0]++' \
    | grep -vx "$current" \
    | head -1 || true)"
  VERSION="${VERSION#"$KAMAL_VERSION_PREFIX"}"
fi

if [[ -z "$VERSION" ]]; then
  echo 'error: could not determine a previous version.' >&2
  echo "       inspect 'bundle exec kamal app containers -c $CONFIG' and pass one explicitly." >&2
  exit 1
fi
require_version "$VERSION"

echo "==> Rolling back to $(kamal_version "$VERSION")"
kamal rollback "$(kamal_version "$VERSION")"
wait_release "$VERSION" "$HEALTH_TIMEOUT"

if [[ "$DESTINATION" == 'prod' ]]; then
  crane_login
  rotate_prod_tags "$(kamal_version "$VERSION")"
fi
