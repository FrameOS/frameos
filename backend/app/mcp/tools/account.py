"""The account, its projects, the project settings and the backend itself."""
from __future__ import annotations

from typing import Any

from app.schemas.settings import SettingsUpdateRequest
from app.utils.settings_secrets import MASK_BULLETS
from app.utils.versions import current_frameos_version

from ..client import ToolContext
from ..protocol import McpServer
from ..registry import Tool
from ..result import McpInputError, run, text

SETTINGS_GROUPS = tuple(SettingsUpdateRequest.model_fields)


def register_account_tools(server: McpServer, ctx: ToolContext) -> None:
    api = ctx.api

    async def account_info():
        async def go():
            user = await api.json("GET", "/api/user", scoped=False)
            projects = await api.projects()
            return text({
                "user": user,
                "auth": ctx.auth,
                "projects": projects,
                "backend_version": current_frameos_version(),
                "backend_url": ctx.public_origin,
                "mcp_url": f"{ctx.public_origin}/api/mcp",
                "note": (
                    "Tools take project_id; it may be omitted when there is exactly one project."
                    if len(projects) == 1
                    else "Several projects: every project-scoped tool needs project_id."
                ),
            })

        return await run(go)

    server.tool(Tool(
        name="account_info",
        description="Who this credential is (email), how the request authenticated (session or API token, and its access), the projects it may use, and this backend's version and URL.",
        annotations={"readOnlyHint": True},
        scoped=False,
        handler=account_info,
    ))

    async def projects_list():
        return await run(lambda: _text(api, "GET", "/api/projects"))

    server.tool(Tool(
        name="projects_list",
        description="The projects this account belongs to (id, name, organization). Frames, scenes and settings are per project.",
        annotations={"readOnlyHint": True},
        scoped=False,
        handler=projects_list,
    ))

    async def api_tokens_list():
        return await run(lambda: _text(api, "GET", "/api/user/api_tokens"))

    server.tool(Tool(
        name="api_tokens_list",
        description="The account's personal API tokens: name, hint, access (full/read_only), expiry, last use. Minting one is browser-only (Settings → API tokens and MCP).",
        annotations={"readOnlyHint": True},
        scoped=False,
        handler=api_tokens_list,
    ))

    async def api_token_revoke(confirm: bool, token_id: str):
        return await run(lambda: _text(api, "DELETE", f"/api/user/api_tokens/{token_id}"))

    server.tool(Tool(
        name="api_token_revoke",
        description="Revoke one API token (a token may revoke itself). Requires confirm=true.",
        properties={
            "confirm": {"type": "boolean", "const": True, "description": "Must be true — scripts using the token stop working."},
            "token_id": {"type": "string", "minLength": 1},
        },
        required=["confirm", "token_id"],
        annotations={"destructiveHint": True},
        scoped=False,
        handler=api_token_revoke,
    ))

    async def settings_get(group: str | None = None, project_id: int | None = None):
        async def go():
            settings = await api.json("GET", "/api/settings", project_id=project_id)
            if group:
                if group not in SETTINGS_GROUPS:
                    raise McpInputError(f"Unknown settings group {group}; one of: {', '.join(SETTINGS_GROUPS)}")
                return text({group: settings.get(group)})
            return text(settings)

        return await run(go)

    server.tool(Tool(
        name="settings_get",
        description=(
            "The project's settings: service API keys scenes use (openAI, unsplash, homeAssistant, immich, "
            "github, frameOS), defaults for new frames, posthog, repositories, ssh_keys, the legacy build "
            "environment. Secrets are always masked (bullets plus the last four characters); the backend "
            "never reveals a stored key. Groups: " + ", ".join(SETTINGS_GROUPS) + "."
        ),
        properties={"group": {"type": "string", "enum": list(SETTINGS_GROUPS)}},
        annotations={"readOnlyHint": True},
        handler=settings_get,
    ))

    async def settings_update(group: str, values: dict[str, Any], project_id: int | None = None):
        async def go():
            if group not in SETTINGS_GROUPS:
                raise McpInputError(f"Unknown settings group {group}; one of: {', '.join(SETTINGS_GROUPS)}")
            current = await api.json("GET", "/api/settings", project_id=project_id)
            existing = current.get(group)
            if isinstance(existing, dict):
                merged: Any = {**existing, **values}
            else:
                merged = values
            # A masked value posted back keeps the stored key.
            updated = await api.json("POST", "/api/settings", project_id=project_id, json={group: merged})
            return text({group: updated.get(group), "note": f"Values shown as {MASK_BULLETS}… are stored secrets, masked."})

        return await run(go)

    server.tool(Tool(
        name="settings_update",
        description=(
            "Set keys in one settings group, merged over the current values (only the keys you pass change; "
            "a masked secret posted back keeps the stored one). E.g. group=openAI values={apiKey: 'sk-…'}; "
            "group=unsplash values={accessKey: '…'}; group=homeAssistant values={url, accessToken}."
        ),
        properties={
            "group": {"type": "string", "enum": list(SETTINGS_GROUPS)},
            "values": {"type": "object"},
        },
        required=["group", "values"],
        annotations={"idempotentHint": True},
        handler=settings_update,
    ))

    async def system_info():
        return await run(lambda: _text(api, "GET", "/api/system/info"))

    server.tool(Tool(
        name="system_info",
        description="This backend host: versions, Python, platform, disk and memory, and whether a Nim toolchain is present for legacy source builds.",
        annotations={"readOnlyHint": True},
        scoped=False,
        handler=system_info,
    ))

    async def apps_list(search: str | None = None, project_id: int | None = None):
        async def go():
            payload = await api.json("GET", "/api/apps", project_id=project_id)
            apps = []
            for keyword, config in (payload.get("apps") or {}).items():
                entry = {
                    "keyword": keyword,
                    "name": config.get("name"),
                    "category": config.get("category"),
                    "description": config.get("description"),
                    "fields": [
                        {key: field.get(key) for key in ("name", "type", "label", "required", "value", "options") if key in field}
                        for field in (config.get("fields") or [])
                        if isinstance(field, dict)
                    ],
                    "output": config.get("output"),
                }
                if search:
                    haystack = " ".join(str(value) for value in (keyword, entry["name"], entry["category"], entry["description"])).lower()
                    if search.lower() not in haystack:
                        continue
                apps.append(entry)
            return text({"apps": apps, "count": len(apps)})

        return await run(go)

    server.tool(Tool(
        name="apps_list",
        description="The app catalog a scene's nodes come from: keyword (what a node's data.keyword names), name, category, description, fields with their types and defaults, output type. `search` filters by any of those.",
        properties={"search": {"type": "string"}},
        annotations={"readOnlyHint": True},
        handler=apps_list,
    ))

    async def app_source_get(keyword: str, project_id: int | None = None):
        return await run(lambda: _text(api, "GET", "/api/apps/source", project_id=project_id, params={"keyword": keyword}))

    server.tool(Tool(
        name="app_source_get",
        description="The source files of one catalog app (config.json plus its Nim or JavaScript), for understanding what it does or building a code node after it.",
        properties={"keyword": {"type": "string", "minLength": 1}},
        required=["keyword"],
        annotations={"readOnlyHint": True},
        handler=app_source_get,
    ))

    async def fonts_list(project_id: int | None = None):
        return await run(lambda: _text(api, "GET", "/api/fonts", project_id=project_id))

    server.tool(Tool(
        name="fonts_list",
        description="Fonts available to scenes: the bundled set plus the project's uploads (file name, family, weight, italic). A scene names a font by file.",
        annotations={"readOnlyHint": True},
        handler=fonts_list,
    ))


async def _text(api, method: str, path: str, **kwargs: Any):
    scoped = "project_id" in kwargs
    return text(await api.json(method, path, scoped=scoped, **kwargs))
