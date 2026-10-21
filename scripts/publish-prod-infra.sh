#!/usr/bin/env bash
# Proposes the pilot prod Terraform root from the primary infra repo to OlegShevtsov1/1_mvp_infra env/prod as one
# commit on a sync branch and a PR the operator merges after a plan (scripts/publish-prod-infra.README.md).
# Usage: publish-prod-infra.sh [<ref>] [--dry-run]
# Env: GH_TOKEN (OlegShevtsov1's token, required unless --dry-run; every API call uses it);
#      INFRA_PROD_AUTHOR_NAME, INFRA_PROD_AUTHOR_EMAIL (author and committer);
#      INFRA_PROD_PRIMARY_URL, INFRA_PROD_TARGET_URL (override the SSH URLs, e.g. with local paths).
# Exit 0: PR opened (stdout is its URL), nothing to sync, already proposed, or dry run built.
# Exit 1: clone, ref resolution, push or gh call failed. Exit 2: refused (pilot-prod root not found, required paths
# missing, module source unresolvable, unexported workflow reference, token of another account). Exit 64: usage.
# The primary login is assembled from parts: this repo is mirrored by publish-mirror.sh, and a plain literal
# would be rewritten in the mirror's copy.
set -euo pipefail
export LC_ALL=C

src_owner="oleh""shev1"
dst_owner="OlegShevtsov1"
dst_slug="${dst_owner}/1_mvp_infra"
prod_root="infra/projects/pilot-prod"
marker="INFRA_PROD_SOURCE.json"

# Exported besides the prod root and its module closure. Every entry must exist at the ref; a directory entry
# exports all its tracked files. The prod workflows run the support files (copies of project-terraform*.yml).
manifest=(
  .github/workflows/project-terraform-prod.yml
  .github/workflows/project-terraform-prod-deploy.yml
  projects/pilot.yaml
  docs/uk/25-prod-infra-split.md
  .github/actions
  scripts/ci-vpn.sh
  scripts/ci_vpn_lock.py
  scripts/notify-telegram.sh
  host/vpn-client-dns.sh
  scripts/projects.py
  scripts/project_plan_guard.py
  scripts/vpn_dns.py
  scripts/ship-vpn-client.sh
  host/project-vpn-client.sh
  bin/vpnctl
  dnsmasq.conf
  infra/backend.generated.hcl
)

usage() {
  echo "usage: publish-prod-infra.sh [<ref>] [--dry-run]" >&2
  exit 64
}
log() { echo "publish-prod-infra: $*" >&2; }
die() { local rc=$1; shift; log "$*"; exit "${rc}"; }

ref=origin/env/dev dry_run=false
parse_args() {
  local ref_given=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=true ;;
      -*) usage ;;
      *) ! "${ref_given}" || usage; ref=$1; ref_given=true ;;
    esac
    shift
  done
}

# Never runs gh auth: the caller's GH_TOKEN is the only identity, the active gh account is left alone.
check_token() {
  local login
  [ -n "${GH_TOKEN:-}" ] || { log "GH_TOKEN of ${dst_owner} is required (gh auth token --user ${dst_owner})"; exit 64; }
  login=$(gh api user --jq .login) || die 1 "cannot read the GH_TOKEN owner"
  [ "${login}" = "${dst_owner}" ] || die 2 "GH_TOKEN belongs to ${login}, not ${dst_owner}"
}

tmp="" keep_tmp=false
cleanup() { [ -z "${tmp}" ] || "${keep_tmp}" || rm -rf "${tmp}"; }

