#!/usr/bin/env bash
# Publishes one primary repo to its public mirror as a single commit without history, pushed to the mirror's develop
# and merged into main through a PR (scripts/publish-mirror.README.md).
# Usage: publish-mirror.sh <repo> [<ref>] [--dry-run] [--subject <text>]
# Env: MIRROR_AUTHOR_NAME, MIRROR_AUTHOR_EMAIL (mirror author, committer and tagger);
#      MIRROR_PRIMARY_URL, MIRROR_TARGET_URL (override the SSH URLs, e.g. with local paths);
#      MIRROR_CHECKS_TIMEOUT, MIRROR_CHECKS_INTERVAL (seconds to wait for the PR checks, default 1800 and 30).
# Exit 0: synced (stdout is the mirror main sha) or nothing to sync. Exit 1: clone, fetch, push or API call failed,
# the mirror main has changes not on develop, or the merge or a tag target did not verify.
# Exit 2: refused to publish (primary owner left over or the scan for it failed, public-repo check or gitleaks
# failed). Exit 3: the PR checks failed or timed out; the PR stays open and its URL is on stdout. Exit 64: usage.
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

repo="" ref="origin/main" subject="" dry_run=false
parse_args() {
  [ $# -gt 0 ] || usage
  repo=$1
  shift
  case "${repo}" in
    1_mvp_sdlc | 1_mvp_pilot_be | 1_mvp_pilot_fe) ;;
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

replace_exprs=(-e "s/${src_owner}/${dst_owner}/g" -e "s/${src_owner_cap}/${dst_owner}/g" -e "s/${src_name}/${dst_name}/g")
replace_owner() {
  (cd "${tmp}/export" &&
    grep -rlIZ -e "${src_owner}" -e "${src_owner_cap}" -e "${src_name}" . |
    xargs -0 -r sed -i "${replace_exprs[@]}")
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

# The sync is built on the mirror develop when it exists, else on main (pushing it then creates develop). A main
# whose tree differs from where it last met develop got commits outside this flow; merging over them is refused.
mirror="" main_sha="" has_develop=false
prepare_mirror() {
  local url=${MIRROR_TARGET_URL:-git@github.${dst_owner}:${dst_owner}/${repo}.git} base=origin/main fork
  mirror="${tmp}/mirror"
  git clone --quiet "${url}" "${mirror}" || die 1 "cannot clone the mirror ${repo}"
  main_sha=$(git -C "${mirror}" rev-parse --verify --quiet refs/remotes/origin/main) || die 1 "the mirror ${repo} has no main"
  if git -C "${mirror}" rev-parse --verify --quiet refs/remotes/origin/develop >/dev/null; then
    has_develop=true
    base=origin/develop
    fork=$(git -C "${mirror}" merge-base origin/main origin/develop) || die 1 "the mirror develop and main share no history"
    git -C "${mirror}" diff --quiet "${fork}" origin/main ||
      die 1 "mirror main has changes that are not on develop; reconcile by hand"
  fi
  git -C "${mirror}" checkout --quiet --detach "${base}"
  git -C "${mirror}" show HEAD:MIRROR_SOURCE.json > "${tmp}/prev-source.json" 2>/dev/null || rm -f "${tmp}/prev-source.json"
  find "${mirror}" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -a "${tmp}/export/." "${mirror}/"
  git -C "${mirror}" add -A
}

# tag_names < MIRROR_SOURCE.json: the tag names its tags list records; nothing for empty input.
tag_names() {
  python3 -c '
import json, sys
tags = json.loads(sys.stdin.read() or "{}").get("tags")
for t in tags if isinstance(tags, list) else []:
    if isinstance(t, dict) and isinstance(t.get("tag"), str):
        print(t["tag"])'
}

# tag_message <tag>: writes the primary tag's message, owner replaced, to tag-msg/<tag>. Fails if the primary has no
# such tag; refuses (exit 2) when the primary login is still in it.
tag_message() {
  local file="${tmp}/tag-msg/$1"
  git -C "${tmp}/primary" rev-parse --verify --quiet "refs/tags/$1" >/dev/null || return 1
  mkdir -p "${tmp}/tag-msg"
  git -C "${tmp}/primary" for-each-ref --format='%(contents)' "refs/tags/$1" > "${file}"
  sed -i "${replace_exprs[@]}" "${file}"
  ! grep -qi -e "${src_owner}" "${file}" || die 2 "refusing to publish: the message of tag $1 still contains the primary owner"
}

# is_ancestor <dir> <a> <b>: whether <a> is an ancestor of <b>; a git error (status above 1) is not a "no".
is_ancestor() {
  local rc=0
  git -C "$1" merge-base --is-ancestor "$2" "$3" || rc=$?
  [ "${rc}" -le 1 ] || die 1 "cannot tell whether ${2} is an ancestor of ${3}"
  return "${rc}"
}

# Annotated release tags of the primary that the synced commit contains, whose commit has the synced tree (the tag's
# content is what the mirror main holds after the merge) and that the mirror has not recorded yet.
carried=() carried_shas=()
find_release_tags() {
  local recorded="" name type commit tree src_tree
  src_tree=$(git -C "${tmp}/primary" rev-parse "${src_sha}^{tree}")
  [ ! -f "${tmp}/prev-source.json" ] || recorded=$(tag_names < "${tmp}/prev-source.json")
  while read -r name type commit tree; do
    if [ "${type}" != tag ] || ! [[ "${name}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then continue; fi
    is_ancestor "${tmp}/primary" "${commit}" "${src_sha}" || continue
    ! grep -qxF "${name}" <<<"${recorded}" || continue
    if [ "${tree}" != "${src_tree}" ]; then
      log "tag ${name} not carried: its content is not the synced content"
      continue
    fi
    if git -C "${mirror}" rev-parse --verify --quiet "refs/tags/${name}" >/dev/null; then
      log "tag ${name} already exists on the mirror but is not recorded — skipped"
      continue
    fi
    tag_message "${name}"
    carried+=("${name}")
    carried_shas+=("${commit}")
  done < <(git -C "${tmp}/primary" for-each-ref --sort=version:refname \
    --format='%(refname:short) %(objecttype) %(*objectname) %(*tree)' 'refs/tags/v*')
}

# MIRROR_SOURCE.json alone always differs (synced_at), so it does not count as a change once it exists.
nothing_to_sync() {
  [ -f "${tmp}/prev-source.json" ] && [ "${#carried[@]}" -eq 0 ] &&
    git -C "${mirror}" diff --cached --quiet HEAD -- . ':(exclude)MIRROR_SOURCE.json'
}

# An earlier run pushed a sync to develop and stopped before the merge.
develop_pending() {
  "${has_develop}" && ! is_ancestor "${mirror}" origin/develop origin/main
}

# mirror_sha, top level and per tag entry, is the mirror main the sync PR merges into: the merge commit's first
# parent. Neither the sync commit nor the merge commit can contain its own sha.
write_source_json() {
  local i pairs=()
  for i in "${!carried[@]}"; do pairs+=("${carried[i]}=${carried_shas[i]}"); done
  python3 - "${mirror}/MIRROR_SOURCE.json" "${tmp}/prev-source.json" "${repo}" "${ref}" "${src_sha}" "${main_sha}" \
    "${pairs[@]}" <<'PY'
import datetime, json, os, sys
out, prev, repo, ref, src_sha, mirror_sha, *pairs = sys.argv[1:]
synced_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
tags = []
if os.path.exists(prev):
    old = json.load(open(prev))
    if isinstance(old.get("tags"), list):
        tags = old["tags"]
for pair in pairs:
    tag, primary_sha = pair.split("=", 1)
    tags.append({"tag": tag, "primary_sha": primary_sha, "mirror_sha": mirror_sha, "synced_at": synced_at})
doc = {
    "repo": repo,
    "source_ref": ref,
    "source_sha": src_sha,
    "mirror_sha": mirror_sha,
    "synced_at": synced_at,
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

# as_mirror_author <command...>: runs the command with the mirror identity as git author and committer (tagger).
as_mirror_author() {
  GIT_AUTHOR_NAME="${MIRROR_AUTHOR_NAME:-${dst_name}}" GIT_COMMITTER_NAME="${MIRROR_AUTHOR_NAME:-${dst_name}}" \
    GIT_AUTHOR_EMAIL="${MIRROR_AUTHOR_EMAIL:-olegshevtsov1@gmail.com}" \
    GIT_COMMITTER_EMAIL="${MIRROR_AUTHOR_EMAIL:-olegshevtsov1@gmail.com}" "$@"
}

# Unsigned on purpose: a host signing key would carry the primary identity into the mirror.
sync_sha=""
commit_mirror() {
  local message="Sync from ${branch} (${short_sha})"
  [ -z "${subject}" ] || message="${message}: ${subject}"
  as_mirror_author git -C "${mirror}" -c commit.gpgsign=false commit --quiet -m "${message}"
  sync_sha=$(git -C "${mirror}" rev-parse HEAD)
}

# Never forced: if the mirror develop moved since the clone, the push fails and nothing is overwritten.
push_develop() {
  if "${dry_run}"; then
    keep_tmp=true
    echo "dry run: not pushed; inspect ${mirror}" >&2
    echo "dry run: git push origin ${sync_sha}:refs/heads/develop" >&2
  else
    git -C "${mirror}" push --quiet origin HEAD:refs/heads/develop || die 1 "push to the mirror ${repo} failed"
  fi
}

# Every mirror API call runs as the mirror account through its own token; the active gh account is never switched.
mirror_token=""
read_mirror_token() {
  "${dry_run}" && return 0
  mirror_token=$(gh auth token -u "${dst_owner}") || mirror_token=""
  [ -n "${mirror_token}" ] || die 1 "no gh token for ${dst_owner}; log in with gh auth login"
}

# mirror_api <METHOD> <path under repos/<mirror>/> [gh api args...]
mirror_api() {
  local method=$1 path="repos/${dst_owner}/${repo}/$2"
  shift 2
  if "${dry_run}"; then
    echo "dry run: gh api -X ${method} ${path} $*" >&2
    return 0
  fi
  GH_TOKEN="${mirror_token}" gh api -X "${method}" "${path}" "$@"
}

pr_number="" pr_url="" pr_title="" pr_body=""
pr_title_and_body() {
  local new_tags
  new_tags=$(comm -23 <(git -C "${mirror}" show "${sync_sha}:MIRROR_SOURCE.json" | tag_names | sort) \
    <({ git -C "${mirror}" show "${main_sha}:MIRROR_SOURCE.json" 2>/dev/null || true; } | tag_names | sort) | sort -V)
  pr_body="Sync of ${repo} from ${branch} at ${short_sha}."
  if [ -n "${new_tags}" ]; then
    pr_title="PILOT-0: Release $(tail -n 1 <<<"${new_tags}")"
    pr_body+=$'\n'"Tags: $(paste -sd ' ' <<<"${new_tags}")"
  else
    pr_title="PILOT-0: Sync ${branch} (${short_sha})"
  fi
  pr_body+=$'\n\nType: chore'
}

# An open develop → main PR left by an earlier run is updated and reused.
open_pr() {
  local open created
  pr_title_and_body
  open=$(mirror_api GET pulls -f head="${dst_owner}:develop" -f base=main -f state=open) ||
    die 1 "listing the PRs of the mirror ${repo} failed"
  read -r pr_number pr_url < <(python3 -c '
import json, sys
prs = json.loads(sys.stdin.read().strip() or "[]")
print(prs[0]["number"], prs[0]["html_url"]) if prs else print()' <<<"${open}")
  if [ -n "${pr_number}" ]; then
    mirror_api PATCH "pulls/${pr_number}" -f title="${pr_title}" -f body="${pr_body}" >/dev/null ||
      die 1 "updating ${pr_url} failed"
  else
    created=$(mirror_api POST pulls -f title="${pr_title}" -f head=develop -f base=main -f body="${pr_body}") ||
      die 1 "opening the PR on the mirror ${repo} failed"
    "${dry_run}" && { pr_number="<pr>" pr_url="<pr url>"; return 0; }
    read -r pr_number pr_url < <(python3 -c '
import json, sys
pr = json.load(sys.stdin)
print(pr["number"], pr["html_url"])' <<<"${created}")
  fi
  log "PR ${pr_url}"
}

# Green: at least one check run, all completed, none failed. Red or timed out: exit 3 with the PR URL on stdout.
wait_checks() {
  local timeout=${MIRROR_CHECKS_TIMEOUT:-1800} interval=${MIRROR_CHECKS_INTERVAL:-30} start=${SECONDS} runs state
  while :; do
    runs=$(mirror_api GET "commits/${sync_sha}/check-runs" -f per_page=100) || die 1 "reading the checks of ${pr_url} failed"
    "${dry_run}" && return 0
    state=$(python3 -c '
import json, sys
runs = json.load(sys.stdin)["check_runs"]
failed = [r["name"] for r in runs if r["status"] == "completed" and r["conclusion"] not in ("success", "neutral", "skipped")]
if failed:
    print("red " + ", ".join(failed))
elif runs and all(r["status"] == "completed" for r in runs):
    print("green")
else:
    print("pending")' <<<"${runs}")
    case "${state}" in
      green) return 0 ;;
      red*) log "checks failed: ${state#red }; not merged"; echo "${pr_url}"; exit 3 ;;
    esac
    if [ $((SECONDS - start)) -ge "${timeout}" ]; then
      log "checks timed out after ${timeout}s; not merged"
      echo "${pr_url}"
      exit 3
    fi
    sleep "${interval}"
  done
}

# A merge commit, not a squash (decision 51); sha makes GitHub refuse if develop moved after the checks ran.
merge_pr() {
  mirror_api PUT "pulls/${pr_number}/merge" -f merge_method=merge -f sha="${sync_sha}" >/dev/null ||
    die 1 "merging ${pr_url} failed"
}

verify_merge() {
  local merge
  git -C "${mirror}" fetch --quiet origin main || die 1 "cannot fetch main of the mirror ${repo}"
  merge=$(git -C "${mirror}" rev-parse origin/main)
  if [ "$(git -C "${mirror}" rev-list --parents -n 1 "${merge}")" != "${merge} ${main_sha} ${sync_sha}" ] ||
    ! git -C "${mirror}" diff --quiet "${sync_sha}" "${merge}"; then
    die 1 "the mirror main ${merge:0:7} is not the merge of ${sync_sha:0:7} into ${main_sha:0:7}; no tags created"
  fi
}

# tag_target <tag>: the first commit on the mirror main's first-parent line whose MIRROR_SOURCE.json lists the tag —
# the merge commit of the sync PR that wrote the entry.
tag_target() {
  local c
  for c in $(git -C "${mirror}" rev-list --first-parent --reverse origin/main); do
    if { git -C "${mirror}" show "${c}:MIRROR_SOURCE.json" 2>/dev/null || true; } | tag_names | grep -xF "$1" >/dev/null; then
      echo "${c}"
      return 0
    fi
  done
  return 1
}

# Tags recorded on the mirror main but missing on the mirror: created after a merge, and recreated if deleted.
create_missing_tags() {
  local tag entry_mirror_sha target
  while read -r tag _ entry_mirror_sha; do
    if [ -z "${entry_mirror_sha}" ]; then
      log "tag entry ${tag} has no primary_sha or mirror_sha — not tagged"
      continue
    fi
    ! git -C "${mirror}" rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null || continue
    target=$(tag_target "${tag}") || die 1 "no commit on the mirror main records tag ${tag}"
    [ "$(git -C "${mirror}" rev-parse "${target}^1")" = "${entry_mirror_sha}" ] ||
      die 1 "the first parent of ${target:0:7} is not the mirror_sha recorded for ${tag}; nothing tagged"
    tag_message "${tag}" || { log "the primary has no tag ${tag} — not tagged"; continue; }
    if "${dry_run}"; then
      echo "dry run: tag ${tag} on ${target}" >&2
      continue
    fi
    as_mirror_author git -C "${mirror}" -c tag.gpgSign=false tag -a "${tag}" --cleanup=verbatim \
      -F "${tmp}/tag-msg/${tag}" "${target}"
    git -C "${mirror}" push --quiet origin "refs/tags/${tag}" || die 1 "push of tag ${tag} to the mirror ${repo} failed"
    log "tagged ${tag} on ${target:0:7}"
  done < <(git -C "${mirror}" show origin/main:MIRROR_SOURCE.json 2>/dev/null | python3 -c '
import json, sys
tags = json.loads(sys.stdin.read() or "{}").get("tags")
for t in tags if isinstance(tags, list) else []:
    if isinstance(t, dict) and isinstance(t.get("tag"), str):
        fields = [t.get("primary_sha"), t.get("mirror_sha")]
        print(t["tag"], *(fields if all(isinstance(f, str) and f for f in fields) else []))')
}

# Export, commit to the mirror develop, PR into main, wait for green, merge, tag what the merge recorded.
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
  find_release_tags
  if ! nothing_to_sync; then
    write_source_json
    run_public_checks
    commit_mirror
    push_develop
  elif develop_pending; then
    log "the mirror develop is ahead of main: resuming its PR"
    sync_sha=$(git -C "${mirror}" rev-parse origin/develop)
  else
    create_missing_tags
    echo "nothing to sync (mirror main ${main_sha:0:7})"
    exit 0
  fi
  read_mirror_token
  open_pr
  wait_checks
  merge_pr
  if "${dry_run}"; then
    local tag
    for tag in "${carried[@]}"; do echo "dry run: tag ${tag} on the merge commit" >&2; done
    echo "${sync_sha}"
    return 0
  fi
  verify_merge
  create_missing_tags
  git -C "${mirror}" rev-parse origin/main
}

main "$@"
