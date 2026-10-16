#!/usr/bin/env bash
set -euo pipefail
mkdir -p docs/features/comments
printf '# Data model - comments\n' > docs/features/comments/data-model.md
printf 'CREATE TABLE comments (id bigserial PRIMARY KEY);\n' > docs/features/comments/schema.sql
