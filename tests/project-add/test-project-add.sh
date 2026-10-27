#!/usr/bin/env bash
# Behaviour test for bin/project-add: every external command is a stub on PATH (gh, aws, curl, ssh, claude, and
# 1_mvp_infra's vpnctl and scripts/projects.py in a local clone of a bare "infra" origin); git is real, against local
# bare repositories that https://github.com/ is rewritten to. HOME is a temp dir holding the operator's env files with
# fake credentials. Every stub call is one JSON line in calls.log. No network. Hosts and network prefixes the
# public-repo check bans are assembled at runtime.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "${tmp}"' EXIT

fail() { echo "FAIL $1: $2" >&2; exit 1; }

g() { git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false "$@"; }

FAKES=(fake-trello-key-1 fake-trello-token-1 fake-notion-token-1 fake-bot-token-mvp fake-bot-token-smoke
  fake-bot-token-bad
  fake-rag-token-1 https://rag.example.test/fake-rag-url fake-prod-vpn-ip fake-ovpn-secret-1 fakeaccount)

write_stubs() {
  local b="${tmp}/bin"
  mkdir -p "${b}"
  cat > "${b}/gh" <<'PY'
#!/usr/bin/env python3
import hashlib, json, os, subprocess, sys
stub = os.environ["STUB"]
args = sys.argv[1:]
with open(os.path.join(stub, "calls.log"), "a") as log:
    log.write(json.dumps({"tool": "gh", "argv": args}) + "\n")
flag = lambda name: os.path.exists(os.path.join(stub, "flags", name))
bare = lambda repo: os.path.join(stub, "remotes", repo + ".git")
store = os.path.join(stub, "secrets.json")
stored = json.load(open(store)) if os.path.exists(store) else []
opt = lambda name, default: args[args.index(name) + 1] if name in args else default
if args[:2] == ["auth", "status"]:
    sys.exit(1 if flag("gh-auth-fail") else 0)
if args[:3] == ["api", "user", "--jq"]:
    print("OlegShevtsov1")
elif args[:3] == ["api", "-i", "user"]:
    print("HTTP/2.0 200 OK\nX-Oauth-Scopes: repo, workflow\n\n{}")
elif args[:3] == ["api", "-X", "PUT"] and "/environments/" in args[3]:
    pass
elif args[0] == "api" and args[1].endswith("/actions/workflows"):
    names = ("develop-guard.yml", "pr-conventions-check.yml", "main-guard.yml")
    state = lambda n: "disabled_manually" if n == "develop-guard.yml" and flag("guard-disabled") else "active"
    print(json.dumps({"workflows": [{"path": ".github/workflows/" + n, "state": state(n)} for n in names]}))
elif args[:2] == ["repo", "view"]:
    sys.exit(0 if os.path.isdir(bare(args[2])) else 1)
elif args[:2] == ["repo", "create"]:
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", bare(args[2])], check=True)
elif args[:2] == ["repo", "clone"]:
    subprocess.run(["git", "clone", "-q", "https://github.com/{}.git".format(args[2]), args[3]], check=True,
                   stderr=subprocess.DEVNULL)
elif args[:2] == ["repo", "set-default"]:
    sys.exit(1 if os.path.exists(os.path.join(os.environ["STUB"], "flags", "set-default-fail")) else 0)
elif args[:2] == ["secret", "list"]:
    repo, env = opt("-R", None), opt("--env", "repo")
    print(json.dumps([{"name": s["name"]} for s in stored if s["repo"] == repo and s["env"] == env]))
elif args[:2] == ["secret", "set"]:
    value = sys.stdin.read()
    stored.append({"repo": opt("-R", None), "env": opt("--env", "repo"), "name": args[2],
                   "sha": hashlib.sha256(value.encode()).hexdigest()})
    json.dump(stored, open(store, "w"))
    with open(os.path.join(stub, "values.log"), "a") as values:
        values.write(json.dumps({"name": args[2], "value": value}) + "\n")
else:
    sys.exit(97)
PY
  cat > "${b}/aws" <<'PY'
#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.path.join(os.environ["STUB"], "calls.log"), "a") as log:
    log.write(json.dumps({"tool": "aws", "argv": args}) + "\n")
if args[:2] == ["sts", "get-caller-identity"]:
    print(json.dumps({"Account": "fakeaccount"}))
elif args[:2] == ["iam", "get-role"]:
    print("arn:aws:iam::fakeaccount:role/" + args[args.index("--role-name") + 1])
else:
    sys.exit(97)
PY
  cat > "${b}/ssh" <<'PY'
#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.path.join(os.environ["STUB"], "calls.log"), "a") as log:
    log.write(json.dumps({"tool": "ssh", "argv": args}) + "\n")
command = " ".join(args[3:])
if command == "free -m":
    print("               total        used        free      shared  buff/cache   available")
    print("Mem:            8000        3000        1000          10        4000        " + os.environ["STUB_FREE_MB"])
elif " dsn " in command:
    print("fake-dsn-" + command.split()[-1])
else:
    sys.exit(97)
PY
  cat > "${b}/claude" <<'PY'
#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.path.join(os.environ["STUB"], "calls.log"), "a") as log:
    log.write(json.dumps({"tool": "claude", "argv": args, "cwd": os.getcwd()}) + "\n")
assert args == ["plugin", "list", "--json"]
if os.path.exists(os.path.join(os.environ["STUB"], "flags", "claude-fail")):
    sys.exit("error: not logged in")
here = os.getcwd()
ids = ("sdlc@mvp",) if here.endswith("_fe") and os.path.exists(os.path.join(os.environ["STUB"], "flags", "fe-plugin-off")) \
    else ("sdlc@mvp", "mvp-sdlc@mvp")
print(json.dumps([{"id": p, "scope": "project", "enabled": True, "projectPath": here} for p in ids]
                 + [{"id": "other@x", "scope": "user", "enabled": True}]))
PY
  # git is real; the flag git-fetch-fail makes a fetch of origin main fail as a network fault would.
  cat > "${b}/git" <<SH
#!/usr/bin/env bash
if [ -e "\${STUB:-}/flags/git-fetch-fail" ] && [[ " \$* " == *" fetch -q origin main "* ]]; then
  echo "fatal: unable to access origin: Could not resolve host" >&2
  exit 128
fi
exec $(command -v git) "\$@"
SH
  # curl --config -: url, request, header, data and data-urlencode on stdin (notify-telegram passes data in argv).
  # Serves the Trello, Notion and Telegram routes project-add uses from api.json; the bot token in a Telegram path
  # is redacted in the log.
  cat > "${b}/curl" <<'PY'
#!/usr/bin/env python3
import json, os, re, sys
from urllib.parse import parse_qsl, urlsplit
stub = os.environ["STUB"]
argv = sys.argv[1:]
unquote = lambda v: re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), v)
opts = {}
for line in sys.stdin.read().splitlines():
    m = re.match(r'\s*([\w-]+)\s*=\s*"(.*)"\s*$', line)
    if m:
        opts.setdefault(m.group(1), []).append(unquote(m.group(2)))
