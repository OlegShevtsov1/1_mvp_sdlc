#!/usr/bin/env python3
"""Logic of every mvp-sdlc hook. Usage: guards.py <hook>, with the Claude Code hook event JSON on stdin.

Exit 0 allows the tool call or prompt; exit 2 blocks it and the reason on stderr is shown to the model and the user.
A hook that only warns (check-branch-name) exits 0 and prints a JSON `systemMessage` and `additionalContext` on
stdout. An empty, `{}` or non-JSON event is allowed. These are best-effort command-line parsers, not a sandbox: deny
rules, main-guard and branch protection are the other layers.
"""
import json
import os
import re
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import sdlc_common  # noqa: E402

PROTECTED_BRANCHES = {"main", "master"}
SHELLS = {"bash", "sh", "zsh"}
WRAPPERS = {"command", "exec", "nohup", "time", "sudo"}
# Shell keywords that may precede a command in one segment (`then git push`, `do rm x`, `if git tag -d v1`).
KEYWORDS = {"if", "then", "else", "elif", "while", "until", "do", "!", "{"}
# Segments starting with these list values (`for f in a b`), they run nothing themselves.
LIST_HEADERS = {"for", "select", "case"}
SEPARATOR_CHARS = set(";&|()")
GIT_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
PUSH_OPTIONS_WITH_VALUE = {"--repo", "-o", "--push-option", "--receive-pack", "--exec"}
SECRET_EXAMPLE_SUFFIXES = {"example", "sample", "template"}
STATE_PATH = re.compile(r"(^|/)docs/features/[^/]+/state\.json$")
STATE_READERS = {"cat", "head", "tail", "less", "jq", "grep", "wc", "git", "diff"}
VERSION_TAG = re.compile(r"v?\d+(\.\d+)+([-+.][\w.]+)?")
# App-repository branch names (decision 24); factory branches are exempt (decision 26).
BRANCH_NAME = re.compile(r"(feature|hotfix)/PILOT-[0-9]+-[a-z0-9-]+")
FACTORY_BRANCH_PREFIX = "archon/task-factory-"
BRANCH_CREATE_OPTIONS = {"-f", "--force", "-t", "--track", "--no-track", "-q", "--quiet"}
CREATE_FLAGS = {"checkout": {"-b", "-B"}, "switch": {"-c", "-C", "--create", "--force-create"}}
# Course skills whose phase order bin/sdlc-gate enforces, and the phase each one starts.
GATED_SKILLS = {
    "write-prd": "prd",
    "architecture-design": "architecture",
    "decide-adr": "adr",
    "api-forge": "contracts",
    "break-tasks": "tasks",
    "ship-feature": "ship",
}
GATED_PROMPT = re.compile(r"\s*/sdlc[:-]({})(?:\s+(.*))?\Z".format("|".join(GATED_SKILLS)), re.S)


class Blocked(Exception):
    pass


# ---------------------------------------------------------------- shell parsing


