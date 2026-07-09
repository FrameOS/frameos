# FrameOS Cloud — plan and work tracker

This file tracks the work to link FrameOS backends (and frames directly) to
FrameOS Cloud (`https://cloud.frameos.net`, private repo `../frameos-cloud`).

Two repos are involved:

- **frameos** (this repo, AGPL) — everything a self-hosted user runs. Must stay
  fully functional without the cloud, and must talk to the cloud only through a
  documented, reimplementable protocol (`docs/cloud-link.md`). Anyone can point
  it at their own compatible server.
- **frameos-cloud** (private) — the hosted service: accounts, linked backends,
  device-authorization flow, and the paid services below.

## Principles

1. **One-way, outbound-only.** Backends and frames initiate every connection.
   Linking uses the OAuth 2.0 Device Authorization Grant (RFC 8628): the
   backend asks the cloud for a code, the user approves it in their cloud
   account in a browser, the backend polls and receives a scoped bearer token.
   The cloud can never reach into a backend unless the backend has explicitly
   opened a tunnel (remote access scope + user toggle).
2. **Tightly scoped permissions.** The token carries only the scopes the user
   approved on the consent screen. Scopes are additive, revocable per scope,
   and every privileged feature checks its scope on both sides.
3. **Local-first, cloud-optional.** Local login, local backups, and local
   repositories always keep working. Every paid cloud service has a documented
   do-it-yourself alternative.
4. **Upfront about money.** Services that cost real money to run (storage,
   relay bandwidth, log retention) will be paid. The UI must say so before the
   user enables them, never after.
5. **AGPL-clean boundary.** The protocol (endpoints, payloads, token semantics)
   is documented in `docs/cloud-link.md` in this repo. The private repo may do
   whatever it wants behind that contract.

## Permission scopes

Requested at link time, shown on the cloud consent screen, stored with the
link, re-checkable via the grants endpoint. Proposed set:

| Scope | Grants the cloud/backend the ability to | Phase | Paid? |
|---|---|---|---|
| `backend:link` | Base scope: identify this backend, sync inventory/health, rotate token | 0 | free |
| `auth:login` | Log users into this backend via their FrameOS Cloud account (login handoff) | 1 | free |
| `store:read` | Browse/install from the scene & app store (public repositories) | 2 | free |
| `store:publish` | Publish scenes/apps to the user's cloud collections or public store | 2 | free |
| `gallery:read` | Access curated photo galleries / gallery API | 2 | freemium |
| `backup:templates` | Store the user's scene template collections in the cloud | 3 | paid tier |
| `backup:frames` | Back up frame metadata + scene JSON ("backup of your backup") | 3 | paid tier |
| `backup:assets` | Back up frame assets (SD card contents), client-side encrypted | 4 | paid (storage) |
| `remote:access` | Relay inbound connections so `something.local:8616` is reachable from cloud.frameos.net | 4 | paid (bandwidth) |
| `telemetry:logs` | Ship logs to cloud retention | 5 | paid (retention) |
| `telemetry:metrics` | Ship metrics to cloud retention | 5 | paid (retention) |

Frames that link directly (no backend) use the same flow with `frame:link` as
the base scope plus the subset that makes sense on-device (`auth:login`,
`backup:assets`, `remote:access`).

Notes:
- `remote:access` additionally requires an explicit on/off toggle locally;
  granting the scope alone must not open a tunnel.
- "Paid?" is a product intention, not a commitment; free tiers likely include
  small quotas. The linking/consent UI must show the price state of a scope.

## Phases

### Phase 0 — planning and linking (this branch)

The connection itself: a backend (or frame) can be linked to a cloud account
and hold a scoped token. No user-visible service yet beyond "Connected".

- [x] This plan.
- [x] Reuse the accidentally-shipped migration `2c4a6f8d9b10_cloud_auth_integration.py`.
      It is load-bearing (later migration `961ada4af571` chains off it, and it
      shipped in a release), so reverting would break user databases. Its
      `cloud_backend_link` table is the storage for the link. `cloud_identity`
      and `cloud_membership` stay unused until Phase 1.
- [x] Backend: `CloudBackendLink` model (`app/models/cloud.py`) over the
      existing table; token encrypted at rest (Fernet keyed off `SECRET_KEY`).