form = dict(parse_qsl("&".join(opts.get("data-urlencode", []))))
form.update(dict(a.split("=", 1) for a in argv[argv.index("--data-urlencode") + 1::2]) if "--data-urlencode" in argv else {})
url = urlsplit(opts["url"][0])
method = opts.get("request", ["POST" if form or "data" in opts else "GET"])[0]
query = dict(parse_qsl(url.query))
body = json.loads(opts["data"][0]) if "data" in opts else None
path = re.sub(r"^/bot[^/]+/", "/bot<token>/", url.path)
with open(os.path.join(stub, "calls.log"), "a") as log:
    log.write(json.dumps({"tool": "curl", "call": "{} {}{}".format(method, url.hostname, path), "argv": argv}) + "\n")
state_file = os.path.join(stub, "api.json")
st = json.load(open(state_file))
flag = lambda name: os.path.exists(os.path.join(stub, "flags", name))
status, out = 404, {"message": "not found"}
host = url.hostname
if host.startswith("api.trello."):
    if (query.get("key"), query.get("token")) != ("fake-trello-key-1", "fake-trello-token-1"):
        status, out = 401, {"message": "invalid token"}
    elif method == "GET" and url.path == "/1/members/me":
        status, out = 200, {"id": "member-1"}
    elif method == "GET" and url.path == "/1/members/me/boards":
        status, out = 200, st["boards"]
    elif method == "POST" and url.path == "/1/boards":
        board = {"id": "board-{}".format(len(st["boards"]) + 1), "name": form["name"], "closed": False,
                 "url": "https://boards.example.test/{}".format(form["name"])}
        st["boards"].append(board)
        st["lists"][board["id"]], st["labels"][board["id"]] = [], []
        status, out = 200, board
    elif method == "POST" and url.path == "/1/lists":
        st["lists"][form["idBoard"]].append({"id": "list-x", "name": form["name"]})
        status, out = 200, {}
    elif method == "POST" and url.path == "/1/labels":
        st["labels"][form["idBoard"]].append({"name": form["name"], "color": form["color"]})
        status, out = 200, {}
    else:
        m = re.fullmatch(r"/1/boards/([^/]+)/(lists|labels)", url.path)
        if m and method == "GET":
            status, out = 200, st[m.group(2)][m.group(1)]
elif host.startswith("api.notion."):
    m = re.fullmatch(r"/v1/(blocks|pages)/([^/]+)(/children)?", url.path)
    if opts.get("header", [""])[0] != "Authorization: Bearer fake-notion-token-1":
        status, out = 401, {"message": "unauthorized"}
    elif method == "GET" and url.path == "/v1/users/me":
        status, out = 200, {"object": "user"}
    elif method == "POST" and url.path == "/v1/search":
        title = {"title": {"type": "title", "title": [{"plain_text": "PROJECTS"}]}}
        results = [{"object": "page", "id": "projects-page", "properties": title}] if flag("notion-projects") else []
        status, out = 200, {"results": results}
    elif method == "POST" and url.path == "/v1/pages":
        parent, name = body["parent"]["page_id"], body["properties"]["title"]["title"][0]["text"]["content"]
        page = "page-{}".format(name.lower())
        st["children"].setdefault(parent, []).append({"id": page, "type": "child_page", "child_page": {"title": name}})
        st["pages"][page] = {"id": page, "url": "https://pages.example.test/" + page}
        status, out = 200, st["pages"][page]
    elif m and m.group(1) == "blocks" and m.group(3) and method == "GET":
        # One child per page, so finding a page past the first exercises the cursor.
        start, children = int(query.get("start_cursor", 0)), st["children"].get(m.group(2), [])
        more = start + 1 < len(children)
        status, out = 200, {"results": children[start:start + 1], "has_more": more,
                            "next_cursor": str(start + 1) if more else None}
    elif m and m.group(1) == "blocks" and m.group(3) and method == "PATCH":
        st["appended"].setdefault(m.group(2), []).extend(body["children"])
        status, out = 200, {}
    elif m and m.group(1) == "pages" and method == "GET" and m.group(2) in st["pages"]:
        status, out = 200, st["pages"][m.group(2)]
