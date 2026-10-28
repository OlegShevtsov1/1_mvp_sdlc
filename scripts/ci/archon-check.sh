#!/usr/bin/env bash
# Installs and tests every Archon workflow of this repository on each pinned Archon release:
# install.sh (which validates), `workflow test factory`, trace assertions per factory fixture (merge-gate
# executes in every one), runs in which pr-state, merge-gate and merge (or, for a pull request into a
# manual base, notify-operator) execute for real against the engine's own deliver output (only gh is
# faked; they also cover a merge gh refuses and a pull request that conflicts with its base), and a stubbed
# dry run of every orchestration/workflows/*.yaml. The Trello card nodes and rag-context run in dry-run
# mode in every fixture, and the traces assert each move at its node and rag-context before the plan.
# The Claude login checks run as dry runs in every fixture: claude-auth before the profile, claude-auth-scan
# before the report (also after a failed sync-base); one fixture stops at claude-auth-stop before the profile.
# sync-base is stubbed in every fixture and executes for real in a scratch run worktree cut from a
# default branch that has diverged from the profile's base_branch, and from a base it cannot fetch (the
# run must still end with a report). pr-body-sync is stubbed in every fixture and executes for real in
# the unstubbed runs: once replacing a stale description before pr-state, once with a failed edit that
# merge-gate refuses. Each binary must still name the artifacts pr-body-sync reads (its bundled
# delivery is embedded as text). visual-scope executes in every fixture that is not visual, which must
# pass visual-round straight on; the three visual fixtures stub it visual and assert the visual gate's
# path for approve, for a needs-revision round on the same pull request, and for abort; one more run
# gives visual-scope a UI task with no visual reference and asserts the run stops before the plan.
# review-state and followup-judge (PILOT-300) are stubbed or skipped in every fixture and review-followup
# executes in every one; two fixtures assert a round-3 replan followed up with a dry-run card and one
# the judge calls a new defect, and the unstubbed runs assert a ready delivery passes it untouched. Each
# binary must still embed the bundled text review-followup reads (_lib/follow-up.ts BUNDLED_LITERALS).
# A delivery that ends failed is delivered once more (PILOT-301): one fixture asserts a failed first
# delivery the retry delivers and merges, one a review route with no structured output that fails both
# deliveries and ends not delivered, and every other fixture asserts the retry was skipped.
# Needs the binaries from `tools.sh archon` and bun on PATH.
# Every Archon call runs with a throwaway ARCHON_HOME: without one a binary reads and writes the
# operator's live ~/.archon.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "${root}"
versions=(0.12.1)
fixtures_dir=orchestration/factory/.archon/workflows/sdlc-factory/factory/fixtures
# The fixture whose validation is red; it must end with the merge skipped.
red_fixture=validation-red-merge-refused
# The fixture whose merge gh refused; the run must end not delivered with gh's words in the report.
merge_failed_fixture=merge-refused-by-github
# The fixture whose validation is red for an environment cause while the PR's CI is green; it must merge.
env_fixture=validation-environment-ci-green
# The fixture whose review verdict is the interim one of PILOT-120; it must end before the merge path.
interim_fixture=review-interim-verdict
# The fixture whose pull request targets a manual base; it must end completed, pending the operator.
manual_fixture=manual-base-pending-operator
# The fixture whose description could not be republished; it must end with merge-gate refusing.
body_sync_fixture=pr-body-sync-failed
# The fixture whose Claude login has expired; it must stop at claude-auth-stop before the profile.
auth_fixture=claude-login-expired
# The bundled delivery's artifact names pr-body-sync reads, as the binary embeds them: read from
# _lib/pr-body.ts itself, so the check follows what the script relies on.
pr_body_lib=orchestration/factory/.archon/workflows/sdlc-factory/factory/scripts/_lib/pr-body.ts
# The visual gate fixtures (PILOT-278): approve, a needs-revision round then approve, and abort.
visual_approved_fixture=visual-review-approved
visual_revised_fixture=visual-review-revised
visual_aborted_fixture=visual-review-aborted
# The follow-up fixtures (PILOT-300): a round-3 replan re-raising R6 on a narrower case, followed up
# and delivered; and the same delivery the judge calls a new defect, which ends not delivered.
followup_fixture=review-followup-ready
followup_new_fixture=review-followup-new-defect
# The retry fixtures (PILOT-301): a failed delivery the retry delivers, and one that fails twice.
retry_fixture=delivery-failed-then-delivered
retry_twice_fixture=delivery-failed-twice
follow_up_lib=orchestration/factory/.archon/workflows/sdlc-factory/factory/scripts/_lib/follow-up.ts
# The green fixture the unstubbed merge runs start from.
green_fixture=existing-profile

