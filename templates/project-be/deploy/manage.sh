#!/usr/bin/env bash
# Operate the prod deployment: deploy/manage.sh status|logs|restart|remove
# Needs the same environment as deploy/deploy.sh prod. Rollback is deploy/rollback.sh prod.
#
# remove deletes the app, the accessories and their data volumes, so it only runs with
# BACKUP_GATE=passed, which the Kamal Manage workflow sets after the prod DB backup gate. From a
# console, take and check a backup of the prod database first.
# dev is never managed with this script: its kamal-proxy is shared with another deployment.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source deploy/_common.sh

ACTION="${1:-}"
case "$ACTION" in
  status|logs|restart) ;;
  remove)
    if [[ "${BACKUP_GATE:-}" != 'passed' ]]; then
      echo 'error: remove needs BACKUP_GATE=passed (a checked backup of the prod database); nothing was removed' >&2
      exit 1
    fi
    ;;
  *)
    echo "error: unknown action '${ACTION}' (supported: status, logs, restart, remove)" >&2
    exit 2
    ;;
esac

select_destination prod
load_project_env
resolve_registry
require_secrets

case "$ACTION" in
  status)
    kamal details
    kamal app version
    ;;
  logs) kamal app logs --lines 200 ;;
  restart) kamal app boot ;;
  remove) kamal remove -y ;;
esac
