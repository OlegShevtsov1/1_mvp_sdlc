#!/usr/bin/env bash
# Behaviour test for the root install.sh: what it copies, what it backs up, and when it refuses.
# A stub archon and a stub bun stand in for the real tools; no network, a throwaway ARCHON_HOME.
# Also checks the unit's PATH (bun, archon, claude and gh directories, then a stub login shell's PATH, then the
# rbenv/nvm/pyenv/tfenv directories of a stub HOME; each once) and that archon-check.sh renders the unit into a scratch
# XDG_CONFIG_HOME rather than the operator's.
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
mkdir "${tmp}/claude-bin" "${tmp}/gh-bin"
printf '#!/usr/bin/env bash\n' > "${tmp}/claude-bin/claude"
printf '#!/usr/bin/env bash\n' > "${tmp}/gh-bin/gh"
# The stub login shell prints profile noise, then the PATH in ${tmp}/login-path (a file: install.sh runs it under env -i).
cat > "${tmp}/login-shell" <<STUB
#!/usr/bin/env bash
echo "noise from a profile"
login_path=/usr/local/bin:/usr/bin:/bin
[ -f "${tmp}/login-path" ] && login_path=\$(cat "${tmp}/login-path")
printf '\nSDLC_LOGIN_PATH=%s\n' "\${login_path}"
STUB
mkdir "${tmp}/home"
chmod +x "${tmp}/bin/archon" "${tmp}/bin/bun" "${tmp}/claude-bin/claude" "${tmp}/gh-bin/gh" "${tmp}/login-shell"

home="${tmp}/archon-home"
factory_src="${root}/orchestration/factory/.archon/workflows/sdlc-factory/factory"
factory_dst="${home}/workflows/sdlc-factory/factory"
supervisor_dst="${home}/supervisor"
unit="${tmp}/config/systemd/user/sdlc-autopilot.service"

