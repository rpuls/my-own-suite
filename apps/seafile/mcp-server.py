"""The tools MOS offers an owner's AI for Seafile, as a small MCP server.

Only MOS calls it, with the key MOS generated for this package. It never holds a
password: MOS passes the owner's password to /sign-in once, gets the owner's
Seafile API token back, and sends that token with every call. It only reads, and
reaches nothing but Seafile.
"""

import hmac
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SEAFILE = os.environ.get("SEAFILE_URL", "http://seafile").rstrip("/")
EMAIL = os.environ.get("SEAFILE_ADMIN_EMAIL", "")
MOS_KEY = os.environ.get("MOS_AI_KEY", "")
PORT = int(os.environ.get("PORT", "8100"))

PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"]
BODY_LIMIT = 1_000_000
READ_LIMIT = 2_000_000
TEXT_PAGE = 12_000
SEARCH_LIMIT = 50
LIBRARY_TTL = 60
WRONG_PASSWORD = "Unable to login with provided credentials."


class ToolError(Exception):
    pass


class SignInRefused(ToolError):
    pass


# MOS reads this from a tool result and asks the owner to sign in again.
SIGN_IN_REFUSED = {"myownsuite.org/sign-in": "refused"}


class Seafile:
    def __init__(self):
        self.libraries = None
        self.request = threading.local()

    def exchange(self, password):
        """The owner's Seafile API token, or None when Seafile refuses the password."""
        body = urllib.parse.urlencode({"username": EMAIL, "password": password}).encode()
        try:
            return self.send("POST", "/api2/auth-token/", body, {"Content-Type": "application/x-www-form-urlencoded"})["token"]
        except urllib.error.HTTPError as error:
            if error.code != 400:
                raise
            reasons = json.loads(error.read().decode("utf-8", "replace") or "{}").get("non_field_errors") or []
        # Two-factor sign-in, a disabled or a frozen account: no other password would help.
        if reasons and WRONG_PASSWORD not in reasons:
            raise ToolError(f"Seafile refused the sign-in for {EMAIL}: {' '.join(reasons)}")
        return None

    def send(self, method, path, body=None, headers=None, limit=None):
        request = urllib.request.Request(f"{SEAFILE}{path}", data=body, method=method)
        request.add_header("Accept", "application/json")
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        with urllib.request.urlopen(request, timeout=40) as response:
            data = response.read(limit) if limit else response.read()
        return data if limit else json.loads(data.decode("utf-8") or "null")

    def call(self, path, limit=None, missing="Seafile has no file or library there."):
        token = getattr(self.request, "token", None)
        if not token:
            raise SignInRefused("My Own Suite has not signed in to Seafile yet.")
        try:
            return self.send("GET", path, headers={"Authorization": f"Token {token}"}, limit=limit)
        except urllib.error.HTTPError as error:
            if error.code == 401:
                raise SignInRefused("Seafile no longer accepts the sign-in My Own Suite had.") from None
            if error.code == 404:
                raise ToolError(missing) from None
            if error.code == 403:
                raise ToolError("The Seafile admin account may not read that.") from None
            if error.code == 429:
                raise ToolError("Seafile asks to slow down. Try again in a minute.") from None
            detail = error.read().decode("utf-8", "replace")[:300]
            raise ToolError(f"Seafile refused that (HTTP {error.code}): {detail}") from None
        except urllib.error.URLError:
            raise ToolError("Seafile is not answering right now. Try again in a minute.") from None

    def get(self, path, **query):
        return self.call(f"{path}?{urllib.parse.urlencode(query)}" if query else path)

    # The admin's libraries, own and shared, refreshed once a minute and kept only for the token that listed them.
    def library_list(self, fresh=False):
        token = getattr(self.request, "token", None)
        if not fresh and self.libraries and self.libraries[1] == token and time.monotonic() - self.libraries[0] < LIBRARY_TTL:
            return self.libraries[2]
        seen = {}
        for repo in self.get("/api/v2.1/repos/").get("repos") or []:
            seen.setdefault(repo["repo_id"], repo)
        self.libraries = (time.monotonic(), token, list(seen.values()))
        return self.libraries[2]

    def readable_libraries(self):
        return [repo for repo in self.library_list() if not repo.get("encrypted")]

    def library(self, wanted):
        wanted = text(wanted)
        if not wanted:
            raise ToolError("Name the library. list_libraries shows them.")
        matches = [repo for repo in self.library_list() if repo["repo_id"] == wanted]
        matches = matches or [repo for repo in self.library_list() if repo["repo_name"].casefold() == wanted.casefold()]
        if not matches:
            raise ToolError(f'Seafile has no library called "{wanted}". list_libraries shows the names it has.')
        if len(matches) > 1:
            raise ToolError(f'More than one library is called "{wanted}". Use its id from list_libraries.')
        if matches[0].get("encrypted"):
            raise ToolError(f'"{matches[0]["repo_name"]}" is encrypted, so MOS cannot read it.')
        return matches[0]


