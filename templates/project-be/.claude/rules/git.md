# Git

- Work on a feature branch; changes reach `main` only through a reviewed, squash-merged pull request.
- Never force-push, never `git reset --hard`, never delete or move a tag. The `mvp-sdlc` hooks block these; if a hook
  blocks you, change the approach instead of looking for a way around it.
- Commit subjects follow Conventional Commits (`feat`, `fix`, `test`, `refactor`, `docs`, `chore`, `ci`).
- A task from `tasks/tasks.json` is two or three commits: `test(...)` with the failing tests, `feat(...)` or
  `fix(...)` that makes them pass, and `refactor(...)` if there is cleanup to do. Each carries the trailers
  `SDLC-Task: <id>` and `SDLC-AC: <AC ids>`.
- Branches are `feature/<KEY>-<n>-<slug>` or `hotfix/<KEY>-<n>-<slug>` and the PR title is `<KEY>-<n>: <card title>`;
  `<KEY>` is `PROJECT_NAME` from `config/project.env` in capitals (`bin/pr-conventions-check` enforces both).
- Stage files by name. Never commit `.env*` files, `config/master.key`, `.claude/*.local.md` or build output.
- A PR whose `Type:` is `feat` or `fix` adds an entry under `[Unreleased]` in `CHANGELOG.md` (`changelog-check`;
  label `skip-changelog` only for trivia).
- Never move or delete a published `v*` tag; the repository's `.githooks/pre-push` refuses it
  (`git config core.hooksPath .githooks`).
- When a task is done, set its row in `docs/features/<slug>/tasks/tracker.md` and its `status` in `tasks.json` to
  `done` in the same pull request.
