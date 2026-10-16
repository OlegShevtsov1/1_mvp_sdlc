#!/usr/bin/env bash
set -euo pipefail
dir=docs/features/postslug/migrations
mkdir -p "${dir}"
printf 'class AddSlugToPosts < ActiveRecord::Migration[7.1]\nend\n' > "${dir}/01_add_slug_to_posts.rb"
printf 'class BackfillPostSlugs < ActiveRecord::Migration[7.1]\nend\n' > "${dir}/02_backfill_post_slugs.rb"
printf 'class RequirePostSlug < ActiveRecord::Migration[7.1]\nend\n' > "${dir}/03_require_post_slug.rb"
