#!/usr/bin/env bash
# Runs one step of a 1_mvp_sdlc release from reviewed code, so that a post-merge step is one line the sdlc-autopilot
# supervisor can approve (scripts/release.README.md). Every subcommand is idempotent: a rerun after a success, or
# after a fix, finishes the same release.
# Usage: release.sh <merge-release-pr|tag|mirror|install|verify|plugin> v<X.Y.Z>
# Env: RELEASE_CHECKS_TIMEOUT (seconds to wait for the release PR checks, default 1200);
#      RELEASE_INSTALL_WAIT, RELEASE_INSTALL_INTERVAL (seconds to wait for running factory, plan-review and
#      plugin-probe runs before install, default 1800 and 30); MIRROR_CHECKS_TIMEOUT (default 1200) and
#      MIRROR_TARGET_URL, passed to publish-mirror.sh; ARCHON_HOME (default ~/.archon), as install.sh reads it;
#      RELEASE_PLUGIN_PROJECTS (space-separated checkouts whose project-scope mvp-sdlc plugin updates, default the
#      be and fe checkouts under ~/projects/mvp); CLAUDE_CONFIG_DIR (default ~/.claude), as the claude CLI reads it.
# Each proof prints `ok <what>` or `DIFF <what>` on stdout; progress goes to stderr.
# Exit 0: done, or already done. Exit 1: a precondition or a proof failed. Exit 3: the release PR checks failed or
# timed out, and nothing was merged. Exit 64: usage. Exit 75: install only, runs that install would replace are still
# running. mirror passes publish-mirror.sh's own exit code through (1, 2, or 3 for the mirror PR checks).
set -euo pipefail

usage() {
  echo "usage: release.sh <merge-release-pr|tag|mirror|install|verify|plugin> v<X.Y.Z>" >&2
  exit 64
}
log() { echo "release: $*" >&2; }
die() { local rc=$1; shift; log "$*"; exit "${rc}"; }