- [x] Backend API (`app/api/cloud.py`, login-gated, not project-scoped —
      the link belongs to the installation, not a project):
      `GET /api/cloud/status`, `POST /api/cloud/connect`,
      `POST /api/cloud/poll`, `POST /api/cloud/disconnect`,
      `POST /api/cloud/provider` (edit server URL while disconnected).
- [x] Frontend: "FrameOS Cloud" settings section between Account and Settings
      (`cloudLogic.tsx` + Settings.tsx section): connected state, connect
      button with user code + verification link + countdown + polling,
      provider URL editing when disconnected.
- [x] Frame (on-device admin): same UI, backed by Nim routes
      `/api/cloud/*` in `frameos/src/frameos/server/routes/cloud_api_routes.nim`,
      token stored in frame config.
- [x] Protocol documentation: `docs/cloud-link.md` (public, AGPL-side spec).
- [x] frameos-cloud: widen `allowedDeviceScopes` to the scope table above,
      render requested scopes + paid markers on the consent screen.
- [ ] frameos-cloud: distinguish backend links from direct frame links
      (`client_kind` on `linked_clients`).
- [ ] E2E happy-path test: local backend against a local frameos-cloud dev
      server.

### Phase 1 — cloud login (auth)

- [ ] "Continue with FrameOS Cloud" on `/login` and first-run `/signup` (setup)
      screens when a provider is configured (backend login handoff:
      `POST /api/frameos/login/start` → redirect → code exchange).
- [ ] Create/link local `User` for a cloud principal (`cloud_identity` table).
      Email match is NOT proof of ownership; explicit link required.
- [ ] Local-fallback toggle: disabling local passwords requires a verified,
      working cloud owner session (`local_fallback_enabled` column exists).
- [ ] Same for the frame on-device `/admin` login (`frame:link` + `auth:login`).
- [ ] Grants sync loop (arq worker, `app/ha/sync.py` singleton-service pattern)
      so cloud-side revocation takes effect quickly.

### Phase 2 — store and galleries

- [ ] Cloud-hosted scene/app repositories browsable in the existing
      repositories UI (`store:read`); the current repository JSON format is
      the interchange format.
- [ ] Publish a scene/template to a personal cloud collection or the public
      store (`store:publish`), with review flow on the cloud side.
- [ ] Photo gallery service (`gallery:read`): curated feeds usable as image
      sources in scenes, quota-limited free tier.

### Phase 3 — config backups

- [ ] Scene template collection backup/restore (`backup:templates`).
- [ ] Frame metadata + scenes backup (`backup:frames`), automatic after deploy;
      "Restore from FrameOS Cloud" option in backend first-run setup.
- [ ] Export everything as a plain tarball too (the self-service alternative).

### Phase 4 — heavy transport (paid)

- [ ] Asset backup (`backup:assets`): client-side encryption (age or similar,
      key never leaves the user), content-addressed chunks, resumable.
- [ ] Remote access (`remote:access`): persistent outbound WebSocket tunnel
      from backend/frame to a cloud relay (pattern exists in
      `app/ws/remote_bridge.py`); reach your backend/frame UI from
      cloud.frameos.net. Explicit local toggle, visible "tunnel open" status.
- [ ] Direct frame login from the cloud via that relay (`/admin` handoff).

### Phase 5 — observability (paid)

- [ ] Log shipping + retention (`telemetry:logs`).
- [ ] Metrics shipping + dashboards (`telemetry:metrics`).
- [ ] Uptime/health alerts ("your frame has been offline for 2 days").

### Ideas parking lot (unscheduled)

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
POST {provider}/api/frameos/login/start (Bearer) → login handoff (Phase 1)
```

The provider URL is user-editable (default `https://cloud.frameos.net`), so any
server implementing this contract works. Env override: `FRAMEOS_CLOUD_URL`
(`disabled` hides the feature entirely).

## Open questions

- Billing mechanics (Stripe? bundled tiers vs. per-service metering) — decide
  before Phase 3 ships anything paid.
- Should `store:publish` require a verified email + human review always, or
  only for the public store (not personal collections)?
- Asset backup encryption UX: who holds the key, what does recovery look like
  if the user loses it? (Answer must be "we cannot read your photos".)
- One backend link per installation vs. per project — currently one per
  installation; multi-tenant installs may eventually want per-organization.
