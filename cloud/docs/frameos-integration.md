# FrameOS Integration Contract

This document is the cloud-side contract for the FrameOS backend and
frontend work. The implementation in that repository should stay generic OIDC
and device-flow oriented; it must not depend on private FrameOS Cloud internals.

## Backend Configuration

`FRAMEOS_AUTH_PROVIDER_URL` controls cloud auth in the FrameOS backend:

- Unset or empty: use `https://cloud.frameos.net`.
- URL value: use that auth provider origin.
- `disabled`: hide cloud auth and keep local login only.

FrameOS should normalize this value with the helper exported from
`@frameos-cloud/auth-client`:

```ts
import { normalizeFrameosAuthProviderUrl } from "@frameos-cloud/auth-client";
```

The backend should still preserve local email/password login by default. A
cloud-only setting must require a verified working cloud owner/admin session
before local fallback can be disabled.

The hosted Scene Store is canonical at `https://scenes.frameos.net`, account
and device-approval pages are canonical at `https://account.frameos.net`, and
login/auth plus backend-link endpoints remain under
`https://cloud.frameos.net`. Store API routes continue to answer on the cloud
origin as a backwards-compatibility path for already linked backends, while
new public repository configuration should use:

```text
https://scenes.frameos.net/api/store/repository.json
```

## Browser Login

For browser login, FrameOS should treat `FRAMEOS_AUTH_PROVIDER_URL` as the
FrameOS Cloud app origin. That app owns sign-in directly (first-party
email/password plus optional Google SSO) and stores the FrameOS-owned account
mapping; there is no external identity provider between FrameOS and FrameOS
Cloud.

FrameOS should create or link a local `User` row for a cloud principal. Matching
email is not proof of ownership and must not overwrite a local profile
automatically.

## Backend Linking

Backends without a stable public callback URL use the device authorization
contract implemented in this repo:

```text
POST {provider}/api/device/start
POST {provider}/api/device/poll
POST {provider}/api/backends/inventory
GET  {provider}/api/backends/grants
POST {provider}/api/backends/rotate-token
POST {provider}/api/backends/unlink
```

`POST /api/device/start` accepts:

```json
{
  "public_display_name": "Kitchen FrameOS backend",
  "local_origin": "http://frameos.local",
  "reported_frameos_version": "0.1.0",
  "capabilities": {
    "localFallback": true
  },
  "client_kind": "backend",
  "scopes": ["backend:link", "backend:read"]
}
```

`client_kind` is `"backend"` or `"frame"`. When omitted it is derived from the
requested scopes (`frame:link` → `"frame"`). It is stored on the request and
the linked client, and the approval screen and account page use it to say
"frame" instead of "backend".

The response contains `device_code`, `user_code`, `verification_uri`,
`verification_uri_complete`, `expires_in`, and `interval`.

### Scopes

Unknown scopes are dropped from the request; an empty or missing `scopes`
array falls back to the default `["backend:link", "backend:read"]`. The
requested scopes and their descriptions are shown to the user on the approval
screen. The allowlist:

| Scope               | Description                                                           | Paid plan   |
| ------------------- | --------------------------------------------------------------------- | ----------- |
| `backend:link`      | Register this backend with your FrameOS Cloud account (default)       |             |
| `backend:read`      | Read basic backend connection details (default)                       |             |
| `auth:login`        | Sign users in to this backend with their FrameOS Cloud account        |             |
| `frame:link`        | Link a frame directly to your FrameOS Cloud account without a backend |             |
| `store:read`        | Browse and install scenes from the FrameOS store                      |             |
| `store:publish`     | Publish scenes from this backend to the FrameOS store                 |             |
| `gallery:read`      | Show curated images from the FrameOS gallery on frames                |             |
| `backup:scenes`     | Store encrypted backups of your scenes                                | may require |
| `backup:frames`     | Store encrypted backups of frame configurations                       | may require |
| `backup:assets`     | Store encrypted backups of frame assets                               | may require |
| `remote:access`     | Open a relay so this backend can be reached from cloud.frameos.net    | may require |
| `telemetry:logs`    | Send frame and backend logs to FrameOS Cloud                          | may require |
| `telemetry:metrics` | Send frame and backend metrics to FrameOS Cloud                       | may require |

The backend polls `POST /api/device/poll` with:

```json
{ "device_code": "..." }
```

Pending responses return `authorization_pending`. Approved responses return a
Bearer `access_token`, token reference, linked client id, and an
`approved_by` claims object (account id, issuer, subject, email snapshot) that
identifies the approving account so FrameOS can map its local user to the
cloud account without a second handoff. The backend stores the token securely
and uses it only for cloud sync endpoints. Identity matching on the FrameOS
side falls back to the stable `account_id` when the same account signs in
through a different method (password vs. Google).