elif host.startswith("api.telegram."):
    token, call = re.match(r"/bot([^/]+)/(\w+)$", url.path).groups()
    bots = {"fake-bot-token-mvp": 501, "fake-bot-token-smoke": 502}
    if token not in bots:
        status, out = 401, {"ok": False, "description": "Unauthorized"}
    elif call == "getMe":
        status, out = 200, {"ok": True, "result": {"id": bots[token]}}
    elif call == "getChatMember" and flag("telegram-5xx"):
        status, out = 502, {"ok": False, "description": "Bad Gateway"}
    elif call == "getChatMember" and flag("telegram-kicked"):
        status, out = 403, {"ok": False, "description": "Forbidden: bot is not a member of the supergroup chat"}
    elif call == "getChatMember" and flag("telegram-not-member"):
        status, out = 400, {"ok": False, "description": "Bad Request: chat not found"}
    elif call == "getChatMember":
        member = "member" if flag("telegram-not-admin") else "administrator"
        status, out = 200, {"ok": True, "result": {"status": member, "can_manage_topics": True}}
    elif call == "createForumTopic" and flag("telegram-garbled"):
        sys.stdout.write("<html>proxy error</html>\n200")
        sys.exit(0)
    elif call == "createForumTopic" and flag("telegram-no-thread"):
        status, out = 200, {"ok": True, "result": {}}
    elif call == "createForumTopic":
        st["topics"].append(form["name"])
        status, out = 200, {"ok": True, "result": {"message_thread_id": 100 + len(st["topics"])}}
    elif call == "sendMessage":
        st["messages"].append(form["text"])
        status, out = 200, {"ok": True, "result": {"message_thread_id": 9}}
json.dump(st, open(state_file, "w"))
sys.stdout.write(json.dumps(out) + ("\n{}".format(status) if "write-out" in opts else ""))
PY
  chmod +x "${b}"/*
}

# The infra origin: env/dev with the pilot entry (protected), a projects.py with check-name and get, and a vpnctl
# that speaks the subcommands project-add uses.
write_infra() {
  local seed="${tmp}/infra-seed"
  git init -q -b env/dev "${seed}"
  mkdir -p "${seed}/bin" "${seed}/scripts" "${seed}/projects"
  printf 'name: pilot\nprotected: true\nprod:\n  vpn_octet: 70\n' > "${seed}/projects/pilot.yaml"
  cat > "${seed}/scripts/projects.py" <<'PY'
#!/usr/bin/env python3
import json, os, pathlib, re, sys
projects = pathlib.Path(__file__).resolve().parent.parent / "projects"
cmd, name = sys.argv[1:3]
if cmd == "get" and os.path.exists(os.path.join(os.environ["STUB"], "flags", "registry-fail")):
    print("ERROR: projects/{}.yaml: mapping values are not allowed here".format(name))
    sys.exit(1)
if cmd == "check-name":
    if not re.fullmatch(r"[a-z0-9]{2,16}", name) or name in ("mvp", "shared", "bootstrap"):
        print("ERROR: name {!r} is reserved or invalid".format(name))
        sys.exit(1)
elif cmd == "get":
    entry = projects / (name + ".yaml")
    if not entry.is_file():
        print("ERROR: unknown project {!r}".format(name))
        sys.exit(1)
    print(json.dumps({"name": name, "protected": "protected: true" in entry.read_text()}))
PY
  cat > "${seed}/bin/vpnctl" <<'PY'
#!/usr/bin/env python3
import json, os, pathlib, re, sys
root = pathlib.Path(__file__).resolve().parent.parent
stub = os.environ["STUB"]
args = sys.argv[1:]
call = {"tool": "vpnctl", "argv": args}
if args[:2] == ["project", "remove"]:
    call["stdin"] = sys.stdin.readline().strip()
with open(os.path.join(stub, "calls.log"), "a") as log:
    log.write(json.dumps(call) + "\n")
if args[:2] == ["project", "list"]:
    for entry in sorted((root / "projects").glob("*.yaml")):
        print("{}  {}  {}.example.test".format(entry.stem, re.search(r"vpn_octet: (\d+)", entry.read_text()).group(1),
                                               entry.stem))
elif args == ["users"]:
    print("PROFILE          FIXED_IP")
    print("ci               {}.5".format(os.environ["STUB_VPN_NET"]))
    print("proxy            {}.71".format(os.environ["STUB_VPN_NET"]))
elif args[:2] == ["project", "show"]:
    n = args[2]
    print(json.dumps({"vpn_ip": "fake-prod-vpn-ip", "oidc_role": "mvp-{}-app-oidc".format(n),
                      "dev_host": "dev.{}.example.test".format(n), "app_dev_host": "app.dev.{}.example.test".format(n),
                      "prod_host": "{}.example.test".format(n), "app_prod_host": "app.{}.example.test".format(n)}))
elif args[:2] == ["project", "add"]:
    print("https://github.com/OlegShevtsov1/1_mvp_infra/pull/7")
elif args[:2] == ["project", "bootstrap"]:
    if os.path.exists(os.path.join(stub, "flags", "delegation")):
        print("ERROR: step 4 delegation: NS records do not match yet", file=sys.stderr)
        sys.exit(1)
    print("bootstrap {} done".format(args[2]))
elif args[:3] == ["user", "get", "ci"]:
    profile = ("client", "remote vpn.example.test 1194", "redirect-gateway def1", "<key>", "fake-ovpn-secret-1", "</key>")
    pathlib.Path(args[3]).write_text("\n".join(profile) + "\n")
    print(args[3])
elif args == ["_split-tunnel"]:
    text = "".join(line for line in sys.stdin if not line.startswith("redirect-gateway"))
    sys.stdout.write(text + "route-nopull\n")
elif args[:2] == ["project", "remove"]:
    if call["stdin"] != "REMOVE-" + args[2]:
        print("ERROR: confirmation did not match")
        sys.exit(1)
    print("Project Remove {} done".format(args[2]))
else:
    sys.exit(97)
PY
  chmod +x "${seed}/bin/vpnctl" "${seed}/scripts/projects.py"
  g -C "${seed}" add -A
  g -C "${seed}" commit -q -m "infra"
  git clone -q --bare "${seed}" "${tmp}/infra-origin.git"
  git clone -q -b env/dev "${tmp}/infra-origin.git" "${tmp}/infra"
  ln -s "${tmp}/infra/bin/vpnctl" "${tmp}/bin/vpnctl"
}

# merge_registry <name>: the registry PR is merged — projects/<name>.yaml lands on origin env/dev.
merge_registry() {
  rm -rf "${tmp}/infra-merge"
  git clone -q -b env/dev "${tmp}/infra-origin.git" "${tmp}/infra-merge"
  printf 'name: %s\nprod:\n  vpn_octet: 72\n' "$1" > "${tmp}/infra-merge/projects/$1.yaml"
  g -C "${tmp}/infra-merge" add -A
  g -C "${tmp}/infra-merge" commit -q -m "Register project $1"
  git -C "${tmp}/infra-merge" push -q origin env/dev
}

new_fixture() {
  rm -rf "${tmp:?}"/*
  local h="${tmp}/home" app
  mkdir -p "${tmp}/stub/flags" "${tmp}/stub/remotes" "${h}"
  echo '{"boards": [], "lists": {}, "labels": {}, "children": {}, "pages": {}, "appended": {}, "topics": [], "messages": []}' \
    > "${tmp}/stub/api.json"
  : > "${tmp}/stub/calls.log"
  : > "${tmp}/out.log"
  for app in trello notion telegram-bots mvp-rag project-add; do mkdir -p "${h}/.config/${app}"; done
  printf 'TRELLO_API_KEY=fake-trello-key-1\nTRELLO_TOKEN=fake-trello-token-1\n' > "${h}/.config/trello/.env"
  printf 'NOTION_TOKEN=fake-notion-token-1\n' > "${h}/.config/notion/.env"
  printf '%s\n' '# alerts' TELEGRAM_MVP_VPN_ALERTS_BOT_TOKEN=fake-bot-token-mvp \
    TELEGRAM_MVP_VPN_ALERTS_CHAT_ID=-777001 TELEGRAM_MVP_VPN_ALERTS_THREAD_ID=9 > "${h}/.config/telegram-bots/.env"
  printf 'RAG_MCP_URL=https://rag.example.test/fake-rag-url\nRAG_MCP_TOKEN=fake-rag-token-1\n' > "${h}/.config/mvp-rag/.env"
  printf 'PROJECT_ADD_DEV_SSH=devhost\n' > "${h}/.config/project-add/.env"
  chmod 600 "${h}"/.config/*/.env
  # init.defaultBranch master proves the first commit lands on main anyway; github.com resolves to the bare remotes.
  git config -f "${h}/.gitconfig" user.name t
  git config -f "${h}/.gitconfig" user.email t@example.invalid
  git config -f "${h}/.gitconfig" commit.gpgsign false
  git config -f "${h}/.gitconfig" init.defaultBranch master
  git config -f "${h}/.gitconfig" "url.${tmp}/stub/remotes/.insteadOf" https://github.com/
  mkdir -p "${tmp}/stub/remotes/OlegShevtsov1"
  write_stubs
  write_infra
}

