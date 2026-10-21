#!/usr/bin/env bash
# Installs and tests every Archon workflow of this repository on each pinned Archon release:
# install.sh (which validates), `workflow test factory`, trace assertions per factory fixture (merge-gate
# executes in every one), runs in which pr-state, merge-gate and merge (or, for a pull request into a
# manual base, notify-operator) execute for real against the engine's own deliver output (only gh is
# faked), a real (not dry) run in which wait-keeper resumes a durable wait, and a stubbed dry run of
# every orchestration/workflows/*.yaml. The Trello card nodes run in dry-run mode in every fixture, and
# the traces assert each move at its node. Needs the binaries from `tools.sh archon`, bun and uv on PATH.
# Every Archon call runs with a throwaway ARCHON_HOME: without one a binary reads and writes the
# operator's live ~/.archon.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "${root}"
versions=(0.10.1 0.11.1)
fixtures_dir=orchestration/factory/.archon/workflows/sdlc-factory/factory/fixtures
# The fixture whose validation is red; it must end with the merge skipped.
red_fixture=validation-red-merge-refused
# The fixture whose validation is red for an environment cause while the PR's CI is green; it must merge.
env_fixture=validation-environment-ci-green
# The fixture whose pull request targets a manual base; it must end completed, pending the operator.
manual_fixture=manual-base-pending-operator
# The green fixture the unstubbed merge runs start from.
green_fixture=existing-profile

command -v bun >/dev/null || { echo "archon-check: bun not found on PATH" >&2; exit 1; }
command -v uv >/dev/null || { echo "archon-check: uv not found on PATH (the bundled validate scripts run on it)" >&2; exit 1; }
export UV_PYTHON="${UV_PYTHON:-3.12}"

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
  existing-profile | fresh-profile | "${env_fixture}") final=Test ;;
  "${manual_fixture}") final=Review ;;
  esac
  expect_move "${version}" "${name}" "${trace}" trello-done "${final}"
  cancel_line=$(grep -nE '^COMPLETED +not-delivered' "${trace}" | cut -d: -f1 || true)
  [ -n "${cancel_line}" ] || return 0
  done_line=$(grep -nE '^COMPLETED +trello-done \(' "${trace}" | cut -d: -f1)
  [ "${done_line}" -lt "${cancel_line}" ] ||
    fail "${version} ${name}" "trello-done must move the card before not-delivered cancels the run"
}

check_fixture_trace() {
  local version=$1 name=$2 trace=$3
  local gate_lines state_lines notify_lines
  check_trello_moves "${version}" "${name}" "${trace}"
  gate_lines=$(grep -E '^[A-Z]+ +merge-gate \(' "${trace}" || true)
  [ -n "${gate_lines}" ] || fail "${version} ${name}" "no merge-gate line in the trace"
  ! grep -vE '^(COMPLETED|SKIPPED) ' <<<"${gate_lines}" >/dev/null ||
    fail "${version} ${name}" "merge-gate must execute (or be skipped), never be stubbed: ${gate_lines}"
  # pr-state talks to GitHub; a fixture must never reach it.
  state_lines=$(grep -E '^[A-Z]+ +pr-state \(' "${trace}" || true)
  [ -n "${state_lines}" ] || fail "${version} ${name}" "no pr-state line in the trace"
  ! grep -vE '^(STUBBED|SKIPPED) ' <<<"${state_lines}" >/dev/null ||
    fail "${version} ${name}" "pr-state must be stubbed or skipped in a test: ${state_lines}"
  grep -qE '^COMPLETED +wait-keeper \(' "${trace}" && grep -q '"keeper":"off"' "${trace}" ||
    fail "${version} ${name}" "wait-keeper must execute and report itself off in a dry run"
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
    grep -qE '^COMPLETED +deliver__gate-validated \(' "${trace}" ||
      fail "${version} ${name}" "the bundled gate-validated did not pass the environment red"
    grep -qE '^COMPLETED +merge-gate \(' "${trace}" && grep -qE '^STUBBED +merge \(' "${trace}" ||
      fail "${version} ${name}" "merge-gate did not lead to the merge: ${gate_lines}"
    grep -qE '^SKIPPED +not-delivered' "${trace}" || fail "${version} ${name}" "the run was not delivered"
  fi
  if [ "${name}" != "${red_fixture}" ]; then
    ! grep -q '^FAILED' "${trace}" || fail "${version} ${name}" "unexpected failure: $(grep '^FAILED' "${trace}")"
    return
  fi
  local failed
  failed=$(grep '^FAILED' "${trace}" || true)
  grep -qE '^FAILED +deliver__gate-validated \(' <<<"${failed}" && [ "$(wc -l <<<"${failed}")" -eq 1 ] ||
    fail "${version} ${name}" "want exactly one FAILED line, deliver__gate-validated; got: ${failed:-none}"
  grep -qE '^SKIPPED +merge \(' "${trace}" || fail "${version} ${name}" "merge was not skipped"
  grep -qE '^COMPLETED +not-delivered' "${trace}" || fail "${version} ${name}" "not-delivered did not complete"
  if [ "${version}" = 0.10.1 ]; then
    # Archon 0.10.1 flips the PR ready despite the red gate; the fixture must exercise that path.
    grep -qE '^STUBBED +deliver__flip-ready' "${trace}" || fail "${version} ${name}" "the flip-ready path was not exercised"
    grep -qE '^COMPLETED +merge-gate \(' "${trace}" && grep -q 'test command exited 1 on the pull request head' "${trace}" ||
      fail "${version} ${name}" "merge-gate did not refuse on its own test run"
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
  "pr view "*" --json headRefOid,headRefName,isDraft,state,baseRefName")
    printf '{"headRefOid":"%s","headRefName":"fixture-branch","isDraft":false,"state":"OPEN","baseRefName":"%s"}\n' \
      "${FAKE_GH_HEAD_OID}" "${FAKE_GH_BASE:-develop}" ;;
  "pr checks "*" --json name,bucket") printf '%s\n' "${FAKE_GH_CHECKS:-[]}" ;;
  "pr merge "*) ;;
  "pr comment "*) printf '%s\n' "$*" >>"${FAKE_GH_COMMENTS}" ;;
  *"--json state --jq .state") echo MERGED ;;
  *"--json mergeCommit "*) printf '%s\n' "${FAKE_GH_MERGE_COMMIT}" ;;
  *"--json headRefName --jq .headRefName") echo fixture-branch ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 1 ;;