command -v bun >/dev/null || { echo "archon-check: bun not found on PATH" >&2; exit 1; }
pr_body_literals_text=$(bun -e '
  const { CANDIDATES, PR_CREATE_STARTED } = await import(process.argv[1]);
  console.log([...CANDIDATES.map((name) => `$ARTIFACTS_DIR/${name}`), `\x27${PR_CREATE_STARTED}\x27`].join("\n"));
' "${root}/${pr_body_lib}")
mapfile -t pr_body_literals <<<"${pr_body_literals_text}"
follow_up_literals_text=$(bun -e '
  const { BUNDLED_LITERALS } = await import(process.argv[1]);
  console.log(BUNDLED_LITERALS.join("\n"));
' "${root}/${follow_up_lib}")
mapfile -t follow_up_literals <<<"${follow_up_literals_text}"

work=$(mktemp -d)
trap 'rm -rf "${work}"' EXIT

fail() { echo "FAIL archon $1: $2" >&2; exit 1; }
without_logs() { grep -v '^{"level"' || true; }

# The JSON output line Archon prints under a node's COMPLETED line.
node_output() {
  grep -E -A3 "^COMPLETED +$2 \\(" "$1" | grep -m1 '^  output: ' || true
}

# Every fixture run is a dry run: the Trello node computes its move and touches nothing.
expect_move() {
  local version=$1 name=$2 trace=$3 node=$4 list=$5 out
  out=$(node_output "${trace}" "${node}")
  grep -qF '"status":"dry-run"' <<<"${out}" && grep -qF "\"target\":\"${list}\"" <<<"${out}" ||
    fail "${version} ${name}" "${node} must move the card to ${list} in dry-run mode; output: ${out:-none}"
}

expect_skipped() {
  grep -qE "^SKIPPED +$4 \\(" "$3" || fail "$1 $2" "$4 must be skipped"
}

check_trello_moves() {
  local version=$1 name=$2 trace=$3 final=Ready done_line cancel_line
  expect_move "${version}" "${name}" "${trace}" trello-plan-gate Blocked
  expect_move "${version}" "${name}" "${trace}" trello-start "In Progress"
  if grep -qE '^SKIPPED +pr-state \(' "${trace}"; then
    expect_skipped "${version}" "${name}" "${trace}" trello-review
  else
    expect_move "${version}" "${name}" "${trace}" trello-review Review
  fi
  if grep -qF "profile-check: '{\"exists\":false}'" "${fixtures_dir}/${name}.stubs.yaml"; then
    expect_move "${version}" "${name}" "${trace}" trello-profile-gate Blocked
    expect_move "${version}" "${name}" "${trace}" trello-profile-round Ready
  else
    # A skipped loop prints no line for the nodes of its body.
    ! grep -qE '^COMPLETED +trello-profile-gate \(' "${trace}" ||
      fail "${version} ${name}" "trello-profile-gate ran although the profile exists"
    expect_skipped "${version}" "${name}" "${trace}" trello-profile-round
  fi
  case "${name}" in
  "${visual_approved_fixture}" | "${visual_revised_fixture}" | "${visual_aborted_fixture}")
    expect_move "${version}" "${name}" "${trace}" trello-visual-gate Blocked
    ;;
  esac
  case "${name}" in
  existing-profile | fresh-profile | "${env_fixture}" | "${visual_approved_fixture}" | "${visual_revised_fixture}" | \
    "${followup_fixture}" | "${retry_fixture}") final=Test ;;
  "${manual_fixture}") final=Review ;;
  esac
  expect_move "${version}" "${name}" "${trace}" trello-done "${final}"
  cancel_line=$(grep -nE '^COMPLETED +not-delivered' "${trace}" | cut -d: -f1 || true)
  [ -n "${cancel_line}" ] || return 0
  done_line=$(grep -nE '^COMPLETED +trello-done \(' "${trace}" | cut -d: -f1)
  [ "${done_line}" -lt "${cancel_line}" ] ||
    fail "${version} ${name}" "trello-done must move the card before not-delivered cancels the run"
}

# The pre-flight stops the run before anything else; every other fixture runs both login checks
# as dry runs: the pre-flight before the profile, the scan before the report.
check_claude_auth() {
  local version=$1 name=$2 trace=$3 auth_line profile_line scan_line report_line
  if [ "${name}" = "${auth_fixture}" ]; then
    grep -qE '^STUBBED +claude-auth \(' "${trace}" || fail "${version} ${name}" "claude-auth must be stubbed"
    grep -qE '^COMPLETED +claude-auth-stop' "${trace}" || fail "${version} ${name}" "claude-auth-stop did not stop the run"
    ! grep -qE '^(COMPLETED|STUBBED|FAILED) +(profile-check|rag-context|plan__plan) \(' "${trace}" ||
      fail "${version} ${name}" "work ran after the login check failed: $(grep -E '^[A-Z]+ ' "${trace}" | tail -40)"
    grep -qF 'claude /login' "${trace}" || fail "${version} ${name}" "the stop does not name claude /login"
    return 0
  fi
  grep -qF '"status":"dry-run"' <<<"$(node_output "${trace}" claude-auth)" ||
    fail "${version} ${name}" "claude-auth did not run as a dry run: $(node_output "${trace}" claude-auth)"
  auth_line=$(grep -nE '^COMPLETED +claude-auth \(' "${trace}" | cut -d: -f1)
  profile_line=$(grep -nE '^[A-Z]+ +profile-check \(' "${trace}" | head -1 | cut -d: -f1 || true)
  [ -n "${profile_line}" ] && [ "${auth_line}" -lt "${profile_line}" ] ||
    fail "${version} ${name}" "claude-auth must run before profile-check"
  expect_skipped "${version}" "${name}" "${trace}" claude-auth-stop
  grep -qF '"status":"dry-run"' <<<"$(node_output "${trace}" claude-auth-scan)" ||
    fail "${version} ${name}" "claude-auth-scan did not run as a dry run: $(node_output "${trace}" claude-auth-scan)"
  scan_line=$(grep -nE '^COMPLETED +claude-auth-scan \(' "${trace}" | cut -d: -f1)
  report_line=$(grep -nE '^COMPLETED +report \(' "${trace}" | cut -d: -f1 || true)
  [ -z "${report_line}" ] || [ "${scan_line}" -lt "${report_line}" ] ||
    fail "${version} ${name}" "claude-auth-scan must run before the report"
}

# The line number of a node's first line in a trace.
line_of() {
  grep -nE "^[A-Z]+ +$2 \\(" "$1" | head -1 | cut -d: -f1 || true
}

check_visual_trace() {
  local version=$1 name=$2 trace=$3 out want previous=0 node at
  case "${name}" in
  "${visual_approved_fixture}" | "${visual_revised_fixture}" | "${visual_aborted_fixture}") ;;
  *)
    # A task that is not visual: visual-scope executes and says so, there is no gate, and a ready
    # delivery passes visual-round straight on (interim-verdict's delivery is not ready, so it skips).
    grep -qF '"visual":false' <<<"$(node_output "${trace}" visual-scope)" ||
      fail "${version} ${name}" "visual-scope must execute and find no UI task: $(grep -E '^[A-Z]+ +visual-scope' "${trace}" || true)"
    expect_skipped "${version}" "${name}" "${trace}" visual-cycle
    grep -qF '"proceed":true' <<<"$(node_output "${trace}" visual-round)" || expect_skipped "${version}" "${name}" "${trace}" visual-round
    return 0
    ;;
  esac
  out=$(node_output "${trace}" visual-shots)
  grep -qF '"ready":true' <<<"${out}" && grep -qE 'blob/[0-9a-f]{40}/[^"]*/home-desktop-light-data\.png\?raw=true' <<<"${out}" ||
    fail "${version} ${name}" "visual-shots must list the committed screenshots as links at the head: ${out:-none}"
  grep -qE '^COMPLETED +visual-round \(' "${trace}" || fail "${version} ${name}" "visual-round must execute"
  case "${name}" in
  "${visual_revised_fixture}")
    out=$(node_output "${trace}" revise__report)
    grep -qF '"ready":true' <<<"${out}" && grep -qF '"pr_url":"https://github.com/example/repo/pull/3"' <<<"${out}" ||
      fail "${version} ${name}" "the revision must deliver on the first delivery's pull request: ${out:-none}"
    [ "$(grep -cE '^[A-Z]+ +implement__implement \(' "${trace}")" -eq 2 ] ||
      fail "${version} ${name}" "the revision must run its own implement round"
    for node in deliver__report visual-turn revise__report visual-shots visual-gate; do
      at=$(line_of "${trace}" "${node}")
      [ -n "${at}" ] && [ "${previous}" -lt "${at}" ] || fail "${version} ${name}" "${node} is out of order in the visual round"
      previous=${at}
    done
    ;;
  *)
    ! grep -qE '^COMPLETED +revise__report \(' "${trace}" || fail "${version} ${name}" "the first visual round must revise nothing"
    ;;
  esac
  if [ "${name}" = "${visual_aborted_fixture}" ]; then
    grep -qF '"proceed":false' <<<"$(node_output "${trace}" visual-round)" || fail "${version} ${name}" "visual-round must stop the run"
    for want in 'SKIPPED +pr-body-sync' 'SKIPPED +pr-state' 'SKIPPED +merge-gate' 'SKIPPED +merge' 'COMPLETED +not-delivered'; do
      grep -qE "^${want}( |\$)" "${trace}" || fail "${version} ${name}" "trace lacks ${want}"
    done
    grep -qF 'stopped at the visual gate (operator chose abort: too dark)' "${trace}" ||
      fail "${version} ${name}" "the report does not name the visual gate's abort"
  else
    grep -qF '"proceed":true' <<<"$(node_output "${trace}" visual-round)" || fail "${version} ${name}" "approve must pass visual-round"
    for want in 'COMPLETED +merge-gate' 'STUBBED +merge' 'SKIPPED +not-delivered'; do
      grep -qE "^${want}( |\$)" "${trace}" || fail "${version} ${name}" "trace lacks ${want}"
    done
  fi
}

