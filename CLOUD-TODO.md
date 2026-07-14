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
link, re-checkable via the grants endpoint. Proposed set:

| Scope | Grants the cloud/backend the ability to | Phase | Paid? |
|---|---|---|---|
| `backend:link` | Base scope: identify this backend, sync inventory/health, rotate token | 0 | free |
| `auth:login` | Log users into this backend via their FrameOS Cloud account (login handoff) | 1 | free |
| `store:read` | Browse/install from the scene & app store (public repositories) | 2 | free |
| `store:publish` | Publish scenes/apps to the user's cloud collections or public store | 2 | free |
| `gallery:read` | Access curated photo galleries / gallery API | 2 | freemium |
| `backup:scenes` | Store the user's scene template collections in the cloud | 3 | paid tier |
| `backup:frames` | Back up frame metadata + scene JSON ("backup of your backup") | 3 | paid tier |
| `backup:assets` | Back up frame assets (SD card contents), client-side encrypted | 4 | paid (storage) |
| `remote:access` | Relay inbound connections so `something.local:8616` is reachable from cloud.frameos.net | 4 | paid (bandwidth) |
| `telemetry:logs` | Ship logs to cloud retention | 5 | paid (retention) |
| `telemetry:metrics` | Ship metrics to cloud retention | 5 | paid (retention) |

Frames that link directly (no backend) use the same flow with `frame:link` as
the base scope plus the subset that makes sense on-device (`auth:login`,
`backup:assets`, `remote:access`).

Notes:
- The UI never says "scopes" or "permissions": these are the install's
  **enabled features**. They change in place through
  `POST {provider}/api/backends/scopes` (Settings → FrameOS Cloud → Enabled
  features) — removals apply immediately, additions of security-sensitive
  scopes need a quick owner approval on the provider's device screen; the
  link token never changes and nothing disconnects.
- Only security-sensitive features (cloud login, later remote access and
  telemetry) get a cloud-approved opt-in toggle. The safe scopes — backups and
  "Save and share scenes via the cloud" (`store:publish`) — are included with
  every cloud account: requested at link time and auto-granted when added
  later.
- The backup scopes are a permission, not the feature: nothing is uploaded
  until the user flips the local scene/frame backup switches
  (`backup_scenes_enabled` / `backup_frames_enabled`, instant, no cloud
  approval). Same pattern as the future `remote:access` local toggle —
  granting a scope alone must never move data.
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
- [x] frameos-cloud: distinguish backend links from direct frame links
      (`client_kind` on `linked_clients` and `device_authorization_requests`,
      set from the request body or derived from `frame:link`; consent screen
      and account page say "frame" vs "backend").
- [x] E2E happy-path test: local backend against a local frameos-cloud dev
      server. `backend/app/api/tests/test_cloud_e2e.py` (skipped unless
      `FRAMEOS_CLOUD_E2E_URL` is set); runner: frameos-cloud
      `scripts/e2e-frameos.sh`. Covers link + login handoff + backups over
      real HTTP.

### Phase 1 — cloud login (auth) — done

- [x] "Continue with FrameOS Cloud" on `/login` and first-run `/signup` (setup)
      screens when available (login handoff: `POST /api/frameos/login/start` →
      browser redirect → `POST /api/frameos/login/token`; the provider only
      completes a handoff for the account that owns the link, and enforces the
      `auth:login` scope). Frontend: `scenes/auth/cloudLoginLogic.ts`;
      first-run device-link flow on the signup screen uses the open
      `/api/cloud/setup/*` endpoints (valid only while no user exists) and
      creates the first local user from the cloud principal.
- [x] Create/link local `User` for a cloud principal (`cloud_identity` table,
      keyed on issuer+subject). Email match is NOT proof of ownership; a
      logged-in user links explicitly via `POST /api/cloud/identity/link`
      (same handoff, identity stored instead of a session).
- [x] Local-fallback toggle (`POST /api/cloud/local-fallback`): disabling
      requires a connected link with `auth:login`, the user's identity matching
      the link's owner account, and a live grants check; `/api/login` then
      rejects passwords. Losing/disconnecting the link always re-enables it.
- [x] Same for the frame on-device `/admin` login (`frame:link` + `auth:login`):
      open `/api/cloud/login/{options,start,callback}` in
      `cloud_api_routes.nim`; a completed handoff mints the admin session.
      (Also fixed the on-device login form to post to `/api/admin/login`.)
