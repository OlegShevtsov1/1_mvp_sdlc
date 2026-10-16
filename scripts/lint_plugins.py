#!/usr/bin/env python3
"""Evals layer 0: lint the plugin marketplace against plugins/contracts.yaml.

Checks marketplace entries against plugin manifests, agent tool allowlists against the contract (read-only agents
never get write tools), skill frontmatter, hooks/hooks.json (known events, command hooks whose plugin scripts exist and
are executable), and the tree sha256 of vendored upstream plugins (UPSTREAM.md).
Stdlib only, Python >= 3.8. Usage: lint_plugins.py [--root DIR]
"""
import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

WRITE_TOOLS = {"Write", "Edit", "NotebookEdit"}
BLOCK_INDICATORS = {"", ">", "|", ">-", "|-", ">+", "|+"}
TREE_HASH_LINE = re.compile(r"^- Tree sha256: `([0-9a-f]{64})`$")
# Files a vendoring PR adds beside the upstream tree; see plugins/sdlc/UPSTREAM.md for the shell definition.
NOT_UPSTREAM = ("UPSTREAM.md", "LICENSE")
NOT_UPSTREAM_DIR = ".claude-plugin"
HOOK_EVENTS = {
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionStart",
    "SessionEnd",
    "PreCompact",
}
PLUGIN_ROOT_PATH = re.compile(r"\$\{?CLAUDE_PLUGIN_ROOT\}?/([^\s\"']+)")