check_retry_trace() {
  local version=$1 name=$2 trace=$3 out node at previous=0 want
  out=$(node_output "${trace}" last-delivery)
  case "${name}" in
  "${retry_fixture}")
    grep -qF '"ready":true' <<<"$(node_output "${trace}" redeliver__report)" &&
      grep -qF '"pr_url":"https://github.com/example/repo/pull/3"' <<<"$(node_output "${trace}" redeliver__report)" ||
      fail "${version} ${name}" "the retry must deliver on the run's pull request: $(node_output "${trace}" redeliver__report)"
    [ "$(grep -cE '^[A-Z]+ +implement__implement \(' "${trace}")" -eq 2 ] ||
      fail "${version} ${name}" "the retry must run its own implement round"
    for node in deliver__report redeliver__report last-delivery review-followup; do
      at=$(line_of "${trace}" "${node}")
      [ -n "${at}" ] && [ "${previous}" -lt "${at}" ] || fail "${version} ${name}" "${node} is out of order around the retry"
      previous=${at}
    done
    grep -qF '"ready":true' <<<"${out}" && grep -qE '"retry_note":"[^"]+' <<<"${out}" ||
      fail "${version} ${name}" "last-delivery must hand on the retry's ready report with a note: ${out:-none}"
    for want in 'STUBBED +merge' 'SKIPPED +not-delivered'; do
      grep -qE "^${want} \\(" "${trace}" || fail "${version} ${name}" "trace lacks ${want}"
    done
    grep -qF 'Retried the delivery once: the first delivery ended failed' <<<"$(node_output "${trace}" report)" ||
      fail "${version} ${name}" "the report does not say it retried and why: $(node_output "${trace}" report)"
    ;;
  "${retry_twice_fixture}")
    [ "$(grep -cE '^FAILED +review__route \(' "${trace}")" -eq 2 ] ||
      fail "${version} ${name}" "the review route must fail in both deliveries"
    for node in deliver__report redeliver__report; do
      grep -qF '"reason":"failed"' <<<"$(node_output "${trace}" "${node}")" ||
        fail "${version} ${name}" "${node} must end failed: $(node_output "${trace}" "${node}")"
    done
    [ "$(grep -cE '^[A-Z]+ +(deliver|redeliver)__report \(' "${trace}")" -eq 2 ] ||
      fail "${version} ${name}" "exactly two deliveries may run"
    grep -qF '"reason":"failed"' <<<"${out}" || fail "${version} ${name}" "last-delivery must hand on the failed retry: ${out:-none}"
    for want in 'SKIPPED +pr-state' 'SKIPPED +merge-gate' 'SKIPPED +merge' 'COMPLETED +not-delivered'; do
      grep -qE "^${want}( |\$)" "${trace}" || fail "${version} ${name}" "trace lacks ${want}"
    done
    grep -qF 'the delivery ended not ready (failed)' "${trace}" && grep -qF 'Retried the delivery once:' "${trace}" ||
      fail "${version} ${name}" "the report does not say both deliveries failed"
    ;;
  *)
    # Every other reason (delivered, review_open, replan) skips the retry.
    expect_skipped "${version}" "${name}" "${trace}" redeliver__forge
    ! grep -qE '^(COMPLETED|STUBBED|FAILED) +redeliver__' "${trace}" ||
      fail "${version} ${name}" "a delivery that did not fail was retried: $(grep -E '^[A-Z]+ +redeliver__' "${trace}")"
    grep -qF '"retry_note":""' <<<"${out}" || fail "${version} ${name}" "last-delivery must pass the delivery through: ${out:-none}"
    ;;
  esac
}

