"""The FrameOS backend as Model Context Protocol tools (docs/mcp.md).

A backport of the cloud's `packages/mcp`: the same vocabulary and the same
rule — every tool is one (occasionally two) calls to the backend's own HTTP
routes, made in-process over ASGI with the caller's credential, so the routes
remain the single place behaviour, validation and auth live. Served
statelessly at `POST /api/mcp` (app/api/mcp.py); no SSE, no sessions.
"""
