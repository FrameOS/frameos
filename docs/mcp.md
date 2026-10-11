# FrameOS backend MCP and API tokens

The self-hosted backend exposes everything a signed-in user can do — frames,
scenes, settings, the catalog, the scene AI — to scripts and AI agents in two
layers, the same two FrameOS Cloud has (`cloud/docs/mcp.md`):

1. **Personal API tokens** (`fb_api_…`): a bearer credential accepted by every
   route exactly where the session cookie or login JWT is.
2. **The MCP server** at `POST /api/mcp`: the same API as [Model Context
   Protocol](https://modelcontextprotocol.io) tools, with descriptions an
   agent can act on. It lives in `backend/app/mcp` and is, by design, a thin
   wrapper — every tool is one (occasionally two) calls to the backend's own
   routes, made in-process, so the routes remain the single place behaviour,
   validation and auth live.

Both are managed on Settings → API tokens and MCP (`/settings#settings-developer`).
Neither is available under Home Assistant ingress: tokens are minted behind a
local login, and ingress replaces that login.

## API tokens

| | |
|---|---|
| Table | `api_token` (migration `d4e5f6a7b8c9`): hash, hint, `access`, expiry, last use, revocation. Model and helpers in `backend/app/models/api_token.py`. |
| Mint | `POST /api/user/api_tokens` `{name, access?: "full"\|"read_only", expires_in_days?, current_password?}` → `{token, api_token}` — the secret is returned once. Needs a session (never a token: `403 api_token_not_allowed`) and the current password when the account has one, because it turns a session into a durable credential — the same gate the email and password changes have. |
| Expiry | Every token expires. `expires_in_days` is 1–365; omitted means 90. `GET` reports `default_ttl_days` and `max_ttl_days`. |
| List / revoke | `GET /api/user/api_tokens` (live tokens plus the last week's revoked and expired ones, so a script that stopped working can be explained), `DELETE /api/user/api_tokens/{id}`. A token may revoke itself. |
| Cap | 25 live tokens per user. |
| Use | `Authorization: Bearer fb_api_…` on any route under `/api` that takes a login. |

How it plugs in (`backend/app/api/auth.py`):

- `get_current_user` and `get_current_user_from_request` resolve a bearer
  that starts with `fb_api` against the table instead of decoding a JWT, so
  no route changed. The identity (`id`, `name`, `access`) lands on
  `request.state.api_token`; `request_api_token(request)` reads it.
- A read-only token (`fb_apiro_…`) is refused for anything but GET, HEAD and
  OPTIONS with `403 {"error": "read_only_token"}`, in that one place where
  the method and the credential meet. The row's `access` is the authority: a
  forged prefix that disagrees with the row is refused outright. The MCP
  endpoint is exempt from the method check because the POST is the
  transport; its tool calls reach the routes as separate requests carrying
  the same token, and those are refused.
- What tokens cannot do: mint tokens, change the email or the password
  (`require_session_credential`, `403 api_token_not_allowed`), or log in to
  the web UI. Frame credentials (SSH password, admin login, agent secret,
  Wi-Fi) are not settable through the MCP either, by tool design rather than
  by route.
- A password change does not revoke tokens: they are the owner's own scripts.
  Revoke them on the settings page when a token leaks.

## The MCP server

### Connecting

From Claude Code:

```sh
claude mcp add --transport http frameos http://<backend>:8989/api/mcp \
  --header "Authorization: Bearer fb_api_…"
```

Any Streamable-HTTP client: `{"type": "http", "url": "http://<backend>:8989/api/mcp", "headers": {"Authorization": "Bearer fb_api_…"}}`.
The settings page shows the exact URL (`FRAMEOS_PUBLIC_URL` when set,
otherwise the host the browser dialled) and the command with the token just
minted filled in.

### How the endpoint works

`backend/app/api/mcp.py` answers one JSON-RPC request per POST and keeps
nothing: JSON responses, no SSE stream, no session id (`GET` and `DELETE`
are 405). The protocol itself — `initialize`, `ping`, `tools/list`,
`tools/call`, `resources/list`, `resources/templates/list`,
`resources/read`, `prompts/list`, `prompts/get`, batches for older clients —
is `backend/app/mcp/protocol.py`, small enough to own rather than add the
Python SDK and its transports for.

Tool calls go to this same process's own routes over an in-process ASGI
client (`backend/app/mcp/client.py`): the caller's `Authorization` or
`Cookie` header is forwarded, the real client address is kept so per-IP
limits key on it, and project-scoped paths (`/api/frames`, `/api/templates`,
`/api/settings`, …) get the `/api/projects/{id}` prefix. A tool names its
project with `project_id`; omitted, the account's only project is used, and
an account with several is told to pass one.

### Tools

Fifty-odd tools in four groups; every one documents its parameters, and the
names follow the cloud's where the meaning matches. Read-only tools are
annotated `readOnlyHint`, destructive ones `destructiveHint` and take
`confirm: true` — as does every tool that changes what a physical frame does,
shows or stores (`frame_update`, `frame_scene_install`, `frame_scene_update`,
`frame_scene_remove`, `frame_scene_activate`, `frame_scene_state_set`,
`frame_render`, `frame_event`, `frame_restart`, `frame_reboot`, `frame_stop`,
`frame_deploy`, the `frame_asset_*` writes, `frame_assets_sync_fonts`,
`frame_firmware_update`). `test_mcp.py` enumerates the gated tools and fails
when one of them lacks the literal. The server's instructions tell the model
to treat every tool result as untrusted data and to call those only on the
user's own say-so.

The backend pushes: changing a frame's scenes or settings edits the project's
record, and a deploy carries it to the device. The scene tools therefore
take `deploy` (`fast`, the default: scenes and config to the running runtime;
`full`: the complete deploy, which also installs a newer release; `none`:
save on the backend for a `frame_deploy` later).

- **account** — `account_info` (who, how authenticated, projects, backend
  version and URL), `projects_list`, `api_tokens_list`, `api_token_revoke`,
  `settings_get` (secrets always masked), `settings_update` (merges over the
  current group; a masked value posted back keeps the stored key),
  `system_info`, `apps_list`, `app_source_get`, `fonts_list`.
- **frames** — `frames_list`, `frame_get` (credentials redacted, scenes
  summarised), `frame_ping`, `frame_sync_status`, `frame_state_get`,
  `frame_create`, `frame_update` (the settable keys are listed in its
  description; `then`: none / fast_deploy / deploy / restart / reboot),
  `frame_rename`, `frame_delete`, `frame_scenes_list` (apps and state fields
  per scene), `frame_scene_get`, `frame_scene_install` (from scene JSON, a
  saved scene, a catalog slug pair, or a URL — a scenes.json, a zip or a
  scene store page; ids are regenerated unless `preserve_ids`;
  `activate=true` makes it the boot default and shows it),
  `frame_scene_update`, `frame_scene_remove`, `frame_scene_activate`,
  `frame_scene_state_set`, `frame_render`, `frame_event`,
  `frame_screenshot`, `frame_scene_preview`, `frame_logs` (search and
  type filters), `frame_metrics`, `frame_restart`, `frame_reboot`,
  `frame_stop`, `frame_deploy`, `frame_deploy_plan`, `frame_deploy_cancel`,
  `frame_commands_list`, `frame_command_cancel`, `frame_assets_list`,
  `frame_asset_get`, `frame_asset_upload`, `frame_asset_delete`,
  `frame_asset_mkdir`, `frame_asset_rename`, `frame_assets_sync_fonts`,
  `frame_firmware_info`, `frame_firmware_update`.
- **scenes** — the project's saved scenes (the UI's templates): `scenes_list`,
  `scene_get`, `scene_create` (scene JSON, a frame's scenes, or a URL),
  `scene_update` (name, description), `scene_delete`; and the catalog:
  `store_browse` (the bundled repositories plus the ones the project added,
  with how to install each row), `store_scene_get`.
- **ai** — `ai_scene_generate`, `ai_scene_chat`, `ai_chats_list`,
  `ai_chat_get`. The AI only proposes scene JSON; installing it is a
  separate, confirmed `frame_scene_install`.

Resources: `frameos://frames`, `frameos://frames/{id}`,
`frameos://frames/{id}/scenes/{scene_id}`, `frameos://scenes`. Prompts:
`diagnose_frame`, `build_scene`.

Refusals reach the model as `isError` results with the method, the path, the
status, the detail the route sent and — for the ones whose fix is not
obvious (`read_only_token`, `api_token_not_allowed`, 401, 404, 409, 502,
504) — one sentence on what to do (`backend/app/mcp/result.py`).

### What the cloud has that this does not

The cloud's scene store, versioned scenes and the hub's durable command queue
have no backend equivalent, so `scene_publish`, `scene_version_*`,
`frame_claim_token_create`, `frame_confirm`, `frame_revoke`, `frame_schedule_*`
and `scene_render` are not here. Scene previews come from the frame
(`frame_scene_preview`); a frame's schedule is a key of `frame_update`.

### Tests

`backend/app/api/tests/test_mcp.py` drives the endpoint through the test
client against the real routes: the protocol surface, the gated-tool
enumeration, frames and saved-scene tools end to end, resources and
prompts, and API tokens driving the MCP (a read-only token's mutations are
refused by the routes). `test_api_tokens.py` covers minting, the password
gate, read-only enforcement, revocation, expiry and forged prefixes.
