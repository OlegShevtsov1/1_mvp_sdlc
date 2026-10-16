#!/usr/bin/env bash
# Fetches the pinned CI tools into .tools/bin (gitignored) and verifies their sha256.
# The single place to bump actionlint, gitleaks and the Archon versions the workflows are tested on:
# Dependabot only updates actions, not these. Callers put .tools/bin on PATH themselves.
# Usage: tools.sh            actionlint and gitleaks
#        tools.sh archon     .tools/bin/archon-<version> for every pinned Archon release (never installed)
set -euo pipefail
root=$(git rev-parse --show-toplevel)
bin="${root}/.tools/bin"

[ "$(uname -sm)" = "Linux x86_64" ] || { echo "tools: only Linux x86_64 is supported (got $(uname -sm))" >&2; exit 2; }
mkdir -p "${bin}"

# fetch <name> <version> <version command> <url> <sha256>
fetch() {
  local name=$1 version=$2 version_cmd=$3 url=$4 sha256=$5
  if [ -x "${bin}/${name}" ] && "${bin}/${name}" "${version_cmd}" 2>/dev/null | grep -qF "${version}"; then
    echo "tools: ${name} ${version} ok"
    return
  fi
  local tgz
  tgz=$(mktemp "${root}/.tools/${name}.XXXXXX")
  curl -sSfL -o "${tgz}" "${url}"
  echo "${sha256}  ${tgz}" | sha256sum -c --quiet - || { rm -f "${tgz}"; exit 1; }
  tar -xzf "${tgz}" -C "${bin}" "${name}"
  rm -f "${tgz}"
  echo "tools: ${name} ${version} ok"
}

# fetch_binary <name> <url> <sha256>: a raw release binary, not a tarball. The checksum is also the
# up-to-date check, so the binary is never run here (Archon writes to its home on every start).
fetch_binary() {
  local name=$1 url=$2 sha256=$3
  if [ -x "${bin}/${name}" ] && echo "${sha256}  ${bin}/${name}" | sha256sum -c --quiet - >/dev/null 2>&1; then
    echo "tools: ${name} ok"
    return
  fi
  local tmp
  tmp=$(mktemp "${root}/.tools/${name}.XXXXXX")
  curl -sSfL -o "${tmp}" "${url}"
  echo "${sha256}  ${tmp}" | sha256sum -c --quiet - || { rm -f "${tmp}"; exit 1; }
  chmod 0755 "${tmp}"
  mv -f "${tmp}" "${bin}/${name}"
  echo "tools: ${name} ok"
}

if [ "${1:-}" = archon ]; then
  fetch_binary archon-0.10.1 \
    "https://github.com/coleam00/Archon/releases/download/v0.10.1/archon-linux-x64" \
    7aa8b25a4b0017dddb05aead518cbd453ca8db9c54ac4a7611f40164fecd3973
  fetch_binary archon-0.11.1 \
    "https://github.com/coleam00/Archon/releases/download/v0.11.1/archon-linux-x64" \
    81ee5feaf4e6c8de19903a6c1252743228d235bbedb818dbee045b21df49d59d
  exit 0
fi

fetch actionlint 1.7.12 -version \
  "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz" \
  8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
fetch gitleaks 8.30.1 version \
  "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz" \
  551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
