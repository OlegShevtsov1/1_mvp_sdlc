#!/usr/bin/env bash
# Promotes the dev-built image sha-<sha> to prod-sha-<sha> in ECR: the same layers, re-labelled
# for the prod service, verified, never built. deploy/deploy.sh prod runs this itself.
# Usage: deploy/promote.sh sha-<40-hex git sha>
# Needs crane, jq and AWS credentials able to read and push ECR (or ECR_REGISTRY + KAMAL_REGISTRY_PASSWORD).
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ $# -eq 1 ] || die "usage: deploy/promote.sh sha-<git sha>"
select_destination prod
require_version "$1"
load_project_env
ecr_env
crane_login
promote_prod_image "$1"
