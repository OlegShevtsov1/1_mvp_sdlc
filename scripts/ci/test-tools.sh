#!/usr/bin/env bash
# Behaviour test for tools.sh: a download that fails its sha256 must never land in .tools/bin.
# Runs in a throwaway git repo with a stub curl on PATH; no network.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)/tools.sh"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

# A well-formed tarball with an impostor binary: only the sha256 gate can stop it.
mkdir "${tmp}/payload"
printf '#!/bin/sh\necho impostor\n' > "${tmp}/payload/actionlint"
chmod +x "${tmp}/payload/actionlint"
tar -czf "${tmp}/tampered.tgz" -C "${tmp}/payload" actionlint
cat > "${tmp}/curl" <<STUB
#!/usr/bin/env bash
while [ \$# -gt 0 ]; do
  if [ "\$1" = -o ]; then cp "${tmp}/tampered.tgz" "\$2"; fi
  shift
done
STUB
chmod +x "${tmp}/curl"

fail() { echo "FAIL $1: $2" >&2; exit 1; }

mkdir -p "${tmp}/repo/scripts/ci"
git -C "${tmp}/repo" init -q
cp "${src}" "${tmp}/repo/scripts/ci/tools.sh"
rc=0
out=$(cd "${tmp}/repo" && PATH="${tmp}:${PATH}" bash scripts/ci/tools.sh 2>&1) || rc=$?
[ "${rc}" -eq 1 ] || fail "checksum mismatch" "exit ${rc}, want 1: ${out}"
[ ! -e "${tmp}/repo/.tools/bin/actionlint" ] || fail "checksum mismatch" "actionlint was installed"
[ -z "$(find "${tmp}/repo/.tools" -maxdepth 1 -type f)" ] || fail "checksum mismatch" "download left behind"
echo "PASS checksum mismatch installs nothing"

# The raw Archon binaries go through the same gate: an impostor must not land as .tools/bin/archon-*.
printf '#!/bin/sh\necho impostor\n' > "${tmp}/archon-impostor"
cat > "${tmp}/curl" <<STUB
#!/usr/bin/env bash
while [ \$# -gt 0 ]; do
  if [ "\$1" = -o ]; then cp "${tmp}/archon-impostor" "\$2"; fi
  shift
done
STUB
chmod +x "${tmp}/curl"
rc=0
out=$(cd "${tmp}/repo" && PATH="${tmp}:${PATH}" bash scripts/ci/tools.sh archon 2>&1) || rc=$?
[ "${rc}" -eq 1 ] || fail "archon checksum mismatch" "exit ${rc}, want 1: ${out}"
[ -z "$(find "${tmp}/repo/.tools/bin" -name 'archon-*')" ] || fail "archon checksum mismatch" "an archon binary was installed"
[ -z "$(find "${tmp}/repo/.tools" -maxdepth 1 -type f)" ] || fail "archon checksum mismatch" "download left behind"
echo "PASS archon checksum mismatch installs nothing"
