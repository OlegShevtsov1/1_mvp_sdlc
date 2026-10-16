#!/usr/bin/env bash
# Shared helpers for the hook tests; source it. Events are built with python3 json.dumps to avoid quoting bugs.
set -euo pipefail
hooks_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../hooks" && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "${scratch}"' EXIT

fail() { echo "FAIL $1: $2" >&2; exit 1; }

# bash_event <command> [<cwd>]
bash_event() {
  python3 -c 'import json, sys
event = {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}
if len(sys.argv) > 2:
    event["cwd"] = sys.argv[2]
print(json.dumps(event))' "$@"
}

# tool_event <tool> <input key> <value> [<cwd>]
tool_event() {
  python3 -c 'import json, sys
event = {"hook_event_name": "PreToolUse", "tool_name": sys.argv[1], "tool_input": {sys.argv[2]: sys.argv[3]}}
if len(sys.argv) > 4:
    event["cwd"] = sys.argv[4]
print(json.dumps(event))' "$@"
}

# run_hook <script> <stdin> <want-exit> <name>; a block (exit 2) must explain itself on stderr.
run_hook() {
  local script=$1 input=$2 want=$3 name=$4 err rc=0
  err=$(printf '%s' "${input}" | "${hooks_dir}/${script}" 2>&1 >/dev/null) || rc=$?
  [ "${rc}" -eq "${want}" ] || fail "${script}: ${name}" "exit ${rc}, want ${want}: ${err}"
  if [ "${want}" -eq 2 ] && [ -z "${err}" ]; then fail "${script}: ${name}" "blocked without a reason on stderr"; fi
  echo "PASS ${script}: ${name}"
}

# common_cases <script>: empty event and empty stdin are never blocked.
common_cases() {
  run_hook "$1" '{}' 0 "empty event"
  run_hook "$1" '' 0 "empty stdin"
  run_hook "$1" 'not json' 0 "non-JSON stdin"
}
