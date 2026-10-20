#!/usr/bin/env python3
"""Run one Hermes native-ACP turn and emit JSONL events for Kontrol.

This talks to Hermes through the public ACP Python SDK.
It does not wrap ``hermes chat`` and it does not enable ``--yolo``. Kontrol
owns the outer review barrier after the turn completes.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import uuid
from pathlib import Path


def emit(payload: dict) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


async def main() -> int:
    raw = os.environ.get("KONTROL_HERMES_NATIVE_INPUT")
    if not raw:
        emit({"type": "error", "error": "missing KONTROL_HERMES_NATIVE_INPUT"})
        return 2
    spec = json.loads(raw)

    hermes_root = Path(os.environ.get("HERMES_AGENT_ROOT", os.getcwd()))
    sys.path.insert(0, str(hermes_root))

    pending_permissions: dict[str, asyncio.Future[dict]] = {}
    response_text: list[str] = []
    thought_text: list[str] = []
    streaming_usage: dict = {}

    def dump_acp(value):
        if hasattr(value, "model_dump"):
            return value.model_dump(mode="json", by_alias=True, exclude_none=True)
        if isinstance(value, list):
            return [dump_acp(item) for item in value]
        if isinstance(value, dict):
            return {key: dump_acp(item) for key, item in value.items()}
        return value

    def read_adapter_responses(loop: asyncio.AbstractEventLoop) -> None:
        def deliver(msg: dict) -> None:
            if msg.get("type") != "permission_response":
                return
            request_id = str(msg.get("requestId") or "")
            future = pending_permissions.get(request_id)
            if future and not future.done():
                future.set_result(msg)

        while True:
            line = sys.stdin.readline()
            if not line:
                return
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if isinstance(msg, dict):
                loop.call_soon_threadsafe(deliver, msg)

    class KontrolACPClient:
        def on_connect(self, _conn) -> None:
            return None

        async def request_permission(self, options, session_id: str, tool_call, **_kwargs):
            from acp.schema import AllowedOutcome, DeniedOutcome, RequestPermissionResponse

            request_id = f"perm_{uuid.uuid4()}"
            loop = asyncio.get_running_loop()
            future: asyncio.Future[dict] = loop.create_future()
            pending_permissions[request_id] = future

            emit({
                "type": "permission_request",
                "requestId": request_id,
                "sessionId": session_id,
                "toolCall": dump_acp(tool_call),
                "options": dump_acp(options),
            })

            # No timeout: a human may step away for hours. Like the CLI coding
            # agents, the tool call parks until the reviewer responds (or the
            # session is explicitly cancelled, which cancels this future). A
            # timeout that auto-denies would silently drop the agent's work.
            try:
                response = await future
            except asyncio.CancelledError:
                return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))
            finally:
                pending_permissions.pop(request_id, None)

            if response.get("approved"):
                option_id = str(response.get("optionId") or "")
                allowed = {str(option.get("optionId") or option.get("option_id") or "") for option in dump_acp(options)}
                if option_id in allowed:
                    return RequestPermissionResponse(outcome=AllowedOutcome(option_id=option_id, outcome="selected"))
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))

        async def session_update(self, session_id: str, update, **_kwargs) -> None:
            data = dump_acp(update)
            update_type = str(data.get("sessionUpdate") or data.get("type") or "") if isinstance(data, dict) else ""
            content = data.get("content") if isinstance(data, dict) else None
            text = content.get("text", "") if isinstance(content, dict) else ""
            if update_type == "agent_message_chunk" and isinstance(text, str):
                response_text.append(text)
            elif update_type == "agent_thought_chunk" and isinstance(text, str):
                thought_text.append(text)
            elif update_type == "usage_update":
                streaming_usage.update(data)
            emit({"type": "raw_update", "params": {"sessionId": session_id, "update": data}})

        async def write_text_file(self, **kwargs):
            from acp.schema import WriteTextFileResponse

            if os.environ.get("KONTROL_BOUNDED_FILE_WRITE") != "1" or os.environ.get("KONTROL_READ_ONLY_EXECUTION") == "1":
                emit({"type": "error", "error": "write_text_file is unavailable outside a signed bounded-write execution"})
                raise RuntimeError("write_text_file is unavailable outside a signed bounded-write execution")

            path = kwargs.get("path")
            content = kwargs.get("content")
            if not isinstance(path, str) or not isinstance(content, str):
                emit({"type": "error", "error": "write_text_file requires string path and content"})
                raise RuntimeError("write_text_file requires string path and content")

            mcp_url = os.environ.get("KONTROL_MCP_URL")
            worker_token = os.environ.get("KONTROL_WORKER_TOKEN")
            workspace_session_id = os.environ.get("KONTROL_WORKSPACE_SESSION_ID")
            work_session_id = os.environ.get("KONTROL_WORK_SESSION_ID")
            if not mcp_url or not worker_token or not workspace_session_id:
                emit({"type": "error", "error": "Kontrol bounded-write MCP environment is incomplete"})
                raise RuntimeError("Kontrol bounded-write MCP environment is incomplete")

            # Initialize MCP session and call open_workspace + staged_file_write.
            try:
                import urllib.request
                import urllib.error

                headers = {
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    "X-Kontrol-Worker-Token": worker_token,
                }
                mcp_session_id = None
                rpc_id = 0

                def parse_rpc_payload(raw: str, content_type: str) -> dict | None:
                    if "text/event-stream" not in content_type:
                        return json.loads(raw) if raw.strip() else None
                    message: dict | None = None
                    for raw_line in raw.splitlines():
                        if not raw_line.startswith("data:"):
                            continue
                        value = raw_line[5:].strip()
                        if not value:
                            continue
                        parsed = json.loads(value)
                        if "method" in parsed and "id" not in parsed:
                            continue
                        message = parsed
                    return message

                def mcp_rpc(method: str, params: dict | None = None, notification: bool = False) -> dict | None:
                    nonlocal mcp_session_id, rpc_id
                    body: dict = {"jsonrpc": "2.0", "method": method}
                    if notification:
                        body["params"] = params or {}
                    else:
                        rpc_id += 1
                        body["id"] = rpc_id
                        body["params"] = params
                    req_headers = dict(headers)
                    if mcp_session_id:
                        req_headers["Mcp-Session-Id"] = mcp_session_id
                    req = urllib.request.Request(
                        mcp_url,
                        data=json.dumps(body).encode("utf-8"),
                        headers=req_headers,
                        method="POST",
                    )
                    try:
                        with urllib.request.urlopen(req, timeout=30) as resp:
                            content_type = resp.headers.get("Content-Type", "")
                            raw = resp.read().decode("utf-8")
                            session_id = resp.headers.get("Mcp-Session-Id")
                            if session_id:
                                mcp_session_id = session_id
                            if notification:
                                if resp.status not in (200, 202, 204):
                                    raise RuntimeError(f"MCP {method} failed: HTTP {resp.status}")
                                return None
                            result = parse_rpc_payload(raw, content_type)
                    except urllib.error.HTTPError as exc:
                        detail = exc.read().decode("utf-8", errors="replace")
                        raise RuntimeError(f"MCP {method} failed: HTTP {exc.code}: {detail}") from exc
                    if not result:
                        raise RuntimeError(f"MCP {method} returned no JSON-RPC response")
                    if result.get("error"):
                        raise RuntimeError(f"MCP error: {result['error']}")
                    return result.get("result", {})

                # Initialize
                mcp_rpc("initialize", {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "kontrol-hermes-runner", "version": "1.0.0"},
                })
                mcp_rpc("notifications/initialized", {}, notification=True)

                # Reuse the signed workspace identity; /workspace is only the
                # sandbox alias and is not a registered host workspace path.
                workspace_id = workspace_session_id

                # Staged file write
                write_result = mcp_rpc("tools/call", {
                    "name": "staged_file_write",
                    "arguments": {
                        "workspaceId": workspace_id,
                        "path": path,
                        "content": content,
                    },
                })
                write_sc = write_result.get("structuredContent") or {}
                if write_result.get("isError"):
                    text = "\n".join(
                        part.get("text", "")
                        for part in write_result.get("content", [])
                        if isinstance(part, dict)
                    )
                    raise RuntimeError(f"staged_file_write failed: {text}")
                emit({
                    "type": "kontrol_bounded_write",
                    "path": path,
                    "sha256": write_sc.get("contentSha256"),
                    "workspaceId": workspace_id,
                })
                return WriteTextFileResponse()
            except Exception as exc:
                emit({"type": "error", "error": f"bounded write failed: {exc}"})
                raise

        async def read_text_file(self, **_kwargs):
            raise RuntimeError("Kontrol native bridge does not expose client-side file reads")

        async def create_terminal(self, **_kwargs):
            raise RuntimeError("Kontrol native bridge does not expose client-side terminals")

        async def terminal_output(self, **_kwargs):
            raise RuntimeError("Kontrol native bridge does not expose client-side terminals")

        async def release_terminal(self, **_kwargs):
            return None

        async def wait_for_terminal_exit(self, **_kwargs):
            raise RuntimeError("Kontrol native bridge does not expose client-side terminals")

        async def kill_terminal(self, **_kwargs):
            return None

        async def ext_method(self, method: str, params: dict):
            raise RuntimeError(f"Unsupported ACP client method: {method}")

        async def ext_notification(self, method: str, params: dict) -> None:
            emit({"type": "raw_request", "method": method, "params": params})

    try:
        from acp.core import connect_to_agent
        from acp.meta import PROTOCOL_VERSION
        from acp.schema import ClientCapabilities, FileSystemCapabilities, Implementation, TextContentBlock
    except Exception as exc:  # pragma: no cover - exercised by integration env
        emit({"type": "error", "error": f"failed to import public ACP SDK: {exc}"})
        return 3

    env = dict(os.environ)
    command = spec.get("command") or "hermes"
    args = spec.get("args") or []
    cwd = spec.get("cwd") or os.getcwd()
    max_run_seconds = positive_duration(
        spec.get("maxRunSeconds") or os.environ.get("KONTROL_HERMES_MAX_RUN_SECONDS"),
        2 * 60 * 60,
    )
    # Keep request-level timeouts under the same configurable outer ceiling.
    # The old fixed 30-minute default could kill a healthy long-running test
    # or tool operation.
    timeout = positive_duration(spec.get("timeoutSeconds"), max_run_seconds)

    try:
        loop = asyncio.get_running_loop()
        threading.Thread(target=read_adapter_responses, args=(loop,), name="kontrol-adapter-responses", daemon=True).start()
        process = await asyncio.create_subprocess_exec(
            command,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=cwd,
            limit=10 * 1024 * 1024,
        )
        if process.stdout is None or process.stdin is None:
            raise RuntimeError("Hermes ACP subprocess did not expose both stdio pipes")
        stderr_task = None
        if process.stderr is not None:
            async def forward_stderr() -> None:
                while chunk := await process.stderr.read(64 * 1024):
                    sys.stderr.buffer.write(chunk)
                    sys.stderr.buffer.flush()
            stderr_task = asyncio.create_task(forward_stderr())

        connection = None
        try:
            client = KontrolACPClient()
            connection = connect_to_agent(
                client=client,
                input_stream=process.stdin,
                output_stream=process.stdout,
                use_unstable_protocol=True,
            )
            try:
                await connection.initialize(
                    protocol_version=PROTOCOL_VERSION,
                    client_capabilities=ClientCapabilities(fs=FileSystemCapabilities(write_text_file=True)),
                    client_info=Implementation(name="kontrol-hermes-runner", version="1.0.0"),
                )
                session = await connection.new_session(cwd=cwd, mcp_servers=[])
                prompt = str(spec.get("task") or "")
                result = await asyncio.wait_for(
                    connection.prompt(
                        prompt=[TextContentBlock(type="text", text=prompt)],
                        session_id=session.session_id,
                    ),
                    timeout=min(timeout, max_run_seconds),
                )
            except asyncio.TimeoutError:
                emit({"type": "error", "error": f"ACP prompt exceeded its {min(timeout, max_run_seconds):.0f}s deadline (absolute run ceiling: {max_run_seconds:.0f}s)"})
                return 1
        finally:
            if connection is not None:
                await connection.close()
            if process.stdin and not process.stdin.is_closing():
                process.stdin.close()
                try:
                    await process.stdin.wait_closed()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                if process.returncode is None:
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    if process.returncode is None:
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                    await process.wait()
            if stderr_task is not None:
                try:
                    await asyncio.wait_for(stderr_task, timeout=2.0)
                except asyncio.TimeoutError:
                    stderr_task.cancel()
                    try:
                        await stderr_task
                    except asyncio.CancelledError:
                        pass
    except Exception as exc:
        emit({"type": "error", "error": f"{type(exc).__name__}: {exc}"})
        return 1

    stop_reason = getattr(result.stop_reason, "value", result.stop_reason)
    emit({
        "type": "complete",
        "responseText": "".join(response_text),
        "thoughtText": "".join(thought_text),
        "usage": dump_acp(result.usage) if getattr(result, "usage", None) else streaming_usage,
        "stopReason": stop_reason,
    })
    return 0


def positive_duration(value, fallback: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
