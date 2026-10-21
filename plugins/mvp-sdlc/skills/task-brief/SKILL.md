---
name: task-brief
description: >-
  Use when a task from docs/features/<slug>/tasks/tasks.json is about to be handed to the Archon factory: prints the
  complete factory task text (what to do and how to tell it works, deploy, health check, rollback) generated from
  the PRD, test plan, tasks, tracker and factory profile. Triggers: "/mvp-sdlc:task-brief <slug> <task-id>",
  "factory brief for <task-id>", "task text for <slug> <task-id>".
---

# task-brief

The factory's gate 2 must be approvable without editing the task text, so the text is generated, not written.

## Steps

1. In the repository that owns the task (backend tasks in the backend repository, frontend tasks in the frontend
   one), run `task-brief <slug> <task-id>`.
2. A non-zero exit is a Definition of Ready failure: show the message and fix the cause where it lives (finish
   the dependency, split the task in `break-tasks`, add the missing test level to the test plan, run
   `bootstrap-project`; no Trello card number: start the feature from its card with `feature-start` in the
   backend, or re-run `sync-spec` in the frontend; an unknown `type` in `tasks/tasks.json`: set one of the listed
   values). Never work around it by writing the brief by hand.
3. Print the output unchanged, with no additions, summaries or branch names: the factory opens the pull request
   from its own `archon/task-factory-*` branch (decision 26). The text already carries the pull request title
   `PILOT-<n>: <card title>` and the description lines `Type:`, `SDLC-Task:` and `SDLC-AC:` that
   `pr-conventions-check` and the squash commit need. The title line is also how the factory finds the card and
   moves it through the board, so the operator does not move the card by hand once the run starts.
4. To run it, pass the whole text as the message argument of `archon workflow run factory --cwd <repo>`.
