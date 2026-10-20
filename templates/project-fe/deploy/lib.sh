# shellcheck shell=bash
# Shared by the deploy scripts. They print variable names, never their values.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

KAMAL=${KAMAL:-kamal}
ECR_REGION=us-east-1

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# Sets HOST_VAR (the variable holding the Kamal host), VERSION_PREFIX and DEFAULT_WAIT_SECONDS.
# shellcheck disable=SC2034 # HOST_VAR is read by the scripts that source this file
select_destination() {
  case ${1:-} in
    dev) HOST_VAR=DEV_HOST VERSION_PREFIX='' DEFAULT_WAIT_SECONDS=300 ;;
    # Kamal only runs an image labelled with its service, and Dev Deploy labels sha-<sha> for the
    # dev service, so prod runs prod-sha-<sha>: the same image re-labelled (promote_prod_image).
    prod) HOST_VAR=PROD_VPN_IP VERSION_PREFIX=prod- DEFAULT_WAIT_SECONDS=600 ;;
    *) die "unknown destination '${1:-}' (expected: dev or prod)" ;;
  esac
}

require_version() {
  [[ $1 =~ ^sha-[0-9a-f]{40}$ ]] || die "version must be sha-<40-hex git sha>"
}

# The image tag and the Kamal version deployed to the selected destination.
kamal_version() {
  echo "$VERSION_PREFIX$1"
}

load_project_env() {
  PROJECT_NAME=$(sed -n 's/^PROJECT_NAME=//p' config/project.env)
  PROJECT_ZONE=$(sed -n 's/^PROJECT_ZONE=//p' config/project.env)
  [[ $PROJECT_NAME =~ ^[a-z][a-z0-9-]*$ ]] || die "config/project.env: invalid PROJECT_NAME"
  [[ $PROJECT_ZONE =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "config/project.env: invalid PROJECT_ZONE"
}

# Must agree with proxy.host in config/deploy.<destination>.yml (tests/kamal-config.test.ts).
destination_url() {
  case $1 in
    dev) echo "https://app.dev.$PROJECT_ZONE" ;;
    prod) echo "https://app.$PROJECT_ZONE" ;;
  esac
}

