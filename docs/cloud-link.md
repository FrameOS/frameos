# FrameOS Cloud link protocol

FrameOS (AGPL) can link a backend — or a frame directly — to a "cloud
provider": by default `https://cloud.frameos.net`, but the URL is
user-editable and the protocol below is the complete contract, so anyone can
run their own compatible provider. FrameOS works fully without any provider;
the link only adds optional services.

Related reading: `CLOUD-TODO.md` (roadmap and permission scopes),
`backend/app/api/cloud.py` and `backend/app/utils/cloud_link.py` (backend
implementation), `frameos/src/frameos/server/routes/cloud_api_routes.nim`
(on-frame implementation).

## Principles

- **Outbound-only.** The FrameOS side initiates every request. A provider can
  never reach into an installation; even revocation only takes effect when the
  installation next syncs.
- **Scoped tokens.** Linking uses the OAuth 2.0 Device Authorization Grant
  (RFC 8628). The user approves a short code in their provider account, in a
  browser, and sees exactly which permission scopes are requested. The
  resulting bearer token carries only those scopes.
- **Local-first.** Local login and local data always keep working. Disabling
  local password login (a later phase) will require a verified working cloud
  session first.

## Configuration

Environment variable on the backend (`backend/app/config.py`):

| `FRAMEOS_CLOUD_URL` | Meaning |
|---|---|
| unset / empty | use `https://cloud.frameos.net` |
| an `http(s)://` origin | use that provider |
| `disabled` | hide the cloud link feature entirely |

(`FRAMEOS_AUTH_PROVIDER_URL` is accepted as a fallback name.) The provider URL
can also be edited in the UI while disconnected; the edited value is stored
with the link and wins over the environment default.

On a frame, link state (including the URL) lives in `./state/cloud_link.json`
next to the FrameOS binary; there is no environment toggle.

## Permission scopes

Requested at link time, shown on the provider's consent screen, and returned
with the token. Unknown scopes must be dropped by the provider; an empty list
falls back to the provider's default.

| Scope | Allows the holder to |
|---|---|
| `backend:link` | register a backend, sync inventory/health, rotate its token |
| `backend:read` | read basic backend connection details |
| `frame:link` | register a frame that links directly, without a backend |
| `auth:login` | sign users in to this installation via their cloud account |
| `store:read` | browse/install from scene & app repositories |
| `store:publish` | publish scenes/apps to the user's collections or the store |
| `gallery:read` | access curated photo galleries |
| `backup:templates` | store scene template collections |
| `backup:frames` | store frame metadata + scene backups |
| `backup:assets` | store client-side-encrypted frame asset backups |
| `remote:access` | relay inbound connections to this installation |
| `telemetry:logs` | ship logs for retention |
| `telemetry:metrics` | ship metrics for retention |

Phase 0 requests only `backend:link backend:read` (backends) or `frame:link`
(frames). Feature scopes are requested when the user enables the feature.
Some scopes may map to paid plans on cloud.frameos.net; the consent screen
must say so before approval.

## Linking (device authorization)

All bodies are JSON; all responses are JSON.

### 1. Start

```http
POST {provider}/api/device/start
```

```json
{
  "public_display_name": "FrameOS backend (https://frameos.example)",
  "local_origin": "https://frameos.example",
  "reported_frameos_version": "2026.7.4",
  "capabilities": { "localFallback": true },
  "client_kind": "backend",
  "scopes": ["backend:link", "backend:read"]
}
```

`client_kind` is `"backend"` or `"frame"`; when omitted, the provider derives
it from the base scope (`frame:link` → frame). It is shown on the consent
screen and stored with the link.

Response `200`:

```json
{
  "device_code": "…",
  "user_code": "ABCD-1234",
  "verification_uri": "https://cloud.frameos.net/device",
  "verification_uri_complete": "https://cloud.frameos.net/device?code=ABCD-1234",
  "expires_in": 600,
  "interval": 5
}
```

The FrameOS UI shows `user_code` and links to `verification_uri_complete`.
The user signs in to the provider and approves (or denies) the request there,
seeing the requested scopes.

### 2. Poll

