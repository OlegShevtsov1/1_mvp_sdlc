#!/usr/bin/env python3
"""Read and advance docs/features/<slug>/state.json, the feature's machine state. Only scripts write this file.

Usage: feature-state.py [--root DIR] get <slug>
       feature-state.py [--root DIR] set <slug> <stage> --evidence <evidence>
Evidence: an https:// URL, an existing file, exit:<int>, or <tool>:<detail> for a tool in EVIDENCE_TOOLS.
Optional keys trello_card_id_short (the card number) and trello_card_title feed the pull request title.
Exit 0 on success, 1 on any refusal (the reason goes to stderr).
"""
import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import sdlc_common  # noqa: E402

SCHEMA_VERSION = 1
EVIDENCE_TOOLS = ("sdlc-gate", "feature-start", "factory-deliver", "release", "sdlc-metrics")


class StateError(Exception):
    pass


def state_path(root, slug):
    if not sdlc_common.valid_slug(slug):
        raise StateError("invalid slug {!r}: must match {}".format(slug, sdlc_common.SLUG_RE.pattern))
    return sdlc_common.feature_dir(root, slug) / "state.json"


def check_evidence(root, evidence):
    if re.fullmatch(r"https://\S+", evidence) or re.fullmatch(r"exit:-?\d+", evidence):
        return
    tool = re.fullmatch(r"([a-z-]+):(\S.*)", evidence)
    if tool and tool.group(1) in EVIDENCE_TOOLS:
        return
    path = Path(evidence)
    if evidence and (path if path.is_absolute() else Path(root) / path).is_file():
        return
    raise StateError(
        "unusable evidence {!r}: give an https:// URL, an existing file, exit:<int> or <tool>:<detail> "
        "with tool one of {}".format(evidence, ", ".join(EVIDENCE_TOOLS))
    )


def check_stage(stage):
    if stage not in sdlc_common.STAGE_RANK:
        raise StateError("unknown stage {!r}; stages: {}".format(stage, ", ".join(sdlc_common.STAGE_RANK)))


def valid_card_number(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def read(root, slug):
    path = state_path(root, slug)
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        raise StateError("{} not found".format(path.relative_to(root)))
    except ValueError as exc:
        raise StateError("{} is not valid JSON: {}".format(path.relative_to(root), exc))
    valid = (
        isinstance(state, dict)
        and state.get("schema_version") == SCHEMA_VERSION
        and state.get("slug") == slug
        and state.get("stage") in sdlc_common.STAGE_RANK
        and (state.get("trello_card_id") is None or isinstance(state.get("trello_card_id"), str))
        and (state.get("trello_card_id_short") is None or valid_card_number(state.get("trello_card_id_short")))
        and (state.get("trello_card_title") is None or isinstance(state.get("trello_card_title"), str))
        and isinstance(state.get("history"), list)
    )
    if not valid:
        raise StateError("{} does not follow schema_version {}".format(path.relative_to(root), SCHEMA_VERSION))
    return state


def write(path, state):
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".state.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(state, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, str(path))


def history_entry(stage, evidence):
    return {"stage": stage, "evidence": evidence, "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}


def init(root, slug, trello_card_id, evidence, card_id_short=None, card_title=None):
    path = state_path(root, slug)
    check_evidence(root, evidence)
    if path.exists():
        raise StateError("{} already exists".format(path.relative_to(root)))
    path.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "schema_version": SCHEMA_VERSION,
        "slug": slug,
        "stage": "idea",
        "trello_card_id": trello_card_id,
        "trello_card_id_short": card_id_short,
        "trello_card_title": card_title,
        "history": [history_entry("idea", evidence)],
    }
    write(path, state)
    return state


def advance(root, slug, stage, evidence):
    """Move forward to `stage`; True when written, False when already at or past it."""
    check_stage(stage)
    check_evidence(root, evidence)
    state = read(root, slug)
    if sdlc_common.STAGE_RANK[stage] <= sdlc_common.STAGE_RANK[state["stage"]]:
        return False
    state["stage"] = stage
    state["history"].append(history_entry(stage, evidence))
    write(state_path(root, slug), state)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, help="app repository root (default: git top-level of the cwd)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("get").add_argument("slug")
    setter = commands.add_parser("set")
    setter.add_argument("slug")
    setter.add_argument("stage")
    setter.add_argument("--evidence")
    args = parser.parse_args(argv)
    root = args.root.resolve() if args.root else sdlc_common.repo_root()
    try:
        if root is None:
            raise StateError("not inside a git repository; pass --root")
        if args.command == "get":
            print(json.dumps(read(root, args.slug), indent=2, sort_keys=True))
            return 0
        if args.evidence is None:
            raise StateError("set needs --evidence <evidence>")
        check_stage(args.stage)
        current = read(root, args.slug)["stage"]
        if sdlc_common.STAGE_RANK[args.stage] < sdlc_common.STAGE_RANK[current]:
            raise StateError("refusing to move {} backwards from {} to {}".format(args.slug, current, args.stage))
        if advance(root, args.slug, args.stage, args.evidence):
            print("feature-state: {} {} -> {}".format(args.slug, current, args.stage))
        else:
            print("feature-state: {} already at {}".format(args.slug, current))
        return 0
    except StateError as exc:
        print("feature-state: {}".format(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
