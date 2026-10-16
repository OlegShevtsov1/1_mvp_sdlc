# Upstream: course `sdlc` plugin

This directory is a vendored, byte-for-byte copy of the course SDLC plugin.

- Source: https://github.com/genkovich/agentic-engineering-course-public, path `modules/6-sdlc/sdlc/plugin/`,
  commit `9fb189ade982e90fe6413f3a968dea4ef2d7c968` (2026-09-23), git tree `379d30c1e1d2718cda4c978b81f8cd5b1b420798`.
- Version: `4.5.1`
- Vendored: 2026-10-14
- Tree sha256: `af39622b68b2b74a8dad6706f37244531e22901720aea1d1a7b5ee791ac0160f`

## Rule

**Never edit files under `plugins/sdlc/` except this `UPSTREAM.md`. Adaptations live in the `mvp-sdlc` plugin
(`plugins/mvp-sdlc/`, S3).** CI (`bash scripts/ci/check.sh plugins`) fails if the tree sha256 changes.

## Tree sha256

Run in this directory:

```sh
find . -type f ! -path ./UPSTREAM.md ! -path ./LICENSE ! -path './.claude-plugin/*' -print0 \
  | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum
```

It excludes the three files added here, so the same command run in the upstream `plugin/` directory gives the
same value.

## Files added beside upstream

- `LICENSE` — byte copy of `modules/6-sdlc/sdlc/LICENSE` (MIT, Copyright (c) 2026 Kyrylo Genkov).
- `.claude-plugin/plugin.json` — byte copy of `plugin.json`. Claude Code reads the plugin manifest only from
  `.claude-plugin/` (checked with `claude plugin validate`); the root `plugin.json` stays because it is part of the
  upstream tree. The linter requires the two to be identical.
- `UPSTREAM.md` — this file.

## Updating from upstream (separate PR)

1. Replace the tree with a new byte copy of upstream `plugin/` and re-add the three files above.
2. Record the new tree sha256, commit, version and date here.
3. Bump the `sdlc` version in `.claude-plugin/marketplace.json`.
4. Update `plugins/contracts.yaml` if agents or their tools changed.
5. Run `bash scripts/ci/check.sh` (layer-0 lint, hygiene — check that the `generate-data-model/SKILL.md`
   exception still points at the right file — and gitleaks).
6. Run the evals (C6), then merge.
