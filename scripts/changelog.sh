#!/usr/bin/env bash
# Changelog fragments (changelog.d/README.md): a task PR adds changelog.d/PILOT-<n>.md instead of editing
# CHANGELOG.md, so parallel tasks never conflict in [Unreleased].
# Usage: changelog.sh check | release <X.Y.Z> [YYYY-MM-DD]
#   check    every fragment is well formed and CHANGELOG.md's [Unreleased] holds no entries (check.sh changelog).
#   release  release-prep: writes `## [X.Y.Z] - <date, default today>` after [Unreleased] with the six Keep a
#            Changelog categories in order, each category's fragments by card number, and deletes the fragments.
#            A rerun once X.Y.Z is assembled and no fragment is left changes nothing.
# Env: CHANGELOG_ROOT (the directory holding CHANGELOG.md and changelog.d/, default the repository's top level).
# Exit 0: ok. Exit 1: a check or a precondition failed. Exit 64: usage.
set -euo pipefail

usage() {
  echo "usage: changelog.sh check | release <X.Y.Z> [YYYY-MM-DD]" >&2
  exit 64
}

[ $# -ge 1 ] || usage
cmd=$1
shift
case "${cmd}" in
  check) [ $# -eq 0 ] || usage ;;
  release)
    (($# >= 1 && $# <= 2)) || usage
    [[ $1 =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || usage
    [ $# -eq 1 ] || [[ $2 =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || usage
    ;;
  *) usage ;;
esac

cd "${CHANGELOG_ROOT:-$(git rev-parse --show-toplevel)}"
python3 - "${cmd}" "$@" <<'PY'
import datetime, os, re, sys

CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]
cmd, args = sys.argv[1], sys.argv[2:]


def die(*errors):
    for e in errors:
        print(f"::error::changelog: {e}", file=sys.stderr)
    sys.exit(1)


def read_fragment(path):
    """(category, body lines) of a well-formed fragment, else an error string."""
    lines = open(path, encoding="utf-8").read().split("\n")
    m = re.fullmatch(r"category: (\w+)", lines[1]) if len(lines) >= 3 else None
    if lines[0] != "---" or not m or m.group(1) not in CATEGORIES or lines[2] != "---":
        return f"{path}: must start with the front matter '---', 'category: <{'|'.join(CATEGORIES)}>', '---'"
    body = lines[3:]
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()
    if not body or not body[0].startswith("- ") or any(
        line.strip() and not line.startswith(("- ", "  ")) for line in body
    ):
        return f"{path}: the body must be list items ('- ' lines, continuation lines indented by two spaces)"
    return m.group(1), body


errors, fragments = [], []
for name in sorted(os.listdir("changelog.d")) if os.path.isdir("changelog.d") else []:
    path = f"changelog.d/{name}"
    if name == "README.md":
        continue
    m = re.fullmatch(r"PILOT-([1-9][0-9]*)\.md", name)
    if not m or not os.path.isfile(path):
        errors.append(f"{path}: only README.md and fragments named PILOT-<n>.md belong in changelog.d/")
        continue
    fragment = read_fragment(path)
    if isinstance(fragment, str):
        errors.append(fragment)
        continue
    category, body = fragment
    fragments.append((CATEGORIES.index(category), int(m.group(1)), path, body))

text = open("CHANGELOG.md", encoding="utf-8").read().split("\n")
if "## [Unreleased]" not in text:
    die("CHANGELOG.md has no '## [Unreleased]' section")
start = text.index("## [Unreleased]")
end = next((i for i in range(start + 1, len(text)) if text[i].startswith("## ")), len(text))
if any(re.match(r"\s*[-*+]\s+\S", line) for line in text[start + 1 : end]):
    errors.append(
        "CHANGELOG.md: [Unreleased] has entries; a task writes changelog.d/PILOT-<n>.md instead (changelog.d/README.md)"
    )
if errors:
    die(*errors)

if cmd == "check":
    print(f"changelog: ok ({len(fragments)} fragment(s), [Unreleased] empty)")
    sys.exit(0)

version = args[0]
date = args[1] if len(args) > 1 else datetime.date.today().isoformat()
assembled = any(line == f"## [{version}]" or line.startswith(f"## [{version}] ") for line in text)
if assembled and not fragments:
    print(f"changelog: {version} already assembled")
    sys.exit(0)
if assembled:
    die(f"CHANGELOG.md already has {version}, and changelog.d/ still has fragments")
if not fragments:
    die("no fragments in changelog.d/; nothing to release")

fragments.sort()
section = [f"## [{version}] - {date}", ""]
for index, category in enumerate(CATEGORIES):
    section += [f"### {category}", ""]
    for c, _, _, body in fragments:
        if c == index:
            section += body
    if section[-1]:
        section.append("")
with open("CHANGELOG.md.tmp", "w", encoding="utf-8") as f:
    f.write("\n".join(text[:end] + section + text[end:]))
os.replace("CHANGELOG.md.tmp", "CHANGELOG.md")
for _, _, path, _ in fragments:
    os.remove(path)
print(f"changelog: assembled {version} from {len(fragments)} fragment(s)")
PY