check_fixture_trace() {
  local version=$1 name=$2 trace=$3
  local gate_lines state_lines body_lines notify_lines sync_lines rag_line plan_line node lines out allowed
  check_claude_auth "${version}" "${name}" "${trace}"
  [ "${name}" != "${auth_fixture}" ] || return 0
  check_trello_moves "${version}" "${name}" "${trace}"
  check_visual_trace "${version}" "${name}" "${trace}"
  check_retry_trace "${version}" "${name}" "${trace}"
  # rag-context executes in every fixture, as a dry run (no request), before the plan reads its file.
  rag_line=$(grep -nE '^COMPLETED +rag-context \(' "${trace}" | cut -d: -f1 || true)
  [ -n "${rag_line}" ] || fail "${version} ${name}" "rag-context must execute, never be stubbed: $(grep -E '^[A-Z]+ +rag-context' "${trace}" || true)"
  grep -qF '"status":"dry-run"' <<<"$(node_output "${trace}" rag-context)" ||
    fail "${version} ${name}" "rag-context did not run as a dry run: $(node_output "${trace}" rag-context)"
  plan_line=$(grep -nE '^[A-Z]+ +plan__plan \(' "${trace}" | head -1 | cut -d: -f1 || true)
  [ -n "${plan_line}" ] && [ "${rag_line}" -lt "${plan_line}" ] ||
    fail "${version} ${name}" "rag-context must run before the plan"
  ! grep -qE '^COMPLETED +report \(' "${trace}" || grep -qF '"rag_status":"dry-run"' <<<"$(node_output "${trace}" report)" ||
    fail "${version} ${name}" "the report does not record rag_status dry-run: $(node_output "${trace}" report)"
  gate_lines=$(grep -E '^[A-Z]+ +merge-gate \(' "${trace}" || true)
  [ -n "${gate_lines}" ] || fail "${version} ${name}" "no merge-gate line in the trace"
  ! grep -vE '^(COMPLETED|SKIPPED) ' <<<"${gate_lines}" >/dev/null ||
    fail "${version} ${name}" "merge-gate must execute (or be skipped), never be stubbed: ${gate_lines}"
  # pr-state talks to GitHub; a fixture must never reach it.
  state_lines=$(grep -E '^[A-Z]+ +pr-state \(' "${trace}" || true)
  [ -n "${state_lines}" ] || fail "${version} ${name}" "no pr-state line in the trace"
  ! grep -vE '^(STUBBED|SKIPPED) ' <<<"${state_lines}" >/dev/null ||
    fail "${version} ${name}" "pr-state must be stubbed or skipped in a test: ${state_lines}"
  # pr-body-sync talks to GitHub; a fixture must never reach it.
  body_lines=$(grep -E '^[A-Z]+ +pr-body-sync \(' "${trace}" || true)
  [ -n "${body_lines}" ] || fail "${version} ${name}" "no pr-body-sync line in the trace"
  ! grep -vE '^(STUBBED|SKIPPED) ' <<<"${body_lines}" >/dev/null ||
    fail "${version} ${name}" "pr-body-sync must be stubbed or skipped in a test: ${body_lines}"
  # review-state reads GitHub and followup-judge is an agent; a fixture must never reach either.
  for node in review-state followup-judge; do
    lines=$(grep -E "^[A-Z]+ +${node} \\(" "${trace}" || true)
    [ -n "${lines}" ] || fail "${version} ${name}" "no ${node} line in the trace"
    ! grep -vE '^(STUBBED|SKIPPED) ' <<<"${lines}" >/dev/null ||
      fail "${version} ${name}" "${node} must be stubbed or skipped in a test: ${lines}"
  done
  # review-followup executes in every fixture and follows up only in the follow-up fixture.
  out=$(node_output "${trace}" review-followup)
  case "${name}" in
  "${followup_fixture}")
    grep -qF '"ready":true' <<<"${out}" && grep -qF '"reason":"follow_up"' <<<"${out}" &&
      grep -qF '"cards":[{"finding":"R6","url":"","status":"dry-run"}]' <<<"${out}" ||
      fail "${version} ${name}" "review-followup must follow R6 up with a dry-run card: ${out:-none}"
    for want in 'COMPLETED +visual-round' 'STUBBED +pr-state' 'COMPLETED +merge-gate' 'STUBBED +merge' 'COMPLETED +report' \
      'SKIPPED +not-delivered'; do
      grep -qE "^${want} \\(" "${trace}" || fail "${version} ${name}" "trace lacks ${want}"
    done
    grep -qF 'Follow-up cards: R6 → (dry run).' <<<"$(node_output "${trace}" report)" ||
      fail "${version} ${name}" "the report does not name the follow-up card: $(node_output "${trace}" report)"
    ;;
  "${followup_new_fixture}")
    grep -qF '"ready":false' <<<"${out}" && grep -qF '"reason":"replan"' <<<"${out}" && grep -qF '"cards":[]' <<<"${out}" ||
      fail "${version} ${name}" "review-followup must pass the replan through not ready: ${out:-none}"
    for want in 'SKIPPED +pr-state' 'SKIPPED +merge-gate' 'SKIPPED +merge' 'COMPLETED +not-delivered'; do
      grep -qE "^${want}( |\$)" "${trace}" || fail "${version} ${name}" "trace lacks ${want}"
    done
    grep -qF 'the delivery ended not ready (replan). Not ready: Round 3: replan.' "${trace}" &&
      grep -qF 'Not followed up: the judge found R6 new, not a narrower case of an earlier finding.' "${trace}" ||
      fail "${version} ${name}" "the report does not quote the replan and why it was not followed up"
    ;;
  *)
    [ -n "${out}" ] && grep -qF '"followed_up":false' <<<"${out}" && grep -qF '"cards":[]' <<<"${out}" &&
      ! grep -qF 'Not followed up' <<<"${out}" ||
      fail "${version} ${name}" "review-followup must execute and pass the delivery through: ${out:-none}"
    ;;
  esac
  # sync-base fetches and hard-resets the checkout; a fixture must never reach it.
  sync_lines=$(grep -E '^[A-Z]+ +sync-base \(' "${trace}" || true)
  [ -n "${sync_lines}" ] || fail "${version} ${name}" "no sync-base line in the trace"
  ! grep -vE '^STUBBED ' <<<"${sync_lines}" >/dev/null ||
    fail "${version} ${name}" "sync-base must be stubbed in a test: it fetches and resets the checkout: ${sync_lines}"
  # notify-operator comments on GitHub; a fixture must never reach it either.
  notify_lines=$(grep -E '^[A-Z]+ +notify-operator \(' "${trace}" || true)
  [ -n "${notify_lines}" ] || fail "${version} ${name}" "no notify-operator line in the trace"
  ! grep -vE '^(STUBBED|SKIPPED) ' <<<"${notify_lines}" >/dev/null ||
    fail "${version} ${name}" "notify-operator must be stubbed or skipped in a test: ${notify_lines}"
  if [ "${name}" = "${manual_fixture}" ]; then
    local want
    for want in 'COMPLETED +merge-gate' 'SKIPPED +merge' 'STUBBED +notify-operator' 'SKIPPED +deploy' 'SKIPPED +health' \
      'SKIPPED +rollback' 'COMPLETED +report' 'SKIPPED +not-delivered'; do
      grep -qE "^${want} \\(" "${trace}" || fail "${version} ${name}" "trace lacks ${want}: $(grep -E '^[A-Z]+ ' "${trace}" | tail -40)"
    done
    grep -q 'delivered-pending-operator' "${trace}" || fail "${version} ${name}" "the report is not delivered-pending-operator"
  else
    grep -qE '^SKIPPED +notify-operator \(' "${trace}" || fail "${version} ${name}" "notify-operator ran for a base that is not manual"
  fi
  if [ "${name}" = "${env_fixture}" ]; then
    grep -qE '^STUBBED +pr__publish \(' "${trace}" ||
      fail "${version} ${name}" "the deliver block did not hand the environment red on to the pull request"
    grep -qF '"ready":true' <<<"$(node_output "${trace}" deliver__report)" ||
      fail "${version} ${name}" "the delivery did not end ready: $(node_output "${trace}" deliver__report)"
    grep -qE '^COMPLETED +merge-gate \(' "${trace}" && grep -qE '^STUBBED +merge \(' "${trace}" ||
      fail "${version} ${name}" "merge-gate did not lead to the merge: ${gate_lines}"
    grep -qE '^SKIPPED +not-delivered' "${trace}" || fail "${version} ${name}" "the run was not delivered"
  fi
  # The failed-twice fixture's route defect fails the route, what reads it, and both rounds loops.
  allowed='^$'
  [ "${name}" != "${retry_twice_fixture}" ] || allowed='^FAILED +(review__route|review__synthesize|deliver__rounds|redeliver__rounds) \('
  ! grep '^FAILED' "${trace}" | grep -qvE "${allowed}" ||
    fail "${version} ${name}" "unexpected failure: $(grep '^FAILED' "${trace}" | grep -vE "${allowed}")"
  local want
  if [ "${name}" = "${merge_failed_fixture}" ]; then
    for want in 'STUBBED +merge' 'SKIPPED +deploy' 'COMPLETED +report' 'COMPLETED +not-delivered'; do
      grep -qE "^${want} \\(" "${trace}" || fail "${version} ${name}" "trace lacks ${want}: $(grep -E '^[A-Z]+ ' "${trace}" | tail -40)"
    done
    grep -qF 'merge refused (merge: gh pr merge failed:' "${trace}" || fail "${version} ${name}" "the report does not carry gh's refusal"
  fi
  if [ "${name}" = "${red_fixture}" ]; then
    grep -qE '^COMPLETED +merge-gate \(' "${trace}" && grep -q 'test command exited 1 on the pull request head' "${trace}" ||
      fail "${version} ${name}" "merge-gate did not refuse on its own test run"
    for want in 'SKIPPED +merge' 'COMPLETED +not-delivered'; do
      grep -qE "^${want}( |\$)" "${trace}" || fail "${version} ${name}" "trace lacks ${want}"
    done
  fi
  if [ "${name}" = "${body_sync_fixture}" ]; then
    grep -qE '^COMPLETED +merge-gate \(' "${trace}" &&
      grep -q 'the pull request description could not be republished: gh pr edit exited 1' "${trace}" ||
      fail "${version} ${name}" "merge-gate did not refuse the description that was not republished"
    for want in 'SKIPPED +merge' 'COMPLETED +not-delivered'; do
      grep -qE "^${want}( |\$)" "${trace}" || fail "${version} ${name}" "trace lacks ${want}"
    done
  fi
  if [ "${name}" = "${interim_fixture}" ]; then
    grep -qF '"reason":"review_open"' <<<"$(node_output "${trace}" deliver__report)" ||
      fail "${version} ${name}" "the delivery did not end review_open: $(node_output "${trace}" deliver__report)"
    for want in 'SKIPPED +pr-state' 'SKIPPED +merge-gate' 'SKIPPED +merge' 'COMPLETED +not-delivered'; do
      grep -qE "^${want}( |\$)" "${trace}" || fail "${version} ${name}" "trace lacks ${want}"
    done
    grep -qF 'the delivery ended not ready (review_open). Not ready: Round 1: review_open. Not yet finalized' "${trace}" ||
      fail "${version} ${name}" "the report does not quote the delivery's reason and summary"
    ! grep -q 'invalid review verdict' "${trace}" || fail "${version} ${name}" "the review verdict was rejected"
  fi
}

