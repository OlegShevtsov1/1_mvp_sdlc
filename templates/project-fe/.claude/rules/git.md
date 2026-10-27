# Git

- Work on `feature/<KEY>-<n>-<slug>` (or `hotfix/<KEY>-<n>-<slug>`; the factory uses `archon/task-factory-*`). Changes
  reach `develop` (hotfixes: `main`) only through a reviewed, squash-merged pull request titled
  `<KEY>-<n>: <card title>` with exactly one `Type:` line in its body; `develop → main` is the operator's release PR.
  `<KEY>` is the ticket key: `PROJECT_NAME` from `config/project.env` in capitals.
  Never push to `main` or `develop` directly.
- Never force-push, never `git reset --hard`, never delete or move a tag. The `mvp-sdlc` hooks block these; if a hook
  blocks you, change the approach instead of looking for a way around it.
- Commit subjects follow Conventional Commits (`feat`, `fix`, `test`, `refactor`, `docs`, `chore`, `ci`).
- A task from `tasks/tasks.json` is exactly three commits: `test(...)` with the failing tests, `feat(...)` or
  `fix(...)` that makes them pass, `refactor(...)`. Each carries the trailers `SDLC-Task: <id>` and
  `SDLC-AC: <AC ids>`.
- A PR whose body has `Type: feat` or `Type: fix` adds an entry under `[Unreleased]` in `CHANGELOG.md` (a hotfix PR
  into `main` adds its `## [X.Y.Z]` section instead), or carries the label `skip-changelog`; changelog-check enforces it.
- Release pull request `develop` → `main`: title `<KEY>-<n>: Release vX.Y.Z` (the release's own card, never
  `<KEY>-0`; decision 91); its body has `## Changelog` followed by the full `## [X.Y.Z]` section of
  `CHANGELOG.md`, pasted verbatim. The release-prep pull request
  `<KEY>-<n>: Release X.Y.Z changelog` writes that section first.
- Never move or delete a published `v*` tag; install the pre-push hook with `git config core.hooksPath scripts/git-hooks`.
- Stage files by name. Never commit `.env*` files, `config/master.key`, `.claude/*.local.md` or build output.
- When a task is done, set its row in `docs/features/<slug>/tasks/tracker.md` and its `status` in `tasks.json` to
  `done` in the same pull request.
