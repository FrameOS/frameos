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
  "scopes": ["backend:link", "backend:read"]
}
```

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
  "token_reference": "…"
}
```

The FrameOS side stores the token encrypted at rest (backend: Fernet keyed off
`SECRET_KEY`; frame: `0600` state file) and never exposes it over its own API.

## Linked endpoints (Bearer token)

```http
POST {provider}/api/backends/inventory     # report version/capabilities/health
GET  {provider}/api/backends/grants        # who owns this link + granted scopes
POST {provider}/api/backends/rotate-token  # atomic credential rotation
POST {provider}/api/backends/unlink        # self-revoke on disconnect
```

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
as it can reconnect (an unlinked token gets `401 invalid_link_token`).

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
