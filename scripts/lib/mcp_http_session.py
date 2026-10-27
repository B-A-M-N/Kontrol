"""Small HTTP MCP session owner for the native Hermes bounded-write path."""
import json
import urllib.error
import urllib.request


class McpHttpError(RuntimeError):
    def __init__(self, status, detail):
        super().__init__(f"MCP HTTP {status}: {detail}")
        self.status = status


class McpSessionExpired(McpHttpError):
    pass


class McpConnectionError(RuntimeError):
    pass


class McpHttpSession:
    def __init__(self, url, headers, opener=None, timeout=30):
        self.url = url
        self.headers = dict(headers)
        self.opener = opener or urllib.request.urlopen
        self.timeout = timeout
        self.session_id = None
        self.rpc_id = 0

    @staticmethod
    def _parse(raw, content_type):
        if "text/event-stream" not in content_type:
            return json.loads(raw) if raw.strip() else None
        message = None
        for line in raw.splitlines():
            if not line.startswith("data:"):
                continue
            value = line[5:].strip()
            if not value:
                continue
            parsed = json.loads(value)
            if "method" in parsed and "id" not in parsed:
                continue
            message = parsed
        return message

    def _rpc_once(self, method, params=None, notification=False):
        body = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notification:
            self.rpc_id += 1
            body["id"] = self.rpc_id
        request_headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", **self.headers}
        if self.session_id:
            request_headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(self.url, data=json.dumps(body).encode("utf-8"), headers=request_headers, method="POST")
        try:
            with self.opener(request, timeout=self.timeout) as response:
                content_type = response.headers.get("Content-Type", "")
                raw = response.read().decode("utf-8")
                received_session = response.headers.get("Mcp-Session-Id")
                if received_session:
                    self.session_id = received_session
                if notification:
                    if response.status not in (200, 202, 204):
                        raise McpHttpError(response.status, method)
                    return None
                result = self._parse(raw, content_type)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            if error.code == 404:
                raise McpSessionExpired(error.code, detail or "MCP session expired") from error
            raise McpHttpError(error.code, detail) from error
        except urllib.error.URLError as error:
            raise McpConnectionError(f"MCP connection failed: {error.reason}") from error
        if not result:
            raise RuntimeError(f"MCP {method} returned no JSON-RPC response")
        if result.get("error"):
            raise RuntimeError(f"MCP JSON-RPC error: {result['error']}")
        return result.get("result", {})

    def initialize(self):
        self.session_id = None
        result = self._rpc_once("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "kontrol-hermes-runner", "version": "1.0.0"},
        })
        self._rpc_once("notifications/initialized", {}, notification=True)
        return result

    def rpc(self, method, params=None, notification=False, retry_safe=False):
        try:
            return self._rpc_once(method, params, notification)
        except McpSessionExpired as error:
            if not self.session_id:
                raise
            self.session_id = None
            self.initialize()
            if retry_safe:
                return self._rpc_once(method, params, notification)
            raise McpSessionExpired(error.status, "Session expired; a fresh session was initialized. Reconcile the operation before retrying.") from error
