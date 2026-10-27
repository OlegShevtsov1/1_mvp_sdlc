# mvp-sdlc evals (layer 1)

Golden LLM eval cases for this plugin's own skills and hooks, run with `claude plugin eval` (R-C6). Layer 0 is
`scripts/lint_plugins.py` (static, blocking in CI). Layer 1 proves that a model working under the plugin ends in the
right repository state, and that a broken configuration of the same plugin is caught. The course plugin `sdlc` is
not tested here.

## Cases

Each case runs twice: against the real plugin (GREEN, must pass 3 of 3 runs) and against a copy with
`broken/<case>.patch` applied (RED, must fail 3 of 3 runs). The patch changes the configuration only, never the
case, so one pair proves both that the plugin works and that the graders see the defect.

| Case | Component | What the RED patch breaks |
|---|---|---|
| `block-main-push` | hook `block-main-push` | the hook is unwired: the model pushes straight to `main` |
| `block-destructive-git` | hook `block-destructive-git` | the hook is unwired: the model force-pushes a published branch |
| `block-env` | hook `block-env` | the hook is unwired: the model reads `.env` and writes its variable names into `.env.example` |
| `sdlc-gate-blocks-unapproved` | hook `sdlc-gate-hook`, `bin/sdlc-gate` | the hook is unwired: `/sdlc:write-prd` reaches the model, which writes a PRD from a Draft idea brief |
| `rails-data-model-no-sql` | skill `rails-data-model` | the skill is SQL-first throughout (rule, steps, template; no migrations rule installed): `schema.sql` instead of staged migrations |
| `rails-data-model-expand-contract` | skill `rails-data-model` | existing tables change in one migration throughout (rules, steps, template; no migrations rule installed): no backfill or contract step |
| `task-brief-ac` | skill `task-brief`, `bin/task-brief` | the three-commit rule and the commit trailers are dropped from the brief |
| `task-brief-split-large` | skill `task-brief`, `bin/task-brief` | the size check is skipped: a task estimated `XL` gets a brief |
| `task-brief-consults-rag` | skill `task-brief`, server `mvp-rag` | the mvp-rag step is removed: no search call, no cited source |
| `sync-spec-stale` | skill `sync-spec`, `bin/sync-spec` | `--check` no longer reports a changed source file, so the stale copy stays |
| `bootstrap-project-idempotent` | skill `bootstrap-project`, `bin/bootstrap-project` | a differing file is overwritten without `--overwrite`: the team's `CLAUDE.md` is lost (the team's `CLAUDE.md` is untracked, so git cannot restore it) |
| `feature-start` (no case) | skill `feature-start`, `bin/feature-start` | covered deterministically by `tests/test_feature_start.py` (foreign board, unknown or archived card, card in progress or done, untrusted block); the LLM prompt-injection case needs a Trello stub — not in C6 |
| `task-cards` (no case) | skill `task-cards`, `bin/task-cards` | covered deterministically by `tests/test_task_cards.py` (create, adopt, never duplicate, partial failure, dry run, refusals, untrusted card text never printed); needs a Trello stub — no LLM case |

The `sdlc-gate-blocks-unapproved` prompt starts with the operator-typed `/sdlc:write-prd demo`, gated on
`UserPromptSubmit` before any model turn; the course plugin is not loaded. Its first instruction creates
`write-prd-started.txt`, so any run in which the prompt reached the model fails `prompt-not-reached`. The
model-invoked `Skill` path is covered by `tests/test_sdlc_gate.py`.

## How a case is built

- `<case>/case.yaml` — the CLI's case schema, written as JSON (JSON is YAML; the stdlib can validate it):
  `schema_version` `"1.0"`, `name` = the directory name, `tags` (`golden`, or `defect` under `cases/`),
  `context.scaffold_script` = `scaffold.sh`, `execution` with `prompt`, `max_turns`, `timeout_seconds` and
  `allowed_tools`, `runs: 3`, and the graders.
- `<case>/scaffold.sh` — builds the starting repository in the empty workspace (the CLI runs it as
  `bash <absolute path>` with only `PATH`, `HOME`, `TMPDIR` and `GIT_CONFIG_NOSYSTEM` set). It sources `lib.sh`
  (fixed git identity, `git init`, a bare `origin.git`, ledger hooks), takes fixtures from `tests/fixtures/`, commits
  the starting state and lists helper paths in `.git/info/exclude`, so `git status --porcelain` is empty.
- Graders assert **state only**: `file_exists` and `regex` on `files` (paths created during the run) or on a file.
  No `llm` or `baseline` graders (no LLM judges), no `last_message`/`trace`, no `tool_used`/`tool_order`. A
  `not_contains` grader always reads a file the scaffold created, so a missing file never passes by accident.
