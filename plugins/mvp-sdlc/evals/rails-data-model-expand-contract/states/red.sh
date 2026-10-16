#!/usr/bin/env bash
# One migration adds the required column at once.
set -euo pipefail
dir=docs/features/postslug/migrations
mkdir -p "${dir}"
printf 'class AddSlugToPosts < ActiveRecord::Migration[7.1]\nend\n' > "${dir}/01_add_slug_to_posts.rb"
