# The model: course SDLC mapped onto the pilot

## The course model

- **Nine phases**: PM → BA/PO → Architect → Tech Lead and developers (contracts) → developers (code) → Review → QA →
  Docs and Deploy → Monitoring, with three feedback loops: QA → BA, Review → Architect, Monitoring → PM. A **gate**
  is a human approval between two phases; the criterion is that the next phase can work from the artifact without
  further questions (M6.1).
- An **artifact** is the agent's external memory and lives in the repository next to the code:
  `docs/features/<slug>/` (CONTEXT, idea brief, PRD, SAD and ADRs, data model, contracts, tasks, test plan,
  `_review/`), `docs/architecture-map.md`, `CHANGELOG.md`. The set depends on the feature size XS…XL (M6.1; see
  [02-artifacts.md](02-artifacts.md)).
- The course plugin 4.5.1 has 21 skills and 11 agents. Five skills hard-refuse to run without their inputs:
  `write-prd`, `architecture-design`, `review-feature`, `ship-feature`, `decide-adr`. The rhythm is one stage per
  session with `/clear` in between (M6.1).
- **Execution**: Plan → Execute → Verify → Repeat. TDD goes specification → test → code: RED is confirmed and
  committed before the code, tests do not change after that, roles are isolated, the gate is deterministic, "done" is
  not decided by the implementer, and iteration and cost limits are hard (M7.1, M7.7).
- **Git**: GitHub Flow, Conventional Commits with `Co-Authored-By`, small PRs, a human merges; the app repositories
  and `1_mvp_sdlc` use the develop model instead of GitHub Flow (decisions 24, 54, [05-git-pr-review.md](05-git-pr-review.md)). AI review does not
  block a merge; findings are P0/P1/P2. For releases a script decides the version number, the agent explains, a
  human confirms (M9.1, M9.7).
- **Agents in production**: least-privilege tools, evals as tests of the agent configuration, every agent input is
  untrusted data. Health checks and watchers are deterministic. The AI does not roll back and has no Docker socket.
  Adoption starts with a pilot and baseline metrics (M10.3, M11.1, M11.3, M11.6).
- **Context**: `CLAUDE.md` up to 200 lines with a Hard Rules block, plus rules, hooks and skills. In a brownfield
  project `map-architecture` comes first; untested code changes by the legacy protocol (M4.4, M4.9).

How it lands on the pilot: the pilot CI/CD plan already covers phases 8–9 and part of 6 (CI, build once and promote,
automatic dev deploy, prod with a typed confirm and a ref check, rollback, GlitchTip, Gatus, Beszel, Telegram,
drills, Trello cards), and the factory already is a Plan → Execute → Verify loop with a human gate on the plan. The
SDLC addendum adds phases 1–7 for pilot features: artifacts, DoR and DoD, TDD discipline in factory tasks, releases,
the changelog, hotfixes, `main` protection and metrics. Deliberately not taken: marketplace governance and managed
settings (a one-person team, M5.6, M11.6), Agent Teams (they do not run headless, M10.4), Managed Code Review and
`claude-code-action` in CI (R-C5), Ralph and `/goal` as a separate loop (the factory is the loop), `scaffold` (we
have our own templates), git flow and trunk-based, and `generate-data-model` as is (SQL-first; the pilot is
ActiveRecord, so `rails-data-model` replaces it).

## Phases and gates for the pilot

Course phase, feature size, who does what, the artifact and where it lives, the gate, and the Trello list (R-C11).
"be" is the backend repository, "fe" the frontend repository.

| Course phase | Size | Who does what, how | Artifact and where it lives | Gate (who approves, criterion) | Trello (R-C11) |
|---|---|---|---|---|---|
| 0. Describe what exists (brownfield) | — | operator with Claude: `/sdlc:map-architecture`, `/mvp-sdlc:bootstrap-project` | `docs/architecture-map.md` (`reflects_commit`), root `CONTEXT.md`, `CLAUDE.md` with Hard Rules (C2, C3) | merged PR | — |
| 1. Idea | S, M+ | `/mvp-sdlc:feature-start <card link>` → `/sdlc:interview <slug>` (S: `--depth=easy`), `/sdlc:classify-size` | be: `docs/features/<slug>/` with `idea-brief.md`, `CONTEXT.md`, `.size` | operator: brief `status: Confirmed` | `Backlog` |
| 2. Requirements | S, M+ | `/sdlc:write-prd` → `/sdlc:clarify-prd` | be: `PRD.md` (acceptance criteria in GWT, no technical tokens) | operator: `status: Approved` + merged PR (R-C8.9) | `Backlog` |
| 3. Architecture | M+ (S: an ADR only if needed) | `/sdlc:architecture-design`, `/sdlc:decide-adr` | be: `sad.md`, `adr/NNNN-*.md` (Accepted) | operator: ADR `Accepted`, merged PR | `Backlog` |
| 4. Contracts | S, M+ | `/mvp-sdlc:rails-data-model`, `/sdlc:api-forge`, `/sdlc:break-tasks` (M+), `/sdlc:plan-tests` | be: `data-model.md`, `migrations/*.rb` (staged), `contracts/openapi.yaml` (checked against `swagger/v1`), `tasks/tasks.json` and `tasks/tracker.md`, `test-plan.md`; fe: `/mvp-sdlc:sync-spec` + the frontend's own `tasks/` | **DoR** ([03-dor-dod.md](03-dor-dod.md)) met; PR merged | `Ready` |
| 5. Code | all | factory, one task per run: `archon workflow run factory --cwd <repo> "<task-brief output>"` | code, tests, `tracker.md` row → `done`, in the same PR | factory gate 2: plan approved; then automatic merge (R-C1) | `In Progress` |
| 6. Review | all; M+ also per feature | factory review (lenses) on every PR; at the end of the feature `/sdlc:review-feature` | `_review/review-<date>.md` | PASS, no P0/P1 | `Review` |
| 7. QA | all | CI (rspec, rubocop, brakeman, bundler-audit, gitleaks; fe: lint, build) + deploy to dev + `project-e2e.sh` | E2E report, CI logs | deterministic: everything green | `Test` |
| 8. Docs and deploy | release | `/sdlc:ship-feature` (CHANGELOG + PR body; never merges), tag `vX.Y.Z` by a human, prod: `kamal-deploy.yml` with a typed confirm | `CHANGELOG.md`, draft Release, `docs/` | **DoD** ([03-dor-dod.md](03-dor-dod.md)) | `Ready to Release` → `Test after Release` → `Done` |
| 9. Monitoring | release | `release-watch` (10 min; planned, C4), Gatus, GlitchTip → Telegram | release execution log, metrics (R-C7) | no new prod issues in the window; otherwise a hotfix | a new `hotfix` or `feature` card |