```http
POST {provider}/api/device/poll
{ "device_code": "…" }
```

- Pending: `{"error": "authorization_pending", "interval": 5}` (HTTP 428)
- Denied: `{"error": "access_denied"}` (HTTP 403)
- Expired: `{"error": "expired_token"}` (HTTP 400)
- Approved (once — the device code is single-use):

```json
{
  "access_token": "…",
  "token_type": "Bearer",
  "scope": "backend:link backend:read",
  "linked_client_id": "…",
  "token_reference": "…",
  "approved_by": {
    "account_id": "…",
    "email": "owner@example.com",
    "email_verified": true,
    "name": "…",
    "provider_issuer": "…",
    "provider_subject": "…",
    "sub": "…"
  }
}
```

`approved_by` identifies the account that approved the link, in the same
claim format as the login handoff. Since the approver is the person doing the
connecting, FrameOS maps it to the connecting local user right away
(`cloud_identity`), so cloud login works without a separate linking step. It
is released once, with the token.

The FrameOS side stores the token encrypted at rest (backend: Fernet keyed off
`SECRET_KEY`; frame: `0600` state file) and never exposes it over its own API.

## Linked endpoints (Bearer token)

```http
POST {provider}/api/backends/inventory     # report version/capabilities/health
GET  {provider}/api/backends/grants        # who owns this link + granted scopes
POST {provider}/api/backends/rotate-token  # atomic credential rotation
POST {provider}/api/backends/scopes        # change enabled features in place
POST {provider}/api/backends/unlink        # self-revoke on disconnect
```

### Changing enabled features (`/api/backends/scopes`)

`{"scopes": ["backend:link", "backend:read", "auth:login", …]}` — the full
desired set. Removing scopes is applied immediately (`{"status": "updated",
"scope": "…"}`): the token holder reducing its own privileges needs no
consent, and the base link scope can never be dropped. Adding scopes returns
`{"status": "approval_required", "device_code", "user_code",
"verification_uri(_complete)", "expires_in", "interval"}`: the owner approves
the change on the provider's device screen (only the account that owns the
link may approve it), and the FrameOS side polls `POST /api/device/poll` as
usual. The approved poll response carries the new `scope` and **no**
`access_token` — the link credential never changes.

`grants` response shape:

```json
{
  "grants": [
    { "account_id": "…", "account_email": "owner@example.com", "role": "owner", "updated_at": "…" }
  ],
  "linked_client_id": "…"
}
```

`account_email` is a display snapshot, not an identity key. FrameOS may cache
grant state across short provider outages, but must honor revocation as soon
as it can reconnect (an unlinked token gets `401 invalid_link_token`). The
backend runs a periodic grants sync (`backend/app/cloud/sync.py`); a 401
resets the local link and re-enables local password login.

## Login handoff (Phase 1, scope `auth:login`)

Signs a browser user in to a FrameOS install with their provider account. The
provider only completes a handoff for the account that owns the link, so a
redeemed code is proof of ownership. Flow (all provider calls carry the link's
Bearer token and require the `auth:login` scope, else `403 insufficient_scope`):

```http
POST {provider}/api/frameos/login/start
{ "redirect_uri": "{local_origin}/api/cloud/login/callback", "state": "…", "intent": "login" }
```

`redirect_uri` must be on the `local_origin` reported at link time. Response:
`{"authorization_url": "…", "expires_in": 600}`. FrameOS sends the browser to
`authorization_url`; the provider authenticates the user, checks they own the
link, and 30x-redirects to `redirect_uri?code=…&state=…` (or `?error=…&state=…`).

```http
POST {provider}/api/frameos/login/token
{ "code": "…" }
```

The code is single-use and bound to the linked client. Response:

```json
{
  "claims": { "account_id": "…", "email": "…", "email_verified": true, "name": "…", "provider_subject": "…", "sub": "…" },
  "provider_issuer": "…"
}
```

FrameOS-side behavior (`backend/app/api/cloud.py`, frame:
`cloud_api_routes.nim`):

