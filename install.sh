#!/usr/bin/env bash
# Installs this repository's Archon workflows for the current user: the `factory` pack
# (orchestration/factory) into <ARCHON_HOME>/workflows/sdlc-factory/factory and every
# orchestration/workflows/*.yaml into <ARCHON_HOME>/workflows/, plus scripts/ci/notify-telegram.sh into the
# pack's scripts/_lib/ (the factory's Claude login check alerts through it). Whatever it replaces is first copied to
# <ARCHON_HOME>/workflows-backup/<UTC timestamp>/ (outside workflows/, which Archon reads in full).
# Other packs, such as mvp-ops, are never touched. Every installed workflow is then validated;
# a validation error exits 1. Only after validation passes, the sdlc-autopilot supervisor
# (orchestration/supervisor) is copied to <ARCHON_HOME>/supervisor and its systemd user unit rendered into
# <XDG_CONFIG_HOME>/systemd/user/sdlc-autopilot.service; the unit is not enabled. The unit's PATH is the bun, archon,
# claude and gh directories, then the operator's login PATH (HOME's and SHELL's: `env -i "$SHELL" -lc`, else this
# shell's PATH, with a warning), then the rbenv/nvm/pyenv/tfenv directories under HOME that exist, then the standard
# directories; each once. A ruby, bundle or node it does not resolve is a warning.
# Knobs: ARCHON_HOME (default ~/.archon), ARCHON_BIN (default archon), XDG_CONFIG_HOME (default ~/.config),
# INSTALL_SKIP_RUNTIME_TOOLS=1 skips the gh/claude checks (needed to run workflows, not to install them); a claude
# not found then leaves the unit's PATH assuming ~/.local/bin, with a warning.
# Install from `main` for production; check out `develop` to test a change before it is released.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHON_HOME="${ARCHON_HOME:-${HOME}/.archon}"
ARCHON_BIN="${ARCHON_BIN:-archon}"
export ARCHON_HOME
workflows="${ARCHON_HOME}/workflows"
factory_src="${HERE}/orchestration/factory/.archon/workflows/sdlc-factory/factory"
factory_rel="sdlc-factory/factory"
supervisor_src="${HERE}/orchestration/supervisor"

die() { echo "install: $*" >&2; exit 1; }

command -v "${ARCHON_BIN}" >/dev/null || die "${ARCHON_BIN} not found. Install Archon: curl -fsSL https://archon.diy/install | bash"
command -v bun >/dev/null || die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
# The factory's scripts parse the profile with Bun.YAML.parse, which exists from
# Bun 1.2.21. `sort -V` orders the two versions; the floor must sort first.
BUN_MIN="1.2.21"
BUN_VERSION="$(bun --version 2>/dev/null | tr -d '[:space:]')"
if [ -z "${BUN_VERSION}" ] || [ "$(printf '%s\n%s\n' "${BUN_MIN}" "${BUN_VERSION}" | sort -V | head -1)" != "${BUN_MIN}" ]; then
  die "bun ${BUN_VERSION:-(version unreadable)} is too old: the factory needs Bun >= ${BUN_MIN} (Bun.YAML.parse). Upgrade: curl -fsSL https://bun.sh/install | bash"
fi
if [ "${INSTALL_SKIP_RUNTIME_TOOLS:-}" != 1 ]; then
  command -v gh >/dev/null || die "gh not found. Install GitHub CLI and run: gh auth login"
  command -v claude >/dev/null || die "claude not found. Install Claude Code and log in."
fi

