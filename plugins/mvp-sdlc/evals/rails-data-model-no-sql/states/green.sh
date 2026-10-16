#!/usr/bin/env bash
set -euo pipefail
mkdir -p docs/features/comments/migrations
printf '# Data model - comments\n' > docs/features/comments/data-model.md
printf 'class CreateComments < ActiveRecord::Migration[7.1]\nend\n' > docs/features/comments/migrations/01_create_comments.rb
