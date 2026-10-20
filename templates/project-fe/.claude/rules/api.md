# API

- The contract of record is `docs/features/<slug>/contracts/openapi.yaml`, produced by the `sdlc` api-forge skill
  and owned by the backend repository. Change the contract first, then the code.
- The backend implements exactly the contract: paths, status codes, error bodies and field names. A difference
  between code and contract is a bug in the code or a missing contract change, never "good enough".
- The frontend calls only operations that exist in its synced copy of the contract; run `sync-spec <slug> --check`
  when a task touches API use.
- Breaking changes (removed fields, changed types, new required inputs) need a new ADR and a migration path for
  existing clients.
- Error responses never leak internals: no stack traces, SQL, file paths or hostnames.
