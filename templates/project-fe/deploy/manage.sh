#!/usr/bin/env bash
# Operates the prod deployment: deploy/manage.sh status|logs|restart|remove
# Needs the same environment as deploy/deploy.sh prod. Rollback is deploy/rollback.sh prod.
# kamal-proxy on the prod host also routes the backend, so nothing here touches the proxy:
# remove deletes only this app's containers, images and route.
# dev is never managed with this script: its host and kamal-proxy are shared with other projects.
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

action=${1:-}
case $action in
  status | logs | restart | remove) ;;
  *)
    echo "ERROR: unknown action '$action' (supported: status, logs, restart, remove)" >&2
    exit 2
    ;;
esac

select_destination prod
load_project_env
require_vars PROD_VPN_IP SENTRY_DSN
ecr_env

case $action in
  status)
    "$KAMAL" details -d prod
    "$KAMAL" app version -d prod
    ;;
  logs) "$KAMAL" app logs -d prod --lines 200 ;;
  restart)
    # Without --version Kamal boots the newest image on the host, which after a rollback is not the live one.
    running=$("$KAMAL" app version -d prod -q | tr -d '[:space:]')
    [[ $running =~ ^prod-sha-[0-9a-f]{40}$ ]] || die "could not read the running prod version"
    "$KAMAL" app boot -d prod --version "$running"
    wait_ready "$(destination_url prod)" "$running" prod
    ;;
  remove) "$KAMAL" app remove -d prod ;;
esac