- Identity mapping is keyed on `(provider_issuer, provider_subject)` and stored
  in `cloud_identity`. A matching email is never proof of ownership: an
  existing local user must link their cloud account explicitly (logged-in
  handoff via `POST /api/cloud/identity/link`).
- First-run setup: while no local user exists, the open `/api/cloud/setup/*`
  endpoints mirror status/provider/connect/poll/disconnect, and a completed
  login handoff creates the first user from the cloud principal.
- Local fallback: `POST /api/cloud/local-fallback {"enabled": false}` disables
  local password login. It requires a connected link with `auth:login`, the
  current user's identity matching the link's owner account, and a live grants
  check. Losing or disconnecting the link always re-enables local login.
- Frames run the same handoff against their own open
  `/api/cloud/login/{options,start,callback}` routes; a successful callback
  mints the on-device admin session.
- Logout: signing out of a FrameOS install that uses cloud login also ends the
  provider session, or the login screen's cloud button would sign the user
  straight back in. `POST /api/logout` returns a `cloud_logout_url`
  (`{provider}/logout?return_to={origin}/login`) when the user has a linked
  identity; the provider validates `return_to` against the account's linked
  client origins (loopback hosts are allowed for development) and bounces
  back to the install's login page.

## Config backups (Phase 3, scopes `backup:templates` / `backup:frames`)

Small replace-in-place blobs owned by the provider **account** (not the linked
client), so a reinstalled backend that relinks to the same account can restore
them. All endpoints carry the link's Bearer token and enforce the matching
scope per kind (`templates` → `backup:templates`, `frames` → `backup:frames`):

```http
GET    {provider}/api/backends/backups                 # list (kinds the scopes allow)
POST   {provider}/api/backends/backups                 # save/replace one blob
GET    {provider}/api/backends/backups/{id}            # metadata + content_base64
DELETE {provider}/api/backends/backups/{id}
```

Save request:

```json
{
  "kind": "frames",
  "item_key": "frame-7",
  "name": "Kitchen frame",
  "content_base64": "…",
  "content_type": "application/json"
}
```

One live copy exists per `(account, kind, item_key)`; a new save replaces it.
Providers should cap blob size (cloud.frameos.net: 8 MB) and count per
account, and answer `413 backup_too_large` / `403 backup_quota_exceeded`.

Payload formats (defined FrameOS-side, opaque to the provider):

- `templates`: the template interchange zip (`{name}/template.json`,
  `scenes.json`, `image.jpg`) — the same file the local export produces.
- `frames`: JSON `{"format": "frameos-frame-backup-v1", "saved_at", "project_name", "frame": {…}}`
  where `frame` is the frame's metadata + scene JSON **with all local secrets
  stripped** (SSH credentials, access keys, TLS material, wifi passwords —
  see `backend/app/utils/cloud_backup.py`). Restores regenerate fresh local
  credentials. Frame backups are pushed automatically after each successful
  deploy while the scope is granted.

The do-it-yourself alternative that needs no provider: `GET /api/backup/export`
on the backend returns everything (full fidelity, secrets included — it stays
local) as a plain `.tar.gz`.

## Scene store (Phase 2, scope `store:publish`)

The provider may host an npm-style registry of scenes. Distribution reuses the
formats FrameOS already speaks, so **browsing and installing needs no new
protocol at all**: the public store is a plain scenes repository —

```http
GET {provider}/api/store/repository.json         # public, standard repository JSON
GET {provider}/api/store/scenes/{id}/download    # public; ?version=N; the template zip
GET {provider}/api/store/scenes/{id}/image       # public; preview image
```

A backend with a connected link seeds `{provider}/api/store/repository.json`
as a normal repository once per project (deleting it is respected).

Publishing carries the link's Bearer token and the `store:publish` scope:

```http
POST {provider}/api/store/publish
```

```json
{
  "name": "Sunrise Clock",
  "description": "optional; falls back to the zip's template.json",
  "visibility": "private | public — optional; private on first publish, unchanged after",
  "content_base64": "…the template interchange zip…",
  "content_type": "application/zip"
}
```

Response: `{"status": "published", "scene": {"id", "slug", "name",
"visibility", "version", "url"}}` — `url` is the scene's page on the
provider's website.

