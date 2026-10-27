#!/usr/bin/env bash
# Installs this repository's Archon workflows for the current user: the `factory` pack
# (orchestration/factory) into <ARCHON_HOME>/workflows/sdlc-factory/factory and every
# orchestration/workflows/*.yaml into <ARCHON_HOME>/workflows/, plus scripts/ci/notify-telegram.sh into the
# pack's scripts/_lib/ (the factory's Claude login check alerts through it). Whatever it replaces is first copied to
# <ARCHON_HOME>/workflows-backup/<UTC timestamp>/ (outside workflows/, which Archon reads in full).
# Other packs, such as mvp-ops, are never touched. Every installed workflow is then validated;
# a validation error exits 1.
# Knobs: ARCHON_HOME (default ~/.archon), ARCHON_BIN (default archon),
# INSTALL_SKIP_RUNTIME_TOOLS=1 skips the gh/claude checks (needed to run workflows, not to install them).
# Install from `main` for production; check out `develop` to test a change before it is released.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHON_HOME="${ARCHON_HOME:-${HOME}/.archon}"
ARCHON_BIN="${ARCHON_BIN:-archon}"
export ARCHON_HOME
workflows="${ARCHON_HOME}/workflows"
factory_src="${HERE}/orchestration/factory/.archon/workflows/sdlc-factory/factory"
factory_rel="sdlc-factory/factory"

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
