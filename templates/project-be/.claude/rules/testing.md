# Testing

- Tests first: write the failing test, run it and see it fail for the expected reason, then write the code.
- After the RED commit, the tests of that task are frozen: do not weaken, skip or delete them to get to GREEN.
  If a test is wrong, stop and say so.
- Each acceptance criterion has at least one test at the level named in `docs/features/<slug>/test-plan.md`
  (or the PRD's test plan for small features). Name tests after the behaviour, not the method.
- Error and authorization criteria get their own tests; never fold them into a happy-path test.
- Tests do not call real external services; use the stubs and fixtures the repository already has.
- Run the commands from `.claude/sdlc.local.md` before every commit; a red suite is never committed as GREEN.