esac
GH
chmod +x "${work}/fake-bin/gh"
export FAKE_GH_HEAD_OID FAKE_GH_COMMENTS="${work}/gh-comments"
FAKE_GH_HEAD_OID=$(git -C "${scratch}" rev-parse HEAD)
sed -e '/^pr-state:/d' -e '/^merge:/d' -e '/^exec-code:/,$d' \
  "${fixtures_dir}/${green_fixture}.stubs.yaml" >"${work}/unstubbed-merge.stubs.yaml"

# Runs the factory with pr-state, merge-gate, merge and notify-operator unstubbed against a pull
# request into base (default develop); the trace goes to trace.out.
run_unstubbed_merge() {
  local archon_bin=$1 merge_commit=$2 base=${3:-develop}
  PATH="${work}/fake-bin:${PATH}" FAKE_GH_MERGE_COMMIT="${merge_commit}" FAKE_GH_BASE="${base}" \
    "${archon_bin}" workflow run factory --cwd "${scratch}" --dry-run --stubs "${work}/unstubbed-merge.stubs.yaml" \
    --exec-code --input task=fixture 2>&1 | without_logs >"${work}/trace.out" || true
}

expect_trace() {
  local label=$1 pattern=$2
  grep -qE "${pattern}" "${work}/trace.out" ||
    fail "${label}" "trace lacks /${pattern}/: $(grep -E '^[A-Z]+ ' "${work}/trace.out" | tail -40)"
}

check_unstubbed_merge() {
  local version=$1 archon_bin=$2 label
  label="${version} unstubbed pr-state and merge-gate"
  run_unstubbed_merge "${archon_bin}" 0123456789abcdef0123456789abcdef01234567
  ! grep -q '^FAILED' "${work}/trace.out" || fail "${label}" "unexpected failure: $(grep '^FAILED' "${work}/trace.out")"
  expect_trace "${label}" '^COMPLETED +pr-state \('
  expect_trace "${label}" '^COMPLETED +merge-gate \('
  expect_trace "${label}" '^COMPLETED +merge \('
  expect_trace "${label}" '^SKIPPED +notify-operator \('
  expect_trace "${label}" '^STUBBED +deploy \('
  expect_trace "${label}" '^SKIPPED +not-delivered \('
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
}

