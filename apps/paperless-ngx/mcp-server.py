"""The tools MOS offers an owner's AI for Paperless-ngx, as a small MCP server.

Only MOS calls it, with the key MOS generated for this package. It never holds a
password: MOS passes the owner's password to /sign-in once, gets the owner's
Paperless API token back, and sends that token with every call. It reaches nothing
but the Paperless API.
"""

import base64
import hmac
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API = os.environ.get("PAPERLESS_API", "http://paperless:8000/api").rstrip("/")
USERNAME = os.environ.get("PAPERLESS_ADMIN_USER", "")
MOS_KEY = os.environ.get("MOS_AI_KEY", "")
PORT = int(os.environ.get("PORT", "8100"))

# Paperless keeps an API version working after it adds a newer one, so pinning it
# means an update breaks these tools only when Paperless drops this version.
API_VERSION = 10
PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"]
BODY_LIMIT = 1_000_000
TEXT_PAGE = 12_000
SEARCH_LIMIT = 25
LABEL_TTL = 60
NONE_MATCHING = 0  # Paperless's "None" matching, so a label made here never files documents by itself.


class ToolError(Exception):
    pass


class SignInRefused(ToolError):
    pass


# MOS reads this from a tool result and asks the owner to sign in again.
SIGN_IN_REFUSED = {"myownsuite.org/sign-in": "refused"}


class Paperless:
    def __init__(self):
        self.labels = {}
        self.request = threading.local()

    def exchange(self, password):
        """The owner's Paperless API token, or None when Paperless refuses the password."""
        body = urllib.parse.urlencode({"username": USERNAME, "password": password}).encode()
        try:
            return self.send("POST", "/token/", body, {"Content-Type": "application/x-www-form-urlencoded"})["token"]
        except urllib.error.HTTPError as error:
            if error.code in (400, 401, 403):
                return None
            raise

    def send(self, method, path, body=None, headers=None):
        request = urllib.request.Request(f"{API}{path}", data=body, method=method)
        request.add_header("Accept", f"application/json; version={API_VERSION}")
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                text = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            if error.code == 406:
                raise ToolError(f"This Paperless no longer accepts API version {API_VERSION}, which these tools are written for.") from None
            raise
        return json.loads(text) if text else None

    def call(self, method, path, payload=None):
        token = getattr(self.request, "token", None)
        if not token:
            raise SignInRefused("My Own Suite has not signed in to Paperless yet.")
        headers = {"Authorization": f"Token {token}"}
        body = None if payload is None else json.dumps(payload).encode()
        if body is not None:
            headers["Content-Type"] = "application/json"
        try:
            return self.send(method, path, body, headers)
        except urllib.error.HTTPError as error:
            if error.code == 401:
                raise SignInRefused("Paperless no longer accepts the sign-in My Own Suite had.") from None
            if error.code == 404:
                raise ToolError("Paperless has no document with that number.") from None
            detail = error.read().decode("utf-8", "replace")[:300]
            raise ToolError(f"Paperless refused that (HTTP {error.code}): {detail}") from None
        except urllib.error.URLError:
            raise ToolError("Paperless is not answering right now. Try again in a minute.") from None

    def get(self, path, **query):
        query = {key: value for key, value in query.items() if value is not None}
        return self.call("GET", f"{path}?{urllib.parse.urlencode(query)}" if query else path)

    # Tags, correspondents and document types by id, refreshed once a minute.
    def label_map(self, kind):
        cached = self.labels.get(kind)
        if cached and time.monotonic() - cached[0] < LABEL_TTL:
            return cached[1]
        names = {item["id"]: item["name"] for item in self.get(f"/{kind}/", page_size=100000)["results"]}
        self.labels[kind] = (time.monotonic(), names)
        return names

    def label_id(self, kind, name, create=False):
        wanted = name.strip().casefold()
        for label_id, label_name in self.label_map(kind).items():
            if label_name.casefold() == wanted:
                return label_id
        if not create:
            return None
        made = self.call("POST", f"/{kind}/", {"matching_algorithm": NONE_MATCHING, "name": name.strip()})
        self.labels.pop(kind, None)
        return made["id"]


paperless = Paperless()


def text(value):
    return str(value or "").strip()


