# Phases and gates

## Sizes and the phases they run

`/sdlc:classify-size` writes the size into `docs/features/<slug>/.size` from four signals: PR count, time to merge,
new module / API / migration, breaking changes (course size matrix, M6.1).

| Size | Typical | Phases that run | Tasks |
|---|---|---|---|
| XS | 1 PR, at most a day, no migration, no new API (typo, copy, config) | card with GWT criteria and DoD → 5 → 6 → 7 → 8–9 with the next release | one, text written from the card (R-C8.7) |
| S | 2–5 PRs, about a week, maybe a small migration | 1 (interview `--depth=easy`) → 2 → 4 → 5 → 6 → 7 → 8 → 9; an ADR only if a decision needs one | one per repository it touches, written by hand, no `break-tasks` (R-C8.10) |
| M | an epic, 1–2 sprints, new module / API / migration | all, 0–9 | from `break-tasks` |
| L | cross-module, breaking changes possible | all, 0–9 | from `break-tasks` |
| XL | a new subsystem with its own roadmap | split into features first (they can be tracked with `/sdlc:roadmap`), each run as M or L | from `break-tasks` |

Phase 0 (describe what exists) runs once per repository, not per feature: `/sdlc:map-architecture` and
`/mvp-sdlc:bootstrap-project` in the brownfield start runs C2 and C3. The rhythm is one phase per session and
`/clear` between phases (M6.1).

## The gate: human approval plus a deterministic check

A gate is a **human** approval: the artifact gets `status: Approved` in its frontmatter (`Confirmed` for the idea
brief, `Accepted` for an ADR) **and** its docs pull request is merged (R-C8.9). The operator merges docs PRs (R-C1).

The same rule is also checked by code, so a phase cannot start on an unapproved or unmerged artifact: the
`sdlc-gate-hook` hook runs `sdlc-gate <phase> [<slug>]` before a gated course skill, whether the model invokes the
skill or you type `/sdlc:<skill>` or `/sdlc-<skill>`. It exits 0 when the phase may start, 2 with every reason
otherwise. You can run it by hand. The table is the one in
[plugins/mvp-sdlc/README.md](../../plugins/mvp-sdlc/README.md#phase-gate):

| Phase (skill) | Requires |
|---|---|
| `prd` (`sdlc:write-prd`) | `idea-brief.md` status `Confirmed` or `Approved`, merged |
| `architecture` (`sdlc:architecture-design`), `adr` (`sdlc:decide-adr`) | `PRD.md` status `Approved`, merged, `lint-prd` clean |
| `contracts` (`sdlc:api-forge`), `tasks` (`sdlc:break-tasks`) | as above, plus `.size`; for `M`/`L`/`XL` also `sad.md` merged and at least one `Accepted` ADR in `adr/`, merged |
| `ship` (`sdlc:ship-feature`) | `tasks/tasks.json` merged and every task `done` |

"Merged" means: the file is on `origin/<base>`, the working tree matches it there, and the last commit touching it
on `origin/<base>` belongs to a merged pull request (checked with `gh api`). The base is `SDLC_BASE_BRANCH`, else the
remote's default branch, else `main`. The gate never fetches: run `git fetch` after a merge. Without a working `gh`
the gate blocks (fail closed). The slug is the argument, else `SDLC_FEATURE`, else the only feature not yet shipped.
On a pass the gate moves `state.json` forward (never back) with the evidence `sdlc-gate:<phase>:<sha>`.

In the app repositories (the develop model, [05-git-pr-review.md](05-git-pr-review.md)) the feature documents merge
into `develop`, not `main`: set `SDLC_BASE_BRANCH=develop` in the session so the gate looks there. The operator
merges these docs PRs by hand (R-C1); only pull requests with base `main` are never merged automatically at all.

`scripts/lint-prd.py` is part of the gate: a PRD whose section 5 acceptance criteria contain HTTP codes, API paths,
SQL keywords or table names cannot pass, so `status: Approved` on such a PRD is useless until the findings are gone.

Not gated: `/mvp-sdlc:rails-data-model`, `/sdlc:plan-tests` and the other course skills. The hooks work in
interactive sessions only; an unattended Archon run does not load the project-scope plugin today (see
[00-operator.md](00-operator.md#1-one-time-setup)).

## Course skills that refuse on their own

Independently of `sdlc-gate`, five course skills hard-refuse without their inputs (M6.1): `write-prd` (needs
`idea-brief.md` and `CONTEXT.md`), `architecture-design` (needs `PRD.md`), `decide-adr`, `review-feature` (needs an
implemented change) and `ship-feature` (needs a `PASS` review in `_review/`). `break-tasks` also refuses without
`PRD.md`, `sad.md` and an Accepted ADR, and `plan-tests` without `PRD.md`.

## Every course skill and where it is used

The course plugin is vendored unchanged (R-B1); invoke its skills as `/sdlc:<skill>` (R-C8.3).

| Skill | Phase | How the pilot uses it |
|---|---|---|
| `map-architecture` | 0 | once per app repository (C2, C3) and after large changes |
| `interview` | 1 | idea brief and glossary; started by `feature-start` |
| `classify-size` | 1 | writes `.size`; `write-prd` asks for it if missing |
| `fix-term` | 1–4 | keeps `CONTEXT.md` canonical when new terms appear |
| `roadmap` | before 1 | optional: `docs/roadmap.md`, outcomes above single features; the place to split an XL |
| `write-prd` | 2 | gated (`prd`) |
| `clarify-prd` | 2 | the critic pass on the PRD |
| `architecture-design` | 3 | M+; gated (`architecture`) |
| `decide-adr` | 3 | M+, or S when a decision needs an ADR; gated (`adr`) |
| `complete-sequence-diagrams` | 3 | M+ (needs `sad.md`): runtime flows in `sad.md` covering every acceptance criterion |
| `generate-data-model` | — | **not used**: SQL-first; replaced by `/mvp-sdlc:rails-data-model` (R-C8.11) |
| `api-forge` | 4 | `contracts/openapi.yaml`; gated (`contracts`) |
| `plan-tests` | 4 | test level per acceptance criterion; `task-brief` refuses a criterion without one |
| `break-tasks` | 4 | M+ only; gated (`tasks`) |
| `prepare-design-spec` | 4 | frontend features with a UI design to hand over |
| `implement-tasks` | — | **not used**: the factory implements, one task per run, from `task-brief` |
| `verify-ui` | 7 | optional browser check of UI acceptance criteria against a running dev app |
| `review-feature` | 6 | once per feature, after every task is done (R-C5) |
| `ship-feature` | 8 | changelog entry and PR body; never merges; gated (`ship`) |
| `user-documentation` | 8 | optional, against a running dev app, when the feature changes what users see |
| `scaffold` | — | **not used**: projects come from our templates (planned, S4) |

## Our skills and commands

From `mvp-sdlc` ([plugins/mvp-sdlc/README.md](../../plugins/mvp-sdlc/README.md)): `feature-start` (phase 1),
`rails-data-model` (phase 4), `sync-spec` (phase 4, frontend), `task-brief` (phase 5), `bootstrap-project`
(phase 0), the commands `sdlc-gate` (every gate), the scripts `lint-prd.py` and `feature-state.py`, and the hooks
`block-main-push`, `block-destructive-git`, `check-branch-name`, `block-env`, `block-state-edit`, `sdlc-gate-hook`
([07-agent-security.md](07-agent-security.md)). Course basis for checks in code rather than in prose: hooks (M5.4).