# A probe workflow shaped like the bundled deliver's await-checks: the first CI probe reads pending and
# the run suspends on a 2 s durable `wait:`; the second reads concluded. `after` records the keeper's
# verdict. Written with or without the keeper node (the negative control).
write_wait_probe() {
  local dir=$1 with_keeper=$2
  {
    printf 'name: wait-keeper-probe\ndescription: wait-keeper real-run check\nnodes:\n'
    if [ "${with_keeper}" = yes ]; then
      cat <<'YAML'
  - id: keeper
    script: wait-keeper
    runtime: bun
    with:
      poll_seconds: "1"
    output_format:
      type: object
      properties:
        keeper: { type: string }
        reason: { type: string }
        run_id: { type: string }
      required: [keeper, reason, run_id]
YAML
    fi
    cat <<'YAML'
  - id: await
    loop_group:
      max_iterations: 5
      until_bash: test -f ci-done
      nodes:
        - id: probe
          bash: |
            if test -f seen; then touch ci-done; printf '{"state":"concluded"}'; else touch seen; printf '{"state":"pending"}'; fi
          output_format:
            type: object
            properties:
              state: { type: string }
            required: [state]
        - id: pause
          wait:
            duration_ms: 2000
          depends_on: [probe]
          when: "$probe.output.state == 'pending'"
YAML
    if [ "${with_keeper}" = yes ]; then
      printf '    depends_on: [keeper]\n'
      printf '  - id: after\n    bash: printf %%s $keeper.output.keeper > keeper-state\n    depends_on: [await]\n'
    else
      printf '  - id: after\n    bash: echo after\n    depends_on: [await]\n'
    fi
  } >"${dir}/.archon/workflows/wait-keeper-probe.yaml"
}

# Starts the probe in a fresh scratch repository and home; prints "<archon home> <repo> <run id>".
start_wait_probe() {
  local archon_bin=$1 with_keeper=$2 dir
  dir=$(mktemp -d "${work}/wait-probe.XXXX")
  mkdir -p "${dir}/repo/.archon/workflows" "${dir}/home"
  git init -q "${dir}/repo"
  git -C "${dir}/repo" -c user.name=archon-check -c user.email=archon-check@example.com commit -q --allow-empty -m init
  cp -R orchestration/factory/.archon/workflows/sdlc-factory/factory/scripts "${dir}/repo/.archon/scripts"
  write_wait_probe "${dir}/repo" "${with_keeper}"
  ARCHON_HOME="${dir}/home" "${archon_bin}" workflow run wait-keeper-probe --cwd "${dir}/repo" --no-worktree \
    </dev/null >"${dir}/run.out" 2>&1 || true
  printf '%s %s %s\n' "${dir}/home" "${dir}/repo" "$(ARCHON_HOME="${dir}/home" "${archon_bin}" workflow runs \
    --cwd "${dir}/repo" --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["runs"][0]["id"])')"
}

run_status() {
  ARCHON_HOME=$1 "$2" workflow get "$3" --json 2>/dev/null |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", "unreadable"))' 2>/dev/null || echo unreadable
}

check_wait_keeper() {
  local version=$1 archon_bin=$2 label="${version} wait-keeper" home repo id status="" i want_keeper output_root
  read -r home repo id < <(start_wait_probe "${archon_bin}" yes)
  for i in $(seq 1 90); do
    status=$(run_status "${home}" "${archon_bin}" "${id}")
    [ "${status}" != completed ] || break
    sleep 1
  done
  [ "${status}" = completed ] || fail "${label}" "the probe run is ${status}, not completed: $(without_logs <"${repo}/../run.out" | tail -20)"
  want_keeper=off
  [ "${version}" != 0.10.1 ] || want_keeper=on
  [ "$(cat "${repo}/keeper-state" 2>/dev/null)" = "${want_keeper}" ] ||
    fail "${label}" "want keeper ${want_keeper}, got '$(cat "${repo}/keeper-state" 2>/dev/null)'"
  [ "${version}" = 0.10.1 ] || return 0
  output_root=$(ARCHON_HOME="${home}" "${archon_bin}" workflow get "${id}" --json 2>/dev/null |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["output_root"])')
  grep -q ' resume: ' "${output_root}/artifacts/runs/${id}/wait-keeper.log" ||
    fail "${label}" "wait-keeper.log has no resume line"

  # Negative control: without the keeper the same run stays paused, so this check reproduces the defect.
  read -r home repo id < <(start_wait_probe "${archon_bin}" no)
  sleep 15
  status=$(run_status "${home}" "${archon_bin}" "${id}")
  [ "${status}" = paused ] || fail "${label}" "without the keeper the probe run is ${status}, not paused"
}

for version in "${versions[@]}"; do
  archon_bin="${root}/.tools/bin/archon-${version}"
  [ -x "${archon_bin}" ] || fail "${version}" "${archon_bin} missing; run: bash scripts/ci/tools.sh archon"
  home="${work}/home-${version}"
  mkdir -p "${home}"
  export ARCHON_HOME="${home}"

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
  check_wait_keeper "${version}" "${archon_bin}"

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

  echo "archon ${version}: install+validate ok, ${fixture_count} fixtures passed, traces ok, unstubbed merge ok, wait-keeper ok, ${dry_runs} dry-runs ok"
done
