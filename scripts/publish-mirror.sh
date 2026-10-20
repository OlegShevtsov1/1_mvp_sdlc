#!/usr/bin/env bash
# Publishes one primary repo to its public mirror as a single commit without history (scripts/publish-mirror.README.md).
# Usage: publish-mirror.sh <repo> [<ref>] [--dry-run] [--subject <text>]
# Env: MIRROR_AUTHOR_NAME, MIRROR_AUTHOR_EMAIL (mirror author and committer);
#      MIRROR_PRIMARY_URL, MIRROR_TARGET_URL (override the SSH URLs, e.g. with local paths).
# Exit 0: synced (stdout is the mirror commit sha) or nothing to sync. Exit 1: clone, fetch or push failed.
# Exit 2: refused to publish (primary owner left over or the scan for it failed, public-repo check or gitleaks
# failed). Exit 64: usage.
# The primary owner strings are assembled from parts: this repo is mirrored by this script, and plain literals
# would be rewritten in the mirror's copy.
set -euo pipefail

src_owner="oleh""shev1"
src_owner_cap="Oleh""shev1"
src_name="Ole""h Shevtsov"
dst_owner="OlegShevtsov1"
dst_name="Oleg Shevtsov"

usage() {
  echo "usage: publish-mirror.sh <1_mvp_sdlc|1_mvp_pilot_be|1_mvp_pilot_fe> [<ref>] [--dry-run] [--subject <text>]" >&2
  exit 64
}
log() { echo "publish-mirror: $*" >&2; }
die() { local rc=$1; shift; log "$*"; exit "${rc}"; }

repo="" ref="" subject="" dry_run=false
parse_args() {
  [ $# -gt 0 ] || usage
  repo=$1
  shift
  case "${repo}" in
    1_mvp_sdlc) ref=origin/main ;;
    1_mvp_pilot_be | 1_mvp_pilot_fe) ref=origin/develop ;;
    *) usage ;;
  esac
  local ref_given=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=true ;;
      --subject) [ $# -ge 2 ] || usage; subject=$2; shift ;;
      -*) usage ;;
      *) ! "${ref_given}" || usage; ref=$1; ref_given=true ;;
    esac
    shift
  done
}

tmp="" keep_tmp=false
cleanup() { [ -z "${tmp}" ] || "${keep_tmp}" || rm -rf "${tmp}"; }

