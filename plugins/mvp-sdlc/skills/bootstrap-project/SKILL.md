---
name: bootstrap-project
description: >-
  Use when an application repository (Rails backend or npm frontend) needs the mvp-sdlc Claude Code setup: CLAUDE.md
  with hard rules, .claude/settings.json enabling the sdlc and mvp-sdlc plugins with deny rules, .claude/rules/,
  .claude/sdlc.local.md and the .gitignore line for local settings. Safe to re-run. Triggers:
  "/mvp-sdlc:bootstrap-project", "bootstrap claude setup", "set up .claude for this repo".
---

# bootstrap-project

The `bootstrap-project` command (on the PATH from this plugin's `bin/`) does the work and is idempotent; this skill
picks the kind and asks before anything is overwritten.

## Steps

1. **Detect the kind** from the repository root: a `Gemfile` means `be`, a `package.json` means `fe`. If both or
   neither exist, ask with `AskUserQuestion` (options `be` and `fe`) and do not guess.
2. Run `bootstrap-project <kind>`. It prints one line per file: `created`, `unchanged`, `overwritten`, or
   `differs (kept; re-run with --overwrite <path>); template: <template file>`, and ends with `No changes` when
   nothing was written.
3. For every `differs` line: show `diff -u <path> <template file>` with the two paths from that line (do not look
   for the template anywhere else), then ask with `AskUserQuestion` whether to replace that file. Only after an explicit yes run
   `bootstrap-project <kind> --overwrite <path>` for it. **Never overwrite `CLAUDE.md` without an explicit yes**;
   if the user does not answer, keep it.
4. Report the final per-file result. Remind the user to commit `CLAUDE.md`, `.claude/settings.json`,
   `.claude/rules/` and `.gitignore` in a pull request; `.claude/sdlc.local.md` stays uncommitted.
