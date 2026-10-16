# Observability

What watches a project after a merge and after a release. Health checks and watchers are deterministic, never an AI,
and nothing rolls prod back by itself (course production observability, M11.3). Hosts, addresses and IDs are in
the private infrastructure docs ([12-infrastructure-references.md](12-infrastructure-references.md)); here only
patterns.

| Tool | Watches | Reports to |
|---|---|---|
| Factory health and monitor nodes | after each task merge: Dev Deploy of the merge commit, then the dev health URL from `.archon/factory-profile.yaml` | the factory report (`report.json`); the factory rolls dev back on a red health check |
| Gatus | health endpoints by pattern: `https://<zone>/health` for prod, the `dev.` and `app.` subdomains for dev and the frontend | Telegram |
| GlitchTip | application errors, one project per app and environment: `<name>-be-prod`, `<name>-be-dev`, `<name>-fe-prod`, `<name>-fe-dev` | the project's prod or dev Telegram topic |
| Beszel | host resources (CPU, memory, disk) of the project's hosts | Telegram |
| `release-watch` (planned, C4) | 10 minutes after a prod deploy: health and new GlitchTip issues of the prod project | the project's prod topic; no automatic rollback |
| Telegram | one bot per project (`@<name>_alerts_bot`) and two topics, `<name>_prod_alerts` and `<name>_dev_alerts`; the pilot keeps its existing bots | the operator |

Rules:

- A new GlitchTip issue in prod within the watch window means a hotfix decision by the operator
  ([06-releases-changelog-hotfix.md](06-releases-changelog-hotfix.md#hotfix)), and counts as an escaped defect if it
  appears within 7 days of a release ([09-metrics.md](09-metrics.md)).
- A Monitoring → PM feedback loop: a brief's success metric that does not come true becomes a new card.
