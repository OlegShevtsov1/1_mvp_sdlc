---
status: Draft
feature: "<slug>"
schema_source: "db/schema.rb"
migration_version: "<x.y>"
---

# Data model — <slug>

## Conventions found

<!-- One row per convention, each with the file:line it was read from. -->

| Convention | Value | Evidence |
|---|---|---|
| Migration version | `ActiveRecord::Migration[<x.y>]` | `db/migrate/<file>:<line>` |
| Primary keys | `bigint` id | `db/schema.rb:<line>` |
| Timestamps | `t.timestamps`, `null: false` | `db/schema.rb:<line>` |
| Soft delete | `<column>` with an index | `app/models/<file>:<line>`, `db/schema.rb:<line>` |
| Foreign keys | `t.references ... foreign_key: true` / `add_foreign_key` | `db/schema.rb:<line>` |
| Index naming | `index_<table>_on_<columns>` | `db/schema.rb:<line>` |

## Entities

<!-- One subsection per new or changed table. -->

### <table>

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|

- Associations: <belongs_to / has_many with dependent: option>
- Indexes: <columns, unique?, name>
- Foreign keys: <column → table>

## Changes to existing tables

<!-- Expand → backfill → contract, one migration per step. Write "None" when the feature only adds tables. -->

| Step | Migration | What it does | Safe while old code runs because |
|---|---|---|---|

## Staged migrations

| File | Purpose |
|---|---|
| `migrations/01_<name>.rb` | <purpose> |

## Decisions and answers

<!-- Every question asked through AskUserQuestion and its answer; "None" when nothing was ambiguous. -->
