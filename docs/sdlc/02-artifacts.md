# Artifacts

An artifact is the agent's external memory: it lives in the repository next to the code, and the next phase reads it
instead of asking again (M6.1). The depth of each artifact grows with the feature size (course size matrix, M6.1).

## Where they live

- **Backend repository** owns every feature artifact: `docs/features/<slug>/` (R-B2).
- **Frontend repository** holds a read-only copy of `PRD.md`, `sad.md`, `adr/`, `contracts/`, `CONTEXT.md` and
  `test-plan.md` (whichever exist, so an S feature without `sad.md` is fine), made by `sync-spec`, each file marked
  "do not edit", with the source commit recorded in `docs/features/<slug>/.spec-source`. The frontend's own `tasks/` live in the frontend repository.
- **Repository level**: `docs/architecture-map.md` (from `map-architecture`, with the commit it reflects), the root
  `CONTEXT.md`, `CLAUDE.md`, `.claude/`, `CHANGELOG.md` (planned, C4 backend, C5 frontend).
- All of it is English (R-C14, R-C8.5).
- Artifacts are **never deleted** after merge: they are the history of the decisions. A stale artifact
  (`status: Draft` for more than 30 days) is a metric, not something to clean up silently ([09-metrics.md](09-metrics.md)).

## Set per size

| Artifact | Written by | XS | S | M, L, XL |
|---|---|---|---|---|
| `state.json` (machine stage) | `feature-start`, then scripts only | yes | yes | yes |
| `idea-brief.md` (`status: Confirmed`) | `/sdlc:interview` | — | yes (easy depth) | yes |
| `CONTEXT.md` (feature glossary) | `/sdlc:interview`, `/sdlc:fix-term` | — | yes | yes |
| `.size` | `/sdlc:classify-size` or `write-prd` | — | yes | yes |
| `PRD.md` (`status: Approved`, acceptance criteria in GWT) | `/sdlc:write-prd`, `/sdlc:clarify-prd` | — | yes | yes |
| `sad.md` | `/sdlc:architecture-design`, `/sdlc:complete-sequence-diagrams` | — | — | yes |
| `adr/NNNN-*.md` (`Accepted`) | `/sdlc:architecture-design`, `/sdlc:decide-adr` | — | only if a decision needs one | yes, at least one |
| `data-model.md` + staged `migrations/NN_name.rb` | `/mvp-sdlc:rails-data-model` | — | if the database changes | if the database changes |
| `contracts/openapi.yaml` | `/sdlc:api-forge` | — | if an API changes | yes |
| `test-plan.md` (or the test plan inside the PRD) | `/sdlc:plan-tests` | — | yes (may stay in the PRD) | yes, separate file |
| `tasks/tasks.json`, `tasks/tracker.md`, `tasks/T<n>.md` | `/sdlc:break-tasks` | — | one task, written by hand (known gap) | yes |
| `_review/review-<date>.md` (`PASS`) | `/sdlc:review-feature` | — | yes | yes |
| `CHANGELOG.md`, `pr-body.md` of the feature | `/sdlc:ship-feature` | — | yes | yes |

For XS the acceptance criteria (Given / When / Then) and the Definition of Done live on the Trello card, and the
task text is written from them (R-C8.7).

## The size S known gap

`task-brief` needs `tasks/tasks.json` (contract R-C2: `id`, `title`, `layer`, `deps`, `acs`, `dod`, `files_hint`,
`owner`, `estimate`, `status`, plus the optional `type` of the pull request, default `feat`), PRD section 5 for every referenced criterion and a test level for each. The course
`break-tasks` refuses without `sad.md` and an Accepted ADR, and S runs neither (R-C8.10). So for S the operator's
interactive session writes `tasks/tasks.json` with one task and one `tasks/tracker.md` row in the contracts docs PR,
and `task-brief <slug> T1` validates them. A helper that writes these two files is a candidate follow-up.

## Machine state

`docs/features/<slug>/state.json` is mandatory for every size and is the only source of the feature's stage; see
[00-model.md](00-model.md#the-chain-from-a-trello-card-to-code), item 7. Only `feature-start`, `sdlc-gate` and
`feature-state.py set` write it; the `block-state-edit` hook stops hand edits.

## Staged migrations

`/mvp-sdlc:rails-data-model` reads `db/schema.rb`, `db/migrate/` and `app/models/` for the conventions and writes
`data-model.md` plus migrations under `docs/features/<slug>/migrations/`. It never touches `db/`, never writes SQL,
and asks instead of guessing when the conventions conflict. Existing tables change only by expand → backfill →
contract, one migration per step. The implementing task promotes the staged migrations into `db/migrate/` with fresh
timestamps (course data model lesson, M6.5).
