## What and why

<!-- One or two sentences. Link the feature: docs/features/<slug>/ and the task ID. -->

## Definition of Done of the task

- [ ] Exactly three commits, in order: `test(<scope>)` (RED, CI red on that commit) → `feat(<scope>)` or
      `fix(<scope>)` (GREEN) → `refactor(<scope>)` (if needed)
- [ ] Tests not changed after the RED commit
- [ ] Tests green; linters, security scanners and gitleaks clean
- [ ] Every commit has the trailers `SDLC-Task: <id>` and `SDLC-AC: <ids>`
- [ ] The task's acceptance criteria are covered at the test levels of the test plan
- [ ] Tracker row `done` and the task `status` `done` in `tasks/tasks.json`, in this PR
- [ ] Frontend only: the spec copy is in sync (`sync-spec <slug> --from <be checkout> --check` exits 0)
- [ ] After merge: Dev Deploy of the merge commit succeeded and the dev health check answers 200
- [ ] After merge: the Trello checklist item of the task is ticked
- [ ] `docs/features/<slug>/state.json` is moved only by script, never edited by hand
- [ ] PR title is `<KEY>-<n>: <card title>`, branch `feature|hotfix/<KEY>-<n>-<slug>`
      (`<KEY>` is `PROJECT_NAME` from `config/project.env` in capitals)
- [ ] `Type: feat|fix`: an entry under `[Unreleased]` in `CHANGELOG.md` (or label `skip-changelog`)

## How it was checked

<!-- Commands run and their results. -->

## Type

<!-- One value, kept as the squash commit's Type line (decision 25): feat, fix, chore, docs, refactor, test or ci. The PR title is <KEY>-<n>: <card title>. -->

Type: 