- Pushes cannot be graded directly, so the hook cases use **ledger files**: a server-side `update` hook in the
  scaffolded `origin.git` appends every updated ref (`push-log.txt`) or every deleted or rewritten ref
  (`rewrite-log.txt`) to a file in the workspace.
- **Mocks.** An MCP server the plugin declares (`.mcp.json`) never runs in an eval: the CLI answers each of its
  tools from `mocks/<server>/<tool>.md` (frontmatter `type: fixed`, the body is the answer) and lists the tools from
  `mocks/<server>/_tools.json`. The mocks are shared by every case; a case can call a tool only where its
  `allowed_tools` grants it. The CLI records each run's calls of mocked tools (`mocks.calls`), which is how
  `task-brief-consults-rag` proves the skill searched (see Running the evals). The CLI ignores an `.mcp.json` the
  scaffold writes into the workspace.
- `<case>/states/green.sh` and `<case>/states/red.sh` — the end state a working and a broken configuration leave.
  The CLI ignores them; the deterministic tests run them to prove the graders pass GREEN and fail RED. They may
  call the plugin's commands through `EVAL_PLUGIN` (the plugin root).

## Broken patches

`broken/<case>.patch` is a unified diff relative to the plugin root (`a/…`, `b/…`) that touches only `hooks/`,
`skills/` or `bin/`. To regenerate one after a real change of the patched file: copy the plugin to a scratch
directory, `git init` and commit there, make the minimal break again, and write `git diff` to the patch. A patch
that no longer applies fails `tests/test_evals.py`.

## Checks in CI (no model calls)

- `plugins/mvp-sdlc/tests/test_evals.py` (check `mvp_sdlc`): exactly the agreed golden cases, the case schema,
  one patch per case that applies, clean scaffolds on the real and the patched plugin, graders pass GREEN and fail
  RED, and the real hook or command blocks what the patched one lets through.
- `scripts/test_evals.py` (check `plugins`): the runner with a stub `claude` — fixed CLI flags, only RED copies are
  patched, budget stop, verdict rules, no local paths in the results file, and CI never runs the LLM evals.
- The hook tests `tests/hooks/test-*.sh` run on every pull request through `check.sh mvp_sdlc`.

## Running the evals

Manual only, before a version bump: every run makes model calls. Not in CI, not on a schedule.

Prerequisites: Claude Code with `claude plugin eval`, logged in; `bwrap` and `socat` (the OS sandbox the CLI needs
to grant the Bash tool); `make`; `python3` ≥ 3.8.

```sh
make eval                            # every case, GREEN and RED, then eval-results
make eval CASE=block-main-push       # one case (the results file is then marked "complete": false)
make eval-results                    # rewrite eval/results/<version>.json from .eval-runs/<version>/
make eval EVAL_JOBS=4 EVAL_MAX_COST_USD=20
```

`make eval` runs `scripts/evals.py run`: one GREEN invocation over all cases on a copy of the plugin, then one RED
invocation per case on a patched copy, with `--ablation none --no-publish --trust-plugin --scaffold --allow-tools
Bash Write Edit mcp__plugin_mvp-sdlc_mvp-rag__search --threshold 1`. `EVAL_MAX_COST_USD` (default 40) is the budget
for the whole run; when it runs out the remaining invocations are skipped and the results are incomplete. A full run
is about 66 agent runs. Raw output stays in `.eval-runs/<version>/` (gitignored: it holds local paths and traces).

`eval/results/<version>.json` holds, per case, the GREEN and RED run counts, passes, errors, turns, duration and
cost, and the verdict. A case is PASS only when GREEN passed 3 of 3 and RED failed 3 of 3, **every run without an
error**: a run that errored (sandbox refusal, timeout) never counts as passed, even when the CLI scored it 1. A RED
run that passes even once means the case does not discriminate: FAIL. A case in `TOOL_CALL_CASES` of
`scripts/evals.py` (`task-brief-consults-rag`) also asserts the tool-call log: a run counts as passed only when it
called a mocked tool at least once without an error (`mocks.calls.total` ≥ 1, `mocks.calls.errors` 0). The overall
verdict is PASS when every included case is PASS and every invocation produced a result.

## Rules

- **Version bump:** a `mvp-sdlc` version bump only after `make eval` with `"verdict": "PASS"` and
  `"complete": true`; the bump pull request links `eval/results/<version>.json`.
- **Defect → case:** a pull request that fixes a missed P0/P1, a manual operator correction or a
  `delivered:false` run adds a case `cases/<yyyy-mm-dd>-<slug>/` (tag `defect`, with the source link to the pull
  request, run or retro line) and its `broken/<yyyy-mm-dd>-<slug>.patch` (the configuration before the fix);
  otherwise review returns the pull request (P1). Start from `cases/_template/`.
- **Cheapest fix first:** an instruction line, then a code check (hook, CI, lint), and an LLM judge only with proof
  that a concrete check keeps missing the defect and code cannot catch it, by a separate operator decision.
