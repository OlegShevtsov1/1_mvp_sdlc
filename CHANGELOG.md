# Changelog

All notable changes to this repository are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version is the `mvp-sdlc` plugin version, tagged
`vX.Y.Z` on `main` after the release pull request `develop` → `main`. A release moves the entries under
`[Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section and keeps the six empty categories as the template; the
release pull request `PILOT-<n>: Release vX.Y.Z` carries that section under `## Changelog` (decision 64, checked by
`scripts/ci/pr-conventions.sh`).

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

## [0.5.0] - 2026-10-28

### Added

- `sync-spec` copies the frontend's own tasks (PILOT-397, mvp-sdlc 0.5.0): `tasks/tasks.json` reduced to the tasks
  whose `"repo"` is the frontend (deps on backend tasks move to `"external_deps"`), their task files and the epic, so
  `/sdlc:implement-tasks <slug>` runs in the frontend. `tasks/tracker.md` stays in the backend, which owns task
  status. `--check` also covers the task copy and fails on a file under `tasks/` that is not a copy; a re-sync
  removes a copied file that is no longer a source. `task-brief --from` works next to the copy and is required for
  it. The operator guide makes the factory the default for code and `implement-tasks` the supported alternative, with
  the steps the operator then does by hand.
- A blocker re-raised on a narrower case from round 3 on becomes a follow-up card (PILOT-300, decisions 93, 99, 100):
  when the bundled delivery ends `replan` at round 3 or later, or at the round cap, and its only open blockers
  re-raise earlier findings on narrower cases, every other contract item is met and CI is green, the factory creates
  a Trello card per such finding (label `task`, in `Ready`), links the cards in the PR description and the run
  report, marks the PR ready and goes on to the merge gate. New nodes `review-state`, `followup-judge` and
  `review-followup`; two fixtures cover both paths.

### Changed

- The AI PR review of the be and fe templates posts a GitHub pull request review (PILOT-369, decision 103 a): one
  review per head commit as `github-actions`, with findings as inline comments on the changed lines (others in the
  review body), *Request changes* on P0/P1, otherwise *Comment*, and the bot's earlier *Request changes* dismissed
  once a review is clean. The posting script runs from the workflow's own revision. Factory PRs are now reviewed
  too. The issue comment is gone. The check stays red on P0/P1 or a missing summary, and the job log lists every
  P0/P1.

### Deprecated

### Removed

### Fixed

- A failed delivery is re-run once (PILOT-301, decision 100): when the bundled delivery ends `failed`, for example
  because the review's `route` node got no structured output from Claude, the factory runs one more delivery on the
  same branch and pull request (new nodes `redeliver` and `last-delivery`) and the report says it retried and why; a
  second failure or any other reason ends the run as before. Two fixtures cover both paths.
- pr-conventions never dies on SIGPIPE under `pipefail` (PILOT-336): the Type-line check of this repository and of
  the fe template, and this repository's release-changelog check, piped the PR body into a reader that stops at its
  first match, so the writer could die of SIGPIPE and a valid pull request failed the check. They now read the body
  from a here-string. Found in 1_mvp_pilot_fe (PILOT-306); the be template already used here-strings.
- The fe template's TDD check never skips the gate on a large change list (PILOT-339): it piped the changed files
  into `grep -q`, so on a list larger than the pipe buffer the upstream `grep` died of SIGPIPE under `pipefail`
  and the check printed "not applicable" and passed. It now reads the whole list before deciding. Found and fixed
  in 1_mvp_pilot_fe (PILOT-117); the be template has no such pipe.
- The merge gate no longer refuses a pull request whose check has a cancelled run superseded by a newer green one
  (PILOT-372): `pr-state` reads every run on the head (`statusCheckRollup`), judges each check by its latest run per
  workflow and name, and waits, bounded like `review-state` (20 min), while a check or a workflow run on the head is
  queued or in progress; a latest run that failed, timed out or was cancelled with nothing newer still refuses.
  Found on 1_mvp_pilot_be#108 (run dacea56f) and 1_mvp_pilot_fe#65.
- The AI PR review of the be and fe templates lists each finding once (PILOT-399): inline on a changed line,
  otherwise in the review body; the summary no longer repeats them (fe report, be prompt). The review body and every
  inline comment are capped at 60000 characters with a truncation note, as GitHub rejects more than 65536. Only a
  `github-actions` review whose body starts with `<!-- ai-review -->` counts as the AI review's own, for the
  same-head no-op and for the dismissal, so another workflow's review on the same token is left alone. The fe
  PR-head checkout no longer persists the token, as in be (PILOT-396). Found by the review of fe parity run
  0e711247.

### Security

## [0.4.0] - 2026-10-27

### Added

- UI tasks pass an operator visual-review gate inside the factory run (PILOT-278, decisions 85, 86): the brief names
  a visual reference, the build commits e2e screenshots under `docs/screenshots/<card>/` and embeds them in the PR
  body, and after CI the run waits for approve / needs-revision / abort; needs-revision runs a new implement round in
  the same run on the same PR.
- Every release has its own card (decision 91, PILOT-283): the pr-conventions checks of this repository and of the
  be/fe templates fail a `PILOT-0: Release …` title, and the factory keeps a release-prep run's card in
  `In Progress` instead of `Review` and `Test`.
