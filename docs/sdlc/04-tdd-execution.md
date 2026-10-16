# Task execution and TDD

Phase 5 runs on the existing Archon factory, one task per run, not on the course `implement-tasks` (rewriting a
working engine is not an adaptation). Course basis: Plan → Execute → Verify → Repeat (M7.1), TDD as execution
discipline (M7.7), feedback loops (M7.6).

## The task text: `task-brief`

The factory's gate 2 must be approvable without editing the task text, so the text is generated, not written.
`task-brief <slug> <task-id>` (or `/mvp-sdlc:task-brief`), run in the repository that owns the task, prints it in
the factory guide's form:

- **A. What to do and how to tell it works**: the task title, layer and likely files; its acceptance criteria
  verbatim from PRD section 5; the test level of each criterion; the task's DoD; the rules — at most one day and 500
  changed lines, exactly three commits in order, the commit trailers, the test and lint commands from
  `.claude/sdlc.local.md`, the tracker row and the `tasks/tasks.json` status to set to `done` in the same PR, and the
  Trello checklist item to tick (the card id comes from `state.json`); the pull request title
  `PILOT-<n>: <card title>` and the description lines `Type:`, `SDLC-Task:` and `SDLC-AC:`
  ([05-git-pr-review.md](05-git-pr-review.md)).
- **B. Deploy, C. Health check, D. Rollback** from `.archon/factory-profile.yaml`, or a note that the factory's
  profile gate will ask.

It never names a branch (the factory opens the PR from its own branch). It refuses a task that is not ready; each
refusal is a Definition of Ready failure to fix where it lives ([03-dor-dod.md](03-dor-dod.md)), never a reason to
write the text by hand. Pass the whole output, unchanged, as the message of
`archon workflow run factory --cwd <repo> "<the task text>"`.

Exceptions: size XS has no PRD or `tasks/tasks.json`, so its text is the card's acceptance criteria plus the DoD
checklist; size S needs the one-task `tasks/tasks.json` written by hand first ([02-artifacts.md](02-artifacts.md)).

## RED, GREEN, refactor

Three commits on the PR branch of each task (R-C3):

1. `test(<scope>): ...` — the failing tests for the task's criteria. CI on this commit is red: that is the proof
   that the tests test something.
2. `feat(<scope>): ...` or `fix(<scope>): ...` — the code that makes them pass. **Tests are not changed after RED.**
3. `refactor(<scope>): ...` — clean-up with every test still green, when needed.

Every commit ends with the trailers `SDLC-Task: <id>` and `SDLC-AC: <ids>`; the merge is one squash commit on
`develop` (in the app repositories) with those trailers and `Co-Authored-By`. CI checks the order from the first PR
(`tdd-check.yml`): first commit `test(` with a recorded red status, no test change between the test and the feat commit.

**Escalation**: if a test encodes a wrong acceptance criterion, the agent does not change the test or bend the code.
It stops with `BLOCKED` and a question to the operator; the fix goes to the PRD (a docs PR), then the task runs again.

## Defects become saved evals

Every missed P0/P1, every manual correction by the operator and every `delivered: false` is closed only together with
a new case that reproduces it; a fix without a case is not accepted. For the plugin's deterministic parts (hooks,
gate, linters) the case is a regression test under `plugins/mvp-sdlc/tests/`, today. LLM eval cases for our skills
go to `plugins/mvp-sdlc/evals/` (one directory per case, with `evals/broken/` RED variants; delivered by C6) and run with `make eval`.

Cheapest fix first:

1. a line in an instruction (skill, rule, `CLAUDE.md`);
2. a check in code (hook, CI step, linter);
3. an LLM judge, only with proof that the first two do not catch it.

## Evals layers

- **Layer 0** (shipped, blocking in CI): `scripts/lint_plugins.py` lints the agent tool contract, skill frontmatter,
  hook definitions, versions and the vendored tree sha256 (R-C6).
- **Layer 1** (planned, C6): golden cases for our skills and hooks only, run by hand before each `mvp-sdlc` version
  bump; the course plugin is not tested (R-C6, course evals lesson M10.3).

## PRD lint

`scripts/lint-prd.py <PRD.md>` fails on technical tokens in the acceptance criteria of PRD section 5: HTTP status
codes, API paths, an HTTP verb with a path, uppercase SQL keywords, table names. It runs before `status: Approved`
and inside `sdlc-gate` for every phase after the PRD (R-C8.6).