seafile = Seafile()


def text(value):
    return str(value or "").strip()


def day(value):
    return text(value)[:10] or "no date"


def size(value):
    amount = float(value or 0)
    for unit in ("bytes", "KB", "MB", "GB"):
        if amount < 1000 or unit == "GB":
            return f"{amount:.0f} {unit}" if unit == "bytes" else f"{amount:.1f} {unit}"
        amount /= 1000


def owner(repo):
    if repo.get("type") == "mine":
        return "yours"
    return f'shared by {text(repo.get("owner_name")) or text(repo.get("owner_email")) or "someone"}'


def list_libraries(_args):
    # Always asked of Seafile, so a sign-in it no longer accepts shows here at once.
    libraries = seafile.library_list(fresh=True)
    readable = sorted(seafile.readable_libraries(), key=lambda repo: repo["repo_name"].casefold())
    lines = [f'"{repo["repo_name"]}" · id {repo["repo_id"]} · {owner(repo)} · {size(repo.get("size"))} · changed {day(repo.get("last_modified"))}' for repo in readable]
    if not lines:
        lines.append("The admin account has no libraries it can read.")
    hidden = len(libraries) - len(readable)
    if hidden:
        lines.append(f'{hidden} encrypted {"library is" if hidden == 1 else "libraries are"} left out: MOS cannot read them.')
    return "\n".join(lines)


def search_files(args):
    query = text(args.get("query"))
    if not query:
        raise ToolError("Give a part of the file or folder name to look for.")
    limit = max(1, min(int(args.get("limit") or 20), SEARCH_LIMIT))
    libraries = [seafile.library(args["library"])] if text(args.get("library")) else seafile.readable_libraries()
    found = []
    for repo in libraries:
        for item in seafile.get("/api/v2.1/search-file/", repo_id=repo["repo_id"], q=query).get("data") or []:
            found.append((repo, item))
    if not found:
        return "No file or folder names match."
    found.sort(key=lambda hit: hit[1].get("mtime") or "", reverse=True)
    lines = [f'{len(found)} {"name matches" if len(found) == 1 else "names match"}, newest first:']
    for repo, item in found[:limit]:
        kind = "folder" if item.get("type") == "folder" else size(item.get("size"))
        lines.append(f'"{repo["repo_name"]}" {item["path"]} · {kind} · changed {day(item.get("mtime"))}')
    if len(found) > limit:
        lines.append(f"{len(found) - limit} more: narrow the name, or name one library.")
    return "\n".join(lines)


def read_file(args):
    repo = seafile.library(args.get("library"))
    path = "/" + text(args.get("path")).lstrip("/")
    offset = max(0, int(args.get("offset") or 0))
    where = urllib.parse.urlencode({"p": path})
    missing = f'"{repo["repo_name"]}" has no file at {path}.'
    detail = seafile.call(f'/api/v2.1/repos/{repo["repo_id"]}/file/?{where}', missing=missing)
    if int(detail.get("size") or 0) > READ_LIMIT:
        raise ToolError(f"{path} is {size(detail['size'])}, more than MOS reads as text.")
    link = seafile.call(f'/api2/repos/{repo["repo_id"]}/file/?{where}&reuse=0', missing=missing)
    # Seafile links to its public address; the same path answers on the package network.
    served = urllib.parse.urlsplit(link)
    data = seafile.call(urllib.parse.urlunsplit(("", "", served.path, served.query, "")), limit=READ_LIMIT + 1)
    try:
        if b"\0" in data:
            raise UnicodeError
        content = data.decode("utf-8-sig")
    except UnicodeError:
        raise ToolError(f"{path} is not a plain text file, so there is no text to read.") from None
    end = min(len(content), offset + TEXT_PAGE)
    lines = [f'"{repo["repo_name"]}" {path} · {size(detail.get("size"))} · changed {day(detail.get("mtime") or detail.get("last_modified"))}']
    if not content:
        lines.append("The file is empty.")
        return "\n".join(lines)
    lines.append(f"Text, characters {offset}-{end} of {len(content)}:")
    lines.append(content[offset:end])
    if end < len(content):
        lines.append(f"[More text: call again with offset {end}.]")
    return "\n".join(lines)


LIBRARY = {"type": "string", "description": "The library's name, or its id from list_libraries."}

