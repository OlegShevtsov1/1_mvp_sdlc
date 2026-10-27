# Definition of Ready and Definition of Done

Our own DoR and DoD, replacing the course's legacy wording (R-C8.8). Course basis: task format and its readiness
rules (M6.7), TDD as execution discipline (M7.7), the legacy protocol (M4.9).

## Definition of Ready of a task

Checked before a factory run starts.

- For S and M+ the PRD has `status: Approved`; for M+ at least one ADR is `Accepted` and `sad.md` is merged. Not
  only a person checks this: `sdlc-gate <phase>` blocks the next phase (exit 2) without a merged PR and the right
  status, and `status: Approved` on a PRD does not count until `scripts/lint-prd.py` reports nothing (HTTP codes,
  API paths, SQL, table names in the acceptance criteria).
- The task is in `tasks/tasks.json` (contract R-C2: `id`, `title`, `layer`, `deps`, `acs`, `dod`, `files_hint`,
  `owner`, `estimate`, `status`); acceptance criteria are referenced by ID, never copied; a "Parity ref" goes into
  the notes when needed. Every criterion has a confirmed test level (`plan-tests`). The task fits in one day and 500
  changed lines; otherwise split it (R-C8.14). The task has its own Trello card, recorded in `tasks/tasks.json` by
  `task-cards <slug>`, which exited 0 (decision 78).
- If the task touches a module without tests, characterization tests come first as a separate task (legacy
  protocol, shortened: extract → tests → change).
- CI on `main` is green; the factory profile is current; in the frontend `sync-spec --check` exits 0.
- `task-brief <slug> <task-id>` prints the task text. Each of its refusals is a DoR failure: unknown task, an
  unfinished dependency, larger than one day, a criterion missing from PRD section 5 or without a test level, invalid
  task card fields, no `.claude/sdlc.local.md`. Its warning that the task has no card is a DoR failure too: run
  `task-cards`.
- A UI task (layer `ui`, or a `Visual review: required` `dod` item) has a `Visual reference: <URL or style>` `dod`
  item; without it the factory stops before the plan (PILOT-278).

## Definition of Done of a task

- The PR has exactly the task's three commits: `test(` (RED, CI red on that commit) → `feat(` or `fix(` (GREEN) →
  `refactor(` (if needed); tests green; rubocop, brakeman, bundler-audit and gitleaks clean.
- **CI, not only review, blocks a broken TDD order from the first PR** (R-C3): the first commit starts with `test(`
  and has a recorded red CI status, and `git diff <test-commit>..<feat-commit>` over the tests (`spec/` in the
  backend, `src/**/*.test.*` in the frontend) is empty; otherwise CI is red.
  That check is `tdd-check.yml`. Review by checklist stays as an extra check (test commit first, tests
  unchanged after RED, no P0/P1).
- Merged as one squash commit on `develop` (in the app repositories): the subject is the pull request title
  `PILOT-<task card>: <task title>`, the body has one `Type:` line and the trailers `SDLC-Task: <id>`, `SDLC-AC: <ids>` and
  `Co-Authored-By`.
- Dev Deploy of the merge commit succeeded, dev health answers 200, the factory reported `delivered: true`, and no new
  GlitchTip issues in the project's dev projects during the monitoring window.
- For a UI task: its screenshots (desktop and mobile, light and dark, with data and empty) are committed under
  `docs/screenshots/<card>/`, embedded in the PR description, and the operator approved them at the factory's visual
  gate (decisions 85 and 86).
- The tracker row is `done` (in the same PR), the task's item on the feature card's checklist is ticked, and `state.json` moved to its next
  stage only by script (the `factory-deliver` writer, planned, C2), with the merge commit or CI run as evidence;
  never by hand.

## Definition of Done of a feature

- Every task is `done`; `review-feature` gives `PASS`.
- `CHANGELOG.md` `[Unreleased]` became a version and a person published the draft Release (planned, C4 and C5;
  until then the release note is the PR body from `ship-feature`).
