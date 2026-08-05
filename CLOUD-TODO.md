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
  services below. Store decisions and threat model: `cloud/STORE-TODO.md`;
  cloud-app scope guardrails: `cloud/TODO.md`.

Remaining work, open questions, and the ideas parking lot are tracked in
one place: `docs/todo.md`. This file keeps the principles, the scope
table, and the protocol summary.

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
5. **NO image proxies for frames. EVER.** Frames fetch and render images
   directly from their sources — never through the backend or the cloud as a
   resizing/fetching middleman, and not via host-side resize params either.
   If a source serves images too large for a device, the fix is better
   on-device streaming decode (incremental inflate + row-by-row
   unfilter/scale into the render target). Proxies are acceptable for
   in-browser previews only. Do not re-implement proxying; it has been built
   and reverted before.
   Why: we don't want to become critical infrastructure for image delivery.
   Frames that keep working without the cloud are insurance against lock-in
   on FrameOS Cloud, and staying out of every image request protects us
   against rising bandwidth and compute costs as the fleet grows.

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

Everything below is live, documented in `docs/cloud-link.md` (frames wire
contract: `docs/cloud-frames.md`), and covered by tests:

- **Linking** (device authorization flow, backends + frames, encrypted
  tokens, grants/inventory sync), **cloud login** (handoff, identity
  linking, first-run setup, lockout-proof local fallback), **scene store**
  (publish, public repository, "Private cloud scenes", risk badges —
  decisions in `cloud/STORE-TODO.md`), **config backups**
  (`backup:scenes`/`backup:frames`, sealed-envelope encryption, tarball
  export), **`frameos-wasm`/`frameos-editor`** npm packages, and
  **cloud-managed frames** (enrollment, control plane + durable queue,
  `apps/frame-hub`, restricted interpreted-only device client, shared-SPA
  workspace at `cloud.frameos.net/frames`, log shipping, buildroot
  personalization, ESP32 browser flashing — design:
  `cloud/docs/cloud-frames.md`; workspace ledger:
  `cloud/docs/cloud-workspace-gaps.md`).
- E2E: `backend/app/api/tests/test_cloud_e2e.py` via
  `cloud/scripts/e2e-frameos.sh`.

## Remaining work

Tracked in `docs/todo.md` (one consolidated list: signed OTA, JS-runtime
capability audit, account hardening, gallery/asset-backup/remote-access
services, observability, store apps, open questions, parking lot).

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

Open product questions (billing, publish review policy, backup-key UX,
per-org links) live with the rest of the tracker in `docs/todo.md`.