def plain(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", html or "")).strip()


def day(value):
    return text(value)[:10] or "no date"


def describe(document):
    tags = paperless.label_map("tags")
    correspondents = paperless.label_map("correspondents")
    types = paperless.label_map("document_types")
    parts = [f'#{document["id"]} "{text(document.get("title"))}"', day(document.get("created"))]
    if document.get("correspondent"):
        parts.append(f'from {correspondents.get(document["correspondent"], "?")}')
    if document.get("document_type"):
        parts.append(types.get(document["document_type"], "?"))
    names = [tags.get(tag, "?") for tag in document.get("tags") or []]
    if names:
        parts.append("tags: " + ", ".join(names))
    return " · ".join(parts)


def search_documents(args):
    query = text(args.get("query"))
    limit = max(1, min(int(args.get("limit") or 10), SEARCH_LIMIT))
    page = max(1, int(args.get("page") or 1))
    filters = {"page": page, "page_size": limit, "truncate_content": "true"}
    if query:
        filters["query"] = query
    else:
        filters["ordering"] = "-created"
    for argument, kind, field in (("tag", "tags", "tags__id__all"), ("correspondent", "correspondents", "correspondent__id"), ("document_type", "document_types", "document_type__id")):
        name = text(args.get(argument))
        if not name:
            continue
        label_id = paperless.label_id(kind, name)
        if label_id is None:
            return f'Paperless has no {argument.replace("_", " ")} called "{name}". list_labels shows the names it has.'
        filters[field] = label_id
    if text(args.get("created_after")):
        filters["created__gte"] = text(args.get("created_after"))
    if text(args.get("created_before")):
        filters["created__lte"] = text(args.get("created_before"))

    found = paperless.get("/documents/", **filters)
    results = found.get("results") or []
    if not results:
        return "No documents match."
    first = (page - 1) * limit + 1
    count = found["count"]
    lines = [f'{count} {"document matches" if count == 1 else "documents match"}. Showing {first}-{first + len(results) - 1}:']
    for document in results:
        lines.append(describe(document))
        hit = document.get("__search_hit__") or {}
        excerpt = plain(hit.get("highlights")) or plain(document.get("content"))[:200]
        if excerpt:
            lines.append(f"  {excerpt}")
    if found.get("next"):
        lines.append(f"More results: call again with page {page + 1}.")
    return "\n".join(lines)


def get_document(args):
    document = paperless.get(f'/documents/{int(args["document_id"])}/')
    offset = max(0, int(args.get("offset") or 0))
    content = document.get("content") or ""
    lines = [describe(document)]
    pages = f' · {document["page_count"]} pages' if document.get("page_count") else ""
    lines.append(f'Added {day(document.get("added"))}{pages} · original file {text(document.get("original_file_name")) or "unknown"}')
    for note in document.get("notes") or []:
        lines.append(f'Note ({day(note.get("created"))}): {text(note.get("note"))}')
    if not content:
        lines.append("Paperless has no text for this document.")
        return "\n".join(lines)
    end = min(len(content), offset + TEXT_PAGE)
    lines.append(f"Text, characters {offset}-{end} of {len(content)}:")
    lines.append(content[offset:end])
    if end < len(content):
        lines.append(f"[More text: call again with offset {end}.]")
    return "\n".join(lines)


def list_labels(_args):
    lines = []
    for kind, title in (("tags", "Tags"), ("correspondents", "Correspondents"), ("document_types", "Document types")):
        names = sorted(paperless.label_map(kind).values(), key=str.casefold)
        lines.append(f'{title}: {", ".join(names) if names else "none yet"}')
    return "\n".join(lines)


def add_note(args):
    note = text(args.get("note"))
    if not note:
        raise ToolError("Write the note to add.")
    document_id = int(args["document_id"])
    paperless.call("POST", f"/documents/{document_id}/notes/", {"note": note[:5000]})
    return f"Added the note to document #{document_id}."


def update_document(args):
    document_id = int(args["document_id"])
    current = paperless.get(f"/documents/{document_id}/")
    change = {}
    if text(args.get("title")):
        change["title"] = text(args["title"])[:128]
    if text(args.get("created")):
        change["created"] = text(args["created"])
    for argument, kind in (("correspondent", "correspondents"), ("document_type", "document_types")):
        if argument in args and args[argument] is not None:
            name = text(args[argument])
            change[argument] = paperless.label_id(kind, name, create=True) if name else None
    adding = [text(name) for name in args.get("add_tags") or [] if text(name)]
    removing = {text(name).casefold() for name in args.get("remove_tags") or [] if text(name)}
    if adding or removing:
        names = paperless.label_map("tags")
        tags = [tag for tag in current.get("tags") or [] if names.get(tag, "").casefold() not in removing]
        for name in adding:
            tag = paperless.label_id("tags", name, create=True)
            if tag not in tags:
                tags.append(tag)
        change["tags"] = tags
    if not change:
        raise ToolError("Say what to change: title, created, correspondent, document_type, add_tags or remove_tags.")
    updated = paperless.call("PATCH", f"/documents/{document_id}/", change)
    return f"Updated. Now: {describe(updated)}"


DOCUMENT_ID = {"type": "integer", "description": "The document number, as search_documents shows it after #."}

TOOLS = {
    "search_documents": (search_documents, {
        "description": "Find documents in Paperless. With a query, searches the text read off every page, titles, notes and labels, best match first. Without one, lists the newest documents. Filters narrow either.",
        "inputSchema": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Words to search for, such as a name, an amount or a policy number."},
            "tag": {"type": "string", "description": "Only documents with this tag."},
            "correspondent": {"type": "string", "description": "Only documents from this sender."},
            "document_type": {"type": "string", "description": "Only documents of this type."},
            "created_after": {"type": "string", "description": "Only documents dated on or after this day, as YYYY-MM-DD."},
            "created_before": {"type": "string", "description": "Only documents dated on or before this day, as YYYY-MM-DD."},
            "limit": {"type": "integer", "minimum": 1, "maximum": SEARCH_LIMIT, "description": "How many to show, 10 unless set."},
            "page": {"type": "integer", "minimum": 1},
        }},
        "annotations": {"readOnlyHint": True},
    }),
    "get_document": (get_document, {
        "description": "Read one document: its labels, notes and the text Paperless read off its pages. Long text comes in parts; ask for the next part with offset.",
        "inputSchema": {"type": "object", "required": ["document_id"], "properties": {
            "document_id": DOCUMENT_ID,
            "offset": {"type": "integer", "minimum": 0, "description": "Where in the text to start, 0 unless set."},
        }},
        "annotations": {"readOnlyHint": True},
    }),
    "list_labels": (list_labels, {
        "description": "List the tags, correspondents (senders) and document types Paperless files documents under.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": True},
    }),
    "add_note": (add_note, {
        "description": "Add a note to a document, such as a summary or a reminder of what to do about it.",
        "inputSchema": {"type": "object", "required": ["document_id", "note"], "properties": {
            "document_id": DOCUMENT_ID,
            "note": {"type": "string", "maxLength": 5000},
        }},
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    }),
    "update_document": (update_document, {
        "description": "Change how a document is filed: its title, date, sender, type or tags. A sender, type or tag that does not exist yet is created. Only the fields given change.",
        "inputSchema": {"type": "object", "required": ["document_id"], "properties": {
            "document_id": DOCUMENT_ID,
            "title": {"type": "string", "maxLength": 128},
            "created": {"type": "string", "description": "The document's own date, as YYYY-MM-DD."},
            "correspondent": {"type": "string", "description": "The sender's name. An empty string clears it."},
            "document_type": {"type": "string", "description": "The type's name. An empty string clears it."},
            "add_tags": {"type": "array", "items": {"type": "string"}},
            "remove_tags": {"type": "array", "items": {"type": "string"}},
        }},
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True},
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
        return {"content": [{"type": "text", "text": "Those arguments do not fit this tool. Check the document number and the field names."}], "isError": True}


def answer(message):
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        asked = params.get("protocolVersion")
        return {
            "capabilities": {"tools": {}},
            "protocolVersion": asked if asked in PROTOCOLS else PROTOCOLS[0],
            "serverInfo": {"name": "mos-paperless", "version": "1"},
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
        paperless.request.token = self.headers.get("X-MOS-App-Token") or None
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
            token = paperless.exchange(password)
        except (urllib.error.URLError, ToolError):
            return self.reply(503, {"error": "Paperless is not answering right now. Try again in a minute."})
        if not token:
            return self.reply(401, {"error": f"Paperless did not accept that password for {USERNAME}."})
        return self.reply(200, {"token": token})

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
