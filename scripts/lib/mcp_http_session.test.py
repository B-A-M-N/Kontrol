import json
import urllib.error
from email.message import Message

from mcp_http_session import McpConnectionError, McpHttpError, McpHttpSession, McpSessionExpired


class Response:
    def __init__(self, body="{}", status=200, session_id=None):
        self.body = body.encode()
        self.status = status
        self.headers = Message()
        self.headers["Content-Type"] = "application/json"
        if session_id:
            self.headers["Mcp-Session-Id"] = session_id

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


def result(value, session_id=None):
    return Response(json.dumps({"jsonrpc": "2.0", "id": 1, "result": value}), session_id=session_id)


requests = []
responses = [
    result({"protocolVersion": "2025-06-18"}, "old-session"),
    Response("", 202),
    urllib.error.HTTPError("http://kontrol/mcp", 404, "unknown session", {}, None),
    result({"protocolVersion": "2025-06-18"}, "fresh-session"),
    Response("", 202),
]


def opener(request, timeout):
    requests.append(request)
    value = responses.pop(0)
    if isinstance(value, Exception):
        raise value
    return value


session = McpHttpSession("http://kontrol/mcp", {"X-Kontrol-Worker-Token": "signed-worker"}, opener=opener)
session.initialize()
try:
    session.rpc("tools/call", {"name": "staged_file_write", "arguments": {"path": "report.txt", "content": "x"}})
    raise AssertionError("expired-session mutation must not be replayed")
except McpSessionExpired as error:
    assert "Reconcile" in str(error)

assert session.session_id == "fresh-session"
assert len(requests) == 5, "write is not replayed after session recovery"
assert requests[2].get_header("Mcp-session-id") == "old-session"
assert requests[3].get_header("Mcp-session-id") is None
assert requests[3].get_header("X-kontrol-worker-token") == "signed-worker"

print("mcp_http_session.test.py: fresh-session recovery and no-write-replay assertions passed")

for status in (401, 429, 503):
    def failing_opener(_request, timeout, status=status):
        raise urllib.error.HTTPError("http://kontrol/mcp", status, "failure", {}, None)

    failing_session = McpHttpSession("http://kontrol/mcp", {}, opener=failing_opener)
    try:
        failing_session.rpc("tools/list", retry_safe=True)
        raise AssertionError(f"HTTP {status} must be surfaced")
    except McpHttpError as error:
        assert error.status == status

reset_session = McpHttpSession(
    "http://kontrol/mcp",
    {},
    opener=lambda _request, timeout: (_ for _ in ()).throw(urllib.error.URLError("connection reset")),
)
try:
    reset_session.rpc("tools/list", retry_safe=True)
    raise AssertionError("connection reset must be surfaced")
except McpConnectionError:
    pass

print("mcp_http_session.test.py: auth, throttling, availability, and reset classifications passed")