yamls=("${HERE}"/orchestration/workflows/*.yaml)
targets=("${factory_rel}")
for y in "${yamls[@]}"; do targets+=("$(basename "${y}")"); done

stamp="${ARCHON_HOME}/workflows-backup/$(date -u +%Y%m%dT%H%M%SZ)"
backup="${stamp}"
# Two installs within one second must not merge into one backup.
n=1
while [ -e "${backup}" ]; do backup="${stamp}-$((n++))"; done
backed_up=0
for t in "${targets[@]}"; do
  [ -e "${workflows}/${t}" ] || continue
  mkdir -p "$(dirname "${backup}/${t}")"
  cp -R "${workflows}/${t}" "${backup}/${t}"
  backed_up=1
done
if [ "${backed_up}" -eq 1 ]; then echo "backup: ${backup}"; else echo "backup: nothing to back up"; fi

mkdir -p "${workflows}/sdlc-factory"
rm -rf "${workflows:?}/${factory_rel}"
cp -R "${factory_src}" "${workflows}/${factory_rel}"
install -m 0755 "${HERE}/scripts/ci/notify-telegram.sh" "${workflows}/${factory_rel}/scripts/_lib/notify-telegram.sh"
for y in "${yamls[@]}"; do install -m 0644 "${y}" "${workflows}/$(basename "${y}")"; done
echo "installed: ${targets[*]} into ${workflows}"

names=(factory)
for y in "${yamls[@]}"; do names+=("$(sed -n 's/^name: *//p' "${y}" | head -1)"); done
failed=0
for n in "${names[@]}"; do
  # Validation runs from this checkout: it carries the `{}` placeholder at .archon/mcp/monitoring.json
  # that the factory's `monitor` node references.
  rc=0
  out="$("${ARCHON_BIN}" validate workflows "${n}" --cwd "${HERE}" 2>&1)" || rc=$?
  printf '%s\n' "${out}" | { grep -v '^{"level"' || true; } | { grep -v '^ *$' || true; }
  [ "${rc}" -eq 0 ] || failed=1
done
if [ "${failed}" -ne 0 ]; then
  if [ "${backed_up}" -eq 1 ]; then
    die "validation failed (see above). The previous install is in ${backup}; restore it with:
  rm -rf '${workflows}/${factory_rel}' && cp -R '${backup}/.' '${workflows}/'"
  fi
  die "validation failed (see above). There was no previous install to restore (backup: nothing to back up)."
fi

supervisor="${ARCHON_HOME}/supervisor"
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
unit="${unit_dir}/sdlc-autopilot.service"
rm -rf "${supervisor}"
cp -R "${supervisor_src}" "${supervisor}"
# A user unit does not inherit the login PATH; bun, archon, claude and gh must resolve under systemd too, and so must
# the toolchains (ruby, bundle, node) the runs this supervisor starts need for their merge gates.
bun_bin="$(command -v bun)"
archon_bin="$(command -v "${ARCHON_BIN}")"
claude_bin="$(command -v claude || true)"
if [ -n "${claude_bin}" ]; then
  claude_dir="$(dirname "${claude_bin}")"
else
  claude_dir="${HOME}/.local/bin"
  echo "install: warning: claude not found; the unit's PATH assumes ${claude_dir}" >&2
fi
gh_bin="$(command -v gh || true)"
# Each directory once, at its first position; the standard directories are appended last, in their usual order.
# Characters outside this set break systemd's Environment= (space, % specifiers) or the sed render below (|, &, \).
unit_path=""
add_dir() {
  case "$1" in /*) ;; *) return 0 ;; esac
  case "$1" in *[!A-Za-z0-9._+@,=~/-]*)
    echo "install: warning: the unit's PATH skips '$1' (systemd or the renderer cannot carry it)" >&2
    return 0 ;;
  esac
  case "$1" in /usr/local/bin | /usr/bin | /bin) return 0 ;; esac
  case ":${unit_path}:" in *":$1:"*) ;; *) unit_path="${unit_path:+${unit_path}:}$1" ;; esac
}
for d in "$(dirname "${bun_bin}")" "$(dirname "${archon_bin}")" "${claude_dir}" ${gh_bin:+"$(dirname "${gh_bin}")"}; do
  add_dir "${d}"
done
# What a fresh login of this operator gets, not whatever environment runs the install (a post-merge run, a test).
# The marker keeps output from profile files out of the value.
login_out=""
timeout_cmd=()
if command -v timeout >/dev/null; then timeout_cmd=(timeout 10); fi
if [ -n "${SHELL:-}" ] && [ -x "${SHELL}" ]; then
  login_out=$(env -i HOME="${HOME}" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" SHELL="${SHELL}" \
    PATH=/usr/local/bin:/usr/bin:/bin "${timeout_cmd[@]}" "${SHELL}" -lc 'printf "\nSDLC_LOGIN_PATH=%s\n" "$PATH"' </dev/null 2>/dev/null) || login_out=""
fi
if grep -q '^SDLC_LOGIN_PATH=' <<<"${login_out}"; then
  base_path=$(sed -n 's/^SDLC_LOGIN_PATH=//p' <<<"${login_out}" | tail -1)
else
  echo "install: warning: could not read ${SHELL:-\$SHELL}'s login PATH; the unit's PATH uses this shell's PATH" >&2
  base_path="${PATH}"
fi
IFS=: read -ra base_dirs <<<"${base_path}"
for d in "${base_dirs[@]}"; do add_dir "${d}"; done
# Interactive rc files (.zshrc, .bashrc) set these up, and a non-interactive login shell does not read them.
nvm_bin=$(printf '%s\n' "${HOME}"/.nvm/versions/node/*/bin | sort -V | tail -1)
for d in "${HOME}/.rbenv/shims" "${HOME}/.rbenv/bin" "${nvm_bin}" "${HOME}/.pyenv/shims" "${HOME}/.tfenv/bin"; do
  if [ -d "${d}" ]; then add_dir "${d}"; fi
done
unit_path="${unit_path:+${unit_path}:}/usr/local/bin:/usr/bin:/bin"
mkdir -p "${unit_dir}"
sed -e "s|@BUN@|${bun_bin}|g" -e "s|@SUPERVISOR_DIR@|${supervisor}|g" -e "s|@ARCHON_HOME@|${ARCHON_HOME}|g" \
  -e "s|@PATH@|${unit_path}|g" \
  "${supervisor_src}/systemd/sdlc-autopilot.service" >"${unit}"
chmod 0644 "${unit}"
for t in ruby bundle node; do
  (PATH="${unit_path}"; command -v "${t}" >/dev/null) ||
    echo "install: warning: ${t} not found on the unit's PATH; be/fe runs the supervisor starts will fail their merge gate" >&2
done
echo "installed: supervisor into ${supervisor}, unit ${unit} (not enabled; enable with: systemctl --user daemon-reload && systemctl --user enable --now sdlc-autopilot)"