require_vars() {
  local name missing=()
  for name in "$@"; do
    [ -n "${!name:-}" ] || missing+=("$name")
  done
  [ ${#missing[@]} -eq 0 ] || die "missing required environment variables: ${missing[*]}"
}

require_commands() {
  local name missing=()
  for name in "$@"; do
    command -v "$name" >/dev/null || missing+=("$name")
  done
  [ ${#missing[@]} -eq 0 ] || die "missing required commands: ${missing[*]}"
}

# Hides a value from GitHub Actions logs; outside Actions nothing is printed at all.
mask() {
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::add-mask::$1"
  fi
}

# Kamal reads both from the environment (config/deploy.yml, .kamal/secrets-common).
ecr_env() {
  if [ -z "${ECR_REGISTRY:-}" ]; then
    local account
    account=$(aws sts get-caller-identity --query Account --output text)
    mask "$account"
    ECR_REGISTRY="$account.dkr.ecr.$ECR_REGION.amazonaws.com"
  fi
  if [ -z "${KAMAL_REGISTRY_PASSWORD:-}" ]; then
    KAMAL_REGISTRY_PASSWORD=$(aws ecr get-login-password --region "$ECR_REGION")
    mask "$KAMAL_REGISTRY_PASSWORD"
  fi
  export ECR_REGISTRY KAMAL_REGISTRY_PASSWORD
}

# Ready means healthy AND serving the expected version and environment in /config.js,
# which also catches a Kamal run that exits 0 without switching versions.
wait_ready() {
  local base_url=$1 version=$2 env_name=$3
  local wait=${DEPLOY_WAIT_SECONDS:-$DEFAULT_WAIT_SECONDS} poll=${DEPLOY_POLL_SECONDS:-5}
  local deadline=$((SECONDS + wait)) config
  while :; do
    if curl -fsS --max-time 10 -o /dev/null "$base_url/health" 2>/dev/null &&
      config=$(curl -fsS --max-time 10 "$base_url/config.js" 2>/dev/null) &&
      grep -qF "APP_VERSION: \"$version\"" <<<"$config" &&
      grep -qF "ENV_NAME: \"$env_name\"" <<<"$config"; then
      echo "ready: $version"
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || die "$base_url not ready after ${wait}s (expected $version)"
    sleep "$poll"
  done
}

# --- prod images in ECR (crane) ---------------------------------------------------------------
# The registry host contains the AWS account: messages name images as <image>:<tag> only, and
# crane's own messages, which print full references, are discarded.

image_name() {
  echo "$PROJECT_NAME-front"
}

registry_ref() {
  echo "$ECR_REGISTRY/$(image_name):$1"
}

# Prints the digest of a tag; fails quietly when the tag does not exist.
image_digest() {
  crane digest "$(registry_ref "$1")" 2>/dev/null
}

image_manifest() {
  crane manifest "$(registry_ref "$1")" 2>/dev/null
}

image_config() {
  crane config "$(registry_ref "$1")" 2>/dev/null
}

crane_login() {
  require_commands crane jq
  crane auth login "$ECR_REGISTRY" -u AWS --password-stdin <<<"$KAMAL_REGISTRY_PASSWORD" >/dev/null 2>&1 ||
    die "crane could not log in to ECR"
}

# Only Dev Deploy builds sha-<sha>, so its absence means the commit never reached dev.
require_dev_image() {
  image_digest "$1" || die "$(image_name):$1 is not in ECR (build and deploy it with Dev Deploy first)"
}

# Build once: the prod image must have the dev image's layers and the same config apart from the
# service label, so nothing rebuilt or altered reaches prod under a promoted tag.
verify_promotion() {
  local src=$1 dst=$2 layers config
  layers='[.layers[].digest]'
  # crane re-serialises the config and drops null fields (e.g. "OnBuild": null), so nulls do not count.
  config='{rootfs, config: (.config | del(.Labels.service) | with_entries(select(.value != null)))}'
  if [ "$(image_manifest "$src" | jq -c "$layers")" != "$(image_manifest "$dst" | jq -c "$layers")" ] ||
    [ "$(image_config "$src" | jq -cS "$config")" != "$(image_config "$dst" | jq -cS "$config")" ]; then
    die "$(image_name):$dst and $(image_name):$src layers differ (or their configs differ beyond the service label)"
  fi
  [ "$(image_config "$dst" | jq -r '.config.Labels.service')" = "$PROJECT_NAME-fe" ] ||
    die "$(image_name):$dst is not labelled service=$PROJECT_NAME-fe"
}

# Makes prod-sha-<sha> from sha-<sha> without building; an existing, verified one is reused.
promote_prod_image() {
  local src=$1 dst src_digest dst_digest
  dst=$(kamal_version "$src")
  src_digest=$(require_dev_image "$src")
  if dst_digest=$(image_digest "$dst"); then
    echo "$(image_name):$dst exists, verifying it"
  else
    echo "Promoting $(image_name):$src to $(image_name):$dst (label service=$PROJECT_NAME-fe, no build)"
    crane mutate "$(registry_ref "$src")" --label "service=$PROJECT_NAME-fe" -t "$(registry_ref "$dst")" >/dev/null 2>&1 ||
      die "could not create $(image_name):$dst"
    dst_digest=$(image_digest "$dst")
  fi
  verify_promotion "$src" "$dst"
  echo "$src $src_digest -> $dst $dst_digest: layers identical ($(image_manifest "$dst" | jq '.layers | length') layers)"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo '| dev tag | digest | prod tag | digest |'
      echo '| --- | --- | --- | --- |'
      echo "| $src | $src_digest | $dst | $dst_digest |"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

# After a ready deploy or rollback: prod-current is the live image, prod-previous the one before it.
rotate_prod_tags() {
  local live current
  live=$(image_digest "$1") || die "$(image_name):$1 is not in ECR, the ECR tags were not moved"
  current=$(prod_current_digest)
  if [ "$current" = "$live" ]; then
    echo "$(image_name):prod-current is already $live"
    return 0
  fi
  if [ -n "$current" ]; then
    move_tag prod-previous "$current"
  fi
  move_tag prod-current "$live"
}

# Prints nothing before the first prod deploy. Any other failure to read the tag stops the rotation:
# forgiving it would skip prod-previous and still report success.
prod_current_digest() {
  local errors digest
  errors=$(mktemp)
  if digest=$(crane digest "$(registry_ref prod-current)" 2>"$errors"); then
    rm -f "$errors"
    echo "$digest"
    return 0
  fi
  if grep -q MANIFEST_UNKNOWN "$errors"; then
    rm -f "$errors"
    return 0
  fi
  rm -f "$errors"
  die "could not read $(image_name):prod-current, the ECR tags were not moved"
}

# Prints the git sha of the prod-sha-<sha> image that prod-previous points at.
resolve_prod_previous() {
  local previous tag
  previous=$(image_digest prod-previous) || die "there is no prod-previous yet (it appears after the second prod release)"
  while read -r tag; do
    if [ "$(image_digest "$tag")" = "$previous" ]; then
      echo "${tag#prod-sha-}"
      return 0
    fi
  done < <(crane ls "$ECR_REGISTRY/$(image_name)" 2>/dev/null | grep -E '^prod-sha-[0-9a-f]{40}$')
  die "no prod-sha-<sha> tag of $(image_name) has the digest of prod-previous"
}

# A prod rollback needs the typed confirmation: ROLLBACK_CONFIRM, or a prompt on a terminal.
confirm_prod_rollback() {
  local answer=${ROLLBACK_CONFIRM:-}
  if [ -z "$answer" ] && [ -t 0 ]; then
    read -r -p "Type ROLLBACK-prod to roll prod back to $1: " answer
  fi
  [ "$answer" = ROLLBACK-prod ] || die "a prod rollback needs the typed confirmation ROLLBACK-prod; nothing was changed"
}

move_tag() {
  local tag=$1 digest=$2
  crane tag "$ECR_REGISTRY/$(image_name)@$digest" "$tag" >/dev/null 2>&1 ||
    die "could not point $(image_name):$tag at $digest"
  echo "$(image_name):$tag -> $digest"
}
