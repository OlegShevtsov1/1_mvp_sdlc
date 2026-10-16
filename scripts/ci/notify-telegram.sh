#!/usr/bin/env bash
# Post a message to a Telegram group topic. Usage: notify-telegram.sh <TOPIC> <message>
# Reads TELEGRAM_<TOPIC>_BOT_TOKEN, _CHAT_ID and optional _THREAD_ID from the environment; without a
# token or chat id it prints "skipped" and exits 0. The token goes to curl on stdin, never in argv or output.
set -euo pipefail
T=$(printf '%s' "${1:?usage: notify-telegram.sh <TOPIC> <message>}" | tr 'a-z-' 'A-Z_')
msg=${2:?usage: notify-telegram.sh <TOPIC> <message>}
[[ "$T" =~ ^[A-Z0-9_]+$ ]] || { echo "notify-telegram: invalid topic '$T'" >&2; exit 2; }

v=TELEGRAM_${T}_BOT_TOKEN; token=${!v:-}
v=TELEGRAM_${T}_CHAT_ID; chat=${!v:-}
v=TELEGRAM_${T}_THREAD_ID; thread=${!v:-}
[ -n "$token" ] || { echo "notify-telegram: $T skipped (TELEGRAM_${T}_BOT_TOKEN not set)"; exit 0; }
[ -n "$chat" ] || { echo "notify-telegram: $T skipped (TELEGRAM_${T}_CHAT_ID not set)"; exit 0; }

args=(--data-urlencode "chat_id=$chat")
[ -z "$thread" ] || args+=(--data-urlencode "message_thread_id=$thread")
args+=(--data-urlencode "text=$msg")
resp=$(curl -sS -m 20 -K - "${args[@]}" <<<"url = \"https://api.telegram.org/bot${token}/sendMessage\"") \
  || { echo "notify-telegram: $T failed: curl error" >&2; exit 1; }

printf '%s' "$resp" | python3 -c '
import json, sys
topic = sys.argv[1]
try:
    r = json.load(sys.stdin)
except ValueError:
    r = {"description": "unreadable response"}
if r.get("ok"):
    print("notify-telegram: %s sent (thread %s)" % (topic, r.get("result", {}).get("message_thread_id", "-")))
else:
    print("notify-telegram: %s failed: %s" % (topic, r.get("description", "unknown error")), file=sys.stderr)
    sys.exit(1)
' "$T"
