"""Shared helpers of the mvp-sdlc scripts, bin commands and hooks. Stdlib only, Python >= 3.8."""
import importlib.machinery
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent

# The addendum reuses the project-name regex for feature slugs; always match with fullmatch.
SLUG_RE = re.compile(r"[a-z0-9]{2,16}")

# Feature stages in order; stages in one tuple share a rank.
STAGES = (
    ("idea",),
    ("accepted",),
    ("researched", "briefed"),
    ("prd",),
    ("architecture",),
    ("contracts",),
    ("tasks",),
    ("in-progress",),
    ("review",),
    ("shipped",),
    ("measured",),
)
STAGE_RANK = {stage: rank for rank, group in enumerate(STAGES) for stage in group}

FEATURES_DIR = Path("docs") / "features"


def valid_slug(value):
    return isinstance(value, str) and SLUG_RE.fullmatch(value) is not None


def feature_dir(root, slug):
    return Path(root) / FEATURES_DIR / slug


def frontmatter_bounds(lines):
    """(opening, closing) line indexes of the frontmatter block, or None. Blank lines and one-line HTML comments may
    precede it (the course ADR template starts with a comment)."""
    start = 0
    while start < len(lines) and (not lines[start].strip() or re.fullmatch(r"\s*<!--.*-->\s*", lines[start])):
        start += 1
    if start >= len(lines) or lines[start].strip() != "---":
        return None
    for index in range(start + 1, len(lines)):
        if lines[index].strip() == "---":
            return start, index
    return None


def frontmatter(text):
    """Top-level `key: value` pairs of the frontmatter; values unquoted, trailing `# ...` comments dropped."""
    lines = text.splitlines()
    bounds = frontmatter_bounds(lines)
    if bounds is None:
        return {}
    meta = {}
    for line in lines[bounds[0] + 1:bounds[1]]:
        match = re.match(r"^([\w-]+):\s*(.*)$", line)
        if match:
            value = re.sub(r"\s+#.*$", "", match.group(2)).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            meta[match.group(1)] = value
    return meta


def run(args, cwd=None, input_text=None):
    return subprocess.run(
        args,
        cwd=None if cwd is None else str(cwd),
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )


def git(cwd, *args):
    """stdout of a git command (stripped), or None when it fails."""
    result = run(["git", "-C", str(cwd)] + list(args))
    return result.stdout.strip() if result.returncode == 0 else None


def repo_root(cwd="."):
    top = git(cwd, "rev-parse", "--show-toplevel")
    return Path(top) if top else None


def base_branch(root, environ):
    if environ.get("SDLC_BASE_BRANCH"):
        return environ["SDLC_BASE_BRANCH"]
    head = git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if head and head.startswith("origin/"):
        return head[len("origin/"):]
    return "main"


def load_script(rel):
    """Import a plugin script by path relative to the plugin dir (hyphenated names and extension-less bin files)."""
    path = PLUGIN_DIR / rel
    name = "mvp_sdlc_" + re.sub(r"\W", "_", path.name)
    if name in sys.modules:
        return sys.modules[name]
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    loader.exec_module(module)
    return module