# A scratch repository for the unstubbed merge runs: its origin is a local bare repository, so the
# merge node's branch deletion never reaches a real remote.
scratch="${work}/scratch"
git init -q --bare "${work}/remote/example/repo.git"
git init -q "${scratch}"
git -C "${scratch}" -c user.name=archon-check -c user.email=archon-check@example.com commit -q --allow-empty -m init
git -C "${scratch}" remote add origin "${work}/remote/example/repo.git"
# Fixtures stub pr-state because `workflow test factory` also runs on an operator's host with a
# real gh. Here a fake gh answers for the pull request whose head is the scratch checkout.
mkdir -p "${work}/fake-bin"
cat >"${work}/fake-bin/gh" <<'GH'
#!/usr/bin/env bash
case "$*" in
  "pr view "*" --json headRefOid,headRefName,isDraft,state,baseRefName,mergeable")
    printf '{"headRefOid":"%s","headRefName":"fixture-branch","isDraft":false,"state":"OPEN","baseRefName":"%s","mergeable":"%s"}\n' \
      "${FAKE_GH_HEAD_OID}" "${FAKE_GH_BASE:-develop}" "${FAKE_GH_MERGEABLE:-MERGEABLE}" ;;
  "pr view "*" --json statusCheckRollup") printf '%s\n' '{"statusCheckRollup":[]}' ;;
  "api repos/example/repo/actions/runs?head_sha="*) echo 0 ;;
  "pr merge "*) [ -z "${FAKE_GH_MERGE_ERROR:-}" ] || { printf '%s\n' "${FAKE_GH_MERGE_ERROR}" >&2; exit 1; } ;;
  "pr comment "*) printf '%s\n' "$*" >>"${FAKE_GH_COMMENTS}" ;;
  *"--json state --jq .state") echo "${FAKE_GH_STATE_AFTER_MERGE:-MERGED}" ;;
  *"--json mergeCommit "*) printf '%s\n' "${FAKE_GH_MERGE_COMMIT}" ;;
  *"--json headRefName --jq .headRefName") echo fixture-branch ;;
  "pr view https://github.com/example/repo/pull/3 --json body --jq .body")
    # Stands in for the stubbed pr__prepare, which writes pr-body.md: the run's artifacts dir is only
    # known inside the run, and pr-body-sync reads the live body before it looks for the file.
    if [ -n "${FAKE_GH_SEED_BODY:-}" ] && [ ! -e "${ARTIFACTS_DIR}/pr-body.md" ]; then
      printf '%s' "${FAKE_GH_SEED_BODY}" >"${ARTIFACTS_DIR}/pr-body.md"
    fi
    if [ -f "${FAKE_GH_EDIT_FILE}" ]; then
      cat "${FAKE_GH_EDIT_FILE}"
    else
      printf '%s' "${FAKE_GH_LIVE_BODY:-}"
    fi ;;
  "pr edit https://github.com/example/repo/pull/3 --body-file "*)
    [ -z "${FAKE_GH_EDIT_ERROR:-}" ] || { printf '%s\n' "${FAKE_GH_EDIT_ERROR}" >&2; exit 1; }
    cp "${@: -1}" "${FAKE_GH_EDIT_FILE}" ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 1 ;;