- [x] Grants sync loop (`app/cloud/sync.py`, arq worker singleton like
      `app/ha/sync.py`): periodic grants + inventory heartbeat, memberships
      synced into `cloud_membership`, 401 → local link reset + local login
      re-enabled. Nudged over Redis channel `cloud_sync` on connect.

### Phase 2 — store and galleries

The store has its own tracker: `../frameos-cloud/STORE-TODO.md` (decisions,
threat model, phases). Protocol: `docs/cloud-link.md` § "Scene store".

- [x] Cloud-hosted scene repositories browsable in the existing repositories
      UI; the current repository JSON format is the interchange format. The
      public store is a plain repository at
      `{provider}/api/store/repository.json`, seeded once per project when a
      cloud link exists (no `store:read` needed — it's public; the scope stays
      reserved for private-collection browsing later).
- [x] Publish a scene/template to the store (`store:publish`):
      `POST /api/cloud/store/publish` + "Save to cloud drive" in the
      Templates panel, scene dropdowns, and the frames-home scene menus
      (works on unsaved templates too — inline scenes straight off a frame).
      Private by default, made public on the cloud website; npm-style
      immutable versions; pre-publish content moderation on the provider,
      then post-moderation (superadmin pull/feature, crates-style yank,
      publisher bans, user reports).
- [x] "My cloud drive" section in the Templates panel: the account's own
      store scenes (private + public), listed above "My local scenes",
      collapsible, with a settings promo while not connected. Backed by
      `GET /api/cloud/store/drive` (+ image proxy); private zips install via
      the normal template-from-URL flow with the link token attached for
      provider URLs. Repository templates show "by {author}" and a "shell"
      risk badge with an install confirmation.
- [x] FrameOS version stamping: `template.json` gains `frameosVersion` at
      export; the store keeps it per scene/version and shows it (listings,
      scene pages, Templates rows — with a "newer than this install" upgrade
      nudge).
- [x] `frameos-wasm` npm package (`frameos/wasm`): the emscripten scene
      runtime + typed preview API + a showIf-aware management interface
      (fields, event buttons, logs). Version always equals the `frameos`
      release version (synced by `tools/update_versions.py`), published to
      npm by the release workflow (needs the `NPM_TOKEN` repo secret).
      frameos-cloud uses it for in-browser live previews on scene pages.
- [ ] Apps (not just scenes) in the store — needs a code-review/signing story
      first (STORE-TODO Phase 3).
- [ ] Photo gallery service (`gallery:read`): curated feeds usable as image
      sources in scenes, quota-limited free tier.

### Phase 3 — config backups — done

- [x] Scene template collection backup/restore (`backup:scenes`): the
      template interchange zip is the payload; push via
      `POST /api/cloud/backups/templates`, restore via
      `POST /api/cloud/backups/restore`. Cloud storage:
      `/api/backends/backups` (account-owned, replace-in-place per
      `(account, kind, item_key)`, 8 MB/blob, 500/account).
- [x] Frame metadata + scenes backup (`backup:frames`), automatic after deploy
      (the cloud sync worker watches `update_frame` broadcasts for a changed
      `last_successful_deploy_at`). Local secrets (SSH creds, access keys, TLS
      material, wifi passwords) are stripped before upload
      (`app/utils/cloud_backup.py`); restores regenerate credentials.
      Backups are account-owned, so a reinstalled backend that relinks via the
      first-run cloud setup sees and restores them (Settings → FrameOS Cloud).
- [x] Export everything as a plain tarball too: `GET /api/backup/export`
      (manifest + per-project frame JSON + template zips, full fidelity since
      it stays local).

### Phase 4 — heavy transport

- [ ] Asset backup (`backup:assets`): client-side encryption (age or similar,
      key never leaves the user), content-addressed chunks, resumable.
- [ ] Remote access (`remote:access`): persistent outbound WebSocket tunnel
      from backend/frame to a cloud relay (pattern exists in
      `app/ws/remote_bridge.py`); reach your backend/frame UI from
      cloud.frameos.net. Explicit local toggle, visible "tunnel open" status.
- [ ] Direct frame login from the cloud via that relay (`/admin` handoff).

### Phase 5 — observability

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
