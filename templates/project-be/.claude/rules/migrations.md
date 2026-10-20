---
paths:
  - "db/**"
  - "docs/features/*/migrations/**"
---

# Migrations (ActiveRecord)

- Design first: `/mvp-sdlc:rails-data-model <slug>` writes `docs/features/<slug>/data-model.md` and staged
  migrations `docs/features/<slug>/migrations/<NN>_<name>.rb`. The implementing task promotes a staged migration to
  `db/migrate/` with a fresh timestamp.
- Never edit `db/schema.rb` or `db/structure.sql` by hand, and never change a migration that is already merged.
- Use the migration version of the schema (`ActiveRecord::Migration[x.y]` matching `db/schema.rb`). No raw `.sql`
  files.
- Existing tables change only by expand → backfill → contract, one migration per step, each safe while the old code
  still runs: add the nullable column or new table, backfill in batches, then add constraints and drop old columns in
  a later release.
- Indexes on existing tables use `algorithm: :concurrently` together with `disable_ddl_transaction!`.
- Follow the conventions already in the schema: `t.timestamps` with `null: false`, the soft-delete column the
  other tables use, foreign keys with `add_foreign_key` or `t.references ... foreign_key: true`, and the existing
  index naming.
- Every migration is reversible (`change` with reversible operations, or `up` and `down`).
- Run `ruby -c` on a staged migration before committing it.
