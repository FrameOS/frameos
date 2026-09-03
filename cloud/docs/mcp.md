# FrameOS Cloud MCP and API tokens

FrameOS Cloud exposes everything a signed-in account can do — frames, scenes,
the store, the scene AI — to scripts and AI agents in two layers:

1. **Personal API tokens** (`fc_api_…`): a bearer credential accepted by every
   account-scoped JSON route exactly where the session cookie is.
2. **The MCP server** at `POST /api/mcp`: the same API as [Model Context
   Protocol](https://modelcontextprotocol.io) tools, with descriptions an
   agent can act on. It lives in `packages/mcp` and is, by design, a thin
   wrapper — every tool is one (occasionally two) HTTP calls to the routes
   under `apps/auth-web/app/api`, so the routes remain the single place
   behaviour, validation, quotas and audit live.

Both are managed on `/account/developer`.

## API tokens

| | |
|---|---|
| Table | `account_api_tokens` (migration 0040): hash, hint, `access`, expiry, last use, revocation |
| Mint | `POST /api/account/api-tokens` `{name, access?: "full"\|"read_only", expires_in_days?}` → `{token, api_token}` — the secret is returned once. Needs a session (never a token) and a recent proof of credentials (`recentApprovalMaxAgeSeconds`, 2 h) because it turns a session into a durable credential — the same gate device approval has. |
| Expiry | Every token expires. `expires_in_days` is 1–365; omitted means `defaultApiTokenTtlDays` (90), and an explicit `null` ("never") is `400 invalid_expiry`. `GET` reports `default_ttl_days` and `max_ttl_days`. |
| List / revoke | `GET /api/account/api-tokens`, `DELETE /api/account/api-tokens/{id}`. A token may revoke itself. |
| Revoked wholesale | On a password reset, an admin "sign out everywhere", and whenever a second factor is **enrolled** (`totp/confirm`, `passkeys` POST): a token minted before 2FA was on would keep walking past it, so the enrolment revokes every live token (`revokeApiTokensForAccount`, count returned as `api_tokens_revoked` and audited) and the owner re-mints behind the new factor. |
| Cap | 25 live tokens per account (`maxApiTokensPerAccount`). |
| Use | `Authorization: Bearer fc_api_…` on any route that calls `readSession()`. |

### Job tokens

A third prefix, `fc_apijob_…`, is not a person's credential at all. Its row's
`access` names the one job it may run — today only `billing_nightly`, the
accounting cron (`scripts/accounting-nightly.sh` → `POST
/api/admin/billing/nightly`). `readSession()` never resolves a job token, so
it satisfies no ordinary route and none of `/api/admin/*`; the nightly route
authenticates it itself with `authenticateJobToken(db, authorization,
"billing_nightly")` and accepts nothing else (no cookie session, no personal
token, superadmin or not). Job tokens are minted only by
`scripts/accounting-service-account.sh`, on a service account that is not a
superadmin and has no login identity; the token route cannot make one. This
replaced the superadmin `fc_api_` token the job used to run on, which could
also read every account and post journal entries from the ops box.

How it plugs in (`src/lib/api-tokens.ts`):

- `readSession()` falls back to the bearer when there is no session cookie and
  returns the usual `SessionProfile` plus `apiToken: {id, name, access}`, so
  no route changed. `providerIssuer` is `frameos-cloud-api-token`.
- `csrfResponse()` exempts bearer-token requests from the Origin check (a
  browser never attaches one on its own) and refuses read-only tokens
  (`fc_apiro_…`) outright with `403 read_only_token` — it is the one helper
  every mutating route calls first, and it sees method and credential
  together. The database row's `access` is verified again in
  `authenticateApiToken`, so a forged prefix buys nothing.
- What tokens cannot do: the sudo-mode routes (`/api/frames/{id}/revoke`,
  `/api/device/revoke`, `/api/device/authorize`) read the session cookie's
  `authenticated_at` and answer `403 reauth_required`; the 2FA routes demand a
  live proof in the body; minting tokens answers `403 api_token_not_allowed`.
- Rate limits are per client IP, unchanged. Audit events:
  `account.api_token_created`, `account.api_token_revoked`.

## Routes added for the MCP (usable directly too)

| Route | Purpose |
|---|---|
| `GET /api/account/usage` | Account, the auth kind in use, usage against every quota (`accountUsage()`), and the fixed caps (`limits`). |
| `GET /api/account/scenes` | The account's scenes as JSON (`?q=&visibility=&status=`), the rows `/my-scenes` renders. |
| `GET /api/account/scenes/{id}` | One scene: summary, every version with the listing and image digests it recorded, the latest version's images, preview/share URLs. |
| `POST /api/scenes/lint` | `{scenes}` → `{ok, errors, warnings}`: the AI's delivery gate (shape, app keywords, deep lint). |
| `POST /api/scenes/render` | `{scene_id\|scenes, version?, scene?, width?, height?, time_zone?, settings?, states?, format?}` → PNG (or JSON with `png_base64`, logs, errors, state). |

### Server-side rendering

`src/lib/scene-render.ts` runs the same `frameos-wasm` bundle the browser
live preview uses (`public/frameos-wasm` — the signed bundle of the release
pinned in `versions.json`, not a build of `main`; see `deployment.md`, "The
wasm runtime is a release asset" — built with `node` in its emscripten
`ENVIRONMENT`) in a `worker_threads` Worker: init → load scenes → render →
a 1.5 s settle for scenes that ask to re-render → raw RGBA → PNG (fflate).
No Chromium. Scene apps' HTTP goes through a synchronous XHR shim that runs
each request in a short-lived child Node with the same SSRF guard as the
preview proxy (`src/lib/ssrf.ts`), capped at 24 requests and 10 MB per
render. Two renders run concurrently, eight queue, 30 s timeout, one fresh
64 MB wasm heap per render — nothing is shared between two accounts' scenes.
`renderer_unavailable` (501) means the bundle is not on disk. The JSON reply
carries `runtime_version` (the PNG reply an `x-frameos-runtime-version`
header): the interpreter version the render used, which is the last release's
and may differ from a frame's firmware.

## The MCP server

### Connecting

Hosted (no local process), from Claude Code:

```sh
claude mcp add --transport http frameos https://cloud.frameos.net/api/mcp \
  --header "Authorization: Bearer fc_api_…"
```

Any Streamable-HTTP client: `{"type": "http", "url": "https://cloud.frameos.net/api/mcp", "headers": {"Authorization": "Bearer fc_api_…"}}`.

Local stdio process (from a checkout, for clients without HTTP transport):

```sh
FRAMEOS_CLOUD_TOKEN=fc_api_… pnpm --filter @frameos-cloud/mcp start
# FRAMEOS_CLOUD_URL / FRAMEOS_STORE_URL override the origins
```

### How the hosted endpoint works

`app/api/mcp/route.ts` authenticates the bearer, builds a `McpServer` and a
stateless `WebStandardStreamableHTTPServerTransport` (JSON responses, no
sessions, no SSE) per request, and hands the request to it. Tool calls go
back to this same process's own JSON routes over loopback
(`http://127.0.0.1:$PORT`, or `FRAMEOS_MCP_INTERNAL_ORIGIN`), carrying the
caller's token and the forwarded-for chain so per-IP rate limits key on the
real client. `GET` and `DELETE` answer 405: there is nothing to stream or end.

### Tools

Around 70 tools in five groups; every one documents its parameters. Read-only
tools are annotated `readOnlyHint`, destructive ones `destructiveHint` and
take `confirm: true` — as do the five that change what a physical frame does
or shows (`frame_scene_install`, `frame_scenes_set`, `frame_settings_update`,
`frame_service_settings_enable`, `frame_firmware_update`). The server's
instructions tell the model to treat every tool result as untrusted data and
to call those only on the user's own say-so: a store scene's description or
a frame's logs must not be able to talk an agent into deploying something.

- **account** — `account_info`, `account_quota`, `account_settings_get`
  (secrets always masked — the cloud never reveals a stored key to a token),
  `account_settings_update` (merges over the current group before posting; a
  masked value posted back keeps the stored key), `api_tokens_list`,
  `api_token_revoke`.
- **frames** — `frames_list`, `frame_get`, `frame_rename`, `frame_delete`,
  `frame_revoke` (always refused for tokens; kept so the agent learns why),
  `frame_confirm`, `frame_claim_token_create`, `frame_settings_update`,
  `frame_scenes_list`, `frame_scenes_set`, `frame_scene_install` (from a store
  id, a URL — store page, zip, scenes.json — or raw JSON; optional activate;
  `settings_groups` grants the scene the account's service keys it declares —
  without it a store scene gets none, and the answer says what it still needs),
  `frame_scene_remove`, `frame_scene_activate`, `frame_render`,
  `frame_screenshot`, `frame_scene_preview`, `frame_logs` (filter + cap),
  `frame_metrics`, `frame_metrics_request`, `frame_activity`,
  `frame_commands_list`, `frame_command_cancel`, `frame_command_send`,
  `frame_reboot`, `frame_restart`, `frame_schedule_get`, `frame_schedule_set`,
  `frame_service_settings_enable`, `frame_telemetry_enable`,
  `frame_assets_list`, `frame_asset_get`, `frame_asset_upload`,
  `frame_asset_delete`, `frame_asset_mkdir`, `frame_asset_rename`,
  `frame_assets_sync_fonts`, `frame_firmware_info`, `frame_firmware_update`.
- **scenes** — `scenes_list`, `scene_get`, `scene_get_content`,
  `scene_create` (JSON / zip URL / scenes.json URL; a store reference forks),
  `scene_update_content` (new version), `scene_update` (description, tags,
  category, frameos_version — the listing is part of a version, so this
  publishes one), `scene_rename` (through a content save, which is what
  renames the listing), `scene_publish`, `scene_delete`, `scene_fork`,
  `scene_version_restore`, `scene_version_yank`, `scene_image_get`,
  `scene_image_add`, `scene_image_remove`, `scene_images_reorder` (images
  are content-addressed by sha256 and the ordered set is part of a version:
  each of the last three publishes one; position 0 is the cover),
  `scene_render`, `scene_lint`.
- **store** — `store_browse`, `store_scene_get`, `store_scene_report`.
- **ai** — `ai_scene_chat` (follows the NDJSON turn up to `wait_seconds`,
  then `apply`: none / new_scene / save_version), `ai_turn_wait`,
  `ai_turn_cancel`, `ai_chats_list`, `ai_chat_get`, `ai_chat_delete`. The
  scene AI never changes a frame itself: its `add_scene_to_frame` only
  *proposes* an install (in the browser that is an Install card the user
  approves), and the MCP result carries those as `proposed_installs` for the
  agent to carry out with `frame_scene_install` — with `confirm: true`, and
  only on the user's say-so.

Resources: `frameos://frames`, `frameos://frames/{id}`, `frameos://scenes`,
`frameos://scenes/{id}/content`. Prompts: `diagnose_frame`, `build_scene`.

API refusals reach the model as `isError` results with the status, the code,
the details the route sent, and — for the codes whose fix is not obvious
(`reauth_required`, `read_only_token`, `settings_need_newer_firmware`,
`turn_in_progress`, quota errors, …) — one sentence on what to do
(`packages/mcp/src/result.ts`).

### Tests

`pnpm --filter @frameos-cloud/mcp test` drives the server through an
in-memory MCP client against a fake cloud and pins, per tool, which routes
are hit with what. The auth-web suite covers the token library, the CSRF
bearer path, the token routes, the lint route and the renderer (the render
test skips when `public/frameos-wasm` is absent).
