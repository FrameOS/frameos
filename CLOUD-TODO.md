# FrameOS Cloud — plan and work tracker

This file tracks the work to link FrameOS backends (and frames directly) to
FrameOS Cloud (`https://cloud.frameos.net`, the `cloud/` app in this repo).

Two sides are involved:

- **FrameOS** (`backend/`, `frontend/`, `frameos/`) — everything a self-hosted
  user runs. Must stay fully functional without the cloud, and must talk to
  the cloud only through a documented, reimplementable protocol
  (`docs/cloud-link.md`). Anyone can point it at their own compatible server.
- **FrameOS Cloud** (`cloud/`) — the hosted service: accounts, linked
  backends, the device-authorization flow, the scene store, and the paid
  services below. Its own tracker is `cloud/TODO.md`; the store's is
  `cloud/STORE-TODO.md`.

## Principles

1. **One-way, outbound-only.** Backends and frames initiate every connection.
   Linking uses the OAuth 2.0 Device Authorization Grant (RFC 8628): the
   backend asks the cloud for a code, the user approves it in their cloud
   account in a browser, the backend polls and receives a scoped bearer token.
   The cloud can never reach into a backend unless the backend has explicitly
   opened a tunnel (remote access scope + user toggle).
2. **Tightly scoped permissions.** The token carries only the scopes the user
   approved on the consent screen. Scopes are additive, revocable per scope,
   and every privileged feature checks its scope on both sides. Adding a
   scope to an existing link always needs owner approval on the provider's
   device screen — a linked client can never escalate its own privileges
   silently. Removals apply immediately.
3. **Local-first, cloud-optional.** Local login, local backups, and local
   repositories always keep working. Every paid cloud service has a documented
   do-it-yourself alternative.
4. **Upfront about money.** Services that cost real money to run (storage,
   relay bandwidth, log retention) will be paid. The UI must say so before the
   user enables them, never after.
5. **Documented protocol boundary.** The protocol (endpoints, payloads, token
   semantics) is documented in `docs/cloud-link.md`. Device and cloud stay
   loosely coupled behind that contract, and independent implementations of
   the documented protocol need no permission from us.
6. **NO image proxies for frames. EVER.** Frames fetch and render images
   directly from their sources — never through the backend or the cloud as a
   resizing/fetching middleman, and not via host-side resize params either.
   If a source serves images too large for a device, the fix is better
   on-device streaming decode (incremental inflate + row-by-row
   unfilter/scale into the render target). Proxies are acceptable for
   in-browser previews only. Do not re-implement proxying; it has been built
   and reverted before.

## Permission scopes

Requested at link time, shown on the cloud consent screen, stored with the
link, re-checkable via the grants endpoint:

| Scope | Grants the cloud/backend the ability to | Paid? |
|---|---|---|
| `backend:link` | Base scope: identify this backend, sync inventory/health, rotate token | free |
| `auth:login` | Log users into this backend via their FrameOS Cloud account (login handoff) | free |
| `store:read` | Browse/install from the scene & app store (public repositories) | free |
| `store:publish` | Publish scenes/apps to the user's cloud collections or public store | free |
| `gallery:read` | Access curated photo galleries / gallery API | freemium |
| `backup:scenes` | Store the user's scene template collections in the cloud | paid tier |
| `backup:frames` | Back up frame metadata + scene JSON ("backup of your backup") | paid tier |
| `backup:assets` | Back up frame assets (SD card contents), client-side encrypted | paid (storage) |
| `remote:access` | Relay inbound connections so `something.local:8616` is reachable from cloud.frameos.net | paid (bandwidth) |
| `telemetry:logs` | Ship logs to cloud retention | paid (retention) |
| `telemetry:metrics` | Ship metrics to cloud retention | paid (retention) |

Frames that link directly (no backend) use the same flow with `frame:link` as
the base scope plus the subset that makes sense on-device (`auth:login`,
`backup:assets`, `remote:access`).

Notes:
- The UI never says "scopes" or "permissions": these are the install's
  **enabled features**. They change in place through
  `POST {provider}/api/backends/scopes` (Settings → FrameOS Cloud → Enabled
  features) — removals apply immediately, additions need a quick owner
  approval on the provider's device screen; the link token never changes and
  nothing disconnects.
- The backup scopes are a permission, not the feature: nothing is uploaded
  until the user flips the local scene/frame backup switches
  (`backup_scenes_enabled` / `backup_frames_enabled`, instant, no cloud
  approval). Same pattern as the future `remote:access` local toggle —
  granting a scope alone must never move data.
- `remote:access` additionally requires an explicit on/off toggle locally;
  granting the scope alone must not open a tunnel.
