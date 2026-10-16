#!/usr/bin/env python3
"""Check the SDLC process docs: every reference exists, planned items say so, English only, required structure.

docs/sdlc/*.md get every rule; templates/github/*.md get the content rules (references, confirm words, language).
Content rules: each /sdlc:<skill>, /sdlc-<skill> and /mvp-sdlc:<skill> is a skill of the vendored plugins; each
path-like word in code (bin/, scripts/, deploy/, hooks/, .github/, *.sh, *.py, *.yml, *.yaml) is a file of this
repository, or is registered in ELSEWHERE (another repository) or PLANNED (a later run); a line that names a PLANNED
item says "planned" and the run; typed confirm words are registered in CONFIRMS; no Cyrillic; no srv/ws2.
Structure: H1 first line; README.md links every file; 00-operator.md has its seven sections in order; every numbered
section except the infrastructure references cites a course lesson M<n>.<n>; every decision R-C1..R-C14 is mentioned;
every mvp-sdlc skill, command, script and hook and every course skill is mentioned somewhere.
Stdlib only, Python >= 3.8. Usage: check_docs.py [--repo DIR]
Prints "docs OK (<n> files)", or "ERROR: <file>:<line>: <reason>" lines and exits 1.
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

# Verified with `gh api repos/OlegShevtsov1/<repo>/contents/<path> --jq .name` before being added; re-verified after merge.
ELSEWHERE = {
    "kamal-deploy.yml": "1_mvp_pilot_be, 1_mvp_pilot_fe: .github/workflows/kamal-deploy.yml",
    "kamal-manage.yml": "1_mvp_pilot_be, 1_mvp_pilot_fe: .github/workflows/kamal-manage.yml",
    "dev-deploy.yml": "1_mvp_pilot_be, 1_mvp_pilot_fe: .github/workflows/dev-deploy.yml",
    "deploy/deploy.sh": "1_mvp_pilot_be, 1_mvp_pilot_fe: deploy/deploy.sh",
    "deploy/rollback.sh": "1_mvp_pilot_be, 1_mvp_pilot_fe: deploy/rollback.sh",
    "rails-test.yml": "1_mvp_pilot_be: .github/workflows/rails-test.yml",
    "rails-lint.yml": "1_mvp_pilot_be: .github/workflows/rails-lint.yml",
    "front-ci.yml": "1_mvp_pilot_fe: .github/workflows/front-ci.yml",
    "tdd-check.yml": "1_mvp_pilot_be, 1_mvp_pilot_fe: .github/workflows/tdd-check.yml",
    "develop-guard.yml": "1_mvp_pilot_be, 1_mvp_pilot_fe: .github/workflows/develop-guard.yml",
    "pr-conventions-check.yml": "1_mvp_pilot_be, 1_mvp_pilot_fe: .github/workflows/pr-conventions-check.yml",
    "project-e2e.sh": "1_mvp_infra: tests/e2e/project-e2e.sh",
    "vpnctl project list": "1_mvp_infra: bin/vpnctl",
    "vpnctl project show": "1_mvp_infra: bin/vpnctl",
}
# token -> (run that delivers it, path in this repository or None). A line naming one must say "planned" and the run.
PLANNED = {
    "factory-deliver": ("C2", None),
    "release.yml": ("C4", None),
    "next-version.sh": ("C4", None),
    "release-watch": ("C4", None),
    "bin/sdlc-metrics": ("C4", None),
    "bin/render-template": ("S4", "bin/render-template"),
    "bin/project-add": ("S5", "bin/project-add"),
    "vpnctl project add": ("P2", None),
    "vpnctl project bootstrap": ("P2", None),
    "vpnctl project delegate": ("P2", None),
    "vpnctl project remove": ("P2", None),
}
# Typed confirm word -> None (exists today) or the run that delivers it (same "planned" rule as PLANNED).
CONFIRMS = {
    "confirm=prod": None,
    "confirm=remove-prod": None,
    "DELEGATE-<name>": "P2",
}
OPERATOR_SECTIONS = (
    "## 1. One-time setup",
    "## 2. A new project",
    "## 3. One feature, by size (XS, S, M+)",
    "## 4. Frontend: spec copies with sync-spec",
    "## 5. Hotfix and rollback",
    "## 6. Metrics once per release",
    "## 7. Rules you never break",
)
DECISIONS = tuple("R-C{}".format(n) for n in range(1, 15))
NO_LESSON_NEEDED = "12-infrastructure-references.md"

SKILL_REFS = (
    (re.compile(r"/sdlc:([a-z0-9-]+)"), "plugins/sdlc/skills", "/sdlc:"),
    (re.compile(r"(?<![\w-])/sdlc-([a-z0-9-]+)"), "plugins/sdlc/skills", "/sdlc-"),
    (re.compile(r"/mvp-sdlc:([a-z0-9-]+)"), "plugins/mvp-sdlc/skills", "/mvp-sdlc:"),
)
CODE_SPAN = re.compile(r"`([^`]+)`")
PATH_PREFIXES = ("bin/", "scripts/", "deploy/", "hooks/", ".github/")
PATH_SUFFIXES = (".sh", ".py", ".yml", ".yaml")
CONFIRM_WORD = re.compile(r"confirm=[^\s`'\")|,;]+|\b[A-Z]{2,}-(?:<name>|prod\b)")
CYRILLIC = re.compile("[Ѐ-ӿ]")
BANNED = re.compile(r"\b(srv|ws2)\b")
LESSON = re.compile(r"\bM\d+\.\d+\b")
NUMBERED = re.compile(r"^\d\d-.*\.md$")


def tracked_files(repo):
    out = subprocess.run(
        ["git", "-C", str(repo), "ls-files", "--cached", "--others", "--exclude-standard"],
        stdout=subprocess.PIPE,
        universal_newlines=True,
        check=True,
    ).stdout
    return out.splitlines()


def mentions(name, text):
    return re.search(r"(?<![\w-]){}(?![\w-])".format(re.escape(name)), text) is not None


def planned_rule(line, run):
    return re.search(r"\bplanned\b", line, re.I) is not None and mentions(run, line)


class Checker:
    def __init__(self, repo):
        self.repo = repo
        self.basenames = {Path(f).name for f in tracked_files(repo)}

    def resolves(self, word):
        word = word.rstrip("/")
        if (self.repo / word).exists() or (self.repo / "plugins/mvp-sdlc" / word).exists():
            return True
        return Path(word).name in self.basenames

    def registry_error(self, line, key):
        run, path = PLANNED[key]
        if path is not None and (self.repo / path).exists():
            return "planned {} ({}) now exists; update the docs and the registry".format(key, run)
        if not planned_rule(line, run):
            return "{} is not shipped yet: say 'planned' and '{}' on the same line".format(key, run)
        return None

    def code_errors(self, line, code):
        """Errors for one piece of code (an inline span or a fenced line)."""
        errs = []
        named = set()
        for key in list(PLANNED) + list(ELSEWHERE):
            if code == key or re.match(r"{}(?![\w-])".format(re.escape(key)), code):
                named.add(key)
        for word in code.split():
            word = word.lstrip("'\"([").rstrip("'\")[],;:.")
            if not word or any(c in word for c in "<{*$=") or word in named:
                continue
            if word in PLANNED or word in ELSEWHERE:
                named.add(word)
            elif (word.startswith(PATH_PREFIXES) or word.endswith(PATH_SUFFIXES)) and not self.resolves(word):
                errs.append("unknown reference {} (not in this repository, ELSEWHERE or PLANNED)".format(word))
        errs += [e for e in (self.registry_error(line, k) for k in sorted(named) if k in PLANNED) if e]
        return errs

    def line_errors(self, line, code_pieces):
        errs = []
        for pattern, skills_dir, prefix in SKILL_REFS:
            for name in pattern.findall(line):
                if not (self.repo / skills_dir / name / "SKILL.md").is_file():
                    errs.append("unknown skill {}{}".format(prefix, name))
        for code in code_pieces:
            errs += self.code_errors(line, code)
        for word in CONFIRM_WORD.findall(line):
            if word not in CONFIRMS:
                errs.append("unregistered confirm word {}".format(word))
            elif CONFIRMS[word] and not planned_rule(line, CONFIRMS[word]):
                errs.append("{} is not shipped yet: say 'planned' and '{}' on the same line".format(word, CONFIRMS[word]))
        if CYRILLIC.search(line):
            errs.append("Cyrillic text (the docs are English only, R-C14)")
        for word in BANNED.findall(line):
            errs.append("banned word '{}' (internal profile or host name)".format(word))
        return errs

    def content_errors(self, path, rel):
        errs = []
        in_code = False
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.lstrip().startswith("```"):
                in_code = not in_code
                continue
            pieces = [line.strip()] if in_code else CODE_SPAN.findall(line)
            errs += ["{}:{}: {}".format(rel, n, e) for e in self.line_errors(line, pieces)]
        return errs


def structure_errors(texts):
    errs = []
    for name, text in texts.items():
        rel = "docs/sdlc/{}".format(name)
        if not text.startswith("# "):
            errs.append("{}:1: first line must be an H1 heading ('# ...')".format(rel))
        if NUMBERED.match(name) and name != NO_LESSON_NEEDED and not LESSON.search(text):
            errs.append("{}: cites no course lesson M<n>.<n>".format(rel))
    readme = texts.get("README.md")
    if readme is None:
        errs.append("docs/sdlc/README.md: missing")
    else:
        errs += ["docs/sdlc/README.md: does not link {}".format(n) for n in texts if n != "README.md" and "({})".format(n) not in readme]
    operator = texts.get("00-operator.md")
    if operator is None:
        errs.append("docs/sdlc/00-operator.md: missing")
    else:
        headings = [line.rstrip() for line in operator.splitlines() if line.startswith("## ")]
        pos = 0
        for section in OPERATOR_SECTIONS:
            if section in headings[pos:]:
                pos = headings.index(section, pos) + 1
            else:
                errs.append("docs/sdlc/00-operator.md: section '{}' missing or out of order".format(section))
    everything = "\n".join(texts.values())
    errs += ["docs/sdlc: decision {} is not mentioned".format(d) for d in DECISIONS if not mentions(d, everything)]
    return errs


def coverage_errors(repo, texts):
    """Every part of the mvp-sdlc plugin and every course skill is described somewhere in docs/sdlc."""
    sources = (
        ("plugins/mvp-sdlc/skills", lambda p: p.is_dir(), lambda p: p.name),
        ("plugins/mvp-sdlc/bin", lambda p: p.is_file(), lambda p: p.name),
        ("plugins/mvp-sdlc/scripts", lambda p: p.suffix == ".py" and not p.name.startswith("test_"), lambda p: p.name),
        ("plugins/mvp-sdlc/hooks", lambda p: p.suffix == ".sh", lambda p: p.stem),
        ("plugins/sdlc/skills", lambda p: p.is_dir() and p.name != "_shared", lambda p: p.name),
    )
    errs, names = [], set()
    for rel, wanted, name in sources:
        if not (repo / rel).is_dir():
            errs.append("{}: directory missing; reverse coverage cannot be checked".format(rel))
            continue
        names |= {name(p) for p in (repo / rel).iterdir() if wanted(p)}
    everything = "\n".join(texts.values())
    return errs + ["docs/sdlc: {} is not described".format(n) for n in sorted(names) if not mentions(n, everything)]


def main(argv):
    parser = argparse.ArgumentParser(description="Check the SDLC process docs.")
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parent.parent))
    repo = Path(parser.parse_args(argv).repo).resolve()
    doc_files = sorted((repo / "docs" / "sdlc").glob("*.md"))
    template_files = sorted((repo / "templates" / "github").glob("*.md"))
    checker = Checker(repo)
    errs = []
    for path in doc_files + template_files:
        errs += checker.content_errors(path, path.relative_to(repo).as_posix())
    texts = {p.name: p.read_text(encoding="utf-8") for p in doc_files}
    errs += structure_errors(texts)
    errs += coverage_errors(repo, texts)
    for e in errs:
        print("ERROR: {}".format(e))
    if errs:
        return 1
    print("docs OK ({} files)".format(len(doc_files) + len(template_files)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
