"""Shared helpers of the mvp-sdlc scripts, bin commands and hooks. Stdlib only, Python >= 3.8."""
import importlib.machinery
import importlib.util
import json
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
FACTORY_PROFILE = Path(".archon") / "factory-profile.yaml"

# Decision 53: the board lists in flow order; a project renames them under `trello.lists` in the factory profile,
# with the keys the factory reads.
BOARD_LISTS = (
    ("backlog", "Backlog"),
    ("ready", "Ready"),
    ("in_progress", "In Progress"),
    ("review", "Review"),
    ("test", "Test"),
    ("blocked", "Blocked"),
    ("ready_to_release", "Ready to Release"),
    ("test_after_release", "Test after Release"),
    ("done", "Done"),
)
BOARD_KEYS = tuple(key for key, _ in BOARD_LISTS)
PAST_READY = BOARD_KEYS[BOARD_KEYS.index("ready") + 1:]


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


def yaml_scalar(value):
    """A YAML block-style scalar: double-quoted (JSON escapes), single-quoted, or plain with a `# ...` comment."""
    value = value.strip()
    if value.startswith('"'):
        return json.loads(value[:value.rindex('"') + 1])
    if value.startswith("'"):
        return value[1:value.rindex("'")].replace("''", "'")
    return re.sub(r"\s+#.*$", "", value).strip()


def yaml_block(lines, header):
    """The lines indented under the first line matching `header`, up to the next line at its indentation or less."""
    for index, line in enumerate(lines):
        match = re.match(header, line)
        if match:
            indent = len(match.group(1))
            block = []
            for inner in lines[index + 1:]:
                if not inner.strip() or inner.lstrip().startswith("#"):
                    continue
                if len(inner) - len(inner.lstrip()) <= indent:
                    break
                block.append(inner)
            return block
    return []


def board_lists(root):
    """{key: list name} of BOARD_LISTS with the renames under `trello.lists` in the repo's factory profile.
    A missing or unreadable profile, an unknown key, an empty value or a flow-style map keeps the default."""
    lists = dict(BOARD_LISTS)
    try:
        lines = (Path(root) / FACTORY_PROFILE).read_text(encoding="utf-8").splitlines()
    except (OSError, ValueError):
        return lists
    trello = yaml_block(lines, r"^()trello:\s*(#.*)?$")
    for line in yaml_block(trello, r"^(\s+)lists:\s*(#.*)?$"):
        match = re.match(r"^\s+([a-z_]+):\s*(.*)$", line)
        if not match or match.group(1) not in lists:
            continue
        try:
            name = yaml_scalar(match.group(2)).strip()
        except ValueError:
            continue
        if name:
            lists[match.group(1)] = name
    return lists


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