src_sha="" short_sha="" branch="" sync_branch=""
fetch_primary() {
  local url=${INFRA_PROD_PRIMARY_URL:-git@github.${src_owner}:${src_owner}/1_mvp_infra.git}
  git clone --quiet --no-checkout "${url}" "${tmp}/primary" || die 1 "cannot clone the primary infra repo"
  src_sha=$(git -C "${tmp}/primary" rev-parse --verify --quiet "${ref}^{commit}") || die 1 "unknown ref ${ref}"
  short_sha=${src_sha:0:7}
  branch=${ref#origin/}
  sync_branch="sync/prod-infra-${short_sha}"
}

require_root() {
  [ -n "$(git -C "${tmp}/primary" ls-tree --name-only "${src_sha}" -- "${prod_root}")" ] ||
    die 2 "pilot-prod root not found: ${prod_root} does not exist at ${ref} (${short_sha}) — run M5 steps 1-2 in the infra repo first"
}

export_tree() {
  mkdir "${tmp}/all"
  git -C "${tmp}/primary" archive "${src_sha}" | tar -x -C "${tmp}/all"
}

# Writes the sorted export list to ${tmp}/files. The module closure follows local module sources ("./", "../")
# from the prod root's .tf files, transitively; registry, git and http sources are not exported.
collect_files() {
  python3 - "${tmp}/all" "${prod_root}" "${manifest[@]}" > "${tmp}/files" <<'PY'
import os, re, sys
root, prod_root, *manifest = sys.argv[1:]
source_re = re.compile(r'^\s*source\s*=\s*"((?:\.\.?/)[^"]*)"', re.M)

def files_under(rel):
    full = os.path.join(root, rel)
    if os.path.isfile(full):
        return [rel]
    found = []
    for d, _, names in os.walk(full):
        found += [os.path.relpath(os.path.join(d, n), root) for n in names]
    return found

errors = []
missing = [p for p in manifest if not os.path.exists(os.path.join(root, p)) or not files_under(p)]
if missing:
    errors.append("required paths missing at the ref: " + ", ".join(missing))

dirs, queue = set(), [prod_root]
while queue:
    d = queue.pop()
    if d in dirs:
        continue
    dirs.add(d)
    for tf in (f for f in files_under(d) if f.endswith(".tf")):
        for src in source_re.findall(open(os.path.join(root, tf)).read()):
            target = os.path.normpath(os.path.join(os.path.dirname(tf), src))
            if target in (".", "..") or target.startswith("../"):
                errors.append(f"{tf}: module source {src} is the repository root or leaves it")
            elif not os.path.isdir(os.path.join(root, target)):
                errors.append(f"{tf}: module source {src} does not exist at the ref")
            else:
                queue.append(target)

if errors:
    for e in errors:
        print(f"publish-prod-infra: refusing: {e}", file=sys.stderr)
    sys.exit(2)
files = set()
for p in sorted(dirs) + manifest:
    files.update(files_under(p))
print("\n".join(sorted(files)))
PY
}

# The prod workflows and actions may only run bin/, scripts/ and host/ files that are exported. Indirect
# dependencies (a script calling another) are not traced.
check_references() {
  local refs unexported
  refs=$(grep -E '^(\.github/workflows/project-terraform-prod(-deploy)?\.yml|\.github/actions/[^/]+/action\.ya?ml)$' "${tmp}/files" |
    (cd "${tmp}/all" && xargs -r grep -ohE "(^|[[:space:]\"'=(]|\./)(bin|scripts|host)/[A-Za-z0-9_.-]+") |
    sed -E "s#^.*((bin|scripts|host)/)#\\1#; s/\\.+\$//" | sort -u) || true
  unexported=$(comm -23 <(printf '%s\n' "${refs}" | sed '/^$/d') "${tmp}/files")
  [ -z "${unexported}" ] ||
    die 2 "the prod workflows reference files that are not exported: $(paste -sd ' ' <<<"${unexported}") — add them to the manifest in scripts/publish-prod-infra.sh"
}

stage_export() {
  mkdir "${tmp}/export"
  tar -C "${tmp}/all" -cf - -T "${tmp}/files" | tar -C "${tmp}/export" -xf -
}

target="" target_url="" base_sha="" create_env_prod=false
prepare_target() {
  local heads base_branch=env/prod
  target_url=${INFRA_PROD_TARGET_URL:-git@github.${dst_owner}:${dst_slug}.git}
  target="${tmp}/target"
  heads=$(git ls-remote --heads "${target_url}" env/prod) || die 1 "cannot list the branches of ${dst_slug}"
  if [ -z "${heads}" ]; then
    base_branch=env/dev
    create_env_prod=true
  fi
  git clone --quiet --branch "${base_branch}" "${target_url}" "${target}" || die 1 "cannot clone ${base_branch} of ${dst_slug}"
  base_sha=$(git -C "${target}" rev-parse HEAD)
  find "${target}" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -a "${tmp}/export/." "${target}/"
  git -C "${target}" add -A
}

# The marker alone always differs (synced_at), so it does not count as a change once env/prod has it.
nothing_to_sync() {
  ! "${create_env_prod}" &&
    git -C "${target}" cat-file -e "HEAD:${marker}" 2>/dev/null &&
    git -C "${target}" diff --cached --quiet HEAD -- . ":(exclude)${marker}"
}

pr_title=""
write_pr_body() {
  pr_title="PILOT-0: Sync prod infra from ${branch} (${short_sha})"
  cat > "${tmp}/pr-body.md" <<EOF
Sync of the prod infra root from ${src_owner}/1_mvp_infra ${ref} at ${src_sha}: $(wc -l < "${tmp}/files") files.

Not auto-merged: the operator merges after reviewing a terraform plan of ${prod_root} (decision 46).

Type: chore
EOF
}

open_pr() {
  write_pr_body
  gh pr create -R "${dst_slug}" --base env/prod --head "${sync_branch}" --title "${pr_title}" \
    --body-file "${tmp}/pr-body.md" || die 1 "PR creation failed; branch ${sync_branch} is pushed — rerun to retry"
}

# A sync branch for this primary commit means an earlier run got as far as the push.
already_proposed() {
  local heads url
  heads=$(git -C "${target}" ls-remote --heads origin "${sync_branch}") || die 1 "cannot list the branches of ${dst_slug}"
  [ -n "${heads}" ] || return 1
  url=$(gh pr list -R "${dst_slug}" --head "${sync_branch}" --base env/prod --state open --json url \
    --jq '.[0].url // empty') || die 1 "cannot list the PRs of ${dst_slug}"
  if [ -n "${url}" ]; then
    echo "already proposed: ${url}"
  else
    open_pr
  fi
}

# mirror_sha is the env/prod commit the sync is built on: the sync commit cannot contain its own sha.
write_source_json() {
  python3 - "${target}/${marker}" "${src_sha}" "${base_sha}" <<'PY'
import datetime, json, sys
out, primary_sha, mirror_sha = sys.argv[1:]
doc = {
    "primary_sha": primary_sha,
    "mirror_sha": mirror_sha,
    "synced_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
with open(out, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PY
  git -C "${target}" add "${marker}"
}

# Unsigned on purpose: a host signing key would carry the primary identity.
commit_target() {
  local name=${INFRA_PROD_AUTHOR_NAME:-Oleg Shevtsov} email=${INFRA_PROD_AUTHOR_EMAIL:-olegshevtsov1@gmail.com}
  GIT_AUTHOR_NAME="${name}" GIT_COMMITTER_NAME="${name}" GIT_AUTHOR_EMAIL="${email}" GIT_COMMITTER_EMAIL="${email}" \
    git -C "${target}" -c commit.gpgsign=false commit --quiet -m "Sync prod infra from ${branch} (${short_sha})"
}

# Never forced. env/prod is only ever created here, at the target env/dev commit; afterwards it moves by PR merges.
push_target() {
  if "${create_env_prod}"; then
    git -C "${target}" push --quiet origin "${base_sha}:refs/heads/env/prod" || die 1 "creating env/prod failed"
  fi
  git -C "${target}" push --quiet origin "HEAD:refs/heads/${sync_branch}" || die 1 "push of ${sync_branch} failed"
}

# Phases run in this order; every refusal comes before the first remote write. Nothing here merges.
main() {
  parse_args "$@"
  "${dry_run}" || check_token
  tmp=$(mktemp -d)
  trap cleanup EXIT
  fetch_primary
  require_root
  export_tree
  collect_files
  check_references
  stage_export
  prepare_target
  if nothing_to_sync; then
    echo "nothing to sync (env/prod ${base_sha:0:7})"
    exit 0
  fi
  if ! "${dry_run}" && already_proposed; then
    exit 0
  fi
  write_source_json
  commit_target
  if "${dry_run}"; then
    keep_tmp=true
    git -C "${target}" ls-tree -r --name-only HEAD
    echo "dry run: not pushed; inspect ${target}" >&2
    exit 0
  fi
  push_target
  open_pr
}

main "$@"