# pa <stdin> <args...>: run project-add in the fixture; sets rc and out, appends out to out.log; mark records where
# this run's calls start in calls.log.
pa() {
  local input=$1
  shift
  mark=$(wc -l < "${tmp}/stub/calls.log")
  rc=0
  out=$(printf '%s\n' "${input}" | env -i HOME="${tmp}/home" PATH="${tmp}/bin:${PATH}" STUB="${tmp}/stub" \
    STUB_FREE_MB="${free_mb:-4000}" STUB_VPN_NET="$(printf '%s.%s.0' 10 18)" PROJECT_ADD_MERGE_WAIT=0 \
    PROJECT_ADD_POLL_SECONDS=0 PROJECT_ADD_REPOS_DIR="${tmp}/repos" "${root}/bin/project-add" "$@" 2>&1) || rc=$?
  printf '%s\n' "${out}" >> "${tmp}/out.log"
}

# calls [<python filter on c>]: this run's calls (since mark), one JSON per line.
calls() { tail -n "+$((mark + 1))" "${tmp}/stub/calls.log"; }

# Mutating stub calls of this run, one per line.
mutating() {
  calls | python3 -c '
import json, sys
for line in sys.stdin:
    c = json.loads(line)
    a = c.get("argv", [])
    hit = (c["tool"] == "vpnctl" and a[:2] in (["project", "add"], ["project", "bootstrap"], ["project", "remove"])) \
        or (c["tool"] == "gh" and (a[:2] in (["repo", "create"], ["secret", "set"]) or (a[:1] == ["api"] and "-X" in a))) \
        or (c["tool"] == "curl" and c["call"].split()[0] in ("POST", "PUT", "PATCH", "DELETE")
            and not c["call"].endswith("/v1/search"))
    if hit:
        print(c.get("call") or " ".join([c["tool"]] + a))
'
}

has_call() { calls | grep -qF -- "$1"; }
state_file() { echo "${tmp}/home/.local/state/project-add/$1.json"; }
remote_ref() { git -C "${tmp}/stub/remotes/OlegShevtsov1/1_mvp_smoke_$1.git" rev-parse --verify -q "$2" || true; }

expect_rc() { [ "${rc}" -eq "$2" ] || fail "$1" "exit ${rc}, want $2: ${out}"; }
expect_out() { grep -qF -- "$2" <<<"${out}" || fail "$1" "output lacks '$2': ${out}"; }
expect_no_mutation() {
  local m
  m=$(mutating)
  [ -z "${m}" ] || fail "$1" "mutating calls: ${m}"
}

# ---------------------------------------------------------------------------------------------------------------

new_fixture
pa "" --dry-run smoke
expect_rc "dry run" 0
[ "$(grep -cE '^[0-8] [a-z]+' <<<"${out}")" -eq 9 ] || fail "dry run" "not nine step lines: ${out}"
for s in "0 preflight" "1 infra" "2 repos" "3 github" "4 telegram" "5 trello" "6 notion" "7 plugins" "8 report"; do
  expect_out "dry run" "${s}:"
