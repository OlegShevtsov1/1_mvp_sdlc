#!/usr/bin/env bash
# block-destructive-git: no force push, hard reset, or deleting/moving published tags.
source "$(dirname "$0")/lib.sh"
h=block-destructive-git.sh

common_cases "${h}"
for cmd in 'git push --force' 'git push -f' 'git push --force-with-lease' 'git push -uf origin feat/x' \
  'git push origin +feat/x' 'git reset --hard' 'git reset --hard origin/main' 'git push --delete origin v0.1.0' \
  'git push origin --delete v0.1.0' 'git push origin :refs/tags/v0.1.0' 'git tag -d v0.1.0' 'git tag -f v0.1.0' \
  'true && git push --force' 'git status; git reset --hard' 'bash -c "git push --force"' 'env A=1 git push -f' \
  'A=1 git push -f' 'git -c core.x=1 -C . push --force' 'git push --delete' 'if true; then git push --force; fi' \
  'while true; do git reset --hard; done' 'if git tag -d v0.1.0; then echo ok; fi'; do
  run_hook "${h}" "$(bash_event "${cmd}" "${scratch}")" 2 "${cmd}"
done
for cmd in 'git push' 'git reset HEAD~1' 'git reset --soft HEAD~1' 'git push --delete origin feat/old' \
  'git tag v0.2.0' 'git push origin v0.2.0' 'git log --format=%H -f' 'echo git reset --hard'; do
  run_hook "${h}" "$(bash_event "${cmd}" "${scratch}")" 0 "${cmd}"
done
