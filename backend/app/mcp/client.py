"""The backend's own HTTP API, called in-process.

Every tool goes through here so the routes stay the single place behaviour,
validation and auth live. The calls never leave the process: an httpx client
over `ASGITransport` drives the same FastAPI app the MCP request arrived on,
with the caller's credential forwarded (the `Authorization` bearer, or the
session cookie) and the real client address, so per-IP limits and the
`read_only_token` refusal see what they would on a direct call.

Project scoping: backend routes live under `/api/projects/{id}/...`. A tool
names its project with `project_id`; omitted, the account's only project is
used, and an account with several is told to choose."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx
from httpx import ASGITransport

from .result import ApiError, McpInputError

PROJECT_SCOPED_PREFIXES = (
    "/api/ai/",
    "/api/apps",
    "/api/assets",
    "/api/fonts",
    "/api/frames",
    "/api/repositories",
    "/api/settings",
    "/api/templates",
)
PROJECT_SCOPED_EXCLUSIONS = ("/api/repositories/system",)


class BackendApi:
    def __init__(
        self,
        app: Any,
        *,
        headers: dict[str, str],
        client_ip: str,
        base_url: str = "http://frameos.internal",
    ):
        transport = ASGITransport(app=app, client=(client_ip or "127.0.0.1", 0), raise_app_exceptions=False)
        self._client = httpx.AsyncClient(
            transport=transport,
            base_url=base_url,
            headers={**headers, "user-agent": "frameos-backend-mcp"},
            # Frame-facing routes wait on the device themselves; the in-process
            # hop adds nothing, so only a generous ceiling.
            timeout=httpx.Timeout(600.0),
        )
        self._projects: list[dict[str, Any]] | None = None
        self._explicit_project: int | None = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def projects(self) -> list[dict[str, Any]]:
        if self._projects is None:
            payload = await self.json("GET", "/api/projects", scoped=False)
            self._projects = list(payload.get("projects") or [])
        return self._projects

    async def project_id(self, explicit: int | None = None) -> int:
        """The project a scoped call targets. An explicit id is checked
        against the account's projects, so the 404 is ours and names the
        choices rather than the route's bare "Project not found"."""
        projects = await self.projects()
        if explicit is not None:
            if any(int(project["id"]) == int(explicit) for project in projects):
                return int(explicit)
            raise McpInputError(
                f"No project with id {explicit} for this account. Projects: "
                + ", ".join(f"{project.get('id')} ({project.get('name')})" for project in projects)
            )
        if len(projects) == 1:
            return int(projects[0]["id"])
        if not projects:
            raise McpInputError("This account has no project yet; open the web UI once to create one.")
        raise McpInputError(
            "This account has several projects; pass project_id. Projects: "
            + ", ".join(f"{project.get('id')} ({project.get('name')})" for project in projects)
        )

    def _scoped_path(self, path: str, project_id: int) -> str:
        if path.startswith(PROJECT_SCOPED_EXCLUSIONS):
            return path
        if any(path == prefix or path.startswith(prefix) for prefix in PROJECT_SCOPED_PREFIXES):
            return f"/api/projects/{project_id}{path[len('/api'):]}"
        return path

    async def request(
        self,
        method: str,
        path: str,
        *,
        scoped: bool = True,
        project_id: int | None = None,
        json: Any = None,
        params: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        if scoped:
            path = self._scoped_path(path, await self.project_id(project_id))
        # Drop `None` query values so a tool can pass its optional inputs
        # straight through.
        query = {key: value for key, value in (params or {}).items() if value is not None} or None
        return await self._client.request(
            method,
            path,
            json=json,
            params=query,
            data=data,
            files=files,
            content=content,
            headers=headers,
        )

    @staticmethod
    def _body(response: httpx.Response) -> Any:
        content_type = response.headers.get("content-type", "")
        if "json" in content_type:
            try:
                return response.json()
            except ValueError:
                pass
        return response.text

    async def json(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self.request(method, path, **kwargs)
        body = self._body(response)
        if response.status_code >= 400:
            raise ApiError(method, str(response.request.url.path), response.status_code, body)
        return body

    async def bytes(self, method: str, path: str, **kwargs: Any) -> tuple[bytes, str]:
        """(body, content-type) for the image and file routes."""
        response = await self.request(method, path, **kwargs)
        if response.status_code >= 400:
            raise ApiError(method, str(response.request.url.path), response.status_code, self._body(response))
        return response.content, response.headers.get("content-type", "application/octet-stream")


@dataclass
class ToolContext:
    api: BackendApi
    # The origin a browser dials, for links in tool output.
    public_origin: str
    # How this request authenticated: {"kind": "api_token"|"session", "token_access": ...}.
    auth: dict[str, Any] = field(default_factory=dict)
