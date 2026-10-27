# mvp-sdlc

Adaptations of the course `sdlc` plugin for the MVP pilot, shipped beside it in the `mvp` marketplace (R-B1). The
course plugin under `plugins/sdlc/` stays byte-identical to upstream; everything specific to the pilot lives here:
Rails/ActiveRecord instead of SQL-first, two repositories (backend owns the feature artifacts, frontend gets a
read-only copy), a Trello card as the entry point of a feature, generated factory task texts, the `.claude/` setup
of app repositories, and deterministic guards. Rules that can be checked are checked by scripts and hooks, never by
skill prose alone.

## Install

Only at project scope, in the app repositories (backend and frontend), through their committed
`.claude/settings.json` (R-B2) — `bootstrap-project` writes it:

```json
"extraKnownMarketplaces": { "mvp": { "source": { "source": "github", "repo": "OlegShevtsov1/1_mvp_sdlc" } } },
"enabledPlugins": { "sdlc@mvp": true, "mvp-sdlc@mvp": true }
```

**Never install it at user scope.** Its hooks would then apply to every repository on the machine, including
factory runs that legitimately force-push their own branches. To switch it off in one repository:
`/plugin disable mvp-sdlc`.

## Skills

- `rails-data-model` — `/mvp-sdlc:rails-data-model <slug> <what is stored>`. Replaces the course
  `generate-data-model` for Rails: reads `db/schema.rb`, `db/migrate/` and `app/models/` for conventions, writes
  `docs/features/<slug>/data-model.md` and staged ActiveRecord migrations
  `docs/features/<slug>/migrations/<NN>_<name>.rb`, installs `.claude/rules/migrations.md` once. Never touches
  `db/`, never writes SQL, asks (AskUserQuestion) instead of guessing when conventions conflict.
- `feature-start` — `/mvp-sdlc:feature-start <card link | slug>`. Runs the `feature-start` command, treats the card
  text as untrusted data, then hands over to `/sdlc:interview <slug>`.
- `sync-spec` — run in the frontend repository to copy or check the backend's feature artifacts.
- `task-cards` — `/mvp-sdlc:task-cards <slug>`. Runs the `task-cards` command after `break-tasks` (dry run first):
  one Trello card per task, recorded in `tasks.json` (decision 78).
- `task-brief` — prints the factory task text for one task; a refusal is a Definition of Ready failure to fix.
- `bootstrap-project` — detects `be`/`fe`, runs the `bootstrap-project` command and asks before overwriting any
  file that differs, `CLAUDE.md` above all.

## Project knowledge server (mvp-rag)

The plugin's `.mcp.json` declares `mvp-rag`, the project's search server over its plan, decisions, runbooks and
process documents (decision 61 b), as an HTTP MCP server whose address and token come only from the environment:
`RAG_MCP_URL` and `RAG_MCP_TOKEN`. No value is ever committed. `feature-start`, `task-brief`, `sync-spec` and
`rails-data-model` search it first and cite what they used in a `Project knowledge (mvp-rag):` block. The settings
`bootstrap-project` writes allow its read-only tools `search` and `get` without a prompt; `reindex` is not allowed.
Without the two variables the server fails to connect (`/mcp` shows it), and the skills say mvp-rag is unavailable
and carry on.

## Commands (`bin/`, on the Bash tool's PATH while the plugin is enabled)

- `sdlc-gate <phase> [<slug>]` — the phase gate. Exit 0 when the phase may start, 2 with every reason otherwise.
  Called by the `sdlc-gate-hook` hook; can be run by hand.