TOOLS = {
    "list_libraries": (list_libraries, {
        "description": "List the Seafile libraries the admin account can read: its own and those shared with it. Encrypted libraries are left out.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True},
    }),
    "search_files": (search_files, {
        "description": "Find files and folders whose name contains the given words, in every readable library or in one. Searches names, not what is inside files.",
        "inputSchema": {"type": "object", "required": ["query"], "properties": {
            "query": {"type": "string", "description": "Part of the file or folder name, such as invoice or .md."},
            "library": LIBRARY,
            "limit": {"type": "integer", "minimum": 1, "maximum": SEARCH_LIMIT, "description": "How many to show, 20 unless set."},
        }},
        "annotations": {"readOnlyHint": True},
    }),
    "read_file": (read_file, {
        "description": "Read a plain text file, such as .txt, .md or .csv, from a library. Long text comes in parts; ask for the next part with offset.",
        "inputSchema": {"type": "object", "required": ["library", "path"], "properties": {
            "library": LIBRARY,
            "path": {"type": "string", "description": "The file's path in the library, as search_files shows it, such as /Notes/plan.md."},
            "offset": {"type": "integer", "minimum": 0, "description": "Where in the text to start, 0 unless set."},
        }},
        "annotations": {"readOnlyHint": True},
    }),
}


def tool_list():
    return [{"name": name, "title": name.replace("_", " ").capitalize(), **spec} for name, (_, spec) in TOOLS.items()]


def call_tool(params):
    name = params.get("name")
    if name not in TOOLS:
        return {"content": [{"type": "text", "text": f"Unknown tool {str(name)[:64]}."}], "isError": True}
    try:
        answer = TOOLS[name][0](params.get("arguments") or {})
        return {"content": [{"type": "text", "text": answer}], "isError": False}
    except SignInRefused as error:
        return {"content": [{"type": "text", "text": str(error)}], "isError": True, "_meta": SIGN_IN_REFUSED}
    except ToolError as error:
        return {"content": [{"type": "text", "text": str(error)}], "isError": True}
    except (KeyError, TypeError, ValueError):
        return {"content": [{"type": "text", "text": "Those arguments do not fit this tool. Check the library, the path and the field names."}], "isError": True}


def answer(message):
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        return {
            "capabilities": {"tools": {}},
            "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
            "serverInfo": {"name": "mos-seafile", "version": "1"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": tool_list()}
    if method == "tools/call":
        return call_tool(params)
    raise LookupError(method)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorised(self):
        presented = self.headers.get("Authorization", "")
        return bool(MOS_KEY) and hmac.compare_digest(presented.encode(), f"Bearer {MOS_KEY}".encode())

    def do_GET(self):
        self.reply(405, {"error": "Send MCP messages with POST."})

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > BODY_LIMIT:
            raise OverflowError
        return json.loads(self.rfile.read(length) or b"null")

    def do_POST(self):
        route = self.path.split("?")[0]
        if route not in ("/mcp", "/sign-in"):
            return self.reply(404, {"error": "Not found."})
        if not self.authorised():
            return self.reply(401, {"error": "Only My Own Suite may call this server."})
        try:
            message = self.read_json()
        except OverflowError:
            return self.reply(413, {"error": "Too large."})
        except ValueError:
            return self.reply(400, {"error": {"code": -32700, "message": "Not JSON."}, "id": None, "jsonrpc": "2.0"})
        if route == "/sign-in":
            return self.sign_in(message)
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return self.reply(400, {"error": {"code": -32600, "message": "Not a JSON-RPC 2.0 request."}, "id": None, "jsonrpc": "2.0"})
        if message.get("id") is None:
            return self.reply(202)
        seafile.request.token = self.headers.get("X-MOS-App-Token") or None
        try:
            return self.reply(200, {"id": message["id"], "jsonrpc": "2.0", "result": answer(message)})
        except LookupError:
            return self.reply(200, {"error": {"code": -32601, "message": f"Unsupported method {str(message.get('method'))[:64]}."}, "id": message["id"], "jsonrpc": "2.0"})

    # The password is used for this one exchange and never kept.
    def sign_in(self, message):
        password = message.get("password") if isinstance(message, dict) else None
        if not isinstance(password, str) or not password:
            return self.reply(400, {"error": "Send the password as {\"password\": ...}."})
        try:
            token = seafile.exchange(password)
        except ToolError as error:
            return self.reply(403, {"error": str(error)})
        except (urllib.error.URLError, ValueError):
            return self.reply(503, {"error": "Seafile is not answering right now. Try again in a minute."})
        if not token:
            return self.reply(401, {"error": f"Seafile did not accept that password for {EMAIL}."})
        return self.reply(200, {"token": token})

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
