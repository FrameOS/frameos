"""`POST /api/mcp`: the backend as Model Context Protocol tools (docs/mcp.md).

One stateless Streamable-HTTP request at a time: the JSON-RPC body is
answered as JSON, no SSE stream, no session id. The router's auth
dependency (`api_user`) has already resolved the credential — an API token
(app/models/api_token.py) or a login session — and the tools call this same
process's own routes with it forwarded (app/mcp/client.py). GET and DELETE
answer 405: there is nothing to stream or end."""
from __future__ import annotations

import json
from http import HTTPStatus

from fastapi import Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from app import config as app_config
from app.api.auth import get_current_user, request_api_token
from app.database import get_db
from app.mcp.protocol import INVALID_REQUEST, PARSE_ERROR
from app.mcp.server import build_server
from app.models.user import User
from app.utils.public_origin import public_origin
from app.utils.request_ip import client_ip_for_request
from app.utils.upload_limits import read_body_limited

from . import api_user

MAX_MCP_BODY_BYTES = 16 * 1024 * 1024
FORWARDED_HEADERS = ("authorization", "cookie")


def _rpc_error(code: int, message: str, status: int = HTTPStatus.BAD_REQUEST) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": code, "message": message}}, status_code=status)


@api_user.post("/mcp")
async def api_mcp(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_current_user),
):
    if app_config.config.HASSIO_RUN_MODE == "ingress":
        # Home Assistant authenticates the browser, not an MCP client; there
        # is no credential to forward to the routes, so there is nothing to
        # serve here. Tokens need a local login (docs/mcp.md).
        raise HTTPException(
            status_code=HTTPStatus.NOT_IMPLEMENTED,
            detail="The MCP server is not available through Home Assistant ingress",
        )
    body = await read_body_limited(request, MAX_MCP_BODY_BYTES, "Request too large")
    try:
        payload = json.loads(body) if body else None
    except ValueError:
        return _rpc_error(PARSE_ERROR, "Body is not JSON")
    if payload is None:
        return _rpc_error(INVALID_REQUEST, "Empty body")

    token = request_api_token(request)
    auth = (
        {"kind": "api_token", "token_name": token.name, "token_access": token.access}
        if token
        else {"kind": "session", "token_access": "full"}
    )
    headers = {name: value for name, value in request.headers.items() if name.lower() in FORWARDED_HEADERS}
    server, api = build_server(
        app=request.app,
        headers=headers,
        client_ip=client_ip_for_request(request) or "127.0.0.1",
        public_origin=public_origin(request),
        auth=auth,
    )
    try:
        response = await server.handle_payload(payload)
    finally:
        await api.aclose()
    if response is None:
        return Response(status_code=HTTPStatus.ACCEPTED)
    return JSONResponse(response)


@api_user.api_route("/mcp", methods=["GET", "DELETE"])
async def api_mcp_not_streaming():
    raise HTTPException(
        status_code=HTTPStatus.METHOD_NOT_ALLOWED,
        detail="The FrameOS MCP server is stateless: POST JSON-RPC requests to this URL",
    )
