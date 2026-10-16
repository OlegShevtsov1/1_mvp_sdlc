#!/usr/bin/env bash
# check-branch-name: warns (never blocks) when a new branch name breaks the app-repository convention.
source "$(dirname "$0")/lib.sh"
h=check-branch-name.sh

common_cases "${h}"

# run_hint <command> <silent|warning> <name>; a warning is one JSON object on stdout, for the user and the model.
run_hint() {
  local cmd=$1 want=$2 name=$3 out errfile="${scratch}/stderr" rc=0
  out=$(bash_event "${cmd}" "${scratch}" | "${hooks_dir}/${h}" 2>"${errfile}") || rc=$?
  [ "${rc}" -eq 0 ] || fail "${h}: ${name}" "exit ${rc}, want 0: $(cat "${errfile}")"
  [ ! -s "${errfile}" ] || fail "${h}: ${name}" "unexpected stderr: $(cat "${errfile}")"
  if [ "${want}" = silent ]; then
    [ -z "${out}" ] || fail "${h}: ${name}" "want no output, got: ${out}"
  else
    printf '%s' "${out}" | python3 -c 'import json, sys
event = json.load(sys.stdin)
specific = event["hookSpecificOutput"]
assert specific["hookEventName"] == "PreToolUse", specific
for text in (event["systemMessage"], specific["additionalContext"]):
    for needle in ("WARNING", "feature/PILOT-", "hotfix/PILOT-"):
        assert needle in text, (needle, text)' || fail "${h}: ${name}" "want a JSON warning, got: ${out}"
  fi
  echo "PASS ${h}: ${name}"
}

for cmd in 'git checkout -b feature/PILOT-123-fix-login' 'git checkout -b archon/task-factory-173800' \
  'git checkout -b hotfix/PILOT-7-crash origin/main' 'git switch --create=feature/PILOT-1-x' \
  'git branch --track feature/PILOT-1-x origin/main' 'git branch' 'git branch -a' 'git branch -d wip-old' \
  'git checkout main' 'git status' 'echo git checkout -b wip-x' 'git checkout -b "$BRANCH"' \
  'git checkout -B feature/PILOT-9-x' 'git switch -C feature/PILOT-9-x' 'git switch --create feature/PILOT-9-x' \
  'git switch --force-create=feature/PILOT-9-x'; do
  run_hint "${cmd}" silent "${cmd}"
done
for cmd in 'git checkout -b wip-login-fix' 'git switch -c wip-login-fix' 'git branch wip-login-fix' \
  'git checkout -b feature/PILOT-12-Fix_Login' 'git checkout -b feat/login' 'true && git checkout -b wip-x' \
  'git checkout -B wip-bad' 'git switch -C wip-bad' 'git switch --create wip-bad' 'git switch --force-create=wip-bad'; do
  run_hint "${cmd}" warning "${cmd}"
done
