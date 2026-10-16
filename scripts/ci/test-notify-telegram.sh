#!/usr/bin/env bash
# Behaviour test for notify-telegram.sh with a stub curl on PATH; no network.
# The send path must hand the token to curl on stdin only, never in argv or the script's own output.
set -euo pipefail
notify="$(cd "$(dirname "$0")" && pwd)/notify-telegram.sh"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

cat > "${tmp}/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${STUB_DIR}/argv"
cat > "${STUB_DIR}/stdin"
printf '%s' "${STUB_RESPONSE}"
STUB
chmod +x "${tmp}/curl"
for v in $(compgen -e | grep '^TELEGRAM_' || true); do unset "${v}"; done
token=dummy-token-not-a-secret
export PATH="${tmp}:${PATH}" STUB_DIR="${tmp}" \
  TELEGRAM_TEST_TOPIC_BOT_TOKEN="${token}" TELEGRAM_TEST_TOPIC_CHAT_ID=42 TELEGRAM_TEST_TOPIC_THREAD_ID=7

fail() { echo "FAIL $1: $2" >&2; exit 1; }

# run_case <name> <expected exit> <stub response> <expected output substring>
run_case() {
  local name=$1 want=$2 response=$3 expect=$4 out rc=0
  rm -f "${tmp}/argv" "${tmp}/stdin"
  out=$(STUB_RESPONSE="${response}" bash "${notify}" test-topic "hello" 2>&1) || rc=$?
  [ "${rc}" -eq "${want}" ] || fail "${name}" "exit ${rc}, want ${want}: ${out}"
  grep -qF -- "${expect}" <<<"${out}" || fail "${name}" "output lacks '${expect}': ${out}"
  if grep -qF -- "${token}" <<<"${out}"; then fail "${name}" "output contains the token"; fi
  if grep -qF -- "${token}" "${tmp}/argv"; then fail "${name}" "curl argv contains the token"; fi
  grep -qF -- "bot${token}/sendMessage" "${tmp}/stdin" || fail "${name}" "token not passed on curl stdin"
  grep -qxF -- "chat_id=42" "${tmp}/argv" || fail "${name}" "chat_id missing from curl argv"
  grep -qxF -- "message_thread_id=7" "${tmp}/argv" || fail "${name}" "thread id missing from curl argv"
  echo "PASS ${name}"
}

run_case "sent"           0 '{"ok":true,"result":{"message_thread_id":7}}' "TEST_TOPIC sent (thread 7)"
run_case "API rejects"    1 '{"ok":false,"description":"Bad Request"}' "TEST_TOPIC failed: Bad Request"
run_case "unreadable"     1 'not json' "unreadable response"

unset TELEGRAM_TEST_TOPIC_BOT_TOKEN
rm -f "${tmp}/argv"
out=$(bash "${notify}" test-topic "hello" 2>&1) || fail "unset token" "exit $?: ${out}"
grep -qF "skipped" <<<"${out}" || fail "unset token" "output lacks 'skipped': ${out}"
[ ! -e "${tmp}/argv" ] || fail "unset token" "curl was called"
echo "PASS unset token skips without calling curl"
