"""JSON-RPC 2.0 over one stateless HTTP POST: the Model Context Protocol
methods a tools/resources/prompts server answers (initialize, ping,
tools/list, tools/call, resources/list, resources/templates/list,
resources/read, prompts/list, prompts/get).

Small enough to own: the server never streams, keeps no session and has no
server-initiated messages, so the SDK's transports would only add a
dependency. The wire shapes follow the 2025-06-18 spec; older clients that
still send batches get a batch back."""
from __future__ import annotations

import re
from typing import Any

from .registry import Prompt, Resource, ResourceTemplate, SchemaError, Tool, validate_arguments
from .result import McpInputError, explain_error, failure

SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(message)


class McpServer:
    def __init__(self, *, name: str, version: str, instructions: str):
        self.name = name
        self.version = version
        self.instructions = instructions
        self.tools: dict[str, Tool] = {}
        self.resources: list[Resource] = []
        self.resource_templates: list[ResourceTemplate] = []
        self.prompts: dict[str, Prompt] = {}

    # -- registration -------------------------------------------------------

    def tool(self, tool: Tool) -> None:
        if tool.name in self.tools:
            raise ValueError(f"Tool {tool.name} registered twice")
        self.tools[tool.name] = tool

    def resource(self, resource: Resource) -> None:
        self.resources.append(resource)

    def resource_template(self, template: ResourceTemplate) -> None:
        self.resource_templates.append(template)

    def prompt(self, prompt: Prompt) -> None:
        self.prompts[prompt.name] = prompt

    # -- dispatch -----------------------------------------------------------

    async def handle_payload(self, payload: Any) -> Any | None:
        """One POST body → the response body, or None when nothing is owed
        (a notification, or a batch of them)."""
        if isinstance(payload, list):
            if not payload:
                return _error_response(None, INVALID_REQUEST, "Empty batch")
            responses = [await self.handle_message(message) for message in payload]
            answered = [response for response in responses if response is not None]
            return answered or None
        return await self.handle_message(payload)

    async def handle_message(self, message: Any) -> dict[str, Any] | None:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return _error_response(None, INVALID_REQUEST, "Not a JSON-RPC 2.0 message")
        method = message.get("method")
        request_id = message.get("id")
        if not isinstance(method, str):
            # A response or a malformed request: nothing to do with either.
            return None if "result" in message or "error" in message else _error_response(
                request_id, INVALID_REQUEST, "Missing method"
            )
        params = message.get("params") or {}
        if not isinstance(params, dict):
            return _error_response(request_id, INVALID_PARAMS, "params must be an object")
        is_notification = "id" not in message
        try:
            result = await self._dispatch(method, params)
        except JsonRpcError as error:
            return None if is_notification else _error_response(request_id, error.code, error.message, error.data)
        except Exception as error:  # noqa: BLE001 — the client gets a JSON-RPC error, not a 500
            return None if is_notification else _error_response(request_id, INTERNAL_ERROR, str(error))
        if is_notification:
            return None
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    async def _dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "initialize":
            return self._initialize(params)
        if method in ("notifications/initialized", "notifications/cancelled", "notifications/roots/list_changed"):
            return {}
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": [tool.describe() for tool in self.tools.values()]}
        if method == "tools/call":
            return await self._call_tool(params)
        if method == "resources/list":
            return {"resources": await self._list_resources()}
        if method == "resources/templates/list":
            return {
                "resourceTemplates": [
                    {
                        "uriTemplate": template.uri_template,
                        "name": template.name,
                        "description": template.description,
                        "mimeType": template.mime_type,
                    }
                    for template in self.resource_templates
                ]
            }
        if method == "resources/read":
            return await self._read_resource(params)
        if method == "prompts/list":
            return {
                "prompts": [
                    {
                        "name": prompt.name,
                        "title": prompt.title,
                        "description": prompt.description,
                        "arguments": [
                            {"name": arg.name, "description": arg.description, "required": arg.required}
                            for arg in prompt.arguments
                        ],
                    }
                    for prompt in self.prompts.values()
                ]
            }
        if method == "prompts/get":
            return self._get_prompt(params)
        if method in ("completion/complete", "logging/setLevel"):
            raise JsonRpcError(METHOD_NOT_FOUND, f"Method not supported: {method}")
        raise JsonRpcError(METHOD_NOT_FOUND, f"Method not found: {method}")

    def _initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        requested = params.get("protocolVersion")
        version = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else LATEST_PROTOCOL_VERSION
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {}, "resources": {}, "prompts": {}},
            "serverInfo": {"name": self.name, "version": self.version},
            "instructions": self.instructions,
        }

    async def _call_tool(self, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        tool = self.tools.get(name) if isinstance(name, str) else None
        if tool is None:
            raise JsonRpcError(INVALID_PARAMS, f"Unknown tool: {name}")
        try:
            arguments = validate_arguments(tool, params.get("arguments"))
        except SchemaError as error:
            raise JsonRpcError(INVALID_PARAMS, f"Invalid arguments for {tool.name}: {error}") from error
        try:
            return await tool.handler(**arguments)
        except McpInputError as error:
            return failure(str(error))
        except Exception as error:  # noqa: BLE001
            return explain_error(error)

    async def _list_resources(self) -> list[dict[str, Any]]:
        listed = [
            {
                "uri": resource.uri,
                "name": resource.name,
                "description": resource.description,
                "mimeType": resource.mime_type,
            }
            for resource in self.resources
        ]
        for template in self.resource_templates:
            try:
                listed.extend(await template.lister())
            except Exception:  # noqa: BLE001 — a listing that fails leaves the static resources
                continue
        return listed

    async def _read_resource(self, params: dict[str, Any]) -> dict[str, Any]:
        uri = params.get("uri")
        if not isinstance(uri, str):
            raise JsonRpcError(INVALID_PARAMS, "uri is required")
        for resource in self.resources:
            if resource.uri == uri:
                payload = await resource.handler()
                return _resource_contents(uri, resource.mime_type, payload)
        for template in self.resource_templates:
            variables = match_uri_template(template.uri_template, uri)
            if variables is not None:
                payload = await template.handler(**variables)
                return _resource_contents(uri, template.mime_type, payload)
        raise JsonRpcError(INVALID_PARAMS, f"Unknown resource: {uri}")

    def _get_prompt(self, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        prompt = self.prompts.get(name) if isinstance(name, str) else None
        if prompt is None:
            raise JsonRpcError(INVALID_PARAMS, f"Unknown prompt: {name}")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise JsonRpcError(INVALID_PARAMS, "arguments must be an object")
        for argument in prompt.arguments:
            if argument.required and not arguments.get(argument.name):
                raise JsonRpcError(INVALID_PARAMS, f"Prompt {prompt.name} needs {argument.name}")
        return {
            "description": prompt.description,
            "messages": [
                {"role": "user", "content": {"type": "text", "text": prompt.render({k: str(v) for k, v in arguments.items()})}}
            ],
        }


def _error_response(request_id: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def _resource_contents(uri: str, mime_type: str, payload: Any) -> dict[str, Any]:
    import json

    body = payload if isinstance(payload, str) else json.dumps(payload, indent=2, default=str)
    return {"contents": [{"uri": uri, "mimeType": mime_type, "text": body}]}


def match_uri_template(template: str, uri: str) -> dict[str, str] | None:
    """`frameos://frames/{frame_id}` against `frameos://frames/3` →
    {"frame_id": "3"}; None when the shape differs."""
    pattern = "^"
    for index, part in enumerate(re.split(r"\{(\w+)\}", template)):
        pattern += re.escape(part) if index % 2 == 0 else f"(?P<{part}>[^/]+)"
    matched = re.match(pattern + "$", uri)
    return matched.groupdict() if matched else None
