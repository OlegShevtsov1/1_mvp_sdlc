#!/usr/bin/env bash
# Behaviour test for the root install.sh: what it copies, what it backs up, and when it refuses.
# A stub archon and a stub bun stand in for the real tools; no network, a throwaway ARCHON_HOME.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

fail() { echo "FAIL $1: $2" >&2; exit 1; }

# The stub archon logs each validated workflow and fails the one named in ARCHON_STUB_FAIL.
mkdir "${tmp}/bin"
cat > "${tmp}/bin/archon" <<STUB
#!/usr/bin/env bash
[ "\$1 \$2" = "validate workflows" ] || exit 2
printf '%s\n' "\$3" >> "${tmp}/validated.log"
if [ "\$3" = "\${ARCHON_STUB_FAIL:-}" ]; then echo "  \$3  error: stub failure"; exit 1; fi
echo '{"level":30,"msg":"log line"}'
echo "  \$3  ok"
STUB
cat > "${tmp}/bin/bun" <<'STUB'
#!/usr/bin/env bash
echo "${BUN_STUB_VERSION:-1.4.2}"
STUB
chmod +x "${tmp}/bin/archon" "${tmp}/bin/bun"

home="${tmp}/archon-home"
factory_src="${root}/orchestration/factory/.archon/workflows/sdlc-factory/factory"
factory_dst="${home}/workflows/sdlc-factory/factory"

# install [env assignments...]: runs install.sh, leaves its output in ${out} and exit code in ${rc}.
install() {
  rc=0
  rm -f "${tmp}/validated.log"
  out=$(env PATH="${tmp}/bin:${PATH}" ARCHON_HOME="${home}" ARCHON_BIN="${tmp}/bin/archon" \
    INSTALL_SKIP_RUNTIME_TOOLS=1 "$@" bash "${root}/install.sh" 2>&1) || rc=$?
}

install
[ "${rc}" -eq 0 ] || fail "fresh install" "exit ${rc}: ${out}"
diff -r -x notify-telegram.sh "${factory_src}" "${factory_dst}" >/dev/null ||
  fail "fresh install" "installed factory differs from the repository"
helper="${factory_dst}/scripts/_lib/notify-telegram.sh"
cmp -s "${root}/scripts/ci/notify-telegram.sh" "${helper}" && [ -x "${helper}" ] ||
  fail "fresh install" "the notify helper is not installed into the pack"
for y in "${root}"/orchestration/workflows/*.yaml; do
  cmp -s "${y}" "${home}/workflows/$(basename "${y}")" || fail "fresh install" "$(basename "${y}") differs or is missing"
done
grep -qF "backup: nothing to back up" <<<"${out}" || fail "fresh install" "no 'nothing to back up' line: ${out}"
[ "$(sort "${tmp}/validated.log" | tr '\n' ' ')" = "factory plan-review plugin-probe " ] ||
  fail "fresh install" "validated: $(tr '\n' ' ' <"${tmp}/validated.log")"
! grep -q '^{"level"' <<<"${out}" || fail "fresh install" "Archon's JSON log lines were printed"
echo "PASS fresh install copies and validates every workflow"

echo stale > "${factory_dst}/stale.txt"
mkdir -p "${home}/workflows/mvp-ops"
echo "name: x" > "${home}/workflows/mvp-ops/x.yaml"
install
[ "${rc}" -eq 0 ] || fail "reinstall" "exit ${rc}: ${out}"
backups=("${home}"/workflows-backup/*)
[ "${#backups[@]}" -eq 1 ] && [ -d "${backups[0]}" ] || fail "reinstall" "want one backup dir, got: ${backups[*]}"
grep -qF "backup: ${backups[0]}" <<<"${out}" || fail "reinstall" "backup dir not printed: ${out}"
[ -f "${backups[0]}/sdlc-factory/factory/stale.txt" ] || fail "reinstall" "previous factory not backed up"
[ -f "${backups[0]}/plan-review.yaml" ] && [ -f "${backups[0]}/plugin-probe.yaml" ] || fail "reinstall" "yaml files not backed up"
[ ! -e "${factory_dst}/stale.txt" ] || fail "reinstall" "stale file survived the install"
[ -f "${home}/workflows/mvp-ops/x.yaml" ] || fail "reinstall" "another pack was touched"
[ ! -e "${backups[0]}/mvp-ops" ] || fail "reinstall" "another pack was backed up"
[ -z "$(find "${home}/workflows" -name '*backup*')" ] || fail "reinstall" "a backup landed inside workflows/, where Archon discovers it"
echo "PASS reinstall backs up only what it replaces, outside workflows/"

install ARCHON_STUB_FAIL=plan-review
[ "${rc}" -eq 1 ] || fail "validation failure" "exit ${rc}, want 1: ${out}"
backups=("${home}"/workflows-backup/*)
[ "${#backups[@]}" -eq 2 ] || fail "validation failure" "want a second, separate backup, got: ${backups[*]}"
[ ! -e "${backups[1]}/sdlc-factory/factory/factory" ] || fail "validation failure" "backup nested into an earlier one"
grep -qF "backup: ${backups[1]}" <<<"${out}" && grep -qF "is in ${backups[1]}" <<<"${out}" ||
  fail "validation failure" "message does not name the new backup: ${out}"
echo "PASS a validation failure exits 1 and names the backup"

rm -rf "${home}"
install BUN_STUB_VERSION=1.1.0
[ "${rc}" -eq 1 ] || fail "old bun" "exit ${rc}, want 1: ${out}"
[ ! -e "${home}/workflows" ] || fail "old bun" "something was copied"
echo "PASS bun older than the floor installs nothing"

install ARCHON_BIN="${tmp}/bin/no-such-archon"
[ "${rc}" -eq 1 ] || fail "missing archon" "exit ${rc}, want 1: ${out}"
[ ! -e "${home}/workflows" ] || fail "missing archon" "something was copied"
echo "PASS a missing archon installs nothing"
