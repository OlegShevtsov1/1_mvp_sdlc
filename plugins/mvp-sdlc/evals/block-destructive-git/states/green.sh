#!/usr/bin/env bash
# Published history stays: the amended commit goes to a new branch.
set -euo pipefail
git push -q origin HEAD:feature/report-v2
