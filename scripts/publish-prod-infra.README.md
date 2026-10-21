# publish-prod-infra.sh

Proposes the pilot prod Terraform root from the primary infra repo (the primary account's `1_mvp_infra`, branch
`env/dev`) to `OlegShevtsov1/1_mvp_infra` branch `env/prod`, as one commit on a sync branch and a PR into `env/prod`.
This is M5 Крок 3 (decision 46): prod is applied from `env/prod` of the OlegShevtsov1 copy, and changes reach it only
through PRs the operator merges after reviewing a plan. It is run by hand from the operator host, and only after
M5 Кроки 1–2 have added `infra/projects/pilot-prod/` and the prod workflows to the primary `env/dev`.

## Usage

```bash
export GH_TOKEN="$(gh auth token --user OlegShevtsov1)"
scripts/publish-prod-infra.sh [<ref>] [--dry-run]
```

`<ref>` is anything `git rev-parse` resolves in a fresh clone of the primary (default `origin/env/dev`). `--dry-run`
builds the commit but pushes nothing and makes no API call (no `GH_TOKEN` needed); the temporary clone is kept and
its path is printed on stderr.

Every GitHub API call goes through `gh` with the caller's `GH_TOKEN`, which must belong to `OlegShevtsov1`. The script
never runs `gh auth` and never switches the active gh account; do not run `gh auth switch` for it either.

| Mode | stdout |
| --- | --- |
| synced | the PR URL |
| nothing to sync | `nothing to sync (env/prod <short sha>)` |
| already proposed | `already proposed: <PR URL>` |
| dry run | the sorted list of files the commit contains, one per line |

Progress and refusals always go to stderr.

| Exit | Meaning |
| --- | --- |
| 0 | PR opened, nothing to sync, already proposed, or dry run built |
| 1 | cloning, resolving the ref, pushing or a `gh` call failed (PR creation: the branch is pushed, rerun to retry) |
| 2 | refused: `pilot-prod root not found`, required paths missing, module source unresolvable or outside the repo, unexported workflow reference, `GH_TOKEN` of another account |
| 64 | usage, including a missing `GH_TOKEN` on a real run |

## What it does

1. Unless `--dry-run`: checks that `GH_TOKEN` is set and belongs to `OlegShevtsov1`.
2. Clones the primary into a temporary directory and resolves `<ref>`.
3. Refuses with `pilot-prod root not found: infra/projects/pilot-prod does not exist at <ref> (<short sha>)` when the
   prod root is not there.
4. Exports the tree at that commit with `git archive`.
5. Computes the exported set (below); refuses, listing every problem, when a required path is missing or a module
   source cannot be resolved.
6. Refuses when a prod workflow or composite action references a `bin/`, `scripts/` or `host/` file that is not
   exported.
7. Clones `env/prod` of the target (its `env/dev` when `env/prod` does not exist yet), deletes everything except
   `.git` and copies the exported set in.
8. Exits 0 with `nothing to sync` when `env/prod` already has `INFRA_PROD_SOURCE.json` and the tree is unchanged.
9. Unless `--dry-run`: when the sync branch for this primary commit already exists, prints the open PR from it, or
   opens that PR, and exits 0.
10. Writes `INFRA_PROD_SOURCE.json` and commits as the author below.
11. With `--dry-run`, prints the file list and stops. Otherwise creates `env/prod` at the target `env/dev` commit
    when it does not exist, pushes the sync branch and opens the PR into `env/prod`.

Every refusal happens before the first remote write. Nothing is ever force-pushed, `env/prod` is never pushed to
after its creation, and the target `env/dev` (used by the public pilot mirrors for the composite actions) is never
written.

## The exported set

- `infra/projects/pilot-prod/**` — the prod root, including its generated `project.auto.tfvars.json`.
- The modules the root uses: every local `source = "./…"` or `"../…"` in the root's `.tf` files, resolved relative to
  the file, with all files under that directory, followed transitively through the included modules' `.tf` files.
  Registry, git and http sources are not exported. A source that does not exist at the ref, is the repository root
  or leaves it is refused.
- `.github/workflows/project-terraform-prod.yml` and `.github/workflows/project-terraform-prod-deploy.yml`.
- `projects/pilot.yaml` — the registry subset the prod root needs.
- `docs/uk/25-prod-infra-split.md`.
- `.github/actions/**` and their scripts (`scripts/ci-vpn.sh`, `scripts/ci_vpn_lock.py`, `scripts/notify-telegram.sh`,
  `host/vpn-client-dns.sh`) — the same files `publish-ci-helpers.sh` copies to the target `env/dev`, taken from the
  primary at `<ref>`.
- The files the prod workflows run: `scripts/projects.py`, `scripts/project_plan_guard.py`, `scripts/vpn_dns.py`,
  `scripts/ship-vpn-client.sh`, `host/project-vpn-client.sh`, `bin/vpnctl`, `dnsmasq.conf`,
  `infra/backend.generated.hcl`.

Every path in the last five items is required. The reference guard catches a prod workflow or action that starts
running another `bin/`, `scripts/` or `host/` file; it does not trace files those scripts call. To export one more
file, add it to the `manifest` array in `scripts/publish-prod-infra.sh`.

The target tree is replaced, not overlaid: files deleted upstream disappear from `env/prod`. The first sync PR
therefore also deletes the `README.md` that `env/prod` inherits from the target `env/dev` (it describes the CI helper
copy, not prod).

Nothing is sanitized or rewritten: both infra repos are private (decision 46).

## Branches and the PR

- Sync branch: `sync/prod-infra-<7-char primary sha>`, pushed as a new branch.
- Commit message: `Sync prod infra from <branch> (<short sha>)`, `<branch>` being `<ref>` without `origin/`.
- PR into `env/prod`, title `PILOT-0: Sync prod infra from <branch> (<short sha>)`, body with the source ref and
  sha, the exported file count and the line `Type: chore`.
- No auto-merge, ever: the operator merges after reviewing a terraform plan of `infra/projects/pilot-prod`
  (decision 46). The script never calls a merge or review API.

Reruns are safe. A rerun after the operator merged prints `nothing to sync`; a rerun while the PR is open prints
`already proposed`; a rerun after a failed PR creation opens the PR for the branch already pushed. A new primary
commit gets a new sync branch built on the current `env/prod`.

## The author rule

Author **and** committer are `Oleg Shevtsov <olegshevtsov1@gmail.com>`; override only through
`INFRA_PROD_AUTHOR_NAME` and `INFRA_PROD_AUTHOR_EMAIL`. The commit is never signed, because a host signing key would
carry the primary identity.

## INFRA_PROD_SOURCE.json

Written at the target root by every sync. After the operator merges, the file on `env/prod` records what prod was
last applied from.

| Field | Value |
| --- | --- |
| `primary_sha` | full primary commit the tree was exported from |
| `mirror_sha` | the `env/prod` commit the sync was built on (the target `env/dev` commit on the first sync; a commit cannot contain its own sha) |
| `synced_at` | UTC time, `YYYY-MM-DDTHH:MM:SSZ` |

## Prerequisites

- SSH aliases in `~/.ssh/config`, as for [publish-mirror.sh](publish-mirror.README.md): `github.OlegShevtsov1` (the
  target URL is `git@github.OlegShevtsov1:OlegShevtsov1/1_mvp_infra.git`) and the primary account's alias, the same
  one the primary checkouts use as `origin`.
- `git`, `python3`, `gh`.

`INFRA_PROD_PRIMARY_URL` and `INFRA_PROD_TARGET_URL` replace the two URLs (a URL or a local path); the tests use them
with a fake `gh` to run without network.