- The factory stops with an operator alert when the Claude CLI login has expired (decision 93, PILOT-305): it checks
  the login with one minimal call before it starts and classifies a provider auth failure in any later node from the
  run's transcript; the run stops with a `claude /login` message and one Telegram alert to `MVP_VPN_ALERTS` per run.
  `install.sh` copies `notify-telegram.sh` into the pack, and `scripts/claude-auth.ts preflight|scan` is the helper
  for `post-merge`.
- One Trello card per feature task (decision 78, PILOT-250): `task-cards` creates or adopts the task cards and
  records them in `tasks.json`; `task-brief` titles the pull request by the task card and briefs frontend tasks from
  the backend checkout with `--from`.
- Every release pull request carries its changelog (decision 64, PILOT-207): this `CHANGELOG.md`; the mirror sync
  pull request of a release has `## Changelog` with the tag's section (PILOT-302), and `publish-mirror.sh` refuses a
  release whose `CHANGELOG.md` has no entries for the tag; the prod infra promotion pull request lists the `env/dev`
  pull requests merged since the last promotion; the pr-conventions check fails a `PILOT-<n>: Release vX.Y.Z` pull
  request without a non-empty `## Changelog` section for the version.
- The SDLC uses the project knowledge server mvp-rag (K1, PILOT-196): the factory's `rag-context` node searches it
  before the plan, the planner cites the sources it used and `report.json` records `rag_status` and
  `rag_sources`; the `mvp-sdlc` skills `feature-start`, `task-brief`, `sync-spec` and `rails-data-model` search it
  first and cite their hits; `bin/rag search|reindex` is the client for shells and post-merge. An unset or
  unreachable server is only a warning.
- `bin/project-add <name>`, the new-project orchestrator (S5, PILOT-187): preflight, infrastructure through
  `vpnctl`, the backend and frontend repositories from the templates with `main` and `develop`, environments and
  secrets (`RAG_MCP_URL` and `RAG_MCP_TOKEN` included), Telegram topics, the Trello board, the Notion page, the
  plugin check and a report; `--dry-run`, `--step`, `--undo`; state in `~/.local/state/project-add/`.

### Changed

- `task-brief` accepts a task estimated `L` (one day) and refuses only `XL`.
- publish-mirror titles a release sync with the release card number, `PILOT-<n>: Release vX.Y.Z` (decision 58,
  PILOT-176).

### Deprecated

### Removed

### Fixed

- The factory ends cleanly after a failed merge (PILOT-164).
- The factory creates the run worktree from the profile's `base_branch` (PILOT-168).
- The recheck action reads the review verdict correctly (PILOT-163).
- The factory plan and profile gates use wait attention, and the gate rounds read the decision saved by
  `until_bash`, so runs resume under Archon v0.12.1 (PILOT-217).
- The factory republishes the pull-request description from the run's latest body file before the merge, and
  refuses to merge a description it could not republish; the implement agents are told not to wait with `pgrep -f`
  on a literal in their own command (PILOT-219).
- The TDD order check of the be and fe templates counts only the task's own commits: be compares against the live
  base branch instead of the event's stale base sha, and fe ignores test changes brought in by merging the base
  (PILOT-281).

### Security

## [0.2.0] - 2026-10-21

### Added

- `publish-prod-infra.sh` syncs the prod infra root to the private infra copy `env/prod` through a pull request
  (PILOT-175).
- Eval results for mvp-sdlc 0.1.2: 10/10 cases discriminate, verdict PASS; the plugin moves to 0.2.0 (PILOT-173).

### Changed

- publish-mirror syncs through the mirror `develop` and a pull request into `main`, and carries release tags
  (decision 51, PILOT-157).
- publish-mirror carries only the release tags whose content the sync brings (PILOT-167).

## [0.1.0] - 2026-10-20

Everything merged into `main` before the develop branch model (decision 54); not tagged. The `mvp-sdlc` plugin
went through 0.1.0, 0.1.1 and 0.1.2 in this period; its own list is in `plugins/mvp-sdlc/README.md` ("Versioning").

### Added

- Repository skeleton and CI with one entry point, `scripts/ci/check.sh`: actionlint, the public-repo check and
  gitleaks.
- The plugin marketplace `mvp` with the vendored course plugin `sdlc` 4.5.1 and the plugin lint (evals layer 0).
- The `mvp-sdlc` plugin: Rails/ActiveRecord data model, two-repository spec sync, Trello-card feature start,
  factory task briefs, app-repo `.claude/` bootstrap and deterministic guards (phase gate, PRD lint, script-only
  `state.json`, git and secret hooks), later the `check-branch-name` hook.
- The SDLC process documents in `docs/sdlc/`.
- The golden eval suite for the mvp-sdlc skills and hooks, with pass^3 results.
- The Archon `factory` workflow pack and the `plan-review` workflow, moved here with their history, and
  `install.sh`.
- `publish-mirror.sh`, which syncs the public mirrors from the primary repositories.
- The project templates `templates/project-be` and `templates/project-fe`, rendered from the pilot release.
- The factory moves the task's Trello card through the SDLC board; the plugin and the templates follow the board
  flow.

### Changed

- The develop branch model in the SDLC docs and the factory briefs; the PILOT title and the `Type:` line in the
  briefs.
- CI jobs take their runner from `vars.RUNS_ON`.
- The public README: intro, live links and how the AI process works; the delivery history moved to `docs/`.
- The factory never merges a pull request whose base is `main` by itself (decision 27).
- This repository moves to the develop branch model: `develop` is the working branch, `main` the released version
  (decision 54).

### Fixed

- Factory runs no longer stall on CI waits under Archon v0.10.1.
- Six mvp-sdlc eval cases that did not discriminate now fail RED.
