#!/usr/bin/env bash
# block-state-edit: docs/features/<slug>/state.json is written only by scripts/feature-state.py.
source "$(dirname "$0")/lib.sh"
h=block-state-edit.sh
state=docs/features/demo/state.json

common_cases "${h}"
for tool in Write Edit MultiEdit; do
  run_hook "${h}" "$(tool_event "${tool}" file_path "${state}")" 2 "${tool} relative"
  run_hook "${h}" "$(tool_event "${tool}" file_path "/srv/app/${state}")" 2 "${tool} absolute"
done
run_hook "${h}" "$(tool_event NotebookEdit notebook_path "${state}")" 2 "NotebookEdit"
for cmd in "echo x > ${state}" "jq . x.json >> ${state}" "sed -i s/idea/prd/ ${state}" "rm ${state}" \
  "cp /tmp/x ./${state}" "true && tee ${state} < x" \
  "bash -c \"rm ${state}\"" "env A=1 rm ${state}" "A=1 rm ${state}"; do
  run_hook "${h}" "$(bash_event "${cmd}")" 2 "${cmd}"
done
for cmd in "cat ${state}" "jq .stage ${state}" "jq .stage < ${state}" "git diff ${state}" \
  'python3 plugins/mvp-sdlc/scripts/feature-state.py set demo prd --evidence exit:0' "echo ok > docs/features/demo/PRD.md" \
  "for f in docs/features/demo/PRD.md ${state}; do echo \"=== \$f\"; cat \"\$f\"; done"; do
  run_hook "${h}" "$(bash_event "${cmd}")" 0 "${cmd}"
done
run_hook "${h}" "$(tool_event Write file_path docs/features/demo/PRD.md)" 0 "Write PRD"