src_sha="" short_sha="" branch=""
fetch_primary() {
  local url=${MIRROR_PRIMARY_URL:-git@github.${src_owner}:${src_owner}/${repo}.git}
  git clone --quiet --no-checkout "${url}" "${tmp}/primary" || die 1 "cannot clone the primary ${repo}"
  src_sha=$(git -C "${tmp}/primary" rev-parse --verify --quiet "${ref}^{commit}") || die 1 "unknown ref ${ref}"
  short_sha=${src_sha:0:7}
  branch=${ref#origin/}
}

export_tree() {
  mkdir "${tmp}/export"
  git -C "${tmp}/primary" archive "${src_sha}" | tar -x -C "${tmp}/export"
}

drop_unsynced() { rm -f "${tmp}/export/.github/dependabot.yml"; }

replace_owner() {
  (cd "${tmp}/export" &&
    grep -rlIZ -e "${src_owner}" -e "${src_owner_cap}" -e "${src_name}" . |
    xargs -0 -r sed -i -e "s/${src_owner}/${dst_owner}/g" -e "s/${src_owner_cap}/${dst_owner}/g" \
      -e "s/${src_name}/${dst_name}/g")
}

# Fail closed: any case, binaries included, path names included. Only paths are printed, never content.
# grep exits 1 for no match and 2 for a scan error, which must not pass as clean.
refuse_leftovers() {
  local in_content in_names hits rc=0
  in_content=$(cd "${tmp}/export" && grep -rli -e "${src_owner}" .) || rc=$?
  [ "${rc}" -le 1 ] || die 2 "refusing to publish: the leftover scan failed"
  in_names=$(cd "${tmp}/export" && find . -iname "*${src_owner}*") || die 2 "refusing to publish: the leftover scan failed"
  hits=$(printf '%s\n%s\n' "${in_content}" "${in_names}" | sed '/^$/d' | sort -u)
  [ -z "${hits}" ] || { printf '%s\n' "${hits}" >&2; die 2 "refusing to publish: these files still contain the primary owner"; }
}

mirror="" prev_sha=""
prepare_mirror() {
  local url=${MIRROR_TARGET_URL:-git@github.${dst_owner}:${dst_owner}/${repo}.git}
  mirror="${tmp}/mirror"
  git clone --quiet --branch main "${url}" "${mirror}" || die 1 "cannot clone main of the mirror ${repo}"
  prev_sha=$(git -C "${mirror}" rev-parse HEAD)
  git -C "${mirror}" show HEAD:MIRROR_SOURCE.json > "${tmp}/prev-source.json" 2>/dev/null || rm -f "${tmp}/prev-source.json"
  find "${mirror}" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -a "${tmp}/export/." "${mirror}/"
  git -C "${mirror}" add -A
}

# MIRROR_SOURCE.json alone always differs (synced_at), so it does not count as a change once it exists.
nothing_to_sync() {
  [ -f "${tmp}/prev-source.json" ] &&
    git -C "${mirror}" diff --cached --quiet HEAD -- . ':(exclude)MIRROR_SOURCE.json'
}

# mirror_sha is the mirror commit the sync is built on: the sync commit cannot contain its own sha.
write_source_json() {
  python3 - "${mirror}/MIRROR_SOURCE.json" "${tmp}/prev-source.json" "${repo}" "${ref}" "${src_sha}" "${prev_sha}" <<'PY'
import datetime, json, os, sys
out, prev, repo, ref, src_sha, mirror_sha = sys.argv[1:]
tags = []
if os.path.exists(prev):
    old = json.load(open(prev))
    if isinstance(old.get("tags"), list):
        tags = old["tags"]
doc = {
    "repo": repo,
    "source_ref": ref,
    "source_sha": src_sha,
    "mirror_sha": mirror_sha,
    "synced_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "tags": tags,
}
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PY
  git -C "${mirror}" add MIRROR_SOURCE.json
}

run_public_checks() {
  local check=""
  if [ -f "${mirror}/scripts/check-public-repo.sh" ]; then
    check=scripts/check-public-repo.sh
  elif [ -f "${mirror}/scripts/ci/hygiene-check.sh" ]; then
    check=scripts/ci/hygiene-check.sh
  fi
  if [ -n "${check}" ]; then
    (cd "${mirror}" && bash "${check}") >&2 || die 2 "refusing to publish: ${check} failed"
  else
    log "no public-repo check in ${repo} — skipped"
  fi
  if command -v gitleaks >/dev/null; then
    gitleaks dir --redact --no-banner --exit-code 1 "${tmp}/export" >&2 || die 2 "refusing to publish: gitleaks failed"
  else
    log "gitleaks not installed — skipped"
  fi
}

# Unsigned on purpose: a host signing key would carry the primary identity into the mirror.
commit_mirror() {
  local message="Sync from ${branch} (${short_sha})"
  [ -z "${subject}" ] || message="${message}: ${subject}"
  GIT_AUTHOR_NAME="${MIRROR_AUTHOR_NAME:-${dst_name}}" GIT_COMMITTER_NAME="${MIRROR_AUTHOR_NAME:-${dst_name}}" \
    GIT_AUTHOR_EMAIL="${MIRROR_AUTHOR_EMAIL:-olegshevtsov1@gmail.com}" \
    GIT_COMMITTER_EMAIL="${MIRROR_AUTHOR_EMAIL:-olegshevtsov1@gmail.com}" \
    git -C "${mirror}" -c commit.gpgsign=false commit --quiet -m "${message}"
}

# Never forced: if the mirror main moved since the clone, the push fails and nothing is overwritten.
push_mirror() {
  if "${dry_run}"; then
    keep_tmp=true
    echo "dry run: not pushed; inspect ${mirror}" >&2
  else
    git -C "${mirror}" push --quiet origin HEAD:main || die 1 "push to the mirror ${repo} failed"
  fi
}

# Phases run in this order. M4 adds tag copying after commit_mirror (and on the nothing-to-sync path) and appends
# to the tags list that write_source_json preserves.
main() {
  parse_args "$@"
  tmp=$(mktemp -d)
  trap cleanup EXIT
  fetch_primary
  export_tree
  drop_unsynced
  replace_owner
  refuse_leftovers
  prepare_mirror
  if nothing_to_sync; then
    echo "nothing to sync (mirror main ${prev_sha:0:7})"
    exit 0
  fi
  write_source_json
  run_public_checks
  commit_mirror
  push_mirror
  git -C "${mirror}" rev-parse HEAD
}

main "$@"
