# SDLC process for the MVP projects

How a feature of an MVP project (today: the pilot, repositories `1_mvp_pilot_be` and `1_mvp_pilot_fe`) goes from a
Trello card to production, following the course "Agentic Engineering with Claude" and the decisions the operator
agreed for the pilot (decision IDs `R-A*`, `R-B*`, `R-C*`). The tooling lives in this repository: the vendored course
plugin `sdlc` and our adaptations in `mvp-sdlc` ([plugins/mvp-sdlc/README.md](../../plugins/mvp-sdlc/README.md)).

These documents describe what exists today. Anything a later run delivers is marked **planned** together with the
run that delivers it (for example "`release-watch` (planned, C4)"); `scripts/check_docs.py` enforces that in CI.

## Reading order

Start with the operator page; the numbered sections are the reference behind it.

- [00-operator.md](00-operator.md) — the operator's steps at every stage, in plain words: commands, confirm words,
  manual steps, what to read at each gate, how long it takes.
- [00-model.md](00-model.md) — the course model, the phase and gate table for the pilot, the Trello card → code
  chain and `state.json`.
- [01-phases-gates.md](01-phases-gates.md) — feature sizes, which phases run, the human gate and the deterministic
  `sdlc-gate`, what every course skill is used for.
- [02-artifacts.md](02-artifacts.md) — which artifacts each size produces, where they live, who owns them.
- [03-dor-dod.md](03-dor-dod.md) — Definition of Ready and Definition of Done.
- [04-tdd-execution.md](04-tdd-execution.md) — task texts, the three TDD commits, escalation, defects become evals.
- [05-git-pr-review.md](05-git-pr-review.md) — branches, commits, pull requests, who merges, review, `main`
  protection.
- [06-releases-changelog-hotfix.md](06-releases-changelog-hotfix.md) — prod deploys and rollback today, the agreed
  release model, hotfixes.
- [07-agent-security.md](07-agent-security.md) — untrusted inputs, secrets, deny rules and hooks.
- [08-observability.md](08-observability.md) — what watches dev and prod after a merge or a release.
- [09-metrics.md](09-metrics.md) — the process metrics and their sources.
- [10-course-contradictions.md](10-course-contradictions.md) — where the course contradicts itself and what we
  chose.
- [11-models.md](11-models.md) — which model tier does which work.
- [12-infrastructure-references.md](12-infrastructure-references.md) — internal-only links to the infrastructure
  docs.

## Publication and language

- This repository is private until the portfolio publication run (PUB) and then becomes public; `1_mvp_infra` and
  `1_mvp_prompt` stay private (R-C13).
- Everything here is English, and from the first commit nothing here names an internal host, IP address, account,
  zone, Trello, Notion or Telegram ID, or a local home path (R-C14). `scripts/ci/hygiene-check.sh` and
  `scripts/check_docs.py` enforce it.
- The Ukrainian translation of [00-operator.md](00-operator.md) is a mirror page in Notion, never the source: the
  English text here is the source of truth and is not edited for the sake of the translation.

## Checks

```sh
bash scripts/ci/check.sh docs   # link check, references that exist, planned items marked, English only
```
