---
name: rails-data-model
description: >-
  Use when a feature of a Rails/ActiveRecord application needs a data model and migrations: designs the model from
  the repository's own conventions (db/schema.rb, db/migrate/, app/models/) and writes
  docs/features/<slug>/data-model.md plus staged ActiveRecord migrations under docs/features/<slug>/migrations/.
  Replaces the course generate-data-model skill (SQL-first) for Rails projects. Triggers: "/mvp-sdlc:rails-data-model
  <slug> <what the feature stores>", "rails data model for <slug>", "ActiveRecord migrations for <slug>".
  Never touches db/schema.rb, db/structure.sql or db/migrate/, never writes SQL files, and asks instead of guessing
  when the conventions or the request are ambiguous.
---

# rails-data-model

Design the data model of one feature for a Rails/ActiveRecord application and stage its migrations. The output is
a design plus migration files that an implementing task later promotes into `db/migrate/`; this skill never changes
the live schema.

## Inputs

- Arguments: `<slug>` first (it must match `[a-z0-9]{2,16}`), then optional free text describing what the feature
  stores.
- `docs/features/<slug>/PRD.md` and `docs/features/<slug>/sad.md` when they exist. Neither is required: without
  them, the arguments are the only description of the feature.
- The repository's conventions, read in this order:
  1. `db/schema.rb`, or `db/structure.sql` when there is no `schema.rb` — tables, column types, null constraints,
     indexes and their names, foreign keys, and the schema version in `ActiveRecord::Schema[x.y]`.
  2. `db/migrate/*.rb` — the migration class version (`ActiveRecord::Migration[x.y]`), `t.references` versus
     explicit `bigint` + `add_foreign_key`, `change` versus `up`/`down`.
  3. `app/models/*.rb` — soft delete (`include Discard::Model` means `discarded_at`, `acts_as_paranoid` means
     `deleted_at`), associations and `dependent:` options.

## Hard rules

- Never create, edit or delete `db/schema.rb`, `db/structure.sql` or anything under `db/migrate/`.
- Never write `.sql` files. Migrations are Ruby ActiveRecord migrations only.
- Write only under `docs/features/<slug>/` and, once, `.claude/rules/migrations.md` (step 6).
- **Ambiguity means a question, never a guess.** If the conventions conflict (for example two tables use different
  soft-delete columns and the new table relates to both), or the request leaves a decision open that changes the
  schema (which tables a record belongs to, whether it is soft-deleted, a uniqueness rule), ask with
  `AskUserQuestion` before writing anything. Offer the concrete options found in the repository, each with the
  file and line that shows it. Write no file until every question is answered. If `AskUserQuestion` is not
  available (for example in a headless run), end your turn with the question and its options as your final answer
  and write nothing.
- Existing tables change only by expand → backfill → contract, one migration per step: first add nullable columns
  or new tables, then backfill in batches in a separate migration, and only then add `null: false`, constraints or
  drop old columns in a third migration.
- Indexes added to an existing table use `algorithm: :concurrently`, and that migration declares
  `disable_ddl_transaction!`. Indexes created inside `create_table` for a new table need neither.

## Steps

1. **Parse the arguments.** Take the slug and the feature text. A missing or invalid slug: stop and ask for it.
2. **Read the conventions** (Inputs above) and write down, with file:line evidence, the migration version, primary
   key type, timestamp style (`t.timestamps` and whether `created_at`/`updated_at` are `null: false`), the
   soft-delete column and whether it is indexed, foreign key style, and index naming.
3. **Check for ambiguity** (Hard rules). Ask now if anything is open; stop until answered.
4. **Design the model.** New tables, columns with types and null constraints, associations, indexes, foreign keys
   and, for every change to an existing table, its expand/backfill/contract steps. Follow the existing conventions
   exactly: same timestamps, same soft-delete column with the same index, same foreign key style.
5. **Write the files.**
   - `docs/features/<slug>/data-model.md` from this skill's `templates/data-model.md` (in the skill's base
     directory), every section filled.
   - One staged migration per step: `docs/features/<slug>/migrations/<NN>_<name>.rb`, `NN` = `01`, `02`, ... in
     the order they must run, `<name>` in snake_case. Each file holds one migration class named after `<name>` in
     CamelCase, inheriting from `ActiveRecord::Migration[x.y]` with the version found in step 2.
6. **Install the migrations rule once.** If `.claude/rules/migrations.md` does not exist, copy the plugin's
   `templates/claude/rules/migrations.md` (two directories above this skill's base directory) to it unchanged.
   Never overwrite an existing one.
7. **Verify.** When Ruby is available, run `ruby -c` on every staged migration and fix any syntax error. List
   the files you wrote, the result of each `ruby -c`, and the next step: the implementing task in `break-tasks`
   promotes the staged migrations into `db/migrate/` with fresh timestamps.
