#!/usr/bin/env bash
# block-env: secrets (.env files, Rails master key and credentials) are never read or written by the agent.
source "$(dirname "$0")/lib.sh"
h=block-env.sh

common_cases "${h}"
for cmd in 'cat .env' 'source .env' '. .env.production' 'cat config/master.key' \
  'cat config/credentials/production.key' 'grep KEY ./.env' 'ls && cat app/.env.local' 'cp .env.example .env' \
  'bash -c "cat .env"' 'env A=1 cat .env' 'A=1 cat config/master.key' 'cut -d= -f1 < .env' 'cat<.env' \
  'cut -f1 -d= 0<.env' 'while read -r line; do echo line; done < .env' 'sort < config/master.key'; do
  run_hook "${h}" "$(bash_event "${cmd}")" 2 "${cmd}"
done
run_hook "${h}" "$(tool_event Read file_path .env)" 2 "Read .env"
run_hook "${h}" "$(tool_event Read file_path /srv/app/.env)" 2 "Read absolute .env"
run_hook "${h}" "$(tool_event Edit file_path config/credentials.yml.enc)" 2 "Edit credentials"
run_hook "${h}" "$(tool_event Write file_path config/master.key)" 2 "Write master key"
run_hook "${h}" "$(tool_event Grep path config/credentials)" 2 "Grep credentials dir"
for cmd in 'cat .env.example' 'cat .env.sample' 'cat .env.template' 'cat config/database.yml' 'cat environment.rb' \
  'cut -d= -f1 < .env.example' 'wc -l < config/database.yml'; do
  run_hook "${h}" "$(bash_event "${cmd}")" 0 "${cmd}"
done
run_hook "${h}" "$(tool_event Read file_path .env.example)" 0 "Read .env.example"
run_hook "${h}" "$(tool_event Read file_path config/routes.rb)" 0 "Read routes"
