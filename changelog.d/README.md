# Changelog fragments

A task pull request records its change as one file here, `changelog.d/PILOT-<n>.md`, named after its own card, and
never edits [CHANGELOG.md](../CHANGELOG.md). Two tasks in flight then write different files instead of the same
`[Unreleased]` block, so they no longer conflict, and the supervisor's queue (which holds back a brief whose paths
overlap an open run's, [orchestration/supervisor/README.md](../orchestration/supervisor/README.md)) runs them in
parallel once their briefs name the fragment instead of `CHANGELOG.md`.

## Format

```markdown
---
category: Added
---

- What changed, for a reader of the release, ending with its card (PILOT-<n>). A long entry wraps with
  continuation lines indented by two spaces.
```

- The front matter is exactly three lines: `---`, `category: <Category>`, `---`.
- The category is one of Keep a Changelog's: `Added` (new behaviour), `Changed` (existing behaviour works
  differently), `Deprecated` (still works, going away), `Removed`, `Fixed` (a bug), `Security`.
- The body is one or more list items: each starts with `- `, and every other non-blank line is indented by two spaces.
- One fragment per card. A later task for the same card (a fix brief) edits the card's fragment while it is
  unreleased, or adds it again after a release.

`bash scripts/ci/check.sh changelog` checks every fragment, and that `[Unreleased]` in `CHANGELOG.md` holds no
entries; CI runs it on every pull request.

## Release

The release-prep pull request runs `bash scripts/changelog.sh release X.Y.Z` (date: today, or a second argument
`YYYY-MM-DD`). It writes `## [X.Y.Z] - YYYY-MM-DD` right after `[Unreleased]` with the six categories in Keep a
Changelog order, each holding its fragments ordered by card number, deletes the fragments, and leaves `[Unreleased]`
empty. A rerun once the section exists and no fragment is left changes nothing. See
[docs/sdlc/06-releases-changelog-hotfix.md](../docs/sdlc/06-releases-changelog-hotfix.md).
