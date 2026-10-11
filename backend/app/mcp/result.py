"""What every tool hands back to the model, and how a refusal from the API
is worded. The backend's `{detail: ...}` bodies are precise but terse; the
model gets the status, the path, whatever detail rode along and — for the
handful of situations whose fix is not obvious — a sentence on what to do.
Mirrors cloud/packages/mcp/src/result.ts."""
from __future__ import annotations

import base64
import json
from typing import Any, Awaitable, Callable

ToolResult = dict[str, Any]


def text(value: Any) -> ToolResult:
    body = value if isinstance(value, str) else json.dumps(value, indent=2, default=str)
    return {"content": [{"type": "text", "text": body}]}


def structured(value: dict[str, Any]) -> ToolResult:
    return {
        "content": [{"type": "text", "text": json.dumps(value, indent=2, default=str)}],
        "structuredContent": value,
    }


def image(data: bytes, mime_type: str, caption: str | None = None) -> ToolResult:
    content: list[dict[str, Any]] = []
    if caption:
        content.append({"type": "text", "text": caption})
    content.append({"type": "image", "data": base64.b64encode(data).decode(), "mimeType": mime_type})
    return {"content": content}


def failure(message: str, extra: dict[str, Any] | None = None) -> ToolResult:
    body = f"{message}\n{json.dumps(extra, indent=2, default=str)}" if extra else message
    return {"content": [{"type": "text", "text": body}], "isError": True}


class ApiError(Exception):
    """A non-2xx answer from the backend's own routes."""

    def __init__(self, method: str, path: str, status: int, body: Any):
        self.method = method
        self.path = path
        self.status = status
        self.body = body
        detail = body.get("detail") if isinstance(body, dict) else body
        # Structured refusals carry `{error: code, message}` in `detail`.
        self.code: str = ""
        self.message: str = ""
        if isinstance(detail, dict):
            self.code = str(detail.get("error") or "")
            self.message = str(detail.get("message") or detail.get("detail") or "")
        elif isinstance(detail, list):
            # A 422 validation error: one line per field.
            self.message = "; ".join(
                f"{'.'.join(str(part) for part in item.get('loc', [])[1:])}: {item.get('msg')}"
                for item in detail
                if isinstance(item, dict)
            )
        elif detail is not None:
            self.message = str(detail)
        super().__init__(f"{method} {path}: {status} {self.code or self.message}")


class McpInputError(Exception):
    """A tool argument the tool itself finds unusable (missing, wrong shape).
    Reaches the model as an `isError` result, not a protocol error."""


# Hints, by refusal code first and by status second, for the refusals whose
# fix is not obvious from the detail alone.
_CODE_HINTS: dict[str, str] = {
    "read_only_token": "This token is read-only. Mutations need a token created with full access.",
    "api_token_not_allowed": (
        "This action needs a browser sign-in and is never available to API tokens: "
        "the account owner does it on the settings page."
    ),
}

_STATUS_HINTS: dict[int, str] = {
    401: (
        "The credential was refused: the API token is revoked, expired, or was not minted by this "
        "server. Create a new one under Settings → API tokens and MCP."
    ),
    404: "No such object in this project. frames_list / scenes_list / projects_list have the valid ids.",
    409: "The frame already has a deploy running. Wait for it, or call frame_deploy with force=true.",
    422: "The request body was rejected by the route's validation; fix the named fields and retry.",
    502: "The frame did not answer. It is offline, asleep, or unreachable from this backend; check frame_ping.",
    504: "The frame did not answer in time. It is offline, asleep, or busy; check frame_ping and retry later.",
}


def explain_error(error: BaseException) -> ToolResult:
    if isinstance(error, ApiError):
        lines = [f"FrameOS refused {error.method} {error.path}: {error.status} {error.code or ''}".rstrip()]
        if error.message:
            lines.append(error.message)
        hint = _CODE_HINTS.get(error.code) or _STATUS_HINTS.get(error.status)
        if hint:
            lines.append(hint)
        if isinstance(error.body, dict):
            extra = {key: value for key, value in error.body.items() if key != "detail"}
            if extra:
                lines.append(json.dumps(extra, default=str))
        return {"content": [{"type": "text", "text": "\n".join(lines)}], "isError": True}
    if isinstance(error, McpInputError):
        return failure(str(error))
    return failure(f"{type(error).__name__}: {error}")


async def run(fn: Callable[[], Awaitable[ToolResult]]) -> ToolResult:
    try:
        return await fn()
    except Exception as error:  # noqa: BLE001 — every failure must reach the model as a result
        return explain_error(error)
