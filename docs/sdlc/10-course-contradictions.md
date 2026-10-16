# Course contradictions and what we chose

The course contradicts itself, or does not fit a one-person Rails + React project, in 18 places. The operator agreed
all 18 decisions as one package (R-C8). Item 5 was changed later by the operator's "public repositories" amendment.
Course lessons are cited in the Source column (M<n>.<n>).

| # | Contradiction | Decision | Source |
|---|---|---|---|
| 1 | GitHub Flow or trunk-based | **GitHub Flow**: branch `feat/...` or `fix/...` → PR → merge; changed by decision 24 for the app repositories: see [05-git-pr-review.md](05-git-pr-review.md) (GitHub Flow stays for the other repositories) | M9.1 |
| 2 | Merge strategy | **Squash** (see R-C3); changed by decisions 24 and 25 for the app repositories: the release PR `develop` → `main` is a merge commit and the squash subject is `PILOT-<n>: <card title>`, see [05-git-pr-review.md](05-git-pr-review.md) | M9.1, M9.4 |
| 3 | `/sdlc:<skill>` or `/sdlc-<skill>` | the docs write `/sdlc:<skill>` (plugin namespace); the `/sdlc-...` trigger phrases work too | M5.5 |
| 4 | Size of `CLAUDE.md` | at most 200 lines, ideally 100–150 | M4.4 |
| 5 | Language of instructions and docs | **changed**: in `1_mvp_sdlc`, `1_mvp_pilot_be` and `1_mvp_pilot_fe` (public after PUB) everything is English, including `docs/` and the feature artifacts; Ukrainian stays only in the private `1_mvp_infra/docs/uk`, `1_mvp_prompt`, Trello and Notion; the Ukrainian `00-operator.md` is a Notion mirror | M1.1, R-C14 |
| 6 | Technical details in acceptance criteria | per the 4.5.1 template: no HTTP codes, paths or SQL in criteria; technical detail goes to contracts and ADRs (`lint-prd.py` enforces it) | M6.3 |
| 7 | Double interview (`interview` and `write-prd`) | XS: no artifacts, criteria in GWT on the card; S: `interview` with easy depth → PRD; M+: the full cycle | M6.2, M6.3 |
| 8 | DoR written in legacy vocabulary | our own DoR and DoD ([03-dor-dod.md](03-dor-dod.md)) | M6.7 |
| 9 | How an artifact approval is recorded | `status: Approved` in the frontmatter + the merged PR of the artifact = the human gate; `sdlc-gate` checks both | M6.1 |
| 10 | `break-tasks` needs at least one Accepted ADR | for S do not run `break-tasks`: one task, `task-brief` takes the criteria from the PRD; for M+ as in the course | M6.7 |
| 11 | `generate-data-model` is SQL-first | `/mvp-sdlc:rails-data-model` (R-B1) | M6.5 |
| 12 | Where the quality gate lives | blocking CI + PreToolUse hooks of the plugin for secrets and `main`; no Stop-hook running tests (an anti-pattern) | M5.4 |
| 13 | `[[wikilinks]]` | plain markdown links | M6.7 |
| 14 | Story budget | criterion B: at most one day, at most 500 changed lines | M6.7 |
| 15 | Release pipeline A or B | **deterministic, B-like**: a person tags, CI creates a draft Release from the changelog section, no LLM in CI and no write to `main` (R-C9; planned, C4) | M9.7 |
| 16 | Changelog categories | six (Keep a Changelog) | M9.7 |
| 17 | "Undetermined" from the critic | an Open Question with an owner and a due date in PRD section 8, no automatic retry | M6.3 |
| 18 | When to open a draft PR | as the factory's deliver decides; by hand, after the first clean commit | M9.4 |

## The other agreed process decisions

Where each one is applied:

| Decision | Subject | Where |
|---|---|---|
| R-C1 | who merges; RULE-LOOP | [05-git-pr-review.md](05-git-pr-review.md#who-merges) |
| R-C2 | task format (`task.md` + `tasks.json`, criteria by ID, Parity ref, size limit) | [03-dor-dod.md](03-dor-dod.md), [02-artifacts.md](02-artifacts.md) |
| R-C3 | three commits per TDD cycle, squash with trailers, CI checks the order from the first PR | [04-tdd-execution.md](04-tdd-execution.md) |
| R-C4 | protection of `main` in layers; branch protection after PUB | [05-git-pr-review.md](05-git-pr-review.md#protection-of-main) |
| R-C5 | review cost: built-in factory review + `review-feature`; no CI auto-review unless triggered | [05-git-pr-review.md](05-git-pr-review.md#review), [09-metrics.md](09-metrics.md) |
| R-C6 | evals layers 0 and 1 | [04-tdd-execution.md](04-tdd-execution.md#evals-layers) |
| R-C7 | process metrics | [09-metrics.md](09-metrics.md) |
| R-C9 | versions, releases, hotfix | [06-releases-changelog-hotfix.md](06-releases-changelog-hotfix.md) |
| R-C10 | the pilot feature: **deferred**, chosen right before C7; blocks only C7–C9 | [00-operator.md](00-operator.md#not-decided-yet) |
| R-C11 | Trello flow: one board per project, six lists, labels, one card per feature | [00-model.md](00-model.md#phases-and-gates-for-the-pilot) |
| R-C12 | model tiers | [11-models.md](11-models.md) |
| R-C13 | publication: three repositories public after C9 (PUB), two private | [README.md](README.md#publication-and-language) |
| R-C14 | no internal IPs, hostnames or IDs committed, from the first commit | [README.md](README.md#publication-and-language) |