esac
GH
chmod +x "${work}/fake-bin/gh"
export FAKE_GH_HEAD_OID FAKE_GH_COMMENTS="${work}/gh-comments" FAKE_GH_EDIT_FILE="${work}/gh-edit.md"
FAKE_GH_HEAD_OID=$(git -C "${scratch}" rev-parse HEAD)
sed -e '/^pr-body-sync:/d' -e '/^pr-state:/d' -e '/^merge:/d' -e '/^exec-code:/,$d' \
  "${fixtures_dir}/${green_fixture}.stubs.yaml" >"${work}/unstubbed-merge.stubs.yaml"

# Runs the factory with pr-body-sync, pr-state, merge-gate, merge and notify-operator unstubbed against a pull
# request into base (default develop) that GitHub reports as mergeable (default MERGEABLE); a non-empty
# merge_error makes `gh pr merge` print it and exit 1; state_after_merge (default MERGED) is the state
# gh reads back after the merge. The trace goes to trace.out.
run_unstubbed_merge() {
  local archon_bin=$1 merge_commit=$2 base=${3:-develop} mergeable=${4:-MERGEABLE} merge_error=${5:-} \
    state_after_merge=${6:-MERGED}
  PATH="${work}/fake-bin:${PATH}" FAKE_GH_MERGE_COMMIT="${merge_commit}" FAKE_GH_BASE="${base}" \
    FAKE_GH_MERGEABLE="${mergeable}" FAKE_GH_MERGE_ERROR="${merge_error}" \
    FAKE_GH_STATE_AFTER_MERGE="${state_after_merge}" \
    "${archon_bin}" workflow run factory --cwd "${scratch}" --dry-run --stubs "${work}/unstubbed-merge.stubs.yaml" \
    --exec-code --input task=fixture 2>&1 | without_logs >"${work}/trace.out" || true
}

expect_trace() {
  local label=$1 pattern=$2
  grep -qE "${pattern}" "${work}/trace.out" ||
    fail "${label}" "trace lacks /${pattern}/: $(grep -E '^[A-Z]+ ' "${work}/trace.out" | tail -40)"
}

check_unstubbed_merge() {
  local version=$1 archon_bin=$2 label body_line state_line
  # The live description is round 1's; the run's pr-body.md is round 2's.
  label="${version} unstubbed pr-state and merge-gate"
  rm -f "${FAKE_GH_EDIT_FILE}"
  export FAKE_GH_SEED_BODY=$'## Problem\nfixture body, round 2\n' FAKE_GH_LIVE_BODY=$'## Problem\nfixture body, round 1\n'
  run_unstubbed_merge "${archon_bin}" 0123456789abcdef0123456789abcdef01234567
  unset FAKE_GH_SEED_BODY FAKE_GH_LIVE_BODY
  ! grep -q '^FAILED' "${work}/trace.out" || fail "${label}" "unexpected failure: $(grep '^FAILED' "${work}/trace.out")"
  expect_trace "${label}" '^COMPLETED +pr-body-sync \('
  grep -qF '"action":"updated"' <<<"$(node_output "${work}/trace.out" pr-body-sync)" ||
    fail "${label}" "pr-body-sync did not update the description: $(node_output "${work}/trace.out" pr-body-sync)"
  body_line=$(grep -nE '^COMPLETED +pr-body-sync \(' "${work}/trace.out" | cut -d: -f1)
  state_line=$(grep -nE '^COMPLETED +pr-state \(' "${work}/trace.out" | cut -d: -f1 || true)
  [ -n "${state_line}" ] && [ "${body_line}" -lt "${state_line}" ] || fail "${label}" "pr-body-sync must complete before pr-state"
  grep -qF 'fixture body, round 2' "${FAKE_GH_EDIT_FILE}" 2>/dev/null ||
    fail "${label}" "the edit did not carry the run's pr-body.md"
  expect_trace "${label}" '^COMPLETED +pr-state \('
  expect_trace "${label}" '^COMPLETED +merge-gate \('
  expect_trace "${label}" '^COMPLETED +merge \('
  expect_trace "${label}" '^SKIPPED +notify-operator \('
  expect_trace "${label}" '^STUBBED +deploy \('
  expect_trace "${label}" '^SKIPPED +not-delivered \('
  # A ready delivery is never considered: no GitHub read, and the report passes through.
  expect_trace "${label}" '^SKIPPED +review-state \('
  expect_trace "${label}" '^SKIPPED +followup-judge \('
  grep -qF '"ready":true,"reason":"delivered"' <<<"$(node_output "${work}/trace.out" review-followup)" &&
    grep -qF '"followed_up":false' <<<"$(node_output "${work}/trace.out" review-followup)" ||
    fail "${label}" "review-followup must pass the ready delivery through: $(node_output "${work}/trace.out" review-followup)"
  # The task names no card, so no Trello node may act.
  grep -qF '"status":"none"' <<<"$(node_output "${work}/trace.out" trello-start)" ||
    fail "${label}" "trello-start must report no card: $(node_output "${work}/trace.out" trello-start)"

  # GitHub has not published the merge commit yet: the merge is real, so the run must still
  # report it, and nothing may be deployed from an unknown commit.
  label="${version} merged, merge commit unreadable"
  run_unstubbed_merge "${archon_bin}" ""
  ! grep -q '^FAILED' "${work}/trace.out" || fail "${label}" "unexpected failure: $(grep '^FAILED' "${work}/trace.out")"
  expect_trace "${label}" '^COMPLETED +merge \('
  expect_trace "${label}" '^SKIPPED +notify-operator \('
  expect_trace "${label}" '^SKIPPED +deploy \('
  expect_trace "${label}" '^COMPLETED +report \('
  expect_trace "${label}" '^COMPLETED +not-delivered'
  expect_trace "${label}" 'merge commit could not be read'

  # Decision 27: a green pull request into main is left to the operator, who is told on the PR.
  label="${version} unstubbed manual base"
  rm -f "${FAKE_GH_COMMENTS}"
  run_unstubbed_merge "${archon_bin}" 0123456789abcdef0123456789abcdef01234567 main
  ! grep -q '^FAILED' "${work}/trace.out" || fail "${label}" "unexpected failure: $(grep '^FAILED' "${work}/trace.out")"
  expect_trace "${label}" '^COMPLETED +pr-state \('
  expect_trace "${label}" '^COMPLETED +merge-gate \('
  expect_trace "${label}" '^SKIPPED +merge \('
  expect_trace "${label}" '^COMPLETED +notify-operator \('
  expect_trace "${label}" '^SKIPPED +deploy \('
  expect_trace "${label}" '^COMPLETED +report \('
  expect_trace "${label}" '^SKIPPED +not-delivered'
  grep -q 'ready for the operator: base main is manual' "${FAKE_GH_COMMENTS}" 2>/dev/null ||
    fail "${label}" "no operator comment was posted on the pull request"

  # gh refuses the merge (its real conflict text): the run must end not delivered with gh's words,
  # not fail at the report.
  label="${version} gh pr merge refused"
  run_unstubbed_merge "${archon_bin}" "" develop MERGEABLE \
    $'X Pull request example/repo#3 is not mergeable: the merge commit cannot be cleanly created.\nTo have the pull request merged after all the requirements have been met, add the --auto flag.'
  ! grep -q '^FAILED' "${work}/trace.out" || fail "${label}" "unexpected failure: $(grep '^FAILED' "${work}/trace.out")"
  expect_trace "${label}" '^COMPLETED +merge \('
  expect_trace "${label}" '^SKIPPED +deploy \('
  expect_trace "${label}" '^COMPLETED +report \('
  expect_trace "${label}" '^COMPLETED +trello-done \('
  expect_trace "${label}" '^COMPLETED +not-delivered'
  expect_trace "${label}" 'merge refused \(merge: gh pr merge failed: X Pull request example/repo#3 is not mergeable'

  # gh reports success but the pull request reads back still open: the merge did not happen.
  label="${version} pull request not MERGED after the merge"
  run_unstubbed_merge "${archon_bin}" "" develop MERGEABLE "" OPEN
  ! grep -q '^FAILED' "${work}/trace.out" || fail "${label}" "unexpected failure: $(grep '^FAILED' "${work}/trace.out")"
  expect_trace "${label}" '^COMPLETED +merge \('
  expect_trace "${label}" '^SKIPPED +deploy \('
  expect_trace "${label}" '^COMPLETED +report \('
  expect_trace "${label}" '^COMPLETED +not-delivered'
  expect_trace "${label}" 'merge refused \(merge: pull request is not MERGED after the merge \(state: OPEN\)'

  # The edit of a stale description fails: merge-gate refuses before anything is merged.
  label="${version} pull request description not republished"
  rm -f "${FAKE_GH_EDIT_FILE}"
  export FAKE_GH_SEED_BODY=$'## Problem\nfixture body, round 2\n' FAKE_GH_LIVE_BODY=$'## Problem\nfixture body, round 1\n' \
    FAKE_GH_EDIT_ERROR='HTTP 502: Bad Gateway'
  run_unstubbed_merge "${archon_bin}" ""
  unset FAKE_GH_SEED_BODY FAKE_GH_LIVE_BODY FAKE_GH_EDIT_ERROR
  ! grep -q '^FAILED' "${work}/trace.out" || fail "${label}" "unexpected failure: $(grep '^FAILED' "${work}/trace.out")"
  expect_trace "${label}" '^COMPLETED +pr-body-sync \('
  expect_trace "${label}" '^COMPLETED +merge-gate \('
  expect_trace "${label}" '^SKIPPED +merge \('
  expect_trace "${label}" '^COMPLETED +not-delivered'
  expect_trace "${label}" 'the pull request description could not be republished: gh pr edit exited 1: HTTP 502: Bad Gateway'

  # GitHub already reports the conflict: merge-gate refuses before anything is merged.
  label="${version} pull request conflicts with its base"
  run_unstubbed_merge "${archon_bin}" "" develop CONFLICTING
  ! grep -q '^FAILED' "${work}/trace.out" || fail "${label}" "unexpected failure: $(grep '^FAILED' "${work}/trace.out")"
  expect_trace "${label}" '^COMPLETED +merge-gate \('
  expect_trace "${label}" '^SKIPPED +merge \('
  expect_trace "${label}" '^COMPLETED +not-delivered'
  expect_trace "${label}" 'merge refused \(the pull request is not mergeable: it conflicts with develop\)'
}

