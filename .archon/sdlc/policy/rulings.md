# Rulings

This repository's maintainers' answers to questions plan and review would otherwise stop on. It replaces the SDLC
pack's default rulings document whole. One entry per ruling: the question it settles, the answer, and the project
document it rests on when there is one.

- **Q: May a 1_mvp_sdlc run change the `mvp-ops` pack (for example its `post-merge` workflow)?**
  A: No. Changes to the `mvp-ops` pack go in `1_mvp_prompt` as their own run; a 1_mvp_sdlc run only ships the
  helpers that pack calls (such as `bin/rag`). Rests on `orchestration/docs/archon-factory.md` §11; operator answer
  on PILOT-196, 2026-10-22.
- **Q: How are references to `project-add` documented before S5 builds it?**
  A: K1-era references to `project-add` are documented as "set by `project-add` (S5)"; the `--dry-run` proof
  belongs to S5. Operator answer on PILOT-196, 2026-10-22.
- **Q: May the factory fork or shadow Archon's bundled blocks to change their internals?**
  A: No. The factory composes Archon's bundled blocks with `include:` and never forks or shadows them; a fix that
  needs a bundled block's internals goes upstream to Archon. Rests on `orchestration/docs/archon-factory.md` §9;
  operator decision on PILOT-219, 2026-10-23 (option C).