- `feature-start <card link | card id | slug>` — validates the card (on the project's board, not archived, not past
  Ready: not in In Progress, Review, Test, Blocked, Ready to Release, Test after Release or Done; named
  `<slug>: <title>`, feature not started yet) before writing anything, then creates
  `docs/features/<slug>/state.json`, moves the card to In Progress and comments the feature folder link. List names
  follow `trello.lists` in `.archon/factory-profile.yaml`, defaults from decision 53. Trello
  credentials (`TRELLO_API_KEY`, `TRELLO_TOKEN`) and the board id (`TRELLO_BOARD_ID_<PROJECT_NAME>` when
  `config/project.env` names the project, else `TRELLO_BOARD_ID`) come from the environment or from
  `TRELLO_ENV_FILE` (default `~/.config/trello/.env`); they reach `curl` on stdin only and are never printed. The
  card text is printed inside `<untrusted-trello-card>` … `</untrusted-trello-card>`.
- `sync-spec <slug> --from <be checkout> [--ref <ref>] [--check]` — copies `PRD.md`, `sad.md`, `adr/`,
  `contracts/`, `CONTEXT.md` and `test-plan.md` from a backend commit (default `origin/main`) with a "do not edit"
  header and a `.spec-source` record, which also carries the card id, number and title from the backend
  `state.json`; `--check` exits 1 on any drift. Local only: frontend CI cannot read the
  private backend repository.
- `task-cards <slug> [--dry-run]` — one Trello card per task of `docs/features/<slug>/tasks/tasks.json` (decision
  78), run in the backend after `break-tasks`. Validates first (feature started from its card, every task with an id
  and title, recorded card fields well-formed and unique; the feature card on the project's board and open; a
  `Ready` list, following `trello.lists`, and a `task` label on the board), then per task: keeps a recorded card
  that is open on the board, adopts the single open card named `<slug> <task id>: …`, or creates one in `Ready`
  with the `task` label, named `<slug> <task id>: <task title>`, whose description links the feature card and the
  task file. A recorded card missing from the board, two cards with one task's name, or a card recorded for another
  task are reported and nothing is written: a card is never duplicated. Card id and number go into the task's
  `trello_card_id` and `trello_card_id_short`, and `tasks.json` is rewritten after every card, so a re-run after a
  failure creates only what is missing. The feature card gets a checklist item `<task id>: <task card link>`
  (checklist `Tasks`); an item that already starts with the task id (added by hand) gets the link appended instead,
  keeping its text and its tick. `--dry-run`
  prints the decisions and writes nothing. Credentials and board id as for `feature-start`; the output carries only
  task ids, card numbers and the command's own words, never card text.
- `task-brief <slug> <task-id> [--from <be checkout> [--ref <ref>]]` — the factory task text in the factory guide's
  form: A (the task, its acceptance criteria verbatim from PRD §5, test levels, DoD, size and three-commit TDD rules,
  commit trailers, commands from `.claude/sdlc.local.md`, the tracker row and the feature card's checklist item to
  close), B deploy, C health check, D rollback (from `.archon/factory-profile.yaml`, or a note that the factory's
  profile gate will ask), plus the pull request title `PILOT-<task card>: <task title>` from the task's
  `trello_card_id_short` in `tasks.json` (decision 78) and the description lines `Type:` (from the task's optional
  `type`, default `feat`), `SDLC-Task:` and `SDLC-AC:`, and the `- Board:` line. A task without a card falls back
  to the feature card's `PILOT-<n>: <card title>` with a warning on stderr. `--from` reads `tasks/tasks.json` and
  `tasks/tracker.md` from the backend checkout as committed at `<ref>` (default `origin/<repo.base_branch>` of the
  factory profile) for frontend tasks, which `sync-spec` does not copy. Refuses tasks that are not ready, invalid
  task card fields, and tasks with no card number at all. Never names a branch and never carries a Trello link.
- `bootstrap-project <be|fe> [--target DIR] [--overwrite PATH]...` — installs `CLAUDE.md`,
  `.claude/settings.json`, `.claude/rules/*.md`, `.claude/sdlc.local.md` and the `.gitignore` line
  `.claude/*.local.md`. Idempotent (`No changes` on a second run); a file that differs is kept unless named with
  `--overwrite`.