# Reproduces how Archon cuts a run worktree: from origin/main of a repository whose profile names
# develop, the two branches diverged. sync-base executes for real and must move the run branch to
# develop before the plan starts.
check_sync_base() {
  local version=$1 archon_bin=$2 label="${version} sync-base from the default branch" dir seed run main_tip develop_tip
  local ident=(-c user.name=archon-check -c user.email=archon-check@example.com) sync_line plan_line out
  dir="${work}/sync-${version}"
  seed="${dir}/seed"
  run="${dir}/run"
  git init -q --bare -b main "${dir}/origin.git"
  git init -q -b main "${seed}"
  git -C "${seed}" remote add origin "${dir}/origin.git"
  git -C "${seed}" "${ident[@]}" commit -q --allow-empty -m base
  git -C "${seed}" checkout -q -b develop
  git -C "${seed}" "${ident[@]}" commit -q --allow-empty -m develop-only
  git -C "${seed}" checkout -q main
  git -C "${seed}" "${ident[@]}" commit -q --allow-empty -m main-only
  git -C "${seed}" push -q origin main develop
  git clone -q "${dir}/origin.git" "${dir}/clone"
  git -C "${dir}/clone" worktree add -q -b archon/task-factory-fixture "${run}" origin/main
  main_tip=$(git -C "${dir}/clone" rev-parse origin/main)
  develop_tip=$(git -C "${dir}/clone" rev-parse origin/develop)
  [ "$(git -C "${run}" rev-parse HEAD)" = "${main_tip}" ] || fail "${label}" "the run worktree does not start at main"

  sed -e '/^sync-base:/d' -e '/^exec-code:/,$d' "${fixtures_dir}/${green_fixture}.stubs.yaml" >"${work}/sync-base.stubs.yaml"
  "${archon_bin}" workflow run factory --cwd "${run}" --dry-run --stubs "${work}/sync-base.stubs.yaml" \
    --exec-code --input task=fixture 2>&1 | without_logs >"${work}/trace.out" || true
  ! grep -q '^FAILED' "${work}/trace.out" || fail "${label}" "unexpected failure: $(grep '^FAILED' "${work}/trace.out")"
  expect_trace "${label}" '^COMPLETED +sync-base \('
  out=$(node_output "${work}/trace.out" sync-base)
  grep -qF '"action":"reset"' <<<"${out}" && grep -qF "\"before\":\"${main_tip}\"" <<<"${out}" &&
    grep -qF "\"after\":\"${develop_tip}\"" <<<"${out}" ||
    fail "${label}" "sync-base must reset from ${main_tip} to ${develop_tip}; output: ${out:-none}"
  sync_line=$(grep -nE '^COMPLETED +sync-base \(' "${work}/trace.out" | cut -d: -f1)
  plan_line=$(grep -nE '^[A-Z]+ +plan__plan \(' "${work}/trace.out" | head -1 | cut -d: -f1)
  [ -n "${plan_line}" ] && [ "${sync_line}" -lt "${plan_line}" ] || fail "${label}" "sync-base must complete before the plan"
  [ "$(git -C "${run}" rev-parse HEAD)" = "${develop_tip}" ] || fail "${label}" "the run worktree is not at develop"
  [ "$(git -C "${run}" symbolic-ref --short HEAD)" = archon/task-factory-fixture ] ||
    fail "${label}" "the run worktree left its branch"

  # The base cannot be fetched: sync-base fails, everything after it is skipped, and the run must
  # still end with a report that records the skipped rag-context.
  label="${version} sync-base cannot fetch the base"
  git -C "${run}" remote set-url origin "${dir}/missing.git"
  "${archon_bin}" workflow run factory --cwd "${run}" --dry-run --stubs "${work}/sync-base.stubs.yaml" \
    --exec-code --input task=fixture 2>&1 | without_logs >"${work}/trace.out" || true
  expect_trace "${label}" '^FAILED +sync-base \('
  expect_trace "${label}" '^SKIPPED +rag-context \('
  expect_trace "${label}" '^COMPLETED +claude-auth-scan \('
  expect_trace "${label}" '^COMPLETED +report \('
  expect_trace "${label}" '^COMPLETED +trello-done \('
  out=$(node_output "${work}/trace.out" report)
  grep -qF '"rag_status":"skipped"' <<<"${out}" && grep -qF '"rag_sources":[]' <<<"${out}" ||
    fail "${label}" "the report must record the skipped rag-context; output: ${out:-none}"
}