done
[ ! -s "${tmp}/stub/calls.log" ] || fail "dry run" "stubs were called: $(cat "${tmp}/stub/calls.log")"
[ ! -e "${tmp}/home/.local/state" ] || fail "dry run" "state written"
printf '%s\n' "${out}" | python3 -c '
import re, subprocess, sys
lines = sys.stdin.read().split("\n3 github", 1)[1].split("\n4 telegram", 1)[0].splitlines()[1:]
for kind in ("be", "fe"):
    listed = set()
    for line in lines:
        if "_smoke_{} ".format(kind) in line:
            listed |= set(re.findall(r"\b[A-Z][A-Z0-9_]+\b", line.split(":", 1)[1]))
    wanted = set(subprocess.run("grep -ohE \"secrets\\.[A-Z_]+\" templates/project-{}/.github/workflows/*.yml | cut -d. -f2"
                                .format(kind), shell=True, cwd=sys.argv[1], stdout=subprocess.PIPE,
                                universal_newlines=True, check=True).stdout.split())
    wanted |= {"RAG_MCP_URL", "RAG_MCP_TOKEN"}
    if listed != wanted:
        sys.exit("{}: missing {} extra {}".format(kind, sorted(wanted - listed), sorted(listed - wanted)))
' "${root}" || fail "dry run" "step 3 secrets differ from the templates' secrets plus the RAG names"
echo "PASS dry run: nine steps, the templates' secrets plus RAG_MCP_URL/RAG_MCP_TOKEN, no call, no write"

for bad in Smoke 1x pilot; do
  pa "" "${bad}"
  [ "${rc}" -ne 0 ] || fail "bad name ${bad}" "exit 0"
  expect_no_mutation "bad name ${bad}"
  [ ! -e "${tmp}/home/.local/state" ] || fail "bad name ${bad}" "state written"
done
expect_out "bad name pilot" "protected"
echo "PASS bad names refused before any write"

touch "${tmp}/stub/flags/gh-auth-fail"
pa "" smoke
expect_rc "preflight gh" 1
expect_out "preflight gh" "STOP"
expect_out "preflight gh" "gh auth status"
expect_no_mutation "preflight gh"
[ ! -e "${tmp}/home/.local/state" ] || fail "preflight gh" "state written"
rm "${tmp}/stub/flags/gh-auth-fail"
free_mb=1000 pa "" smoke
expect_rc "preflight RAM" 1
expect_out "preflight RAM" "1000 MB available"
expect_no_mutation "preflight RAM"
[ ! -e "${tmp}/home/.local/state" ] || fail "preflight RAM" "state written"
echo "PASS preflight STOP before any write (gh auth, dev host memory)"

pa "" smoke --step github
expect_rc "step before its time" 2
expect_out "step before its time" "repos"
expect_no_mutation "step before its time"
echo "PASS --step refused until the earlier steps are done"

# --- one project through every pause --------------------------------------------------------------------------
pa "" smoke
expect_rc "registry pause" 3
expect_out "registry pause" "https://github.com/OlegShevtsov1/1_mvp_infra/pull/7"
merge_registry smoke
touch "${tmp}/stub/flags/delegation"
pa "" smoke
expect_rc "delegation pause" 3
expect_out "delegation pause" "vpnctl project delegate smoke"
expect_out "delegation pause" "NS records do not match yet"
[ -f "${tmp}/infra/projects/smoke.yaml" ] || fail "delegation pause" "local infra checkout not fast-forwarded"
rm "${tmp}/stub/flags/delegation"
pa "nope" smoke
expect_rc "push not confirmed" 3
expect_out "push not confirmed" "PUSH-smoke"
for kind in be fe; do
  [ -z "$(git -C "${tmp}/stub/remotes/OlegShevtsov1/1_mvp_smoke_${kind}.git" for-each-ref)" ] ||
    fail "push not confirmed" "${kind} remote is not empty"
done
echo "PASS pauses: registry PR merge, delegation, first push without PUSH-<name>"

# Someone else's commit reached the empty be main between the pause and the confirm: refused, nothing pushed.
be_remote="${tmp}/stub/remotes/OlegShevtsov1/1_mvp_smoke_be.git"
g init -q "${tmp}/other"
g -C "${tmp}/other" commit -q --allow-empty -m other
git -C "${tmp}/other" push -q "${be_remote}" HEAD:main
other=$(remote_ref be main)
pa "PUSH-smoke" smoke
expect_rc "diverged main" 1
expect_out "diverged main" "reconcile by hand"
[ "$(remote_ref be main)" = "${other}" ] && [ -z "$(remote_ref fe main)" ] || fail "diverged main" "something was pushed"
git -C "${be_remote}" update-ref -d refs/heads/main
echo "PASS a main that diverged from the clone before the first push: STOP, nothing pushed"

pa "PUSH-smoke" smoke
expect_rc "telegram pause" 3
expect_out "telegram pause" "TELEGRAM_SMOKE_PROD_ALERTS_BOT_TOKEN=<token>"
for kind in be fe; do
  main=$(remote_ref "${kind}" main)
  [ -n "${main}" ] && [ "${main}" = "$(remote_ref "${kind}" develop)" ] || fail "first push" "${kind}: main and develop differ"
  git -C "${tmp}/stub/remotes/OlegShevtsov1/1_mvp_smoke_${kind}.git" log -1 --format=%B main | grep -qx "Type: chore" ||
    fail "first push" "${kind}: first commit has no Type: chore"
  [ -f "${tmp}/repos/1_mvp_smoke_${kind}/config/project.env" ] || fail "first push" "${kind}: not rendered"
done
has_call 'environments/dev' || fail "github" "no dev environment"
echo "PASS first push after PUSH-<name>: main and develop at the same commit on both repos; github step done"

