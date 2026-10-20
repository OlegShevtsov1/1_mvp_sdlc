# shellcheck shell=bash
# Shared by the deploy/*.sh scripts; sourced from the repository root.
#
# Both hosts are only reachable through the mvp VPN. dev: DEV_HOST is the vpn-up output dev-host
# in CI, or the dev host's VPN address in an operator's shell; the public dev URL is not used, so
# every HTTP check goes straight to the shared kamal-proxy with the dev Host header. prod:
# PROD_VPN_IP (a secret, never committed) is the SSH target; HTTP checks use the public HTTPS URL,
# the path users take.

PROXY_HTTP_PORT=8091

kamal() {
  bundle exec kamal "$@" -c "$CONFIG"
}

# select_destination dev|prod: sets DESTINATION, CONFIG, SECRETS_FILE, HEALTH_TIMEOUT and
# KAMAL_VERSION_PREFIX, and requires the destination's host.
# shellcheck disable=SC2034 # HEALTH_TIMEOUT is read by the scripts that source this file
select_destination() {
  DESTINATION="$1"
  case "$DESTINATION" in
    dev)
      CONFIG='config/deploy.dev.yml'
      SECRETS_FILE='.kamal/secrets.dev'
      HEALTH_TIMEOUT=180
      KAMAL_VERSION_PREFIX=''
      require_dev_host
      ;;
    prod)
      CONFIG='config/deploy.yml'
      SECRETS_FILE='.kamal/secrets.prod'
      HEALTH_TIMEOUT=600
      # The prod image is sha-<sha> re-labelled for the prod service (promote_prod_image).
      KAMAL_VERSION_PREFIX='prod-'
      require_prod_host
      ;;
    *)
      echo "error: unknown destination '$1' (supported: dev, prod)" >&2
      exit 2
      ;;
  esac
}

require_dev_host() {
  if [[ -z "${DEV_HOST:-}" ]]; then
    echo "error: DEV_HOST is not set (CI: vpn-up output dev-host; console: the dev host's VPN address)" >&2
    exit 2
  fi
}

require_prod_host() {
  if [[ -z "${PROD_VPN_IP:-}" ]]; then
    echo "error: PROD_VPN_IP is not set (CI: secret PROD_VPN_IP; console: the prod host's VPN address)" >&2
    exit 2
  fi
}

require_version() {
  if [[ ! "$1" =~ ^sha-[0-9a-f]{40}$ ]]; then
    echo "error: version '$1' is not sha-<40 hex git sha>" >&2
    exit 2
  fi
}

load_project_env() {
  set -a
  # shellcheck source=/dev/null
  . config/project.env
  set +a
}

service_name() {
  if [[ "$DESTINATION" == 'prod' ]]; then
    echo "${PROJECT_NAME}"
  else
    echo "${PROJECT_NAME}-dev"
  fi
}

# kamal_version sha-<sha>: the image tag and Kamal version deployed to the destination.
kamal_version() {
  echo "${KAMAL_VERSION_PREFIX}$1"
}

# Hides a value from GitHub Actions logs; outside Actions nothing is printed at all.
mask() {
  if [[ "${GITHUB_ACTIONS:-}" == 'true' ]]; then
    echo "::add-mask::$1"
  fi
}

# ECR in the caller's AWS account. The account id is never committed and never printed unmasked.
resolve_registry() {
  local account
  if [[ -z "${KAMAL_REGISTRY_SERVER:-}" ]]; then
    account="$(aws sts get-caller-identity --query Account --output text)"
    mask "$account"
    export KAMAL_REGISTRY_SERVER="${account}.dkr.ecr.${AWS_REGION:-us-east-1}.amazonaws.com"
  fi
  if [[ -z "${KAMAL_REGISTRY_PASSWORD:-}" ]]; then
    KAMAL_REGISTRY_PASSWORD="$(aws ecr get-login-password --region "${AWS_REGION:-us-east-1}")"
    mask "$KAMAL_REGISTRY_PASSWORD"
    export KAMAL_REGISTRY_PASSWORD
  fi
}

# secret_names <secrets file>: the environment variables it reads, one per line.
secret_names() {
  # shellcheck disable=SC2016 # the literal ${VAR} references are what is searched for
  grep -v '^[[:space:]]*#' "$1" \
    | grep -o '\${[A-Z_][A-Z0-9_]*}' \
    | tr -d '${}' \
    | sort -u || true
}

