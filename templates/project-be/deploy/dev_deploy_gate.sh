#!/usr/bin/env bash
# Decides whether a workflow_run trigger of Dev Deploy should deploy HEAD_SHA.
#
# Dev Deploy is triggered once by "Rails Tests" and once by "Rails CI". It deploys only when the
# latest run of both is a success, and only from the trigger of the later-finished of the two
# (latest updated_at, then highest id), so exactly one of the two triggers deploys.
#
# Env: GH_REPO (owner/name), HEAD_SHA, TRIGGER_RUN_ID; needs gh and jq.
# Prints deploy=true|false and reason=<text>, ready for GITHUB_OUTPUT.
set -euo pipefail

: "${GH_REPO:?}" "${HEAD_SHA:?}" "${TRIGGER_RUN_ID:?}"

gh api "repos/${GH_REPO}/actions/runs?head_sha=${HEAD_SHA}&event=push&per_page=100" \
  | jq -r --argjson trigger "$TRIGGER_RUN_ID" '
      def latest($name): [.workflow_runs[] | select(.name == $name)] | max_by(.id);
      [latest("Rails Tests"), latest("Rails CI")] as $runs
      | if any($runs[]; . == null) then
          "false|waiting: \([$runs[] | select(. != null) | .name] | join(", ")) only, the other workflow has no run yet"
        elif any($runs[]; .status != "completed") then
          "false|waiting: \([$runs[] | select(.status != "completed") | .name] | join(", ")) not completed yet"
        elif any($runs[]; .conclusion != "success") then
          "false|not deploying: \([$runs[] | select(.conclusion != "success") | "\(.name) is \(.conclusion)"] | join(", "))"
        else
          ($runs | max_by([.updated_at, .id])) as $last
          | if $last.id == $trigger then "true|both green, \($last.name) finished last"
            else "false|skipped: both green, the \($last.name) trigger deploys"
            end
        end' \
  | {
    IFS='|' read -r deploy reason
    echo "deploy=${deploy}"
    echo "reason=${reason}"
  }