## Inventory And Grant Sync

After approval, the backend reports inventory:

```http
POST /api/backends/inventory
Authorization: Bearer {link_token}
```

Payload:

```json
{
  "reported_frameos_version": "0.1.0",
  "capabilities": { "localFallback": true },
  "health": { "status": "ok" }
}
```

The backend fetches grants:

```http
GET /api/backends/grants
Authorization: Bearer {link_token}
```

The response identifies the cloud account that owns the backend link:

```json
{
  "grants": [
    {
      "account_email": "owner@example.com",
      "account_id": "…",
      "role": "owner",
      "updated_at": "2026-07-09T12:00:00.000Z"
    }
  ],
  "linked_client_id": "…"
}
```

`account_email` is a display/contact snapshot of the owning account's email
(may be `null`), intended for "Connected as \<email\>" UI. It is not an
identity key and must not be used for account matching.

FrameOS should cache enough state for short provider outages, but explicit
revocation should take effect as soon as the backend can reconnect.

The backend can rotate its link credential:

```http
POST /api/backends/rotate-token
Authorization: Bearer {link_token}
```

The response returns a new Bearer token and token reference. The backend should
replace the old stored token atomically.

The backend can change its enabled features (granted scopes) in place:

```http
POST /api/backends/scopes
Authorization: Bearer {link_token}
{"scopes": ["backend:link", "backend:read", "auth:login"]}
```

Removals apply immediately (`{"status": "updated", "scope": "…"}`); the base
link scope is never dropped. Additions of the features included with every
cloud account (`autoGrantedDeviceScopes`: `backup:scenes`, `backup:frames`,
`store:publish`) also apply immediately. Additions of security-sensitive
scopes (`auth:login`, `remote:access`, …) return `{"status":
"approval_required"}` with a device/user code — the owning account (and only
it) approves on `/device`, the backend polls `POST /api/device/poll`, and the
approved response carries the new `scope` without an `access_token`: the link
credential never changes. The approval screen labels these requests as a
feature change and shows human-readable feature names ("Cloud login") from
`deviceScopeLabels`.

Cloud-session logout for linked installs: `GET /logout?return_to=…` revokes
the session and redirects to `return_to` when its origin matches one of the
account's linked clients (loopback hosts allowed for development), else to the
sign-in page. FrameOS backends send users here after a local logout so cloud
login cannot silently sign them back in. Finding/approving devices on
`/device` (and `GET /api/device/request`) requires a signed-in session.

The backend can disconnect itself ("self-unlink") when the user removes the
cloud connection from the FrameOS settings:

```http
POST /api/backends/unlink
Authorization: Bearer {link_token}
```

The response is `{ "status": "unlinked" }`. The link token stops
authenticating immediately; a repeat call (or any other API call) with the
same token returns `401 invalid_link_token`. The user-facing counterpart that
revokes a link from the cloud account page is `POST /api/device/revoke`
(session cookie, not the link token).

## Backend Login Handoff

After linking, a backend (or frame) can start a cloud login handoff:

```http
POST /api/frameos/login/start
Authorization: Bearer {link_token}
```

Requires the `auth:login` scope on the link (`403 insufficient_scope`
otherwise). The `redirect_uri` must be on the same origin as the
`local_origin` reported during linking. Cloud Auth redirects through the
user's account session — only the account that owns the link can approve —
and returns a short-lived code to that redirect URI. The backend exchanges the
code through `POST /api/frameos/login/token` with the same link token.

## Config Backups

Linked clients with the `backup:scenes` / `backup:frames` scopes can store
small config blobs (see `docs/cloud-link.md` in the AGPL repo for the wire
contract mirrored here):

```http
GET    /api/backends/backups        # list (only kinds the scopes allow)
POST   /api/backends/backups        # {kind, item_key, name?, content_base64, content_type?}
GET    /api/backends/backups/{id}   # metadata + content_base64
DELETE /api/backends/backups/{id}
```

Backups are owned by the **account**, not the linked client: after a
reinstall, a newly linked backend on the same account still lists and restores
the old install's backups. One live copy per `(account, kind, item_key)`;
saves replace in place. Caps: 8 MB per blob, 500 backups per account
(`backup_too_large` / `backup_quota_exceeded`). The scope for a kind is
enforced on every request, including reads.

## Frontend States

FrameOS frontend work should expose:

- Login/signup: "Continue with FrameOS Cloud" when the provider is enabled.
- Settings/account: disconnected, connecting, connected, revoked, and provider
  disabled states.
- Device linking: user code, QR code to `verification_uri_complete`,
  expiration countdown, poll status, and final success/denial.
- Local fallback: visible status and guarded enable/disable action.
- Cloud mapping: linked cloud account and backend link status.

Business logic should live in existing FrameOS kea logic modules rather than
component-local state.