# Every ${VAR} in the secrets file must be set: Kamal renders an unset one as an empty string, so
# the deploy would run with a blank secret and only break once the app boots.
require_secrets() {
  local vars var
  vars="$(secret_names "$SECRETS_FILE")"

  if [[ -z "$vars" ]]; then
    echo "error: $SECRETS_FILE references no environment variables" >&2
    exit 1
  fi

  for var in $vars; do
    if [[ -z "${!var:-}" ]]; then
      echo "error: $var is not set in the environment" >&2
      exit 1
    fi
  done

  # POSTGRES_PASSWORD is interpolated into DATABASE_URL in the secrets file.
  if [[ "${POSTGRES_PASSWORD}" =~ [^A-Za-z0-9._~-] ]]; then
    echo 'error: POSTGRES_PASSWORD must be URL-safe (A-Z a-z 0-9 . _ ~ -)' >&2
    exit 1
  fi
}

base_url() {
  if [[ "$DESTINATION" == 'prod' ]]; then
    echo "https://${PROJECT_ZONE}"
  else
    echo "http://dev.${PROJECT_ZONE}"
  fi
}

dev_connect_to() {
  echo "dev.${PROJECT_ZONE}:80:${DEV_HOST}:${PROXY_HTTP_PORT}"
}

# dev: curl against the shared proxy as if through the public TLS terminator.
app_curl() {
  if [[ "$DESTINATION" == 'prod' ]]; then
    curl "$@"
  else
    curl --connect-to "$(dev_connect_to)" -H 'X-Forwarded-Proto: https' "$@"
  fi
}

# Prod has real data, so its smoke only reads: the full smoke may create records it cannot delete.
run_smoke() {
  if [[ "$DESTINATION" == 'prod' ]]; then
    SMOKE_READ_ONLY=1 bin/swagger_smoke "$(base_url)"
  else
    SMOKE_CONNECT_TO="$(dev_connect_to)" SMOKE_FORWARDED_PROTO=https bin/swagger_smoke "$(base_url)"
  fi
}

# wait_release <sha-version> <timeout seconds>: the old release (and on dev the other deployment
# on the shared proxy) also answers {"status":"ok"}, so only the expected release counts.
wait_release() {
  local version="$1" timeout="$2" url body deadline
  url="$(base_url)/health"
  echo "==> Waiting up to ${timeout}s for ${url} to report release ${version#sha-}"
  deadline=$(( SECONDS + timeout ))
  while (( SECONDS < deadline )); do
    body="$(app_curl -fsS --max-time 5 "$url" 2>/dev/null || true)"
    if [[ "$body" == *'"status":"ok"'* && "$body" == *"\"release\":\"${version#sha-}\""* ]]; then
      echo "==> Healthy: $body"
      return 0
    fi
    sleep 3
  done
  echo "error: ${url} did not report release ${version#sha-} within ${timeout}s (last answer: ${body:-none})" >&2
  return 1
}

# --- ECR images (crane) -------------------------------------------------------------------------
# The registry host contains the account id: messages name images as <name>:<tag> only, and
# crane's own messages, which print full references, are discarded.

registry_ref() {
  echo "${KAMAL_REGISTRY_SERVER}/${PROJECT_NAME}:$1"
}

image_manifest() {
  crane manifest "$(registry_ref "$1")" 2> /dev/null
}

image_config() {
  crane config "$(registry_ref "$1")" 2> /dev/null
}

crane_login() {
  crane auth login "${KAMAL_REGISTRY_SERVER}" -u AWS --password-stdin <<< "${KAMAL_REGISTRY_PASSWORD}" > /dev/null
}

# image_digest <tag>: prints the digest, fails quietly when the tag does not exist.
image_digest() {
  crane digest "$(registry_ref "$1")" 2> /dev/null
}

# require_dev_image sha-<sha>: only Dev Deploy builds sha-<sha>, so its absence means the commit
# was never built (and so never deployed to dev).
require_dev_image() {
  if ! image_digest "$1"; then
    echo "error: ${PROJECT_NAME}:$1 is not in ECR (build it with Dev Deploy first)" >&2
    return 1
  fi
}