Semantics the provider must honor:

- **Versions are immutable.** A publish appends version N+1; re-publishing the
  same `name` from the same account updates that scene, a new name creates a
  new one. Bytes under a published version never change.
- **Private by default.** A scene is visible only to its owning account until
  made public (on the provider's website, or by an explicit `visibility`).
- **Moderation.** Providers can *pull* a scene: it disappears from the index,
  downloads answer `410`, and republishing over it is rejected
  (`403 scene_pulled`). Structural validation at publish may reject
  `invalid_zip`, `missing_template_json`, `missing_scenes`,
  `413 scene_too_large`, or quota errors (`403 scene_quota_exceeded` /
  `storage_quota_exceeded`).

## The FrameOS-side API

Both the backend (FastAPI, login-gated) and the frame's on-device admin server
(Nim, admin-session-gated) expose the same five endpoints, driven by the
shared settings UI:

```http
GET  /api/cloud/status      # current state, see shape below
POST /api/cloud/provider    # {"provider_url": "…"} — only while disconnected
POST /api/cloud/connect     # optional {"provider_url", "scopes"} — starts the device flow
POST /api/cloud/poll        # one poll step; the UI calls this on the advertised interval
POST /api/cloud/disconnect  # best-effort cloud unlink + local reset
```

Phase 1/3 additions (login endpoints are open — the user is not logged in yet;
the rest are login-gated; `/setup/*` only answer while no local user exists):

```http
GET  /api/cloud/login/options     # {"available", "provider_url", "local_login_enabled", "setup_mode"}
POST /api/cloud/login/start       # {"next"?} → {"authorization_url"}
GET  /api/cloud/login/callback    # ?code&state → session cookie + redirect
POST /api/cloud/identity/link     # logged-in handoff that links the identity instead
POST /api/cloud/identity/unlink
POST /api/cloud/local-fallback    # {"enabled": bool}
POST /api/cloud/features          # {"scopes": […]} — change enabled features in place
POST /api/cloud/features/cancel   # forget a pending feature-change approval
GET|POST /api/cloud/setup/{status,provider,connect,poll,disconnect}
GET  /api/cloud/backups           # proxied list from the provider
POST /api/cloud/backups/templates # {"template_id"} — push one template
POST /api/cloud/backups/frames    # {"frame_id"} — push one frame
POST /api/cloud/backups/restore   # {"backup_id", "project_id"}
GET  /api/backup/export           # local tar.gz of everything (no cloud needed)
POST /api/cloud/store/publish     # {"template_id", "visibility"?} — publish a scene to the store
```

`GET /api/cloud/status` shape (mirrored by `CloudStatus` in
`frontend/src/types.tsx`):

```json
{
  "enabled": true,
  "provider_url": "https://cloud.frameos.net",
  "default_provider_url": "https://cloud.frameos.net",
  "status": "disconnected | connecting | connected",
  "can_edit_provider": true,
  "poll_error": null,
  "connection": { "user_code": "…", "verification_uri": "…", "verification_uri_complete": "…", "expires_at": "…", "interval_seconds": 5 },
  "link": { "linked_client_id": "…", "scopes": ["…"], "account_id": "…", "account_email": "…", "connected_at": "…", "last_inventory_sync_at": "…" }
}
```

`connection` is set only while `connecting`; `link` only while `connected`.
The access token itself is never included.

## Running your own provider

Implement the five `{provider}` endpoints above (device start/poll +
inventory/grants/rotate-token/unlink) with these behaviors:

- device codes: single-use, hashed at rest, short expiry (~10 min), poll rate
  limiting with `authorization_pending`;
- user codes: short, human-typable, approval requires an authenticated user
  session on your site and must display the requested scopes;
- tokens: opaque bearer secrets, hashed at rest, revocable per link, with a
  rotation endpoint that keeps a short grace window for the previous token;
- scopes: enforce on every request; drop unknown requested scopes.

Then point `FRAMEOS_CLOUD_URL` (or the settings UI) at your origin. Later
phases (login handoff, store, backups, relay) will extend this document as
they are implemented; the scope table above reserves their names.
