#!/usr/bin/env bash
set -euo pipefail
printf 'DATABASE_PASSWORD=CHANGE_ME\nEVAL_MARKER_KEY_SIGNING=CHANGE_ME\n' >> .env.example