[ $# -eq 2 ] || usage
cmd=$1 tag=$2
case "${cmd}" in merge-release-pr | tag | mirror | install | verify | plugin) ;; *) usage ;; esac
[[ ${tag} =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || usage
version=${tag#v}
version_re=${version//./\\.}
ARCHON_HOME=${ARCHON_HOME:-${HOME}/.archon}
mirror_url=${MIRROR_TARGET_URL:-git@github.OlegShevtsov1:OlegShevtsov1/1_mvp_sdlc.git}

cd "$(git rev-parse --show-toplevel)"
# Never --prune: it would drop a tag this release created locally but has not pushed yet.
git fetch -q origin --tags
# The primary repo is read from the remote, not written here: this script is mirrored, and literals are rewritten.
repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

failed=0
proof() {
  local what=$1
  shift
  if "$@" >&2; then echo "ok ${what}"; else echo "DIFF ${what}"; failed=1; fi
}
proven() { [ "${failed}" -eq 0 ] || die 1 "$1"; }

wt_root="" wt=""
cleanup() {
  [ -n "${wt_root}" ] || return 0
  git worktree remove --force "${wt_root}/wt" 2>/dev/null || true
  rm -rf "${wt_root}"
}
trap cleanup EXIT
# tag_worktree: sets wt to a detached worktree at the release tag, removed on exit.
tag_worktree() {
  wt_root=$(mktemp -d)
  wt="${wt_root}/wt"
  git worktree add -q --detach "${wt}" "${tag}" >&2
}

on_origin() { git ls-remote --exit-code origin "refs/tags/${tag}" >/dev/null; }

# blob <rev>:<path>: the file at that revision, read whole, so a reader that stops early (grep -q, awk exit) never
# kills git show with SIGPIPE, which pipefail would turn into a silent exit 141 (PILOT-619). Empty, with git's error
# on stderr, when there is no such file.
blob() { git show "$1" || true; }

# The release PR is titled with the card of the merged release-prep PR `PILOT-<n>: Release X.Y.Z changelog`.
release_title() {
  local titles
  titles=$(gh pr list -R "${repo}" --base develop --state merged --limit 100 \
    --search "Release ${version} changelog in:title" --json title --jq '.[].title' |
    { grep -E "^PILOT-[1-9][0-9]*: Release ${version_re} changelog$" || true; })
  [ "$(printf '%s' "${titles}" | grep -c .)" -eq 1 ] ||
    die 1 "want exactly one merged release-prep PR 'PILOT-<n>: Release ${version} changelog' into develop"
  echo "${titles%%:*}: Release ${tag}"
}

# release_pr <title>: `<number> <state>` of the release PR develop → main with that title, a merged one first, then
# an open one; nothing when there is neither.
release_pr() {
  gh pr list -R "${repo}" --base main --head develop --state all --limit 100 --json number,state,title |
    TITLE="$1" python3 -c '
import json, os, sys
prs = [p for p in json.load(sys.stdin) if p["title"] == os.environ["TITLE"]]
for state in ("MERGED", "OPEN"):
    for p in prs:
        if p["state"] == state:
            print(p["number"], state)
            sys.exit(0)'
}

# prove_merge <number>: the release PR is merged with a merge commit whose second parent is the PR head, on main;
# sets merge_commit.
merge_commit=""
prove_merge() {
  local n=$1 view state head
  git fetch -q origin
  view=$(gh pr view "${n}" -R "${repo}" --json state,headRefOid,mergeCommit \
    --jq '"\(.state) \(.headRefOid) \(.mergeCommit.oid // "")"')
  read -r state head merge_commit <<<"${view}"
  proof "release PR #${n} is MERGED" test "${state}" = MERGED
  proof "${merge_commit:-<no merge commit>} has two parents" \
    test "$(git rev-list --parents -n 1 "${merge_commit:-HEAD}" | wc -w)" -eq 3
  proof "the second parent is the PR head ${head}" test "$(git rev-parse "${merge_commit:-HEAD}^2" 2>/dev/null)" = "${head}"
  proof "the merge commit is on origin/main" git merge-base --is-ancestor "${merge_commit:-HEAD}" origin/main
}

# merged_release: sets release_number and merge_commit of the merged release PR, after its proofs.
release_number=""
merged_release() {
  local title pr state
  title=$(release_title)
  pr=$(release_pr "${title}")
  read -r release_number state <<<"${pr:-0 none}"
  [ "${state}" = MERGED ] || die 1 "the release PR ${title} is not merged"
  prove_merge "${release_number}"
  proven "the release merge of ${tag} did not verify"
}

prove_installed() {
  local wt=$1 installed="${ARCHON_HOME}/workflows/sdlc-factory/factory" y
  proof "installed factory equals ${tag}" \
    diff -r -x notify-telegram.sh "${installed}" "${wt}/orchestration/factory/.archon/workflows/sdlc-factory/factory"
  proof "installed notify-telegram.sh equals ${tag}" \
    cmp "${installed}/scripts/_lib/notify-telegram.sh" "${wt}/scripts/ci/notify-telegram.sh"
  for y in "${wt}"/orchestration/workflows/*.yaml; do
    proof "installed $(basename "${y}") equals ${tag}" cmp "${y}" "${ARCHON_HOME}/workflows/$(basename "${y}")"
  done
  proof "installed supervisor equals ${tag}" diff -r -x node_modules "${ARCHON_HOME}/supervisor" "${wt}/orchestration/supervisor"
}

merge_release_pr() {
  local changelog title pr n state body head out rc left
  changelog=$(blob origin/develop:CHANGELOG.md)
  grep -qE "^## \[${version_re}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" <<<"${changelog}" ||
    die 1 "origin/develop CHANGELOG.md has no '## [${version}] - <date>' section"
  grep -qE "\"version\": \"${version_re}\"" <<<"$(blob origin/develop:plugins/mvp-sdlc/.claude-plugin/plugin.json)" ||
    die 1 "origin/develop plugin.json is not version ${version}"
  title=$(release_title)
  pr=$(release_pr "${title}")
  read -r n state <<<"${pr:-0 none}"
  if [ "${state}" = none ]; then
    body=$(mktemp)
    {
      echo "Release mvp-sdlc ${version} (1_mvp_sdlc develop → main)."
      echo
      echo "## Changelog"
      echo
      awk -v h="## [${version}]" 'index($0, h) == 1 { f = 1 } f && /^## \[/ && index($0, h) != 1 { exit } f' <<<"${changelog}"
      echo "Type: chore"
    } >"${body}"
    REPO="${repo}" BASE_REF=main HEAD_REF=develop PR_TITLE="${title}" PR_BODY="$(cat "${body}")" \
      bash scripts/ci/pr-conventions.sh >&2 || die 1 "the release PR body breaks the PR conventions"
    gh pr create -R "${repo}" --base main --head develop --title "${title}" --body-file "${body}" >&2
    rm -f "${body}"
    pr=$(release_pr "${title}")
    read -r n state <<<"${pr:-0 none}"
    [ "${state}" = OPEN ] || die 1 "the new release PR ${title} was not found"
    log "opened release PR #${n}: ${title}"
  fi
  if [ "${state}" = OPEN ]; then
    # A PR that was just opened reports no checks until CI registers them.
    local deadline=$((SECONDS + ${RELEASE_CHECKS_TIMEOUT:-1200}))
    while :; do
      left=$((deadline - SECONDS))
      [ "${left}" -gt 0 ] || die 3 "checks of #${n} timed out; not merged"
      rc=0
      out=$(timeout "${left}" gh pr checks "${n}" -R "${repo}" --watch 2>&1) || rc=$?
      printf '%s\n' "${out}" >&2
      if [ "${rc}" -eq 0 ] || ! grep -q "no checks reported" <<<"${out}"; then break; fi
      sleep 15
    done
    [ "${rc}" -eq 0 ] || die 3 "checks of #${n} failed or timed out (rc ${rc}); not merged"
    head=$(gh pr view "${n}" -R "${repo}" --json headRefOid --jq .headRefOid)
    gh pr merge "${n}" -R "${repo}" --merge --match-head-commit "${head}" >&2
  fi
  prove_merge "${n}"
  proven "the merge of #${n} did not verify"
  echo "merged: #${n} ${merge_commit}"
}

tag_release() {
  merged_release
  local m=${merge_commit} remote
  grep -qE "\"version\": \"${version_re}\"" <<<"$(blob "${m}:plugins/mvp-sdlc/.claude-plugin/plugin.json")" ||
    die 1 "plugin.json at ${m} is not version ${version}"
  if ! git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
    git tag -a "${tag}" -m "mvp-sdlc ${version}" "${m}"
  fi
  [ "$(git cat-file -t "refs/tags/${tag}")" = tag ] || die 1 "${tag} is not an annotated tag"
  [ "$(git rev-parse "refs/tags/${tag}^{commit}")" = "${m}" ] || die 1 "${tag} is not on the release merge ${m}"
  on_origin || git push -q origin "refs/tags/${tag}"
  remote=$(git ls-remote origin "refs/tags/${tag}^{}" | cut -f1)
  proof "origin ${tag} is on ${m}" test "${remote}" = "${m}"
  proven "origin ${tag} did not verify"
  echo "tagged: ${tag} ${m}"
}

mirror_release() {
  on_origin || die 1 "${tag} is not on origin; run release.sh tag ${tag} first"
  local rc=0
  tag_worktree
  bash "${wt}/scripts/publish-mirror.sh" 1_mvp_sdlc --dry-run >&2 || die $? "the mirror dry run failed; no real run"
  MIRROR_CHECKS_TIMEOUT=${MIRROR_CHECKS_TIMEOUT:-1200} bash "${wt}/scripts/publish-mirror.sh" 1_mvp_sdlc >&2 || rc=$?
  [ "${rc}" -eq 0 ] || die "${rc}" "publish-mirror.sh exited ${rc}"
  proof "the mirror has ${tag}" git ls-remote --exit-code "${mirror_url}" "refs/tags/${tag}"
  proven "the mirror tag did not verify"
}

# running_runs: the ids of running runs that install.sh would replace under them; fails when the list is unreadable.
running_runs() {
  archon workflow status --all --json 2>/dev/null | { grep -v '^{"level"' || true; } | python3 -c '
import json, sys
runs = json.load(sys.stdin)["runs"]
print(" ".join(r["id"][:8] for r in runs
               if r["status"] == "running" and r["workflow_name"] in ("factory", "plan-review", "plugin-probe")))'
}

install_release() {
  on_origin || die 1 "${tag} is not on origin; run release.sh tag ${tag} first"
  local wait=${RELEASE_INSTALL_WAIT:-1800} interval=${RELEASE_INSTALL_INTERVAL:-30} waited=0 runs
  while :; do
    runs=$(running_runs) || runs="(the run list is unreadable)"
    [ -n "${runs}" ] || break
    [ "${waited}" -lt "${wait}" ] || die 75 "still running: ${runs}; install not started"
    log "waiting for ${runs}"
    sleep "${interval}"
    waited=$((waited + interval))
  done
  tag_worktree
  (cd "${wt}" && ./install.sh) >&2
  prove_installed "${wt}"
  proven "the install of ${tag} did not verify"
}

verify_release() {
  local remote
  merged_release
  remote=$(git ls-remote origin "refs/tags/${tag}^{}" | cut -f1)
  proof "origin ${tag} is the merge of #${release_number} ${merge_commit}" test "${remote}" = "${merge_commit}"
  proof "the mirror has ${tag}" git ls-remote --exit-code "${mirror_url}" "refs/tags/${tag}"
  tag_worktree
  prove_installed "${wt}"
  proven "release ${tag} did not verify"
}

# plugin_release: the CLI selects a project only by its cwd and, from a cwd matching no project, updates another one
# and still exits 0, so each project is proven from `claude plugin list --json`, never from the update's exit code.
# The update writes only under the config dir, never in the checkout.
plugin_release() {
  on_origin || die 1 "${tag} is not on origin; run release.sh tag ${tag} first"
  local cfg=${CLAUDE_CONFIG_DIR:-${HOME}/.claude} p root roots=() list
  local cache="${cfg}/plugins/cache/mvp/mvp-sdlc/${version}"
  for p in ${RELEASE_PLUGIN_PROJECTS:-${HOME}/projects/mvp/1_mvp_pilot_be ${HOME}/projects/mvp/1_mvp_pilot_fe}; do
    root=$(git -C "${p}" rev-parse --show-toplevel 2>/dev/null) || die 1 "${p} is not a git checkout"
    roots+=("${root}")
  done
  claude plugin marketplace update mvp >&2 || die 1 "claude plugin marketplace update mvp failed"
  for root in "${roots[@]}"; do
    (cd "${root}" && claude plugin update mvp-sdlc@mvp --scope project --json) >&2 ||
      die 1 "claude plugin update mvp-sdlc@mvp failed in ${root}"
  done
  list=$(claude plugin list --json) || die 1 "claude plugin list --json failed"
  proof "the cache has mvp-sdlc ${version}" python3 -c '
import json, sys
sys.exit(json.load(open(sys.argv[1]))["version"] != sys.argv[2])' "${cache}/.claude-plugin/plugin.json" "${version}"
  for root in "${roots[@]}"; do
    proof "${root} resolves mvp-sdlc@mvp ${version}" python3 -c '
import json, sys
root, version, cache = sys.argv[1:]
want = {"id": "mvp-sdlc@mvp", "scope": "project", "projectPath": root, "version": version, "installPath": cache}
sys.exit(not any(all(e.get(k) == v for k, v in want.items()) for e in json.loads(sys.stdin.read())))' \
      "${root}" "${version}" "${cache}" <<<"${list}"
  done
  proven "the mvp-sdlc ${version} update did not verify"
}

case "${cmd}" in
  merge-release-pr) merge_release_pr ;;
  tag) tag_release ;;
  mirror) mirror_release ;;
  install) install_release ;;
  verify) verify_release ;;
  plugin) plugin_release ;;
esac
