#!/usr/bin/env bash
# block-main-push: no push may update main/master, by refspec, by --all, or implicitly from the current branch.
source "$(dirname "$0")/lib.sh"
h=block-main-push.sh

git init -q --bare "${scratch}/origin.git"
git init -q -b main "${scratch}/app"
git -C "${scratch}/app" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
git -C "${scratch}/app" remote add origin "${scratch}/origin.git"
git -C "${scratch}/app" push -q -u origin main
git clone -q "${scratch}/origin.git" "${scratch}/feature" 2>/dev/null
git -C "${scratch}/feature" checkout -q -b feat/x --track origin/main
git clone -q "${scratch}/origin.git" "${scratch}/topic" 2>/dev/null
git -C "${scratch}/topic" checkout -q -b feat/y
on_main="${scratch}/app"
git init -q -b master "${scratch}/legacy"
git -C "${scratch}/legacy" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init

common_cases "${h}"
run_hook "${h}" "$(bash_event 'git push origin main' "${scratch}/topic")" 2 "explicit main"
run_hook "${h}" "$(bash_event 'git push origin HEAD:main' "${scratch}/topic")" 2 "HEAD:main"
run_hook "${h}" "$(bash_event 'git push origin HEAD:refs/heads/master' "${scratch}/topic")" 2 "HEAD:refs/heads/master"
run_hook "${h}" "$(bash_event 'git push origin :main' "${scratch}/topic")" 2 "delete main"
run_hook "${h}" "$(bash_event 'git push --all' "${scratch}/topic")" 2 "--all"
run_hook "${h}" "$(bash_event 'git push' "${on_main}")" 2 "plain push on main"
run_hook "${h}" "$(bash_event 'git push origin HEAD' "${on_main}")" 2 "push HEAD on main"
run_hook "${h}" "$(bash_event 'git push' "${scratch}/legacy")" 2 "plain push on master without upstream"
run_hook "${h}" "$(bash_event 'git push' "${scratch}/feature")" 2 "plain push with upstream origin/main"
run_hook "${h}" "$(bash_event 'git -C app push origin main' "${scratch}")" 2 "git -C"
run_hook "${h}" "$(bash_event 'true && git push origin main' "${scratch}/topic")" 2 "compound &&"
run_hook "${h}" "$(bash_event 'bash -c "git push origin main"' "${scratch}/topic")" 2 "bash -c"
run_hook "${h}" "$(bash_event 'git push origin fix/main-menu' "${on_main}")" 0 "fix/main-menu"
run_hook "${h}" "$(bash_event 'git push -u origin feat/x' "${on_main}")" 0 "push -u feature branch"
run_hook "${h}" "$(bash_event 'git push' "${scratch}/topic")" 0 "plain push on a feature branch"
run_hook "${h}" "$(bash_event 'git status' "${on_main}")" 0 "not a push"
run_hook "${h}" "$(bash_event 'echo git push origin main' "${on_main}")" 0 "push as text"
