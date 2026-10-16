# Follow-ups after the 2026-09-20 implementation

Deferred and parked review findings, copied from the SDD ledger. None blocks the live run (Task 10). Line numbers refer to the ledger, not to files.

```
2:Task 1: minor (deferred): gate.ts stop_reason has a trailing colon when the gate text is empty (plan-mandated string); consider joining parts with filter(Boolean)
3:Task 1: minor (deferred): gate.ts coerces non-string decision via String(); a typeof check would be safer
4:Task 1: minor (deferred): gate.ts does not unwrap a JSON-encoded string output ("\"approved\""); confirm the simulator emits a bare string in Task 6
5:Task 1: minor (deferred): io.ts emit/fail have no direct tests yet (interfaces for later tasks)
6:Task 1: minor (deferred): no tsconfig.json / type-check script; only bun test exercises the code
8:Task 2: minor (deferred): profile.ts emits secret names unquoted; TRUE/FALSE/NULL would not round-trip — fix is `  - ${q(s)}` (deviates from plan's verbatim block by one token)
9:Task 2: minor (deferred): validateProfile reports paired "required" + "must be one of" errors for an absent enum field
10:Task 2: minor (deferred): monitoring.mcp_config accepted at any value though the workflow uses the fixed path; consuming task should warn
11:Task 2: minor (deferred): validator branches (multi-line, scheme check, non-array secrets, version) have no tests; example profile has no test asserting it validates
14:Task 3: minor (deferred): exec.test.ts sets process.env.FACTORY_TEST_SECRET without cleanup
15:Task 3: minor (deferred): redact default-env path has no direct test
16:Task 3: minor (deferred): secrets shorter than 4 chars are silently not redacted; consider a stderr note
17:Task 3: minor (deferred): deploy.ts interpolates remote/merge_sha into bash -c without validating their shape
18:Task 3: minor (deferred): deploy.ts leaves detached HEAD; document the invariant when factory.yaml lands
20:Task 3: minor (deferred): exec.ts sends the grace SIGKILL even when the child already exited (theoretical pid reuse); Bun.sleep timers not cancelled; log lines may land after [exit 124]; outer wrapper stderr ignored; no automated test for streaming-as-it-arrives
21:Task 3: minor (deferred): plan doc still embeds the superseded exec.ts body ([stderr] section); exec.ts treats timeoutMs: 0 as no timeout
24:Task 4: minor (deferred): report.ts variable `rolledBack` means "rollback decided", not "rollback happened" — rename to rollbackDecided
25:Task 4: minor (deferred): report.ts summary says "See deploy.log." for a skipped deploy that produced no log
26:Task 4: minor (deferred): scripts/report.ts writes report.json before emit(); a write failure would lose the node's stdout — emit first or try/catch
27:Task 4: minor (deferred): no tests for rollback FAILED branch, merged:false, monitor errors → delivered false; entry scripts untested
29:Task 4: minor (deferred): buildReport does not validate cross-field consistency (healthy skipped + monitor errors + no rollback would show the "did not run" summary); not producible by decide-rollback
32:Task 5: minor (deferred): write-profile test's secret-leak assertion is tautological (no value present to leak)
33:Task 5: minor (deferred): write-profile.ts unset ARTIFACTS_DIR resolves to "/factory-profile.json"; add an explicit guard
34:Task 5: minor (deferred): write-profile.ts mkdirSync/writeFileSync unguarded (stack trace instead of fail message on permission error)
37:Task 5: minor (deferred): write-profile.ts commit step is repo-wide (unrelated staged changes would ride along); scope diff --cached and commit to the profile path
38:Task 5: minor (deferred): write-profile.ts "profile committed but HEAD could not be read" message inaccurate on the skip path; PROFILE_PATH interpolated unquoted into bash -c; tests never clean up temp dirs; happy-path test duplicates helper setup
43:Task 6: parked — reviewer minor "quote the reference in until_bash" — ruling: the code stands; Archon substitutes `$node.output.field` already shell-quoted, and archon-deliver.yaml documents that adding quotes around the substitution corrupted the comparison (write the reference bare)
44:Task 6: minor (deferred): intake.md does not spell out the required `report` pointer fields (type/run_id/path); relies on output_format
45:Task 6: minor (deferred): fixtures cannot distinguish "loop exited on approve" from "max_iterations exhausted" (both complete); red gate branches covered only by gate.ts unit tests
46:Task 6: minor (deferred): no explicit timeout on the intake AI node; `&profile` anchor in fresh-profile fixture unused until later tasks
51:Task 7: minor (deferred): merge node assigns ORIGIN_REPO but never uses it (kept as a fail-fast read); re-reads headRefName via gh although $deliver.output.head exists
53:Task 7: minor (deferred): merge node — mergeCommit may read back null right after merge (schema then fails a merged PR); consider `// ""` + retry
54:Task 7: minor (deferred): 24 deliver stubs duplicated verbatim across both fixtures; negative branches (abort-plan, needs-revision second round, $LOOP_PREV substitution, merge body) not exercised by any fixture
55:Task 7: minor (deferred): plan-round.output.decision declared but unread
58:Task 8: ruling — reviewer Important "unquoted URL=$load-profile.output.health_url" REJECTED: Archon shell-quotes substituted $node.output values in bash bodies (variables reference; deliver pack uses PR_NUMBER=$pr.output.number bare); parked
59:Task 8: ruling — reviewer Important "allowed_tools: [] disables MCP tools" REJECTED: Archon MCP guide documents mcp: + allowed_tools: [] as the MCP-only node pattern; parked pending live confirmation in Task 10
63:Task 8: minor (deferred): monitor-check failure is invisible (fail-open: monitor skipped → "monitoring skipped" → delivered true); add monitor-check to report's depends_on
64:Task 8: minor (deferred): dead &profile anchor in four fixtures; 41-line deliver stub block duplicated in five fixtures
65:Task 8: minor (deferred): health loop `-ge` not guarded against a non-integer wait_seconds; report binds $deliver.output.url / $merge.output.merged without if_skipped (safe today, asymmetric)
68:Task 8: complete (commits b714098..cc841c2, review clean after 1 fix round, 2 parked)
71:Task 9: minor (deferred): install.sh validates the source repo's package, not the freshly installed global copy (brief's Step 2 covers the global copy manually)
FINAL: parked — install.sh:13 "(version unreadable)" path unreachable under set -e when bun is present but broken — ruling: real but cosmetic; command -v bun already guards presence
FINAL: parked — deploy.ts REMOTE regex rejects URL-style remotes that validateProfile accepts — ruling: real, narrow (profile says remote is a name like origin); fix later by validating repo.remote as a name in profile.ts
FINAL: observation — merge hard-codes `origin` while deploy uses repo.remote (pre-existing); follow-up
```

## After the live run (2026-09-23)

- Smoke repo `deploy/rollback.sh` prints `rolled back to ` with an empty sha (quoting inside the ssh string); cosmetic, smoke repo only.
- The health check reaches the lab VM only through a manual ssh tunnel (`ssh -f -N -L 8090:localhost:8090 -p 52393 dev@lab-host`); it dies on reboot. A systemd user unit or a host-level VirtualBox port forward would make it durable.
- `merge` hard-codes `origin` while `deploy` uses `repo.remote` (pre-existing observation).
- `intake.md` should state explicitly that `wait_seconds`/`window_minutes` are JSON numbers, not strings (validator would reject strings after gate approval).
- Consider `provider: claude` on every AI node that relies on `allowed_tools` restrictions (monitor already has it).
