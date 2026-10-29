"""Throwaway app repositories and command stubs shared by the mvp-sdlc tests."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
FIXTURES = PLUGIN / "tests" / "fixtures"
BIN = PLUGIN / "bin"

GIT_IDENTITY = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
}

MERGED = [{"number": 7, "merged_at": "2026-10-01T10:00:00Z"}]
UNMERGED = [{"number": 7, "merged_at": None}]

# Stub gh: logs argv as one JSON line. A call `gh <a> <b> ...` answers from the file in GH_STUB_RESPONSE_<A>_<B> when
# that variable is set; otherwise `gh pr list` prints [] and any other `gh pr ...` fails like "no pull requests
# found"; every other call answers from GH_STUB_RESPONSE. A response file whose content is FAIL makes the stub exit 1.
GH_STUB = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, sys
    with open(os.environ["GH_STUB_LOG"], "a") as log:
        log.write(json.dumps(sys.argv[1:]) + "\\n")
    command = "_".join(sys.argv[1:3]).upper().replace("-", "_")
    path = os.environ.get("GH_STUB_RESPONSE_" + command)
    if path is None and sys.argv[1:3] == ["pr", "list"]:
        sys.stdout.write("[]")
        sys.exit(0)
    if path is None and sys.argv[1:2] == ["pr"]:
        sys.stderr.write("no pull requests found\\n")
        sys.exit(1)
    with open(path or os.environ["GH_STUB_RESPONSE"]) as response:
        body = response.read()
    if body.strip() == "FAIL":
        sys.stderr.write("gh: HTTP 502\\n")
        sys.exit(1)
    sys.stdout.write(body)
    """
)


def run(args, cwd, env=None, input_text=None):
    return subprocess.run(
        [str(a) for a in args],
        cwd=str(cwd),
        env=env,
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )


class AppRepo:
    """A git repo at <tmp>/app (optionally from a fixture) with a bare origin at <tmp>/origin.git."""

    def __init__(self, tmp, fixture=None, name="app"):
        self.tmp = Path(tmp)
        self.path = self.tmp / name
        self.origin = self.tmp / (name + "-origin.git")
        self.stub_bin = self.tmp / "stub-bin"
        self.stub_bin.mkdir(exist_ok=True)
        if fixture:
            shutil.copytree(str(FIXTURES / fixture), str(self.path))
        else:
            self.path.mkdir()
        self.env = dict(os.environ, **GIT_IDENTITY)
        self.env["PATH"] = "{}{}{}".format(self.stub_bin, os.pathsep, self.env["PATH"])
        for key in ("SDLC_FEATURE", "SDLC_BASE_BRANCH"):
            self.env.pop(key, None)
        self.git("init", "-q", "-b", "main")
        run(["git", "init", "-q", "--bare", "-b", "main", self.origin], self.tmp).check_returncode()
        self.git("remote", "add", "origin", str(self.origin))

    def git(self, *args):
        result = run(["git"] + list(args), self.path, self.env)
        if result.returncode != 0:
            raise AssertionError("git {} failed: {}".format(" ".join(args), result.stderr))
        return result.stdout.strip()

    def commit(self, message="change", *paths):
        self.git("add", "--", *(paths or ["."]))
        self.git("commit", "-q", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")

    def push(self):
        self.git("push", "-q", "origin", "HEAD:main")
        self.git("fetch", "-q", "origin")

    def write(self, rel, text):
        path = self.path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def read(self, rel):
        return (self.path / rel).read_text(encoding="utf-8")

    def replace(self, rel, old, new):
        text = self.read(rel)
        if old not in text:
            raise AssertionError("{!r} not in {}".format(old, rel))
        self.write(rel, text.replace(old, new))

    def stub_gh(self, response, **commands):
        """Install the gh stub; `response` and each keyword response (`pr_list=`, `pr_view=`, `pr_create=`) is the
        string FAIL, another string printed as is (a URL), or a JSON-able value. Returns the argv log path."""
        stub = self.stub_bin / "gh"
        stub.write_text(GH_STUB, encoding="utf-8")
        stub.chmod(0o755)
        for key in [k for k in self.env if k.startswith("GH_STUB_RESPONSE_")]:
            del self.env[key]
        self.env["GH_STUB_RESPONSE"] = str(self.gh_response("gh-response", response))
        for command, answer in commands.items():
            self.env["GH_STUB_RESPONSE_" + command.upper()] = str(self.gh_response("gh-" + command, answer))
        log = self.tmp / "gh-calls.log"
        log.write_text("", encoding="utf-8")
        self.env["GH_STUB_LOG"] = str(log)
        return log

    def gh_response(self, name, answer):
        path = self.tmp / name
        path.write_text(answer if isinstance(answer, str) else json.dumps(answer), encoding="utf-8")
        return path

    def gh_calls(self):
        log = self.tmp / "gh-calls.log"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]

    def bin(self, name, *args, cwd=None, input_text=None):
        return run([sys.executable, BIN / name] + list(args), cwd or self.path, self.env, input_text)


class TempTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
