#!/usr/bin/env bash
# Deploy an image that is already in ECR with Kamal 2.
# Usage: deploy/deploy.sh dev [sha-<40 hex>]   (the version defaults to sha-<HEAD>)
#        deploy/deploy.sh prod vX.Y.Z           (a release tag: annotated, published, on main)
#
# dev needs DEV_HOST, prod needs PROD_VPN_IP; both need the variables referenced in the
# destination's .kamal/secrets.<dest>, an SSH agent holding a key accepted by the host, and AWS
# credentials able to pull from ECR (or KAMAL_REGISTRY_SERVER and KAMAL_REGISTRY_PASSWORD). The
# image is built by the Dev Deploy workflow, never here; prod also needs crane and jq to promote
# it (deploy/promote.sh) and to move the ECR tags prod-current/prod-previous.
#
# The deploy is only complete once /health reports the new release and bin/swagger_smoke
# passes (read-only on prod); set SKIP_SMOKE=1 to deploy without the smoke gate in an emergency.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source deploy/_common.sh

select_destination "${1:-}"
if [[ "$DESTINATION" == 'prod' ]]; then
  VERSION="$(resolve_release_tag "${2:-}")"
else
  VERSION="${2:-sha-$(git rev-parse HEAD)}"
  require_version "$VERSION"
fi
load_project_env
resolve_registry
require_secrets

SERVICE="$(service_name)"

if [[ "$DESTINATION" == 'prod' ]]; then
  crane_login
  promote_prod_image "$VERSION"
fi

# A failed query is not "nothing deployed": kamal setup must never run over a live deployment.
if ! containers="$(kamal app containers -q)"; then
  echo "error: could not list the containers on the host; deploy or set up was not attempted." >&2
  exit 1
fi

if grep -q "${SERVICE}-web-" <<< "$containers"; then
  echo "==> Existing deployment found, deploying $(kamal_version "$VERSION")"
  kamal deploy --skip-push --version "$(kamal_version "$VERSION")"
else
  echo "==> No deployment found, setting up $(kamal_version "$VERSION")"
  kamal setup --skip-push --version "$(kamal_version "$VERSION")"
fi

wait_release "$VERSION" "$HEALTH_TIMEOUT"

# Any value other than the literal 1 still runs the check: a typo must cost a slower deploy,
# not an unverified one.
if [[ "${SKIP_SMOKE:-}" == '1' ]]; then
  echo '==> SKIP_SMOKE=1: skipping the swagger smoke test'
else
  echo "==> Running swagger smoke test against $(base_url)"
  if run_smoke; then
    echo '==> Smoke test passed'
  else
    echo "error: swagger smoke test failed against $(base_url) (see the FAIL lines above)" >&2
    exit 1
  fi
fi

if [[ "$DESTINATION" == 'prod' ]]; then
  rotate_prod_tags "$(kamal_version "$VERSION")"
fi