# Kamal only runs an image whose service label matches its service, and Dev Deploy labels
# sha-<sha> for the dev service. The prod image is therefore prod-sha-<sha>: the same layers and
# the same config apart from that one label. Build once: verify_promotion fails on any other
# difference, so nothing rebuilt or altered can reach prod under a promoted tag.
verify_promotion() {
  local src="$1" dst="$2" layers config
  layers='[.layers[].digest]'
  # crane re-serialises the config and drops null fields (e.g. "OnBuild": null), so nulls do not count.
  config='{rootfs, config: (.config | del(.Labels.service) | with_entries(select(.value != null)))}'
  if [[ "$(image_manifest "$src" | jq -c "$layers")" != "$(image_manifest "$dst" | jq -c "$layers")" ]] ||
     [[ "$(image_config "$src" | jq -cS "$config")" != "$(image_config "$dst" | jq -cS "$config")" ]]; then
    echo "error: ${PROJECT_NAME}:${dst} and ${PROJECT_NAME}:${src} layers differ (or their configs differ beyond the service label)" >&2
    return 1
  fi
  if [[ "$(image_config "$dst" | jq -r '.config.Labels.service')" != "${PROJECT_NAME}" ]]; then
    echo "error: ${PROJECT_NAME}:${dst} is not labelled service=${PROJECT_NAME}" >&2
    return 1
  fi
}

# promote_prod_image sha-<sha>: makes prod-sha-<sha> from sha-<sha> without building; an existing,
# verified prod-sha-<sha> is reused.
promote_prod_image() {
  local src="$1" dst src_digest dst_digest
  dst="$(kamal_version "$src")"
  src_digest="$(require_dev_image "$src")" || exit 1
  if dst_digest="$(image_digest "$dst")"; then
    echo "==> ${PROJECT_NAME}:${dst} exists, verifying it"
  else
    echo "==> Promoting ${PROJECT_NAME}:${src} to ${PROJECT_NAME}:${dst} (label service=${PROJECT_NAME}, no build)"
    if ! crane mutate "$(registry_ref "$src")" --label "service=${PROJECT_NAME}" -t "$(registry_ref "$dst")" > /dev/null 2>&1; then
      echo "error: could not create ${PROJECT_NAME}:${dst}" >&2
      exit 1
    fi
    dst_digest="$(image_digest "$dst")"
  fi
  verify_promotion "$src" "$dst" || exit 1
  echo "==> ${src} ${src_digest} -> ${dst} ${dst_digest}: layers identical ($(image_manifest "$dst" | jq '.layers | length') layers)"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo '| dev tag | digest | prod tag | digest |'
      echo '| --- | --- | --- | --- |'
      echo "| ${src} | ${src_digest} | ${dst} | ${dst_digest} |"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
}

# rotate_prod_tags <kamal version>: after a healthy deploy or rollback, prod-current is the image
# that is live and prod-previous the one that was live before it.
rotate_prod_tags() {
  local live current
  if ! live="$(image_digest "$1")"; then
    echo "error: ${PROJECT_NAME}:$1 is not in ECR, the ECR tags were not moved" >&2
    exit 1
  fi
  current="$(image_digest prod-current || true)"
  if [[ "$current" == "$live" ]]; then
    echo "==> prod-current is already ${live}"
    return 0
  fi
  if [[ -n "$current" ]]; then
    move_tag prod-previous "$current"
  fi
  move_tag prod-current "$live"
}

move_tag() {
  local tag="$1" digest="$2"
  if ! crane tag "${KAMAL_REGISTRY_SERVER}/${PROJECT_NAME}@${digest}" "$tag" > /dev/null 2>&1; then
    echo "error: could not point ${PROJECT_NAME}:${tag} at ${digest}" >&2
    exit 1
  fi
  echo "==> ${PROJECT_NAME}:${tag} -> ${digest}"
}

# --- Release tags (R-C9) ------------------------------------------------------------------------
# Prod runs only a release: an annotated tag vX.Y.Z, as published on origin, on a commit in main's
# history. The fetch also replaces a local tag of the same name with the published one.

# resolve_release_tag vX.Y.Z: prints sha-<40 hex> of the tagged commit, or exits 1 (2 for a
# malformed tag) explaining why the tag does not qualify. Acts on the repository in the cwd.
resolve_release_tag() {
  local tag="$1" commit
  if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "error: version '$tag' is not a release tag vX.Y.Z (prod deploys only release tags, never a bare sha)" >&2
    exit 2
  fi
  if ! git fetch --quiet --force --no-tags origin "+refs/tags/${tag}:refs/tags/${tag}" \
       '+refs/heads/main:refs/remotes/origin/main' > /dev/null 2>&1; then
    echo "error: tag ${tag} is not published on origin" >&2
    exit 1
  fi
  if [[ "$(git cat-file -t "refs/tags/${tag}")" != 'tag' ]]; then
    echo "error: ${tag} is a lightweight tag; release tags are annotated (git tag -a)" >&2
    exit 1
  fi
  commit="$(git rev-parse "refs/tags/${tag}^{commit}")"
  if ! git merge-base --is-ancestor "$commit" origin/main; then
    echo "error: ${tag} (${commit}) is not on main" >&2
    exit 1
  fi
  echo "sha-${commit}"
}
