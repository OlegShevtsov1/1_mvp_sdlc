#!/usr/bin/env bash
# First step of Dev Deploy: fails fast, naming (never printing) whatever is missing,
# then publishes the deploy parameters as step outputs.
# Usage: deploy/preflight.sh dev [EXTRA_REQUIRED_VAR...]
# Reads DEPLOY_SHA (the commit to deploy) and optional ROLLBACK_TO (a full git sha).
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "${1:-}" = dev ] || die "deploy/preflight.sh is Dev Deploy's guard (prod: deploy/prod_guard.sh and deploy/prod_preflight.sh)"
shift

# An automatic (workflow_run) run always reports the default branch main as its ref; its branches:
# filter already limits it to develop and hotfix/*. A dispatch reports the ref it was dispatched from.
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  case "${GITHUB_REF:-}" in
    refs/heads/main | refs/heads/develop | refs/heads/hotfix/?*) ;;
    *)
      echo "::error::Dev Deploy guard: only main, develop and hotfix/* deploy to dev (got ${GITHUB_REF:-none})"
      exit 1
      ;;
  esac
fi

missing=()
for name in AWS_ROLE_ARN VPN_CI_OVPN SRV_DEPLOY_SSH_KEY SENTRY_DSN "$@"; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Dev Deploy guard: missing ${missing[*]}. Repo secrets: AWS_ROLE_ARN, VPN_CI_OVPN, SRV_DEPLOY_SSH_KEY (I4a post-merge). Environment \"dev\" secrets: SENTRY_DSN, TELEGRAM_*_DEV_ALERTS_*."
  exit 1
fi

[[ ${DEPLOY_SHA:-} =~ ^[0-9a-f]{40}$ ]] || die "DEPLOY_SHA must be a full 40-hex git sha"
rollback_to=${ROLLBACK_TO:-}
[[ -z $rollback_to || $rollback_to =~ ^[0-9a-f]{40}$ ]] || die "ROLLBACK_TO must be empty or a full 40-hex git sha"
require_vars GITHUB_OUTPUT
load_project_env

if [ -n "$rollback_to" ]; then
  mode=rollback version="sha-$rollback_to"
else
  mode=deploy version="sha-$DEPLOY_SHA"
fi

{
  echo "project=$PROJECT_NAME"
  echo "url=$(destination_url dev)"
  echo "image=$PROJECT_NAME-front"
  echo "cache_image=$PROJECT_NAME-front-build-cache"
  echo "service=$PROJECT_NAME-fe-dev"
  echo "mode=$mode"
  echo "version=$version"
  echo "sha=$DEPLOY_SHA"
} >>"$GITHUB_OUTPUT"