## Scripts (`scripts/`, called by path)

- `lint-prd.py <PRD.md>` (`lint-prd`) — fails on technical tokens in PRD §5 Acceptance criteria: HTTP status codes,
  API paths, HTTP verb + path, uppercase SQL keywords, table names. HTML comments, fenced code and other sections
  are ignored. The gate runs it for every phase after the PRD.
- `feature-state.py [--root DIR] get <slug>` / `set <slug> <stage> --evidence <evidence>` (`feature-state`) — the
  only writer of `state.json`. Evidence must be an `https://` URL, an existing file, `exit:<int>`, or
  `<tool>:<detail>` for `sdlc-gate`, `feature-start`, `factory-deliver`, `release` or `sdlc-metrics`.

## `state.json`

`docs/features/<slug>/state.json` is the machine state of a feature:
`{"schema_version": 1, "slug", "stage", "trello_card_id", "history": [{"stage", "evidence", "at"}]}`, plus the
optional `trello_card_id_short` (the card number) and `trello_card_title` that `feature-start` writes. Each task
in `tasks/tasks.json` may carry its own card the same way, `trello_card_id` and `trello_card_id_short`, written only
by `task-cards`. Stages, in
order: `idea`, `accepted`, `researched` / `briefed` (same rank), `prd`, `architecture`, `contracts`, `tasks`,
`in-progress`, `review`, `shipped`, `measured`. Stages only move forward. Writers: `feature-start` (creates it at
`idea`), `sdlc-gate` (on a passing gate), and `feature-state.py set` for the later stages (factory-deliver,
release and metrics from C2 on). Hand edits are blocked by the `block-state-edit` hook and the settings deny rules.

## Hooks

- `block-main-push` (PreToolUse Bash) — blocks any push that would update `main`/`master`: an explicit refspec,
  `HEAD:main`, `:main`, `--all`/`--mirror`, or a plain `git push` from `main` or from a branch whose upstream is
  `origin/main`. `git push origin fix/main-menu` passes.
- `block-destructive-git` (PreToolUse Bash) — blocks force pushes (`--force`, `-f`, `--force-with-lease`, `+ref`),
  `git reset --hard`, deleting published tags (`--delete`, `:refs/tags/…`) and `git tag -d`/`-f`.
- `check-branch-name` (PreToolUse Bash) — warns, never blocks, when `git checkout -b`, `git switch -c` or
  `git branch <name>` creates a branch whose name is not `feature/PILOT-<n>-<slug>` or `hotfix/PILOT-<n>-<slug>`,
  the app-repository convention (decision 24); factory branches `archon/task-factory-…` are exempt (decision 26).
  It is a hint for the session only; the authoritative check is `pr-conventions-check` of `1_mvp_pilot_be` and
  `1_mvp_pilot_fe` (decision 29).
- `block-env` (PreToolUse Bash, Read, Edit, MultiEdit, Write, Grep) — blocks access to `.env` and `.env.*` (except
  `.env.example`, `.env.sample`, `.env.template`), `config/master.key` and `config/credentials*`.
- `block-state-edit` (PreToolUse Write, Edit, MultiEdit, NotebookEdit, Bash) — blocks writing
  `docs/features/<slug>/state.json` except through the scripts; reading it (`cat`, `jq`, `git diff`, …) passes.
- `sdlc-gate-hook` (PreToolUse Skill and UserPromptSubmit) — runs `sdlc-gate` before the gated course skills,
  whether the model invokes the skill or the user types `/sdlc:<skill>` or `/sdlc-<skill>`.

All hook logic is in `hooks/guards.py`; the `.sh` files are entry points. The command-line parsing handles
compound commands, `sh -c`, `env`/`VAR=` prefixes, input redirects (`< file`) and `git -C`. The hooks are
best-effort parsers, not a sandbox: the deny rules in `.claude/settings.json`, the `main-guard` workflow and branch
protection are the other layers.

