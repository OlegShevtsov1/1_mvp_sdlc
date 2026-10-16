# Template: an eval case from a real defect

1. Create `cases/<yyyy-mm-dd>-<slug>/` (the date the defect was found) with `case.yaml`, `scaffold.sh`,
   `states/green.sh` and `states/red.sh`, all as in the golden cases (`../../README.md`).
2. Write `broken/<yyyy-mm-dd>-<slug>.patch`: the plugin configuration before the fix, as a diff against the fixed
   plugin (only `hooks/`, `skills/` or `bin/`).
3. Name the source in `description`: the pull request, run or retro line where the defect showed up.
4. Run `bash plugins/mvp-sdlc/tests/run.sh` (deterministic, no model calls), then `make eval CASE=<name>` before the
   next version bump.

`case.yaml` (JSON; this copy sits in a fenced block so the CLI does not load it):

```json
{
  "schema_version": "1.0",
  "name": "<yyyy-mm-dd>-<slug>",
  "description": "<what must hold>. Source: <pull request / run / retro line>.",
  "tags": ["defect"],
  "context": {"scaffold_script": "scaffold.sh"},
  "execution": {
    "prompt": "<the request that exposed the defect>",
    "max_turns": 10,
    "timeout_seconds": 300,
    "allowed_tools": ["Bash", "Read"]
  },
  "runs": 3,
  "graders": [
    {"name": "<state that must hold>", "type": "regex", "target": {"source": "file", "path": "<file>"},
     "pattern": "<literal or simple regex>", "match": "contains"}
  ]
}
```

`scaffold.sh` (`lib.sh` sits two directories up from a defect case):

```sh
#!/usr/bin/env bash
# <the starting repository>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../lib.sh"

init_repo
# ... build the starting state, from "${fixtures}/<fixture>" when one fits ...
commit_all "Starting state"
```

`states/green.sh` and `states/red.sh` start with the same two lines (`#!/usr/bin/env bash`, `set -euo pipefail`) and
leave the end state of the fixed and of the broken configuration; `EVAL_PLUGIN` is the plugin root.