The lists follow decision 53 (`Blocked` at any phase while the work waits for the operator); who moves the card
at each step is in [the Board flow](03-dor-dod.md#board-flow).

**XS** (a small change, config, text): a card with acceptance criteria in GWT and the DoD → straight to phase 5
(R-C8.7).

Where shipped tooling differs from this agreed table, the tooling wins and the difference is stated:

- Phase 1: the feature starts with `/mvp-sdlc:feature-start` (the `feature-start` command of the plugin), not a
  `bin/` script of the app repository, and it moves the card to `In Progress` when the feature **starts**, so during
  phases 1–4 the card sits in `In Progress`, not in `Backlog`/`Ready`. Aligning the two is open.
- Phase 4 for size S: `break-tasks` is not run (R-C8.10), so the one-task `tasks/tasks.json` and its tracker row are
  written in the contracts docs PR by the operator's session ([00-operator.md](00-operator.md#size-s)).
- Phase 8: today prod deploys a commit sha built by Dev Deploy (`kamal-deploy.yml` with `confirm=prod`). Tags,
  the changelog-driven draft Release and tag-only prod are planned, C4 (backend) and C5 (frontend).

## The chain from a Trello card to code

1. **Card** in the `Backlog` list of the project's board: name `<slug>: <what>`, label `feature`. The size comes
   from `classify-size` and goes onto the card.
2. **Artifacts of phases 1–4** are created by the operator interactively in the backend repository: the skills ask
   through `AskUserQuestion`, which the unattended factory cannot do, so these phases **never** go through the
   factory. Each phase ends with a docs PR that a human merges; the PR link goes onto the card. For the frontend:
   `sync-spec` → a docs PR in the frontend.
3. **Tasks**: `tasks.json` (format B, R-C2) → the card checklist `T1…Tn`. The card moves to `Ready` when the DoR
   holds.
4. **Execution**: for each `Tn` one factory run with the text from `task-brief`. The factory: gate 2 (human) →
   deliver (TDD per the task text, review, CI) → merge → deploy (the profile waits for Dev Deploy of the merge
   commit) → dev health → monitor → `report.json`. The agent ticks `Tn` on the card through the Trello REST API.
5. **Feature review and release** (phases 6–9): `review-feature` → `ship-feature` → release → prod →
   `release-watch` (planned, C4) → card `Done`, with links to the Release and the metrics in a comment.
6. **Source of truth** is git: the backend for everything shared, the frontend holds a copy. Trello is a projection
   of the state with links. Notion mirrors the docs and the execution logs.
7. **Machine state of a feature**: `docs/features/<slug>/state.json` is the only source of the stage. Stages, in
   order: `idea`, `accepted`, `researched` / `briefed` (same rank), `prd`, `architecture`, `contracts`, `tasks`,
   `in-progress`, `review`, `shipped`, `measured`; they only move forward. Only scripts write it, never an LLM or a
   person directly: `feature-start` creates it at `idea`, `sdlc-gate` advances it on a passing gate, and
   `feature-state.py set` writes the later stages with evidence. The writers of the later stages arrive with their
   runs: `in-progress` from `factory-deliver` (planned, C2),
   `shipped` from `release.yml` (planned, C4), `measured` from `bin/sdlc-metrics` (planned, C4). Hand edits are blocked by the `block-state-edit` hook and the deny rules. Moving the card between
   lists is derived from `state.json`, not an independent action; a card that disagrees with `state.json` is a
   defect. Schema and details:
   [plugins/mvp-sdlc/README.md](../../plugins/mvp-sdlc/README.md#statejson).
