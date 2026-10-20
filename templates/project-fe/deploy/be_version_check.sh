#!/usr/bin/env bash
# Release order backend first: refuses a prod frontend deploy while the backend on prod is older
# than the minimum backend version this release declares in deploy/min-be-version. The backend's
# /health reports only its release sha, so "older" is git ancestry: the backend on prod must
# contain the commit of that backend tag.
# Env: MIN_BE_VERSION_FILE (default deploy/min-be-version), BE_REPO (default {{REPO_BE}}),
# BE_REPO_TOKEN (optional; gh token for BE_REPO, used only for that read; otherwise gh's own login).
# Exit 0: the backend on prod is new enough. Exit 1: refused; nothing was deployed.
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

min_file=${MIN_BE_VERSION_FILE:-deploy/min-be-version}
be_repo=${BE_REPO:-{{REPO_BE}}}
minimum=$(tr -d '[:space:]' <"$min_file" 2>/dev/null) || true
[[ $minimum =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$min_file must hold one backend release tag vX.Y.Z"

load_project_env
health_url="https://$PROJECT_ZONE/health"
health=$(curl -fsS --max-time 10 "$health_url" 2>/dev/null) ||
  die "$health_url does not answer, so the backend version on prod is unknown. Nothing was deployed."
release=$(jq -r '.release // empty' <<<"$health" 2>/dev/null) || true
[[ $release =~ ^[0-9a-f]{40}$ ]] || die "backend /health reports no release sha. Nothing was deployed."

status=$(GH_TOKEN=${BE_REPO_TOKEN:-${GH_TOKEN:-}} gh api "repos/$be_repo/compare/$minimum...$release" --jq .status 2>/dev/null) || true
case $status in
  ahead | identical) echo "backend on prod ${release:0:7} contains $minimum (minimum for this release)" ;;
  *)
    die "backend on prod (${release:0:7}) is older than $minimum, the minimum this frontend release needs ($min_file; compare status: ${status:-unknown}). Release order is backend first: deploy backend $minimum or later to prod, then retry. Nothing was deployed."
    ;;
esac