env_tg="${tmp}/home/.config/telegram-bots/.env"
printf 'TELEGRAM_SMOKE_PROD_ALERTS_BOT_TOKEN=fake-bot-token-bad\n' >> "${env_tg}"
pa "" smoke
expect_rc "bot call fails" 1
expect_out "bot call fails" "HTTP 401: Unauthorized"
if grep -qF BotFather <<<"${out}"; then fail "bot call fails" "told to recreate the bot: ${out}"; fi
sed -i 's/^TELEGRAM_SMOKE_PROD_ALERTS_BOT_TOKEN=.*/TELEGRAM_SMOKE_PROD_ALERTS_BOT_TOKEN=fake-bot-token-smoke/' "${env_tg}"
touch "${tmp}/stub/flags/telegram-not-admin"
pa "" smoke
expect_rc "bot not admin" 3
expect_out "bot not admin" "Manage topics"
if grep -qF BotFather <<<"${out}"; then fail "bot not admin" "told to recreate the bot: ${out}"; fi
rm "${tmp}/stub/flags/telegram-not-admin"
touch "${tmp}/stub/flags/telegram-not-member"
pa "" smoke
expect_rc "bot not member" 3
expect_out "bot not member" "chat not found"
expect_out "bot not member" "Manage topics"
if grep -qF -e BotFather -e "revoked token" <<<"${out}"; then fail "bot not member" "told to replace the bot: ${out}"; fi
rm "${tmp}/stub/flags/telegram-not-member"
touch "${tmp}/stub/flags/telegram-kicked"
pa "" smoke
expect_rc "bot removed from the group" 3
expect_out "bot removed from the group" "HTTP 403: Forbidden: bot is not a member of the supergroup chat"
expect_out "bot removed from the group" "Manage topics"
if grep -qF -e BotFather -e "revoked token" <<<"${out}"; then fail "bot removed from the group" "told to replace the bot: ${out}"; fi
rm "${tmp}/stub/flags/telegram-kicked"
touch "${tmp}/stub/flags/telegram-5xx"
pa "" smoke
expect_rc "membership check fails" 1
expect_out "membership check fails" "HTTP 502: Bad Gateway"
if grep -qF -e BotFather -e "not an administrator" <<<"${out}"; then
  fail "membership check fails" "told to fix the bot: ${out}"
fi
rm "${tmp}/stub/flags/telegram-5xx"
echo "PASS a bot that is there but fails, is no member or no admin, or cannot be checked: its cause, not the BotFather recreation"

touch "${tmp}/stub/flags/telegram-garbled"
pa "" smoke
expect_rc "garbled topic reply" 1
expect_out "garbled topic reply" "not JSON"
if grep -q '^TELEGRAM_SMOKE_.*_THREAD_ID=' "${tmp}/home/.config/telegram-bots/.env"; then
  fail "garbled topic reply" "a thread id was written"
fi
rm "${tmp}/stub/flags/telegram-garbled"
touch "${tmp}/stub/flags/telegram-no-thread"
pa "" smoke
expect_rc "topic reply without a thread" 1
expect_out "topic reply without a thread" "no message_thread_id"
if grep -q '^TELEGRAM_SMOKE_.*_THREAD_ID=' "${tmp}/home/.config/telegram-bots/.env"; then
  fail "topic reply without a thread" "a thread id was written"
fi
rm "${tmp}/stub/flags/telegram-no-thread"
echo "PASS a 200 reply that is not JSON or has no thread id stops the telegram step and writes no thread id"

pa "" smoke
expect_rc "notion pause" 3
expect_out "notion pause" "PROJECTS"
for gone in '"project", "add"' '"project", "bootstrap"' '"repo", "create"'; do
  if has_call "${gone}"; then fail "resume" "repeated ${gone}"; fi
done
if calls | grep -F '"secret", "set"' | grep -vqF '"TELEGRAM_'; then fail "resume" "github secrets set again"; fi
[ "$(grep -cE '^TELEGRAM_SMOKE_(PROD|DEV)_ALERTS_(BOT_TOKEN|CHAT_ID|THREAD_ID)=' "${env_tg}")" -eq 6 ] ||
  fail "telegram" "env file lacks the six keys"
[ "$(stat -c %a "${env_tg}")" = 600 ] || fail "telegram" "env file mode $(stat -c %a "${env_tg}")"
grep -qx '# alerts' "${env_tg}" || fail "telegram" "other lines lost"
grep -qx 'TRELLO_BOARD_ID_SMOKE=board-1' "${tmp}/home/.config/trello/.env" || fail "trello" "no TRELLO_BOARD_ID_SMOKE"
python3 - "${tmp}/stub/api.json" "${root}" <<'PY' || fail "trello" "board lists or labels wrong"
import json, subprocess, sys
st = json.load(open(sys.argv[1]))
assert [b["name"] for b in st["boards"]] == ["SMOKE"], st["boards"]
lists = subprocess.run([sys.argv[2] + "/bin/board-lists"], stdout=subprocess.PIPE, universal_newlines=True)
wanted = lists.stdout.splitlines()
assert [l["name"] for l in st["lists"]["board-1"]] == wanted, st["lists"]
assert sorted(l["name"] for l in st["labels"]["board-1"]) == ["feature", "hotfix", "run", "task"]
assert st["topics"] == ["smoke_prod_alerts", "smoke_dev_alerts"], st["topics"]
PY
echo "PASS resume from telegram: infra, repos, github not repeated; topics, env file, Trello board; Notion pause"

