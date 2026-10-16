# Process metrics

A minimal set from existing sources, no new services, no OpenTelemetry and no dashboards (R-C7). The baseline is the
pilot feature (C7–C9). Course basis: what to measure when adopting AI in a team (M11.6).

| Metric | Definition | Source |
|---|---|---|
| Lead time | from the first artifact PR of the feature to the merge of its last task | GitHub PR dates |
| Task cycle time | from the factory run start to its merge | the factory's `report.json` |
| Failed deliveries | share of runs with `delivered: false`, and of dev rollbacks | `report.json` |
| Review findings | count of P0, P1, P2 per feature, from the factory review and `review-feature` | PRs, `_review/` |
| Escaped defects | new GlitchTip issues in prod within 7 days after a release | GlitchTip |
| Prod rollbacks | how often prod was rolled back | `kamal-manage.yml` runs |
| Stale artifacts | artifacts with `status: Draft` for more than 30 days | `docs/features/` |

- `bin/sdlc-metrics` (planned, C4) appends one line per release to the release's execution log; escaped defects are
  added 7 days later. It is also the writer of the `measured` stage in `state.json` and flags a Trello card that
  disagrees with `state.json`. Until it lands, the operator writes the same numbers by hand after each release.
- The metrics are for the **team, never per person**. Look at the trend, not at one number.
- **Monthly review** (from the C9 retrospective on): the metrics, the factory run counts and durations per task, the
  RULE-LOOP events (R-C1, R-C12: review missed P0/P1 twice in a row → manual merge and the large model for
  `migration`/`auth`/`security` tasks), and the auto-review trigger (R-C5: add a non-blocking review comment layer
  in CI only on evidence that the built-in review misses P0/P1, or on a new operator decision after PUB).
