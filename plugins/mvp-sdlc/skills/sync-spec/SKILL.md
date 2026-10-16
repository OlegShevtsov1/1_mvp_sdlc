---
name: sync-spec
description: >-
  Use in the frontend repository to copy a feature's spec artifacts (PRD, SAD, ADRs, contracts, CONTEXT, test plan)
  from a local checkout of the backend repository, or to check that the copy is still in sync. Triggers:
  "/mvp-sdlc:sync-spec <slug>", "sync spec for <slug>", "is the spec copy for <slug> up to date".
---

# sync-spec

The backend repository owns the feature artifacts; the frontend repository keeps a read-only copy under
`docs/features/<slug>/`, each file marked "Copied from be@<sha> ... Do not edit here.".

## Steps

1. Make sure the backend checkout is fresh: `git -C <be checkout> fetch origin`. Ask the user for the path of the
   backend checkout if you do not know it.
2. In the frontend repository run `sync-spec <slug> --from <be checkout>` (add `--ref <ref>` only when the user
   asks for something other than `origin/main`). A non-zero exit: show the message and stop.
3. Commit the copied files and `docs/features/<slug>/.spec-source` on a docs branch and open a docs pull request;
   the copy changes nothing else. In the pilot app repositories that branch is `feature/PILOT-<n>-<slug>-spec`,
   the pull request goes into `develop` with the title `PILOT-<n>: <card title>` and the body line `Type: docs`.
   The record also carries the card number and title from the backend `state.json`, which `task-brief` needs for
   frontend tasks.
4. Never edit a copied file in the frontend repository. A needed change goes to the backend repository first, then
   is synced again.

## Check

`sync-spec <slug> --from <be checkout> --check` exits 1 when a source file changed or appeared, or a copy was edited
locally. Running it and getting exit 0 is part of the Definition of Done of every frontend task of the feature. It
runs locally only: frontend CI cannot read the private backend repository.