# A UI task whose brief names no visual reference (PILOT-278): visual-scope executes for real, the
# cancel node stops the run, and neither the plan nor the delivery starts.
check_visual_scope_missing() {
  local version=$1 archon_bin=$2 label="$1 a UI task without a visual reference" out
  sed '/^exec-code:/,$d' "${fixtures_dir}/${green_fixture}.stubs.yaml" >"${work}/stubs.yaml"
  "${archon_bin}" workflow run factory --cwd "${root}" --dry-run --stubs "${work}/stubs.yaml" --exec-code \
    --input task=$'PILOT-7: fixture\nLayer: ui.' 2>&1 | without_logs >"${work}/trace.out" || true
  out=$(node_output "${work}/trace.out" visual-scope)
  grep -qF '"visual":true' <<<"${out}" && grep -qF '"ready":false' <<<"${out}" ||
    fail "${label}" "visual-scope must execute and find the reference missing; output: ${out:-none}"
  expect_trace "${label}" '^COMPLETED +abort-visual-scope \(cancel\) — workflow cancelled'
  expect_trace "${label}" 'Stopped before the plan: .*names no visual reference'
  ! grep -qE '^[A-Z]+ +(plan-cycle|plan__[a-z-]+|deliver|deliver__[a-z-]+|visual-cycle) \(' "${work}/trace.out" ||
    fail "${label}" "the plan or the delivery started: $(grep -E '^[A-Z]+ ' "${work}/trace.out")"
}

for version in "${versions[@]}"; do
  archon_bin="${root}/.tools/bin/archon-${version}"
  [ -x "${archon_bin}" ] || fail "${version}" "${archon_bin} missing; run: bash scripts/ci/tools.sh archon"
  for literal in "${pr_body_literals[@]}"; do
    grep -aqF -- "${literal}" "${archon_bin}" ||
      fail "${version}" "the bundled delivery no longer names ${literal}; pr-body-sync (_lib/pr-body.ts) reads it"
  done
  for literal in "${follow_up_literals[@]}"; do
    grep -aqF -- "${literal}" "${archon_bin}" ||
      fail "${version}" "the bundled delivery no longer embeds ${literal}; review-followup (_lib/follow-up.ts) reads it"
  done
  home="${work}/home-${version}"
  mkdir -p "${home}"
  export ARCHON_HOME="${home}"
  # Release binaries from v0.12.0 on ship without providers; the factory's monitor node and the other
  # workflows name claude.
  "${archon_bin}" provider add claude >"${work}/provider.out" 2>&1 ||
    fail "${version}" "provider add claude failed: $(cat "${work}/provider.out")"

  ARCHON_BIN="${archon_bin}" INSTALL_SKIP_RUNTIME_TOOLS=1 bash install.sh >"${work}/install.out" 2>&1 ||
    fail "${version}" "install.sh failed: $(cat "${work}/install.out")"

  fixture_count=$(find "${fixtures_dir}" -name '*.stubs.yaml' | wc -l)
  rc=0
  "${archon_bin}" workflow test factory --cwd "${root}" >"${work}/test.out" 2>&1 || rc=$?
  grep -qE "^ *${fixture_count} passed, 0 failed" "${work}/test.out" && [ "${rc}" -eq 0 ] ||
    fail "${version}" "workflow test factory (exit ${rc}): $(without_logs <"${work}/test.out" | tail -40)"

  for fixture in "${fixtures_dir}"/*.stubs.yaml; do
    name=$(basename "${fixture}" .stubs.yaml)
    grep -q '^exec-code:' "${fixture}" || fail "${version} ${name}" "fixture has no exec-code: line"
    sed '/^exec-code:/,$d' "${fixture}" >"${work}/stubs.yaml"
    "${archon_bin}" workflow run factory --cwd "${root}" --dry-run --stubs "${work}/stubs.yaml" --exec-code \
      --input task='PILOT-7: fixture' 2>&1 | without_logs >"${work}/trace.out" || true
    check_fixture_trace "${version}" "${name}" "${work}/trace.out"
  done
  check_unstubbed_merge "${version}" "${archon_bin}"
  check_sync_base "${version}" "${archon_bin}"
  check_visual_scope_missing "${version}" "${archon_bin}"

  dry_runs=0
  for workflow in orchestration/workflows/*.yaml; do
    name=$(sed -n 's/^name: *//p' "${workflow}" | head -1)
    stubs="orchestration/tests/dry-run/${name}.stubs.yaml"
    [ -f "${stubs}" ] || fail "${version} ${name}" "no dry-run stubs at ${stubs}"
    rc=0
    "${archon_bin}" workflow run "${name}" --cwd "${root}" --dry-run --stubs "${stubs}" >"${work}/dry.out" 2>&1 || rc=$?
    [ "${rc}" -eq 0 ] || fail "${version} ${name}" "dry run exit ${rc}: $(without_logs <"${work}/dry.out" | tail -20)"
    dry_runs=$((dry_runs + 1))
  done

  echo "archon ${version}: install+validate ok, ${fixture_count} fixtures passed, traces ok, unstubbed merge ok, sync-base ok, visual reference check ok, ${dry_runs} dry-runs ok, pr-body names ok, follow-up literals ok"
done
