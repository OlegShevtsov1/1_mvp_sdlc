#!/usr/bin/env python3
"""Check relative links and #anchors in markdown files.

Every relative link must point at an existing path; every #anchor into a markdown file must be a GitHub heading slug
of that file. External links (scheme://, mailto:) and fenced code are skipped. Directories are searched for *.md.
Stdlib only, Python >= 3.8. Usage: check_links.py <file|dir>...
Prints "links OK (<n> files)", or "ERROR: <file>:<line>: broken link|anchor <target>" lines and exits 1.
"""
import functools
import re
import sys
from pathlib import Path

LINK = re.compile(r"(!?)\[[^\]]*\]\(([^)#\s]+)(#[^)]*)?\)")
ANCHOR = re.compile(r"\[[^\]]*\]\(([^)#\s]*)#([^)\s]+)\)")
EXTERNAL = re.compile(r"^([a-z]+://|mailto:)")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")


def prose_lines(path):
    """(line number, line) outside fenced code blocks."""
    in_code = False
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.lstrip().startswith("```"):
            in_code = not in_code
            continue
        if not in_code:
            yield n, line


@functools.lru_cache(maxsize=None)
def heading_slugs(path):
    """GitHub-style anchors of a markdown file's headings; repeats get -1, -2, ..."""
    slugs, seen = set(), {}
    for _, line in prose_lines(Path(path)):
        m = HEADING.match(line)
        if not m:
            continue
        slug = re.sub(r"[^\w\- ]", "", m.group(1).lower()).replace(" ", "-")
        n = seen.get(slug, 0)
        seen[slug] = n + 1
        slugs.add(slug if n == 0 else "{}-{}".format(slug, n))
    return frozenset(slugs)


def link_errors(path, line):
    errs = []
    for m in LINK.finditer(line):
        target = m.group(2)
        if not EXTERNAL.match(target) and not (path.parent / target).exists():
            errs.append("broken {} {}".format("image" if m.group(1) else "link", target))
    for m in ANCHOR.finditer(line):
        target, anchor = m.groups()
        if EXTERNAL.match(target):
            continue
        dest = path.parent / target if target else path
        if dest.suffix == ".md" and dest.exists() and anchor not in heading_slugs(str(dest.resolve())):
            errs.append("broken anchor {}#{}".format(target, anchor))
    return errs


def markdown_files(args):
    files = []
    for arg in args:
        path = Path(arg)
        files.extend(sorted(path.rglob("*.md")) if path.is_dir() else [path])
    return files


def main(argv):
    if not argv:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    missing = [a for a in argv if not Path(a).exists()]
    files = markdown_files(a for a in argv if a not in missing)
    errs = ["{}: no such file or directory".format(a) for a in missing]
    errs += ["{}:{}: {}".format(f, n, e) for f in files for n, line in prose_lines(f) for e in link_errors(f, line)]
    for e in errs:
        print("ERROR: {}".format(e))
    if errs:
        return 1
    print("links OK ({} files)".format(len(files)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