# install [env assignments...]: runs install.sh, leaves its output in ${out} and exit code in ${rc}.
install() {
  rc=0
  rm -f "${tmp}/validated.log"
  out=$(env PATH="${tmp}/bin:${tmp}/claude-bin:${tmp}/gh-bin:${PATH}" ARCHON_HOME="${home}" ARCHON_BIN="${tmp}/bin/archon" \
    XDG_CONFIG_HOME="${tmp}/config" INSTALL_SKIP_RUNTIME_TOOLS=1 HOME="${tmp}/home" SHELL="${tmp}/login-shell" "$@" bash "${root}/install.sh" 2>&1) || rc=$?
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
diff -r "${root}/orchestration/supervisor" "${supervisor_dst}" >/dev/null ||
  fail "fresh install" "installed supervisor differs from the repository"
[ -f "${unit}" ] || fail "fresh install" "no unit at ${unit}"
for want in "ExecStart=${tmp}/bin/bun run ${supervisor_dst}/src/main.ts" "Environment=ARCHON_HOME=${home}" "KillMode=process"; do
  grep -qxF "${want}" "${unit}" || fail "fresh install" "unit lacks '${want}': $(cat "${unit}")"
done
[ "$(grep -c '@[A-Z_]*@' "${unit}" || true)" -eq 0 ] || fail "fresh install" "unit keeps a placeholder: $(cat "${unit}")"
grep -qF "(not enabled;" <<<"${out}" || fail "fresh install" "no 'not enabled' line: ${out}"
echo "PASS fresh install copies the supervisor and renders its unit, not enabled"
unit_path=$(sed -n 's/^Environment=PATH=//p' "${unit}")
[ "${unit_path}" = "${tmp}/bin:${tmp}/claude-bin:${tmp}/gh-bin:/usr/local/bin:/usr/bin:/bin" ] ||
  fail "unit PATH" "want the bun/archon, claude, gh and standard directories in order, got: ${unit_path}"
[ -z "$(tr ':' '\n' <<<"${unit_path}" | sort | uniq -d)" ] || fail "unit PATH" "a directory repeats: ${unit_path}"
echo "PASS the unit's PATH holds the bun, archon, claude and gh directories once each"

echo stale > "${factory_dst}/stale.txt"
echo stale > "${supervisor_dst}/stale.txt"
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
[ ! -e "${supervisor_dst}/stale.txt" ] || fail "reinstall" "stale supervisor file survived the install"
[ -f "${home}/workflows/mvp-ops/x.yaml" ] || fail "reinstall" "another pack was touched"
[ ! -e "${backups[0]}/mvp-ops" ] || fail "reinstall" "another pack was backed up"
[ -z "$(find "${home}/workflows" -name '*backup*')" ] || fail "reinstall" "a backup landed inside workflows/, where Archon discovers it"
echo "PASS reinstall backs up only what it replaces, outside workflows/"

rm -rf "${supervisor_dst}"
install ARCHON_STUB_FAIL=plan-review
[ "${rc}" -eq 1 ] || fail "validation failure" "exit ${rc}, want 1: ${out}"
backups=("${home}"/workflows-backup/*)
[ "${#backups[@]}" -eq 2 ] || fail "validation failure" "want a second, separate backup, got: ${backups[*]}"
[ ! -e "${backups[1]}/sdlc-factory/factory/factory" ] || fail "validation failure" "backup nested into an earlier one"
grep -qF "backup: ${backups[1]}" <<<"${out}" && grep -qF "is in ${backups[1]}" <<<"${out}" ||
  fail "validation failure" "message does not name the new backup: ${out}"
[ ! -e "${supervisor_dst}" ] || fail "validation failure" "the supervisor was installed despite the failure"
echo "PASS a validation failure exits 1, names the backup and installs no supervisor"

rm -rf "${home}"
install BUN_STUB_VERSION=1.1.0
[ "${rc}" -eq 1 ] || fail "old bun" "exit ${rc}, want 1: ${out}"
[ ! -e "${home}/workflows" ] || fail "old bun" "something was copied"
echo "PASS bun older than the floor installs nothing"

install ARCHON_BIN="${tmp}/bin/no-such-archon"
[ "${rc}" -eq 1 ] || fail "missing archon" "exit ${rc}, want 1: ${out}"
[ ! -e "${home}/workflows" ] || fail "missing archon" "something was copied"
echo "PASS a missing archon installs nothing"

if ! PATH=/usr/bin:/bin command -v claude >/dev/null; then
  install PATH="${tmp}/bin:/usr/bin:/bin" HOME="${tmp}/fake-home"
  [ "${rc}" -eq 0 ] || fail "missing claude" "exit ${rc}: ${out}"
  grep -qF "install: warning: claude not found" <<<"${out}" || fail "missing claude" "no warning: ${out}"
  grep -qF ":${tmp}/fake-home/.local/bin:" <<<"$(sed -n 's/^Environment=PATH=//p' "${unit}")" ||
    fail "missing claude" "the unit's PATH lacks ~/.local/bin: $(cat "${unit}")"
  echo "PASS a claude not found warns and the unit's PATH falls back to ~/.local/bin"
fi

if PATH=/usr/local/bin:/usr/bin:/bin command -v gh >/dev/null; then
  install PATH="${tmp}/bin:${tmp}/claude-bin:/usr/local/bin:/usr/bin:/bin"
  [ "${rc}" -eq 0 ] || fail "gh in a standard directory" "exit ${rc}: ${out}"
  unit_path=$(sed -n 's/^Environment=PATH=//p' "${unit}")
  [ "${unit_path}" = "${tmp}/bin:${tmp}/claude-bin:/usr/local/bin:/usr/bin:/bin" ] ||
    fail "gh in a standard directory" "want each standard directory once, in place, got: ${unit_path}"
  echo "PASS a tool in a standard directory does not repeat it in the unit's PATH"
fi

tc="${tmp}/tc-home"
mkdir -p "${tc}/.rbenv/shims" "${tc}/.rbenv/bin" "${tc}/.nvm/versions/node/v9.0.0/bin" \
  "${tc}/.nvm/versions/node/v20.1.0/bin" "${tc}/.pyenv/shims"
for t in .rbenv/shims/ruby .rbenv/shims/bundle .nvm/versions/node/v20.1.0/bin/node; do
  printf '#!/usr/bin/env bash\n' > "${tc}/${t}"
  chmod +x "${tc}/${t}"
done
printf '%s' "/opt/login-a:${tc}/.rbenv/shims:/usr/bin:/opt/login-a:relative:/opt/with space" > "${tmp}/login-path"
install HOME="${tc}"
rm -f "${tmp}/login-path"
[ "${rc}" -eq 0 ] || fail "toolchain PATH" "exit ${rc}: ${out}"
unit_path=$(sed -n 's/^Environment=PATH=//p' "${unit}")
want="${tmp}/bin:${tmp}/claude-bin:${tmp}/gh-bin:/opt/login-a:${tc}/.rbenv/shims:${tc}/.rbenv/bin"
want="${want}:${tc}/.nvm/versions/node/v20.1.0/bin:${tc}/.pyenv/shims:/usr/local/bin:/usr/bin:/bin"
[ "${unit_path}" = "${want}" ] || fail "toolchain PATH" "want ${want}, got: ${unit_path}"
[ -z "$(tr ':' '\n' <<<"${unit_path}" | sort | uniq -d)" ] || fail "toolchain PATH" "a directory repeats: ${unit_path}"
grep -qF "install: warning: the unit's PATH skips '/opt/with space'" <<<"${out}" ||
  fail "toolchain PATH" "no warning for the entry with a space: ${out}"
! grep -qF "not found on the unit's PATH" <<<"${out}" || fail "toolchain PATH" "a resolvable toolchain warned: ${out}"
echo "PASS the unit's PATH carries the login PATH and the toolchain directories, each once"

install SHELL=/bin/false
[ "${rc}" -eq 0 ] || fail "login shell fails" "exit ${rc}: ${out}"
grep -qF "install: warning: could not read /bin/false's login PATH" <<<"${out}" || fail "login shell fails" "no warning: ${out}"
unit_path=$(sed -n 's/^Environment=PATH=//p' "${unit}")
[[ "${unit_path}" == *":${tmp}/gh-bin:"*":/usr/local/bin:/usr/bin:/bin" ]] ||
  fail "login shell fails" "want this shell's PATH, ending in the standard directories, got: ${unit_path}"
echo "PASS a login shell that fails falls back to this shell's PATH"

if ! PATH=/usr/local/bin:/usr/bin:/bin command -v bundle >/dev/null; then
  install
  [ "${rc}" -eq 0 ] || fail "missing bundle" "exit ${rc}: ${out}"
  grep -qF "install: warning: bundle not found on the unit's PATH" <<<"${out}" || fail "missing bundle" "no warning: ${out}"
  echo "PASS a bundle the unit's PATH does not resolve warns"
fi

installs=$(grep -F 'bash install.sh' "${root}/scripts/ci/archon-check.sh" || true)
[ -n "${installs}" ] || fail "archon-check" "no 'bash install.sh' line in archon-check.sh"
! grep -vF 'XDG_CONFIG_HOME=' <<<"${installs}" ||
  fail "archon-check" "an install.sh run without a scratch XDG_CONFIG_HOME would overwrite the operator's unit"
echo "PASS archon-check.sh renders the unit into a scratch XDG_CONFIG_HOME, not the operator's"