- The release has its own card, titled in its pull requests as [A release's card](#board-flow) says, and that card
  is in `Done`.
- prod runs the release (from a tag, planned, C4; today the Dev-Deploy-built commit through `kamal-deploy.yml`);
  `release-watch` is green (planned, C4; until then a manual check of health and GlitchTip for 10 minutes); the docs
  are updated (`docs/`, Notion).
- The metrics (R-C7) are recorded ([09-metrics.md](09-metrics.md)). Repeated review findings become a rule
  (RULE-LOOP, M9.7): if review misses a P0/P1 finding twice in a row (found later), tasks labelled `migration`,
  `auth` or `security` switch to manual merge (R-C1, variant c); the case is recorded in the C9 retrospective.

## Board flow

Decision 53 sets the lists of every project board and makes moving the cards the harness's job, not the operator's:
`Backlog → Ready → In Progress → Review → Test → (Blocked) → Ready to Release → Test after Release → Done`.

| List | Meaning | Who moves the card there |
|---|---|---|
| `Backlog` | the card exists | the operator; for a feature, see "Not decided yet" item 5 in [00-operator.md](00-operator.md#not-decided-yet) |
| `Ready` | the Definition of Ready is met and the task brief is ready | the operator; the factory moves the card back here, with a comment naming why, when a run stops at a gate or ends not delivered |
| `In Progress` | the factory started (the plan is approved) | the factory, when gate 2 is approved |
| `Review` | the pull request is open: the factory's review and CI | the factory, when delivery returns the pull request; a pull request into a base the operator merges by hand stays here with the comment "waits for the operator merge" |
| `Test` | merged into `develop` (`env/dev` in the infrastructure repository), deployed to dev, the post-merge check on dev runs | the factory, when the run is delivered (merged, deployed, health 200, monitoring not red) |
| `Blocked` | waits for the operator or for something external; back to the previous list once unblocked | the factory, while a run waits at gate 1, gate 2 (including a plan that is not ready to build) or the visual gate, and after a failed rollback; the operator, for anything external |
| `Ready to Release` | checked on dev, waits for the release (`develop` → `main` and a tag) | post-merge, after the dev check (run H3 of the private ops repository; until then the operator) |
| `Test after Release` | on prod, the release watch and prod checks run | the release runs, for the task cards and the release's own card (planned, C4; until then the operator) |
| `Done` | released and checked on prod | the release runs after the prod check, for the task cards and the release's own card; for repositories without releases (this one, the infrastructure and the prompt repositories) post-merge right after a successful post-merge |

How the factory finds the card: the task text names it with a card link (the card's full URL) or with the pull
request title line `PILOT-<n>: <title>` that `task-brief` writes; `PILOT-0` means "no card" and moves nothing. The
title line names the task's own card (decision 78), so the factory moves the task card; `task-brief` never writes a
card link, which would win over the title line. The feature card is moved by the operator by the feature's state,
not by factory runs.

A release's card (decision 91): every release, interim ones included, has its own card with a number. The
release-prep pull request is titled `PILOT-<card>: Release X.Y.Z changelog`, the release pull request `develop` →
`main` and the mirror sync pull request `PILOT-<card>: Release vX.Y.Z`. `PILOT-0` is only for card-less chores, never
for a release: the pr-conventions checks of this repository and of the be/fe templates fail a `PILOT-0: Release …`
title. The release card moves In Progress → Test after Release → Done: the factory moves it to In Progress at gate 2
of the release-prep run and keeps it there through that pull request's review and merge (where a task card would go
to Review and Test); Test after Release once prod runs the tag, and Done once the release watch is green, are the
release runs' moves (until then the operator's). Post-merge of the private ops repository still moves the release card
on to Test and Ready to Release after the release-prep merge; until it leaves a release card in In Progress, the
operator moves it back.
The card must be on the board `TRELLO_BOARD_ID` names. The factory reads `TRELLO_API_KEY`, `TRELLO_TOKEN` and
`TRELLO_BOARD_ID` at run time from `~/.config/trello/.env`, the same file `feature-start` and post-merge use; the list
names default to the ones above and can be renamed under `trello.lists` in `.archon/factory-profile.yaml`. A missing
file, card or list never fails a delivery: the factory writes a warning to `trello.log` in the run's artifacts and
continues.