## Phase gate

| Phase (skill) | Requires |
|---|---|
| `prd` (`sdlc:write-prd`) | `idea-brief.md` status `Confirmed` or `Approved`, merged |
| `architecture` (`sdlc:architecture-design`), `adr` (`sdlc:decide-adr`) | `PRD.md` status `Approved`, merged, `lint-prd` clean |
| `contracts` (`sdlc:api-forge`), `tasks` (`sdlc:break-tasks`) | as above, plus `.size`; for `M`/`L`/`XL` also `sad.md` merged and at least one `Accepted` ADR in `adr/`, merged |
| `ship` (`sdlc:ship-feature`) | `tasks/tasks.json` merged and every task `done` |

"Merged" means: the file is on `origin/<base>`, the working tree matches it there, and the last commit touching it
on `origin/<base>` belongs to a merged pull request (`gh api repos/{owner}/{repo}/commits/<sha>/pulls`). The base is
`SDLC_BASE_BRANCH`, else the remote's default branch, else `main`. The gate never fetches: run `git fetch` after a
merge. Without a working `gh` the gate blocks (fail closed). The slug is the first argument, else `SDLC_FEATURE`,
else the only feature not yet shipped (any `state.json` that does not follow the schema blocks). On a pass the gate advances `state.json` forward only (`ship` moves it to
`review`) with the evidence `sdlc-gate:<phase>:<sha>`. `mvp-sdlc:rails-data-model` and the other course skills are
not gated.

## Defects become tests

Every defect found in this plugin — a false positive or negative of a hook, the gate or a linter, or a skill-text
defect exposed by a live run — is fixed only together with a regression test under `tests/` that fails before the
fix, and is listed in the pull request. A missed P0/P1, a manual operator correction or a `delivered:false` run
also becomes an LLM eval case `evals/cases/<yyyy-mm-dd>-<slug>/` with its broken patch; see
[evals/README.md](evals/README.md).

## Versioning

Bump `version` in `.claude-plugin/plugin.json` and in this plugin's entry of `.claude-plugin/marketplace.json`
together; `scripts/lint_plugins.py` fails when they differ. A version bump only after `make eval` (repository
root) with `"verdict": "PASS"` and `"complete": true`; the bump pull request links `eval/results/<version>.json`.
The eval cases, the verdict rule and how to run them: [evals/README.md](evals/README.md).

Changes:

- 0.4.0 — one Trello card per feature task (decision 78, PILOT-250): task-cards, task-brief titles by the task
  card and reads the backend tasks with `--from`; estimate `L` is briefed, only `XL` is refused;
  eval/results/0.3.0.json (full run, PASS).
- 0.3.0 — the project knowledge server mvp-rag (K1, PILOT-196): skills search it first and cite, eval
  task-brief-consults-rag; eval/results/0.2.0.json (full run, PASS).
- 0.2.0 — the SDLC board flow (#22): feature-start and task-brief follow the board, templates carry the
  flow; eval/results/0.1.2.json (full run, PASS).
- 0.1.2 — C1b: briefs carry the PILOT title and Type line; card number in state.json
- 0.1.1 — the `check-branch-name` hook (S3b). Bumped without a `make eval` run, as a recorded operator exception
  to the rule above; the last full run is `eval/results/0.1.0.json`.
- 0.1.0 — first release (S3).

## Tests

```sh
bash scripts/ci/check.sh mvp_sdlc     # all plugin tests, as CI runs them
bash plugins/mvp-sdlc/tests/run.sh    # the same, directly
```

Python 3.8+ standard library only; hook tests are bash, the rest `unittest`, with stub `gh` and `curl` on the PATH
and throwaway git repositories. `tests/test_evals.py` checks the LLM eval cases without model calls (schema,
patches, scaffolds, graders against simulated GREEN and RED end states).