def tokenize(command):
    lexer = shlex.shlex(command.replace("\n", ";"), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return command.split()


def is_separator(token):
    return bool(token) and set(token) <= SEPARATOR_CHARS


def is_redirect(token):
    return bool(token) and ">" in token and set(token) <= set("<>&|")


def segments(command, depth=0):
    """Simple commands of a command line as (words, redirect targets, input-redirect sources); `sh -c <script>` is
    expanded recursively."""
    result = []
    current = []
    for token in tokenize(command) + [";"]:
        if is_separator(token):
            if current:
                result.extend(simple_command(current, depth))
            current = []
        else:
            current.append(token)
    return result


def simple_command(tokens, depth):
    words, targets, sources = [], [], []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if is_redirect(token):
            if index + 1 < len(tokens):
                targets.append(tokens[index + 1])
            index += 2
            continue
        if "<" in token and set(token) <= set("<>&|"):
            if index + 1 < len(tokens):
                sources.append(tokens[index + 1])
            index += 2
            continue
        words.append(token)
        index += 1
    words = strip_prefix(words)
    if words and os.path.basename(words[0]) in SHELLS and depth < 5:
        for position, word in enumerate(words[1:], 1):
            if re.fullmatch(r"-[a-z]*c[a-z]*", word) and position + 1 < len(words):
                return [(words, targets, sources)] + segments(words[position + 1], depth + 1)
    return [(words, targets, sources)]


def strip_prefix(words):
    """Drop leading VAR=value assignments, `env [-i] [-u NAME]`, wrappers such as `command` and shell keywords."""
    index = 0
    while index < len(words):
        word = words[index]
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", word) or word in WRAPPERS or word in KEYWORDS:
            index += 1
        elif word == "env":
            index += 1
            while index < len(words) and words[index].startswith("-"):
                index += 2 if words[index] in ("-u", "--unset") else 1
        else:
            break
    return words[index:]


def git_command(words, cwd):
    """(subcommand, args, git cwd) when `words` run git, else None."""
    if not words or os.path.basename(words[0]) != "git":
        return None
    index = 1
    while index < len(words) and words[index].startswith("-"):
        option = words[index]
        if option == "-C" and index + 1 < len(words):
            cwd = os.path.join(cwd, words[index + 1])
        index += 2 if option in GIT_OPTIONS_WITH_VALUE else 1
    if index >= len(words):
        return None
    return words[index], words[index + 1:], cwd


def git_commands(event):
    cwd = event_cwd(event)
    for words, _, _ in segments(bash_command(event)):
        invocation = git_command(words, cwd)
        if invocation:
            yield invocation


def push_arguments(args):
    """(flags, positionals) of `git push`; option values are skipped."""
    flags, positionals = [], []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in PUSH_OPTIONS_WITH_VALUE:
            index += 2
            continue
        if arg.startswith("-") and arg != "-":
            flags.append(arg)
        else:
            positionals.append(arg)
        index += 1
    return flags, positionals


def new_branch_names(subcommand, args):
    """Branch names that `git checkout -b`, `git switch -c` or a plain `git branch <name>` would create."""
    if subcommand in CREATE_FLAGS:
        names = []
        for index, arg in enumerate(args):
            option, _, value = arg.partition("=")
            if option.startswith("--") and value and option in CREATE_FLAGS[subcommand]:
                names.append(value)
            elif arg in CREATE_FLAGS[subcommand] and index + 1 < len(args):
                names.append(args[index + 1])
        return names
    if subcommand == "branch":
        options = [a for a in args if a.startswith("-")]
        positionals = [a for a in args if not a.startswith("-")]
        if positionals and all(o in BRANCH_CREATE_OPTIONS or o.startswith("--track=") for o in options):
            return positionals[:1]
    return []


# ---------------------------------------------------------------- event access


def bash_command(event):
    if event.get("tool_name") != "Bash":
        return ""
    command = (event.get("tool_input") or {}).get("command")
    return command if isinstance(command, str) else ""


def event_cwd(event):
    cwd = event.get("cwd")
    return cwd if isinstance(cwd, str) and cwd else os.getcwd()


def tool_paths(event, keys):
    tool_input = event.get("tool_input") or {}
    return [tool_input[k] for k in keys if isinstance(tool_input.get(k), str) and tool_input[k]]


# ---------------------------------------------------------------- hooks


def block_main_push(event):
    for subcommand, args, cwd in git_commands(event):
        if subcommand != "push":
            continue
        flags, positionals = push_arguments(args)
        if "--all" in flags or "--mirror" in flags or "--branches" in flags:
            raise Blocked("git push {} would update main. Push only your feature branch.".format(flags[0]))
        branch = sdlc_common.git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
        refspecs = positionals[1:]
        if not refspecs:
            upstream = sdlc_common.git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") or ""
            if branch in PROTECTED_BRANCHES or upstream.split("/", 1)[-1] in PROTECTED_BRANCHES:
                raise Blocked(
                    "plain git push from branch {} (upstream {}) would update a protected branch. Create a "
                    "feature branch and push it with git push -u origin <branch>.".format(branch, upstream or "none")
                )
            continue
        for refspec in refspecs:
            spec = refspec.lstrip("+")
            destination = re.sub(r"^refs/heads/", "", spec.split(":", 1)[-1])
            if destination == "HEAD":
                destination = branch or ""
            if destination in PROTECTED_BRANCHES:
                raise Blocked(
                    "git push {} targets the protected branch {}. Changes reach main only through a merged pull "
                    "request.".format(refspec, destination)
                )


def is_tag_ref(name, cwd):
    if name.startswith("refs/tags/"):
        return True
    name = re.sub(r"^refs/heads/", "", name)
    if VERSION_TAG.fullmatch(name):
        return True
    return sdlc_common.git(cwd, "rev-parse", "--verify", "-q", "refs/tags/" + name) is not None


def block_destructive_git(event):
    for subcommand, args, cwd in git_commands(event):
        if subcommand == "push":
            flags, positionals = push_arguments(args)
            forced = [f for f in flags if f.startswith(("--force", "--mirror")) or re.fullmatch(r"-[a-z]*f[a-z]*", f)]
            if forced or any(p.startswith("+") for p in positionals[1:]):
                raise Blocked(
                    "force push rewrites published history. Push a new commit instead (git revert for undo)."
                )
            deleting = "--delete" in flags or "-d" in flags
            if deleting and len(positionals) < 2:
                raise Blocked("git push --delete needs an explicit remote and branch; published tags are never deleted.")
            for refspec in positionals[1:]:
                target = refspec[1:] if refspec.startswith(":") else refspec
                if (deleting or refspec.startswith(":")) and is_tag_ref(target, cwd):
                    raise Blocked(
                        "deleting the published tag {} breaks releases built from it. Tags are immutable; "
                        "publish a new version instead.".format(target)
                    )
        elif subcommand == "reset" and "--hard" in args:
            raise Blocked("git reset --hard discards work. Use git stash push -m <tag>, or git reset --soft/--mixed.")
        elif subcommand == "tag" and {"-d", "--delete", "-f", "--force"} & set(args):
            raise Blocked("deleting or moving a tag rewrites a published release. Tags are immutable.")


def is_secret_path(value):
    path = value.strip().rstrip("/")
    name = os.path.basename(path)
    if name == ".env":
        return True
    if name.startswith(".env.") and name[len(".env."):] not in SECRET_EXAMPLE_SUFFIXES:
        return True
    normalized = "/" + path.lstrip("./") if not path.startswith("/") else path
    return normalized.endswith("/config/master.key") or re.search(r"/config/credentials[^/]*(/|$)", normalized) is not None


def block_env(event):
    tool = event.get("tool_name")
    if tool in ("Read", "Edit", "MultiEdit", "Write", "Grep"):
        candidates = tool_paths(event, ("file_path", "path"))
    elif tool == "Bash":
        candidates = []
        for words, targets, sources in segments(bash_command(event)):
            for word in words[1:] + targets + sources:
                candidates.extend([word, word.split("=", 1)[-1]])
    else:
        return
    for candidate in candidates:
        if is_secret_path(candidate):
            raise Blocked(
                "{} holds secrets and is never read or written by the agent. Ask the user for anything that "
                "needs a real value.".format(candidate)
            )


def block_state_edit(event):
    message = (
        "{} is written only by scripts: use scripts/feature-state.py set <slug> <stage> --evidence <evidence> "
        "(or bin/sdlc-gate, bin/feature-start)."
    )
    tool = event.get("tool_name")
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        for path in tool_paths(event, ("file_path", "notebook_path")):
            if STATE_PATH.search(path):
                raise Blocked(message.format(path))
    elif tool == "Bash":
        for words, targets, _ in segments(bash_command(event)):
            for target in targets:
                if STATE_PATH.search(target):
                    raise Blocked(message.format(target))
            mentioned = [w for w in words[1:] if STATE_PATH.search(w)]
            if mentioned and os.path.basename(words[0]) not in STATE_READERS | LIST_HEADERS:
                raise Blocked(message.format(mentioned[0]))


def check_branch_name(event):
    for subcommand, args, _ in git_commands(event):
        for name in new_branch_names(subcommand, args):
            if "$" in name or "`" in name or BRANCH_NAME.fullmatch(name) or name.startswith(FACTORY_BRANCH_PREFIX):
                continue
            return (
                "branch {0} does not follow the app-repository convention feature/PILOT-<n>-<slug> or "
                "hotfix/PILOT-<n>-<slug> (lowercase slug; factory branches archon/task-factory-* are exempt). The "
                "pull-request check in CI rejects it; rename with: git branch -m {0} feature/PILOT-<n>-<slug>"
            ).format(name)
    return None


def gated_invocation(event):
    """(phase, args) when the event starts a gated course skill, else None."""
    if event.get("hook_event_name") == "UserPromptSubmit" or "prompt" in event:
        match = GATED_PROMPT.match(event.get("prompt") or "")
        return (GATED_SKILLS[match.group(1)], match.group(2) or "") if match else None
    if event.get("tool_name") == "Skill":
        tool_input = event.get("tool_input") or {}
        skill = tool_input.get("skill") or ""
        name = skill[len("sdlc:"):] if skill.startswith("sdlc:") else skill
        if name in GATED_SKILLS:
            args = tool_input.get("args")
            return GATED_SKILLS[name], args if isinstance(args, str) else ""
    return None


def sdlc_gate_hook(event):
    invocation = gated_invocation(event)
    if invocation is None:
        return
    phase, args = invocation
    cwd = event_cwd(event)
    command = [sys.executable, str(sdlc_common.PLUGIN_DIR / "bin" / "sdlc-gate"), phase]
    token = (args.split() or [""])[0]
    root = sdlc_common.repo_root(cwd)
    if root and sdlc_common.valid_slug(token) and sdlc_common.feature_dir(root, token).is_dir():
        command.append(token)
    try:
        result = sdlc_common.run(command, cwd=cwd)
    except OSError as exc:
        raise Blocked("cannot run sdlc-gate in {}: {}".format(cwd, exc))
    if result.returncode != 0:
        raise Blocked("the {} phase is not open yet.\n{}".format(phase, result.stderr.strip()))


HOOKS = {
    "block-main-push": block_main_push,
    "block-destructive-git": block_destructive_git,
    "block-env": block_env,
    "block-state-edit": block_state_edit,
    "sdlc-gate-hook": sdlc_gate_hook,
    "check-branch-name": check_branch_name,
}


def read_event(stream):
    try:
        event = json.loads(stream.read() or "{}")
    except ValueError:
        return {}
    return event if isinstance(event, dict) else {}


def main(argv):
    if len(argv) != 1 or argv[0] not in HOOKS:
        print("usage: guards.py {}".format("|".join(sorted(HOOKS))), file=sys.stderr)
        return 1
    try:
        warning = HOOKS[argv[0]](read_event(sys.stdin))
    except Blocked as exc:
        print("Blocked by mvp-sdlc {}: {}".format(argv[0], exc), file=sys.stderr)
        return 2
    if warning:
        message = "WARNING from mvp-sdlc {}: {}".format(argv[0], warning)
        specific = {"hookEventName": "PreToolUse", "additionalContext": message}
        print(json.dumps({"systemMessage": message, "hookSpecificOutput": specific}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
