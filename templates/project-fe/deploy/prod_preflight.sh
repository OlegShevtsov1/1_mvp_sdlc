#!/usr/bin/env bash
# First step with the "prod" environment's secrets in Kamal Deploy and Kamal Manage: fails fast,
# naming (never printing) whatever is missing.
# Usage: deploy/prod_preflight.sh [EXTRA_REQUIRED_VAR...]
set -euo pipefail

required=(AWS_ROLE_ARN VPN_CI_OVPN PROD_SSH_KEY PROD_VPN_IP SENTRY_DSN "$@")
missing=()
for name in "${required[@]}"; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Kamal prod guard: missing ${missing[*]}. Repo secrets: AWS_ROLE_ARN, VPN_CI_OVPN. Environment \"prod\" secrets: PROD_SSH_KEY, PROD_VPN_IP, SENTRY_DSN, TELEGRAM_*_PROD_ALERTS_*; Kamal Deploy also BE_REPO_READ_TOKEN, GLITCHTIP_API_URL, GLITCHTIP_API_TOKEN."
  exit 1
fi
echo "all required secrets are set: ${required[*]}"
