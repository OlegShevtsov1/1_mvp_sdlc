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
  changed lines; otherwise split it (R-C8.14).
- If the task touches a module without tests, characterization tests come first as a separate task (legacy
  protocol, shortened: extract → tests → change).
- CI on `main` is green; the factory profile is current; in the frontend `sync-spec --check` exits 0.
- `task-brief <slug> <task-id>` prints the task text. Each of its refusals is a DoR failure: unknown task, an
  unfinished dependency, larger than one day, a criterion missing from PRD section 5 or without a test level, no
  `.claude/sdlc.local.md`.

## Definition of Done of a task

- The PR has exactly the task's three commits: `test(` (RED, CI red on that commit) → `feat(` or `fix(` (GREEN) →
  `refactor(` (if needed); tests green; rubocop, brakeman, bundler-audit and gitleaks clean.
- **CI, not only review, blocks a broken TDD order from the first PR** (R-C3): the first commit starts with `test(`
  and has a recorded red CI status, and `git diff <test-commit>..<feat-commit>` over the tests (`spec/` in the
  backend, `src/**/*.test.*` in the frontend) is empty; otherwise CI is red.
  That check is `tdd-check.yml`. Review by checklist stays as an extra check (test commit first, tests
  unchanged after RED, no P0/P1).
- Merged as one squash commit on `develop` (in the app repositories): the subject is the pull request title
  `PILOT-<n>: <card title>`, the body has one `Type:` line and the trailers `SDLC-Task: <id>`, `SDLC-AC: <ids>` and
  `Co-Authored-By`.
- Dev Deploy of the merge commit succeeded, dev health answers 200, the factory reported `delivered: true`, and no new
  GlitchTip issues in the project's dev projects during the monitoring window.
- The tracker row is `done` (in the same PR), the Trello checklist item is ticked, and `state.json` moved to its next
  stage only by script (the `factory-deliver` writer, planned, C2), with the merge commit or CI run as evidence;
  never by hand.

## Definition of Done of a feature

- Every task is `done`; `review-feature` gives `PASS`.
- `CHANGELOG.md` `[Unreleased]` became a version and a person published the draft Release (planned, C4 and C5;
  until then the release note is the PR body from `ship-feature`).
- prod runs the release (from a tag, planned, C4; today the Dev-Deploy-built commit through `kamal-deploy.yml`);
  `release-watch` is green (planned, C4; until then a manual check of health and GlitchTip for 10 minutes); the docs
  are updated (`docs/`, Notion).
- The metrics (R-C7) are recorded ([09-metrics.md](09-metrics.md)). Repeated review findings become a rule
  (RULE-LOOP, M9.7): if review misses a P0/P1 finding twice in a row (found later), tasks labelled `migration`,
  `auth` or `security` switch to manual merge (R-C1, variant c); the case is recorded in the C9 retrospective.
