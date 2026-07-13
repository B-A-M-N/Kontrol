#!/usr/bin/env python3
"""Run one Hermes native-ACP turn and emit JSONL events for DevSpace.

This intentionally talks to ``hermes acp`` through Hermes's ACP client helper.
It does not wrap ``hermes chat`` and it does not enable ``--yolo``. DevSpace
owns the outer review barrier after the turn completes.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path


def emit(payload: dict) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


async def main() -> int:
    raw = os.environ.get("DEVDESKTOP_HERMES_NATIVE_INPUT")
    if not raw:
        emit({"type": "error", "error": "missing DEVDESKTOP_HERMES_NATIVE_INPUT"})
        return 2
    spec = json.loads(raw)

    hermes_root = Path(os.environ.get("HERMES_AGENT_ROOT", "/home/bamn/hermes-agent"))
    sys.path.insert(0, str(hermes_root))

    pending_permissions: dict[str, asyncio.Future[dict]] = {}
    stdin_task: asyncio.Task | None = None

    async def read_adapter_responses() -> None:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                return
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("type") != "permission_response":
                continue
            request_id = str(msg.get("requestId") or "")
            future = pending_permissions.get(request_id)
            if future and not future.done():
                future.set_result(msg)

    class DevSpaceACPClient:
        def on_connect(self, _conn) -> None:
            return None

        async def request_permission(self, options, session_id: str, tool_call, **_kwargs):
            from acp.schema import AllowedOutcome, DeniedOutcome, RequestPermissionResponse

            request_id = f"perm_{uuid.uuid4()}"
            loop = asyncio.get_running_loop()
            future: asyncio.Future[dict] = loop.create_future()
            pending_permissions[request_id] = future

            def dump(value):
                if hasattr(value, "model_dump"):
                    return value.model_dump(mode="json", by_alias=True, exclude_none=True)
                if isinstance(value, list):
                    return [dump(item) for item in value]
                return value

            emit({
                "type": "permission_request",
                "requestId": request_id,
                "sessionId": session_id,
                "toolCall": dump(tool_call),
                "options": dump(options),
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
                allowed = {str(option.get("optionId") or option.get("option_id") or "") for option in dump(options)}
                if option_id in allowed:
                    return RequestPermissionResponse(outcome=AllowedOutcome(option_id=option_id, outcome="selected"))
            return RequestPermissionResponse(outcome=DeniedOutcome(outcome="cancelled"))

        async def session_update(self, **_kwargs) -> None:
            return None

        async def write_text_file(self, **_kwargs):
            return None

        async def read_text_file(self, **_kwargs):
            raise RuntimeError("DevSpace native bridge does not expose client-side file reads")

        async def create_terminal(self, **_kwargs):
            raise RuntimeError("DevSpace native bridge does not expose client-side terminals")

        async def terminal_output(self, **_kwargs):
            raise RuntimeError("DevSpace native bridge does not expose client-side terminals")

        async def release_terminal(self, **_kwargs):
            return None

        async def wait_for_terminal_exit(self, **_kwargs):
            raise RuntimeError("DevSpace native bridge does not expose client-side terminals")

        async def kill_terminal(self, **_kwargs):
            return None

        async def ext_method(self, method: str, params: dict):
            raise RuntimeError(f"Unsupported ACP client method: {method}")

        async def ext_notification(self, method: str, params: dict) -> None:
            emit({"type": "raw_request", "method": method, "params": params})

    try:
        import acp
        from acp.connection import StreamDirection, StreamEvent
        from acp_adapter.client import ACPClient, TaskEvent
    except Exception as exc:  # pragma: no cover - exercised by integration env
        emit({"type": "error", "error": f"failed to import Hermes ACP client: {exc}"})
        return 3

    original_connect_to_agent = acp.connect_to_agent

    def connect_to_agent_with_devspace_client(client, *args, **kwargs):
        return original_connect_to_agent(client or DevSpaceACPClient(), *args, **kwargs)

    acp.connect_to_agent = connect_to_agent_with_devspace_client

    def on_event(event: TaskEvent) -> None:
        emit({"type": "event", "eventType": event.event_type, "data": event.data})

    def on_raw_event(event: StreamEvent) -> None:
        if event.direction != StreamDirection.INCOMING:
            return
        message = event.message
        if not isinstance(message, dict):
            return
        method = message.get("method")
        if method == "session/update" and "id" not in message:
            emit({"type": "raw_update", "params": message.get("params", {})})
        elif isinstance(method, str) and method.startswith("session/"):
            emit({"type": "raw_request", "method": method, "params": message.get("params", {})})

    env = dict(os.environ)
    command = spec.get("command") or "hermes"
    args = spec.get("args") or ["acp"]
    cwd = spec.get("cwd") or os.getcwd()
    timeout = float(spec.get("timeoutSeconds") or 1800)

    try:
        stdin_task = asyncio.create_task(read_adapter_responses())
        async with ACPClient(
            command=command,
            args=args,
            cwd=cwd,
            env=env,
            on_event=on_event,
            timeout=timeout,
            model=str(spec.get("model") or ""),
        ) as client:
            try:
                client._conn._conn.add_observer(on_raw_event)  # type: ignore[attr-defined]
            except Exception as exc:
                emit({"type": "event", "eventType": "warning", "data": {"message": f"failed to attach raw ACP observer: {exc}"}})
            result = await client.dispatch_task(
                prompt=str(spec.get("task") or ""),
                task_id=str(spec.get("runId") or ""),
                timeout=timeout,
                cwd=cwd,
            )
    except Exception as exc:
        emit({"type": "error", "error": str(exc)})
        return 1
    finally:
        if stdin_task is not None:
            stdin_task.cancel()
            try:
                await stdin_task
            except asyncio.CancelledError:
                pass

    emit({
        "type": "complete" if result.success else "error",
        "responseText": result.response_text,
        "thoughtText": result.thought_text,
        "usage": result.usage,
        "stopReason": result.stop_reason,
        "error": result.error,
    })
    return 0 if result.success else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