class Linter:
    def __init__(self, root):
        self.root = root
        self.errors = []
        self.agents = 0
        self.skills = 0

    def error(self, path, message):
        self.errors.append("ERROR {}: {}".format(Path(os.path.relpath(str(path), str(self.root))).as_posix(), message))

    def run(self):
        market_path = self.root / ".claude-plugin" / "marketplace.json"
        market = self.load_json(market_path)
        if market is None:
            return 0
        contract_path = self.root / "plugins" / "contracts.yaml"
        contract = self.parse_contract(contract_path)
        entries = market.get("plugins")
        if not isinstance(entries, list):
            self.error(market_path, "`plugins` must be a list")
            return 0
        names = set()
        for entry in entries:
            name = entry.get("name") if isinstance(entry, dict) else None
            if not isinstance(name, str) or not name:
                self.error(market_path, "plugin entry without a name")
                continue
            names.add(name)
            self.lint_plugin(market_path, entry, contract.get(name, {"tools": {}, "read_only": []}))
        for name in sorted(set(contract) - names):
            self.error(contract_path, "plugin {} has no marketplace entry".format(name))
        return len(names)

    def load_json(self, path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self.error(path, "cannot read JSON: {}".format(exc))
            return None

    def parse_contract(self, path):
        contract = {}
        plugin = section = None
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            self.error(path, "cannot read: {}".format(exc))
            return contract
        for number, line in enumerate(lines, 1):
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            plugin_match = re.match(r"^([\w.-]+):\s*$", line)
            agent_match = re.match(r"^    ([\w.-]+):\s*\[(.*)\]\s*$", line)
            read_only_match = re.match(r"^  read_only:\s*\[(.*)\]\s*$", line)
            if plugin_match:
                plugin, section = plugin_match.group(1), None
                contract[plugin] = {"tools": {}, "read_only": []}
            elif plugin and re.match(r"^  tools:\s*$", line):
                section = "tools"
            elif plugin and section == "tools" and agent_match:
                agent = agent_match.group(1)
                if agent in contract[plugin]["tools"]:
                    self.error(path, "line {}: agent {} listed twice".format(number, agent))
                contract[plugin]["tools"][agent] = split_list(agent_match.group(2))
            elif plugin and read_only_match:
                section = None
                contract[plugin]["read_only"] = split_list(read_only_match.group(1))
            else:
                self.error(path, "line {}: unsupported line (see the header for the accepted subset)".format(number))
        return contract

    def lint_plugin(self, market_path, entry, contract):
        name = entry["name"]
        source = entry.get("source")
        if not isinstance(source, str):
            self.error(market_path, "plugin {}: source must be a relative path".format(name))
            return
        plugin_dir = (self.root / source).resolve()
        manifest_path = plugin_dir / ".claude-plugin" / "plugin.json"
        if not manifest_path.is_file():
            self.error(manifest_path, "plugin {}: manifest not found".format(name))
            return
        manifest = self.load_json(manifest_path)
        if manifest is None:
            return
        if manifest.get("name") != name:
            self.error(manifest_path, "name {!r} != marketplace entry {!r}".format(manifest.get("name"), name))
        if manifest.get("version") != entry.get("version"):
            self.error(
                market_path,
                "plugin {}: marketplace version {} != plugin.json version {}".format(
                    name, entry.get("version"), manifest.get("version")
                ),
            )
        self.lint_agents(plugin_dir, name, contract)
        self.lint_skills(plugin_dir)
        self.lint_hooks(plugin_dir)
        if (plugin_dir / "UPSTREAM.md").is_file():
            self.lint_upstream(plugin_dir, name)

    def lint_agents(self, plugin_dir, plugin, contract):
        allowed = contract["tools"]
        read_only = set(contract["read_only"])
        contract_path = self.root / "plugins" / "contracts.yaml"
        for agent in sorted(read_only - set(allowed)):
            self.error(contract_path, "{}: read_only agent {} has no tools entry".format(plugin, agent))
        for agent in sorted(read_only & set(allowed)):
            granted = WRITE_TOOLS & set(allowed[agent])
            if granted:
                self.error(
                    contract_path,
                    "{}: read-only agent {} is granted {}".format(plugin, agent, ", ".join(sorted(granted))),
                )
        seen = set()
        for path in sorted((plugin_dir / "agents").glob("*.md")):
            self.agents += 1
            agent = path.stem
            seen.add(agent)
            meta = self.frontmatter(path)
            if meta is None:
                continue
            if meta.get("name") != agent:
                self.error(path, "name {!r} != file name {!r}".format(meta.get("name"), agent))
            tools = split_list(meta.get("tools", ""))
            if not tools:
                self.error(path, "agent {} has no tools: allowlist (it would inherit every tool)".format(agent))
                continue
            if agent not in allowed:
                self.error(path, "agent {} is not in the contract for plugin {}".format(agent, plugin))
                continue
            extra = set(tools) - set(allowed[agent])
            missing = set(allowed[agent]) - set(tools)
            if extra or missing:
                self.error(
                    path,
                    "agent {} tools differ from the contract (extra: {}; missing: {})".format(
                        agent, ", ".join(sorted(extra)) or "-", ", ".join(sorted(missing)) or "-"
                    ),
                )
            if agent in read_only and WRITE_TOOLS & set(tools):
                self.error(
                    path,
                    "read-only agent {} has {}".format(agent, ", ".join(sorted(WRITE_TOOLS & set(tools)))),
                )
        for agent in sorted(set(allowed) - seen):
            self.error(contract_path, "{}: contract agent {} has no agents/{}.md".format(plugin, agent, agent))

    def lint_skills(self, plugin_dir):
        skills_dir = plugin_dir / "skills"
        if not skills_dir.is_dir():
            return
        for skill_dir in sorted(p for p in skills_dir.iterdir() if p.is_dir() and not p.name.startswith("_")):
            self.skills += 1
            path = skill_dir / "SKILL.md"
            if not path.is_file():
                self.error(skill_dir, "skill {} has no SKILL.md".format(skill_dir.name))
                continue
            meta = self.frontmatter(path)
            if meta is None:
                continue
            for key in ("name", "description"):
                if not meta.get(key):
                    self.error(path, "skill {} has no {}".format(skill_dir.name, key))
            if meta.get("name") and meta["name"] != skill_dir.name:
                self.error(path, "name {!r} != directory {!r}".format(meta["name"], skill_dir.name))

    def lint_hooks(self, plugin_dir):
        path = plugin_dir / "hooks" / "hooks.json"
        if not path.is_file():
            return
        config = self.load_json(path)
        if config is None:
            return
        events = config.get("hooks") if isinstance(config, dict) else None
        if not isinstance(events, dict):
            self.error(path, "must be a JSON object with a `hooks` object")
            return
        for event, entries in sorted(events.items()):
            if event not in HOOK_EVENTS:
                self.error(path, "unknown hook event {}".format(event))
                continue
            if not isinstance(entries, list):
                self.error(path, "{}: must be a list".format(event))
                continue
            for entry in entries:
                hooks = entry.get("hooks") if isinstance(entry, dict) else None
                if not isinstance(hooks, list) or not isinstance(entry.get("matcher", ""), str):
                    self.error(path, "{}: each entry needs an optional string `matcher` and a `hooks` list".format(event))
                    continue
                for hook in hooks:
                    hook = hook if isinstance(hook, dict) else {}
                    command = hook.get("command")
                    if hook.get("type") != "command":
                        self.error(path, "{}: only hooks of type `command` are supported".format(event))
                    elif not isinstance(command, str) or not command.strip():
                        self.error(path, "{}: command hook without a command".format(event))
                    else:
                        self.lint_hook_command(path, plugin_dir, event, command)

    def lint_hook_command(self, path, plugin_dir, event, command):
        for rel in PLUGIN_ROOT_PATH.findall(command):
            script = plugin_dir / rel
            if not script.is_file():
                self.error(path, "{}: {} does not exist".format(event, rel))
            elif not os.access(str(script), os.X_OK):
                self.error(path, "{}: {} is not executable".format(event, rel))

    def lint_upstream(self, plugin_dir, plugin):
        upstream = plugin_dir / "UPSTREAM.md"
        recorded = [m.group(1) for m in map(TREE_HASH_LINE.match, upstream.read_text(encoding="utf-8").splitlines()) if m]
        if len(recorded) != 1:
            self.error(upstream, "expected exactly one '- Tree sha256: `<hex>`' line, found {}".format(len(recorded)))
            return
        computed = self.tree_hash(plugin_dir)
        if computed is not None and computed != recorded[0]:
            self.error(
                upstream,
                "plugin {}: vendored tree sha256 {} != recorded {} (never edit upstream files)".format(
                    plugin, computed, recorded[0]
                ),
            )
        root_manifest = plugin_dir / "plugin.json"
        manifest = plugin_dir / ".claude-plugin" / "plugin.json"
        if root_manifest.is_file() and root_manifest.read_bytes() != manifest.read_bytes():
            self.error(manifest, "must be a byte copy of the upstream plugin.json")

    def tree_hash(self, plugin_dir):
        """Same value as: find . -type f <exclusions> -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum"""
        paths = []
        for dirpath, dirnames, filenames in os.walk(str(plugin_dir)):
            rel_dir = Path(dirpath).relative_to(plugin_dir)
            if rel_dir == Path("."):
                dirnames[:] = [d for d in dirnames if d != NOT_UPSTREAM_DIR]
                filenames = [f for f in filenames if f not in NOT_UPSTREAM]
            for filename in filenames:
                path = Path(dirpath) / filename
                if path.is_symlink() or not path.is_file():
                    continue
                rel = "./" + (rel_dir / filename).as_posix()
                if "\\" in rel or "\n" in rel:
                    self.error(path, "file name with a backslash or newline cannot be hashed like sha256sum")
                    return None
                paths.append((rel.encode("utf-8"), path))
        listing = hashlib.sha256()
        for rel, path in sorted(paths):
            listing.update("{}  ".format(hashlib.sha256(path.read_bytes()).hexdigest()).encode() + rel + b"\n")
        return listing.hexdigest()

    def frontmatter(self, path):
        lines = path.read_text(encoding="utf-8").splitlines()
        if not lines or lines[0].strip() != "---" or "---" not in (l.strip() for l in lines[1:]):
            self.error(path, "no YAML frontmatter")
            return None
        meta = {}
        key = None
        for line in lines[1:]:
            if line.strip() == "---":
                break
            match = re.match(r"^([\w-]+):(?:\s+(.*))?$", line)
            if match:
                key, value = match.group(1), (match.group(2) or "").strip()
                meta[key] = "" if value in BLOCK_INDICATORS else unquote(value)
            elif key and (line.startswith((" ", "\t")) or not line.strip()):
                meta[key] = (meta[key] + " " + line.strip()).strip()
        return meta


def split_list(value):
    value = value.strip()
    if value.startswith("[") and value.endswith("]"):
        value = value[1:-1]
    return [item.strip() for item in value.split(",") if item.strip()]


def unquote(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    linter = Linter(args.root.resolve())
    plugins = linter.run()
    if linter.errors:
        print("\n".join(linter.errors), file=sys.stderr)
        return 1
    print("lint_plugins: OK ({} plugins, {} agents, {} skills)".format(plugins, linter.agents, linter.skills))
    return 0


if __name__ == "__main__":
    sys.exit(main())
