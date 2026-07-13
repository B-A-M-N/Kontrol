"""Compatibility exports for Hermes' ACP adapter.

Hermes currently imports the ACP SDK as if its historical public API is
re-exported from the top-level ``acp`` package. The installed SDK keeps those
symbols in submodules. Python imports ``sitecustomize`` during interpreter
startup, so this shim restores the expected top-level names only for Hermes
processes whose PYTHONPATH includes this directory.
"""

from __future__ import annotations

try:
    import acp
    from acp.core import AgentSideConnection, ClientSideConnection, Connection, connect_to_agent, run_agent
    from acp.helpers import *  # noqa: F401,F403 - compatibility re-export
    from acp import helpers as _helpers
    from acp.interfaces import Agent, Client
    from acp.transports import spawn_stdio_transport

    acp.Agent = Agent
    acp.Client = Client
    acp.AgentSideConnection = AgentSideConnection
    acp.ClientSideConnection = ClientSideConnection
    acp.Connection = Connection
    acp.connect_to_agent = connect_to_agent
    acp.run_agent = run_agent
    acp.spawn_stdio_transport = spawn_stdio_transport
    acp.PROTOCOL_VERSION = getattr(acp, "PROTOCOL_VERSION", 1)

    for _name in getattr(_helpers, "__all__", []):
        if not hasattr(acp, _name):
            setattr(acp, _name, getattr(_helpers, _name))
except Exception:
    # Do not break unrelated Python startup if the ACP SDK is absent.
    pass
