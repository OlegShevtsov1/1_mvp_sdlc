#!/usr/bin/env bash
# Promote the dev-built image sha-<sha> to prod-sha-<sha> in ECR: the same layers, re-labelled for
# the prod service, verified, never built. deploy/deploy.sh prod runs this itself.
# Usage: PROD_VPN_IP=<prod VPN address> deploy/promote.sh sha-<40 hex>
# Needs crane, jq and AWS credentials able to read and push ECR (or KAMAL_REGISTRY_SERVER and
# KAMAL_REGISTRY_PASSWORD).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source deploy/_common.sh

select_destination prod
require_version "${1:-}"
load_project_env
resolve_registry
crane_login
promote_prod_image "$1"
