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


# Stub curl: reads the request config from stdin (curl --config -), logs `METHOD path`, its argv and the form data,
# and serves a small board from CURL_STUB_DATA, which it updates on writes: {"cards": {id: card}, "lists": [...],
# "labels": [...], "checklists": {card id: [checklist]}, "posts": n, "fail_post": n}. The n-th POST /1/cards fails
# when fail_post is n; PUT renames a checklist item.
CURL_STUB = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, re, sys
    from urllib.parse import urlsplit
    options, form = {}, {}
    for line in sys.stdin.read().splitlines():
        match = re.match(r'\\s*([\\w-]+)\\s*=\\s*"(.*)"\\s*$', line)
        if not match:
            continue
        value = json.loads('"' + match.group(2) + '"')
        if match.group(1) == "data-urlencode":
            name, _, text = value.partition("=")
            form[name] = text
        else:
            options[match.group(1)] = value
    url = urlsplit(options["url"])
    method, path = options.get("request", "GET"), url.path
    with open(os.environ["CURL_STUB_LOG"], "a") as log:
        log.write(json.dumps({"call": method + " " + path, "argv": sys.argv[1:], "data": form}) + "\\n")
    data_path = os.environ["CURL_STUB_DATA"]
    with open(data_path) as handle:
        data = json.load(handle)
    host = "trello" + ".com"
    status, body = 404, "The requested resource was not found."
    match = lambda pattern: re.fullmatch(pattern, path)
    if method == "GET" and match(r"/1/cards/([^/]+)") and match(r"/1/cards/([^/]+)").group(1) in data["cards"]:
        status, body = 200, data["cards"][match(r"/1/cards/([^/]+)").group(1)]
    elif method == "GET" and match(r"/1/boards/[^/]+/lists"):
        status, body = 200, data["lists"]
    elif method == "GET" and match(r"/1/boards/[^/]+/labels"):
        status, body = 200, data["labels"]
    elif method == "GET" and match(r"/1/boards/([^/]+)/cards"):
        board = match(r"/1/boards/([^/]+)/cards").group(1)
        status, body = 200, [c for c in data["cards"].values() if c["idBoard"] == board and not c["closed"]]
    elif method == "GET" and match(r"/1/cards/([^/]+)/checklists"):
        status, body = 200, data["checklists"].get(match(r"/1/cards/([^/]+)/checklists").group(1), [])
    elif method == "POST" and path == "/1/cards":
        data["posts"] += 1
        if data["posts"] == data.get("fail_post"):
            status, body = 500, "server error"
        else:
            short = 300 + data["posts"]
            card = {"id": "da" * 10 + "{:04x}".format(short), "idShort": short, "idBoard": data["board"],
                    "closed": False, "shortUrl": "https://{}/c/new{}".format(host, short)}
            card.update(form)
            data["cards"][card["id"]] = card
            status, body = 200, card
    elif method == "POST" and match(r"/1/cards/([^/]+)/checklists"):
        checklist = {"id": "ce" * 11 + "{:02x}".format(len(data["checklists"]) + 1), "name": form["name"],
                     "checkItems": []}
        data["checklists"].setdefault(match(r"/1/cards/([^/]+)/checklists").group(1), []).append(checklist)
        status, body = 200, checklist
    elif method == "POST" and match(r"/1/checklists/([^/]+)/checkItems"):
        for checklists in data["checklists"].values():
            for checklist in checklists:
                if checklist["id"] == match(r"/1/checklists/([^/]+)/checkItems").group(1):
                    checklist["checkItems"].append({"name": form["name"]})
                    status, body = 200, {"name": form["name"]}
    elif method == "PUT" and match(r"/1/cards/[^/]+/checkItem/([^/]+)"):
        for checklists in data["checklists"].values():
            for checklist in checklists:
                for item in checklist["checkItems"]:
                    if item.get("id") == match(r"/1/cards/[^/]+/checkItem/([^/]+)").group(1):
                        item["name"] = form["name"]
                        status, body = 200, item
    with open(data_path, "w") as handle:
        json.dump(data, handle)
    sys.stdout.write((body if isinstance(body, str) else json.dumps(body)) + "\\n" + str(status))
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