touch "${tmp}/stub/flags/notion-projects" "${tmp}/stub/flags/fe-plugin-off"
pa "" smoke
expect_rc "full run" 0
has_call 'GET api.notion.com/v1/pages/page-smoke' || fail "notion" "page not verified with GET /v1/pages/<id>"
has_call '/sendMessage' || fail "report" "not posted to Telegram"
has_call 'PATCH api.notion.com/v1/blocks/page-smoke/children' || fail "report" "not appended to the Notion page"
expect_out "plugin miss" "mvp-sdlc@mvp in ${tmp}/repos/1_mvp_smoke_fe"
expect_out "plugin miss" "7 plugins: failed; the run goes on"
expect_out "plugin miss" "❌ 7 plugins"
for manual in SRV_DEPLOY_SSH_KEY PROD_SSH_KEY GLITCHTIP_API_TOKEN GLITCHTIP_API_URL BE_REPO_READ_TOKEN ANTHROPIC_API_KEY; do
  expect_out "report" "${manual}"
done
expect_out "report" "https://pages.example.test/page-smoke"
expect_out "report" "https://dev.smoke.example.test"
echo "PASS notion page, report posted to Telegram and Notion; a plugin miss is reported and the run goes on"

rm "${tmp}/stub/flags/fe-plugin-off"
pa "" smoke
expect_rc "plugins again" 0
expect_out "plugins again" "7 plugins: done"
expect_out "plugins again" "8 report: already done"
pa "" smoke --step report
expect_rc "report again" 0
expect_out "report again" "✅ 7 plugins"
echo "PASS a missed plugin check is re-run by the next run"

settings="${tmp}/repos/1_mvp_smoke_fe/.claude/settings.json"
cp "${settings}" "${tmp}/settings.json"
python3 -c 'import json, sys; p = sys.argv[1]; d = json.load(open(p)); del d["enabledPlugins"]; json.dump(d, open(p, "w"))' "${settings}"
pa "" smoke --step plugins
expect_rc "no enabledPlugins" 0
expect_out "no enabledPlugins" "no enabledPlugins in ${settings}"
expect_out "no enabledPlugins" "7 plugins: failed; the run goes on"
python3 -c 'import json, sys; assert json.load(open(sys.argv[1]))["steps"]["plugins"]["status"] == "failed"' \
  "$(state_file smoke)" || fail "no enabledPlugins" "plugins not recorded failed"
cp "${tmp}/settings.json" "${settings}"
pa "" smoke --step plugins
expect_rc "plugins restored" 0
expect_out "plugins restored" "7 plugins: done"
touch "${tmp}/stub/flags/claude-fail"
pa "" smoke --step plugins
expect_rc "plugin list fails" 0
expect_out "plugin list fails" "claude plugin list failed in ${tmp}/repos/1_mvp_smoke_be (exit 1)"
expect_out "plugin list fails" "error: not logged in"
if grep -qF "mvp-sdlc@mvp in" <<<"${out}"; then fail "plugin list fails" "taken for a missing plugin: ${out}"; fi
rm "${tmp}/stub/flags/claude-fail"
pa "" smoke --step plugins
expect_rc "plugins after a failed list" 0
expect_out "plugins after a failed list" "7 plugins: done"
echo "PASS a clone without enabledPlugins or a failing plugin list: reported with its cause, recorded failed, retried"

python3 - "${tmp}/stub/secrets.json" <<'PY' || fail "secrets" "the secrets set differ from the table"
import collections, json, sys
got = [(s["repo"].rsplit("_", 1)[1], s["env"], s["name"]) for s in json.load(open(sys.argv[1]))]
assert len(got) == len(set(got)), [k for k, n in collections.Counter(got).items() if n > 1]
both = {("repo", n) for n in ("AWS_ROLE_ARN", "VPN_CI_OVPN", "RAG_MCP_URL", "RAG_MCP_TOKEN")}
both |= {(t.lower(), "TELEGRAM_{}_ALERTS_{}".format(t, p)) for t in ("DEV", "PROD") for p in ("BOT_TOKEN", "CHAT_ID", "THREAD_ID")}
both |= {("prod", "PROD_VPN_IP")} | {(e, "SENTRY_DSN") for e in ("dev", "prod")}
be = {(e, n) for e in ("dev", "prod") for n in ("SENTRY_ALLOWED_FE_DSN", "SECRET_KEY_BASE", "POSTGRES_PASSWORD", "SMOKE_TOKEN")}
want = {("be",) + k for k in both | be} | {("fe",) + k for k in both}
assert set(got) == want, (sorted(set(got) - want), sorted(want - set(got)))
sha = {(s["repo"], s["env"], s["name"]): s["sha"] for s in json.load(open(sys.argv[1]))}
dev, prod = [sha[("OlegShevtsov1/1_mvp_smoke_be", e, "POSTGRES_PASSWORD")] for e in ("dev", "prod")]
assert dev != prod, "generated values are shared between environments"
PY
echo "PASS the secrets set are exactly the table (manual ones only reported)"

pa "" smoke
expect_rc "already done" 0
for s in "1 infra" "2 repos" "3 github" "4 telegram" "5 trello" "6 notion" "7 plugins" "8 report"; do
  expect_out "already done" "${s}: already done"
done
expect_no_mutation "already done"
echo "PASS a rerun after success: every step already done, nothing changed"

pa "" smoke --step github
expect_rc "step github again" 0
if has_call '"secret", "set"'; then fail "step github again" "a present secret was set again"; fi
echo "PASS --step github again sets nothing that is present"

touch "${tmp}/stub/flags/guard-disabled"
pa "" smoke --step github
expect_rc "guard not active" 1
expect_out "guard not active" "workflows not active: develop-guard.yml"
if has_call '"secret"'; then fail "guard not active" "secrets touched before the guards are active"; fi
rm "${tmp}/stub/flags/guard-disabled"
pa "" smoke --step github
expect_rc "guard active again" 0
echo "PASS --step github with a guard workflow not active: STOP before any secret; done once it is active"

