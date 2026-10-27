#!/usr/bin/env python3
"""Deterministic session-continuity checks for the Hermes ACP runner."""

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace


RUNNER_PATH = Path(__file__).with_name("hermes-native-runner.py")
SPEC = importlib.util.spec_from_file_location("hermes_native_runner", RUNNER_PATH)
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class FakeConnection:
    def __init__(self, *, loaded=True):
        self.loaded = loaded
        self.calls = []

    async def new_session(self, **kwargs):
        self.calls.append(("new", kwargs))
        return SimpleNamespace(session_id="provider-session-1")

    async def load_session(self, **kwargs):
        self.calls.append(("load", kwargs))
        return object() if self.loaded else None


def spec(binding=None):
    return {
        "cwd": "/workspace",
        "workSessionId": "work-1",
        "agentId": "agent-1",
        "workspaceRoot": "/work/project",
        "providerGeneration": "generation-1",
        "sessionBinding": binding,
    }


def binding(**overrides):
    value = {
        "workSessionId": "work-1",
        "agentId": "agent-1",
        "providerSessionId": "provider-session-1",
        "workspaceRoot": "/work/project",
        "providerGeneration": "generation-1",
    }
    value.update(overrides)
    return value


async def main():
    created = FakeConnection()
    persisted = []
    session_id = await runner.open_provider_session(
        created,
        SimpleNamespace(agent_capabilities=SimpleNamespace(load_session=False)),
        spec(),
        lambda provider_id: persist(persisted, provider_id),
    )
    assert session_id == "provider-session-1"
    assert [call[0] for call in created.calls] == ["new"]
    assert persisted == ["provider-session-1"], "new provider identity is persisted before the runner continues"

    resumed = FakeConnection()
    session_id = await runner.open_provider_session(
        resumed,
        SimpleNamespace(agent_capabilities=SimpleNamespace(load_session=True)),
        spec(binding()),
        lambda _provider_id: fail("continuation must not persist a replacement session"),
    )
    assert session_id == "provider-session-1"
    assert resumed.calls == [("load", {"cwd": "/workspace", "session_id": "provider-session-1", "mcp_servers": []})]

    unsupported = FakeConnection()
    try:
        await runner.open_provider_session(
            unsupported,
            SimpleNamespace(agent_capabilities=SimpleNamespace(load_session=False)),
            spec(binding()),
            lambda _provider_id: fail("unsupported resume must not create a replacement"),
        )
    except RuntimeError as error:
        assert str(error).startswith("continuation_session_unsupported")
    else:
        raise AssertionError("continuation without advertised load_session must fail")
    assert unsupported.calls == []

    missing = FakeConnection(loaded=False)
    try:
        await runner.open_provider_session(
            missing,
            SimpleNamespace(agent_capabilities=SimpleNamespace(load_session=True)),
            spec(binding()),
            lambda _provider_id: fail("missing session must not create a replacement"),
        )
    except RuntimeError as error:
        assert str(error).startswith("continuation_session_missing")
    else:
        raise AssertionError("a missing persisted provider session must fail")
    assert [call[0] for call in missing.calls] == ["load"]

    mismatch = FakeConnection()
    try:
        await runner.open_provider_session(
            mismatch,
            SimpleNamespace(agent_capabilities=SimpleNamespace(load_session=True)),
            spec(binding(agentId="another-agent")),
            lambda _provider_id: fail("binding mismatch must not create a replacement"),
        )
    except RuntimeError as error:
        assert str(error).startswith("continuation_session_binding_conflict")
    else:
        raise AssertionError("a binding owned by another agent must fail")
    assert mismatch.calls == []


async def persist(store, provider_id):
    store.append(provider_id)


def fail(message):
    raise AssertionError(message)


asyncio.run(main())
print("hermes-native-runner.test.py: session continuity assertions passed")