- "Paid?" is a product intention, not a commitment; free tiers likely include
  small quotas. The linking/consent UI must show the price state of a scope.

## Shipped

Each of these is documented in `docs/cloud-link.md` and covered by tests;
implementation entry points in parentheses.

- **Linking** via the device authorization flow, from backends
  (`backend/app/api/cloud.py`, `frontend/src/scenes/settings/cloudLogic.tsx`)
  and directly from frames
  (`frameos/src/frameos/server/routes/cloud_api_routes.nim`); token encrypted
  at rest; grants/inventory sync loop (`backend/app/cloud/sync.py`).
- **Cloud login**: "Continue with FrameOS Cloud" on backend and on-device
  admin login screens, explicit identity linking, first-run setup from a
  cloud principal, and a local-password fallback toggle that can never lock
  an install out.
- **Scene store**: publish from the Templates UI (`store:publish`), the
  public store as a plain scenes repository, "Private cloud scenes" private
  scenes, version stamping, risk badges. Store-side details and decisions:
  `cloud/STORE-TODO.md`.
- **Config backups** (`backup:scenes` / `backup:frames`): scene template and
  frame config backups with local on/off switches, secret stripping on
  upload, restore, and the no-cloud-needed tarball export
  (`GET /api/backup/export`).
- **`frameos-wasm` and `frameos-editor`** as workspace packages powering
  in-browser live previews and web scene editing on the store; published to
  npm on release.
- **E2E coverage**: `backend/app/api/tests/test_cloud_e2e.py` against a real
  local cloud dev server, booted by `cloud/scripts/e2e-frameos.sh`.

## Remaining work

- Apps (not just scenes) in the store — needs a code-review/signing story
  first (`cloud/STORE-TODO.md`).
- Photo gallery service (`gallery:read`): curated feeds usable as image
  sources in scenes, quota-limited free tier.
- Asset backup (`backup:assets`): client-side encryption (age or similar,
  key never leaves the user), content-addressed chunks, resumable.
- Remote access (`remote:access`): persistent outbound WebSocket tunnel
  from backend/frame to a cloud relay (pattern exists in
  `app/ws/remote_bridge.py`); reach your backend/frame UI from
  cloud.frameos.net. Explicit local toggle, visible "tunnel open" status.
- Direct frame login from the cloud via that relay (`/admin` handoff).
- Observability: log shipping + retention (`telemetry:logs`), metrics +
  dashboards (`telemetry:metrics`), uptime/health alerts ("your frame has
  been offline for 2 days").
- Cloud-managed frames — the concrete design lives in
  `cloud/docs/cloud-frames.md` (enrollment, restricted device profile,
  interpreted-only scene pushes, fleet UI).

## Ideas parking lot (unscheduled)

- Fleet features: one cloud account administering many backends (installer /
  digital-signage use case); cloud-side "all my frames" dashboard.
- Shared household access: invite a second cloud account to a backend with a
  role (viewer/member/admin) — the `cloud_membership` table anticipates this.
- Notifications: deploy finished / frame offline → push/email via cloud.
- Community scene of the day / featured gallery pushed as an opt-in feed.
- Hosted backends: run the whole backend in the cloud, only frames at home.
- E-ink-friendly weather/calendar data proxy (normalized upstream APIs, one
  key, cached) so users don't need their own API keys per service.

## Protocol summary (details in docs/cloud-link.md)

```
POST {provider}/api/device/start        → device_code, user_code, verification_uri(_complete), interval, expires_in
POST {provider}/api/device/poll         → authorization_pending | access_token + token_reference + linked_client_id
POST {provider}/api/backends/inventory  (Bearer) → report version/capabilities/health
GET  {provider}/api/backends/grants     (Bearer) → owning account, granted scopes
POST {provider}/api/backends/rotate-token (Bearer) → new token (atomic swap)
POST {provider}/api/device/revoke       (Bearer) → unlink
POST {provider}/api/frameos/login/start (Bearer) → login handoff
```

The provider URL is user-editable (default `https://cloud.frameos.net`), so any
server implementing this contract works. Env override: `FRAMEOS_CLOUD_URL`
(`disabled` hides the feature entirely).

## Open questions

- Billing mechanics (Stripe? bundled tiers vs. per-service metering) — decide
  before anything paid ships.
- Should `store:publish` require a verified email + human review always, or
  only for the public store (not personal collections)?
- Asset backup encryption UX: who holds the key, what does recovery look like
  if the user loses it? (Answer must be "we cannot read your photos".)
- One backend link per installation vs. per project — currently one per
  installation; multi-tenant installs may eventually want per-organization.