pa "" smoke --step trello
expect_rc "step trello again" 0
expect_out "step trello again" "5 trello: done"
expect_no_mutation "step trello again"
python3 -c 'import json, sys; assert [b["name"] for b in json.load(open(sys.argv[1]))["boards"]] == ["SMOKE"]' \
  "${tmp}/stub/api.json" || fail "step trello again" "a second board"
python3 - "${tmp}/stub/api.json" <<'PY'
import json, sys
st = json.load(open(sys.argv[1]))
st["children"]["projects-page"].insert(0, {"id": "page-other", "type": "child_page", "child_page": {"title": "OTHER"}})
json.dump(st, open(sys.argv[1], "w"))
PY
pa "" smoke --step notion
expect_rc "step notion again" 0
expect_out "step notion again" "6 notion: done"
expect_no_mutation "step notion again"
[ "$(calls | grep -cF 'GET api.notion.com/v1/blocks/projects-page/children')" -eq 2 ] ||
  fail "step notion again" "the second page of the PROJECTS children was not read"
echo "PASS --step trello and --step notion again: the board and the page (past the first page) are reused"

# The project lives on: main has moved past the first commit and the clone is on a feature branch.
clone="${tmp}/repos/1_mvp_smoke_be"
echo "more" >> "${clone}/README.md"
g -C "${clone}" -c core.hooksPath=/dev/null commit -q -am "docs: more"
git -C "${clone}" -c core.hooksPath=/dev/null push -q "${be_remote}" HEAD:main
git -C "${clone}" switch -q -c feat/x
g -C "${clone}" -c core.hooksPath=/dev/null commit -q --allow-empty -m wip
pa "" smoke --step repos
expect_rc "step repos again" 0
expect_out "step repos again" "2 repos: done"
expect_no_mutation "step repos again"
echo "PASS --step repos on a live project: done, nothing changed"

# A teammate's merge the clone has not fetched yet, then a transient failure: repos must still come back to done.
git clone -q "${be_remote}" "${tmp}/mate"
echo "mate" >> "${tmp}/mate/README.md"
g -C "${tmp}/mate" -c core.hooksPath=/dev/null commit -q -am "docs: mate"
git -C "${tmp}/mate" push -q origin HEAD:main
touch "${tmp}/stub/flags/set-default-fail"
pa "" smoke --step repos
expect_rc "set-default fails" 1
expect_out "set-default fails" "gh repo set-default"
rm "${tmp}/stub/flags/set-default-fail"
pa "" smoke --step repos
expect_rc "repos after a failed rerun" 0
expect_out "repos after a failed rerun" "2 repos: done"
expect_no_mutation "repos after a failed rerun"
echo "PASS --step repos after a failed rerun of a live project: done again, nothing re-rendered"

touch "${tmp}/stub/flags/git-fetch-fail"
pa "" smoke --step repos
expect_rc "fetch fails" 1
expect_out "fetch fails" "git fetch origin main"
if grep -qF "render" <<<"${out}"; then fail "fetch fails" "a fetch failure was taken for a render: ${out}"; fi
expect_no_mutation "fetch fails"
rm "${tmp}/stub/flags/git-fetch-fail"
echo "PASS --step repos when the fetch of main fails: STOP with the fetch, no render"

python3 - "${tmp}/out.log" "${tmp}/stub/calls.log" "${tmp}/stub/values.log" "${tmp}/home/.local/state" "${FAKES[@]}" <<'PY' ||
import json, pathlib, sys
out, calls, values, state = sys.argv[1:5]
texts = {p: pathlib.Path(p).read_text() for p in (out, calls)}
texts.update({str(p): p.read_text() for p in pathlib.Path(state).glob("*.json")})
needles = set(sys.argv[5:])
# Telegram chat and thread ids are addresses, not secrets: notify-telegram passes the chat id in argv by design.
needles |= {v["value"].strip() for v in map(json.loads, open(values))
            if "\n" not in v["value"].strip() and not v["name"].endswith(("_CHAT_ID", "_THREAD_ID"))}
needles |= {"fake-dsn-smoke-{}-{}".format(k, e) for k in ("be", "fe") for e in ("dev", "prod")}
leaks = ["{} in {}".format(n[:12] + "...", p) for n in needles for p, t in texts.items() if n in t]
sys.exit("\n".join(leaks) or None)
PY
  fail "no secret leaks" "a secret value reached the output, an argv or the state"
echo "PASS no secret value in any output, argv or state file"

touch "${tmp}/stub/flags/registry-fail"
pa "" --undo pilot
expect_rc "undo unreadable entry" 1
expect_out "undo unreadable entry" "projects.py get pilot failed"
if has_call '"remove"'; then fail "undo unreadable entry" "vpnctl project remove was called"; fi
pa "" pilot
expect_rc "preflight unreadable entry" 1
expect_out "preflight unreadable entry" "projects.py get pilot failed"
expect_no_mutation "preflight unreadable entry"
rm "${tmp}/stub/flags/registry-fail"
echo "PASS an unreadable registry entry stops undo and preflight; nothing removed"

pa "" --undo pilot
expect_rc "undo pilot" 1
expect_out "undo pilot" "protected"
if has_call '"remove"'; then fail "undo pilot" "vpnctl project remove was called"; fi
pa "REMOVE-smoke" --undo smoke
expect_rc "undo smoke" 0
has_call '"argv": ["project", "remove", "smoke"], "stdin": "REMOVE-smoke"' || fail "undo smoke" "no confirmed remove"
expect_out "undo smoke" "https://github.com/OlegShevtsov1/1_mvp_smoke_be"
expect_out "undo smoke" "https://boards.example.test/SMOKE"
expect_out "undo smoke" "https://pages.example.test/page-smoke"
[ -f "${tmp}/home/.local/state/project-add/smoke.undone.json" ] && [ ! -e "$(state_file smoke)" ] ||
  fail "undo smoke" "state not renamed"
echo "PASS undo: protected refused without action; vpnctl project remove with its typed confirm, checklist printed"
