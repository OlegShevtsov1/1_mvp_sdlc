# Model policy

Which model tier does which work (R-C12). Course basis: choose the model by role; raise the agent a class where it is
really needed instead of compensating a weak model with longer runs (M10.2).

| Work | Tier | Where it is set |
|---|---|---|
| Code (implement, fix) and the task plan in the factory | large (Opus) | the Archon defaults of the implement workflow |
| Review lenses, intake, monitor in the factory | medium (Sonnet) | the Archon defaults of the review workflow |
| Course skills `/sdlc:*` and our `/mvp-sdlc:*` skills | the model of the operator's interactive session | the operator's Claude Code session |

These are Archon's standard settings, recorded here explicitly; the tier mapping in the Archon configuration is not
overridden. A change of tier goes only through a pull request to the factory source (in this repository,
`orchestration/factory`).

**Switch rule** (the same event as RULE-LOOP in R-C1): if review misses a P0/P1 finding twice in a row, the review of
tasks labelled `migration`, `auth` or `security` moves to the large tier. The change is recorded in the C9
retrospective and checked in the monthly review ([09-metrics.md](09-metrics.md)).
