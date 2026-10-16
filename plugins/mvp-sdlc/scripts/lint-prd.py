#!/usr/bin/env python3
"""Lint PRD §5 Acceptance criteria for technical tokens (HTTP codes, API paths, SQL, table names).

Only the §5 section is checked; HTML comments and fenced code inside it are skipped (the course template's own §5
comment lists forbidden examples). Usage: lint-prd.py <PRD.md>
Exit 0 clean, 1 findings (one `<file>:<line>: <reason>` line each), 2 unusable input.
"""
import re
import sys

SECTION_START = re.compile(r"^## +(5\.|.*acceptance criteria)", re.IGNORECASE)
IDENTIFIER = r"(`[A-Za-z_][\w.]*`|\b[a-z][a-z0-9]*_[a-z0-9_]+\b)"
RULES = (
    ("HTTP code", re.compile(r"\b[1-5]\d{2}\b"), re.compile(r"status|code", re.IGNORECASE)),
    ("API path", re.compile(r"/api/"), None),
    ("HTTP verb + path", re.compile(r"\b(?:GET|POST|PUT|PATCH|DELETE) /"), None),
    ("SQL keyword", re.compile(r"\b(?:SELECT|INSERT|UPDATE|DELETE FROM|WHERE)\b"), None),
    ("table name", re.compile(IDENTIFIER + r"\s+tables?\b|\btables?\s+" + IDENTIFIER), None),
)


def keep_newlines(match):
    return "\n" * match.group(0).count("\n")


def acceptance_section(lines):
    """(first line number, lines) of §5 with comments and fenced code blanked, or None when there is no §5."""
    start = next((i for i, line in enumerate(lines) if SECTION_START.match(line)), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    text = "\n".join(lines[start:end])
    text = re.sub(r"<!--.*?-->", keep_newlines, text, flags=re.S)
    text = re.sub(r"^(```|~~~).*?^\1[^\n]*$", keep_newlines, text, flags=re.S | re.M)
    return start + 1, text.split("\n")


def lint(path):
    """[(line number, reason)] for the PRD at `path`; raises OSError when it cannot be read."""
    with open(path, encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    section = acceptance_section(lines)
    if section is None:
        return [(1, "no §5 Acceptance criteria section")]
    first, body = section
    findings = []
    for offset, line in enumerate(body):
        for reason, pattern, context in RULES:
            tokens = [m.group(0).strip() for m in pattern.finditer(line)]
            if tokens and (context is None or context.search(line)):
                findings.append((first + offset, "{} ({})".format(reason, ", ".join(tokens))))
    return findings


def main(argv):
    if len(argv) != 1:
        print("usage: lint-prd.py <PRD.md>", file=sys.stderr)
        return 2
    try:
        findings = lint(argv[0])
    except (OSError, UnicodeDecodeError) as exc:
        print("lint-prd: cannot read {}: {}".format(argv[0], exc), file=sys.stderr)
        return 2
    for number, reason in findings:
        print("{}:{}: {}".format(argv[0], number, reason))
    if findings:
        return 1
    print("lint-prd: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
