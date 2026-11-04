---
category: Fixed
---

- `scripts/release.sh` reads each `git show` blob whole before `grep -q` or awk look at it, so a reader that
  stops early no longer kills `git show` with SIGPIPE: `merge-release-pr` no longer exits 141 with no message,
  and its and `tag`'s version checks no longer fail falsely on a large file (PILOT-619).
