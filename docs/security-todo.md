# Security — what is still open

Written 2026-09-02 after a full-repo security review (cloud, self-hosted
backend, device runtime, ESP32 firmware, frontends, CI). Everything that
was patched in that pass is listed at the end so the next reader knows what
changed and why; everything above it is open work, most severe first.
**When an item ships, delete it.** Prior review of the cloud-link flow:
`docs/cloud-security-review.md`.

Two rules that came out of the review and apply to new code:

- **A personal API token is a script's credential, not the person's.** It
  must never satisfy a sudo-mode gate, enrol a credential, delete the
  account, or reach `/api/admin/*`. `readSession()` accepts tokens, so every
  route that is "the person at the keyboard" must check `session.apiToken`
  or go through `requireRecentAuth` (which reads the cookie only).
- **Scene code is untrusted, everywhere it runs.** A published scene is
  anyone's code: on the frame, in the wasm preview worker, in the headless
  renderer, and in the AI context window. Nothing it declares about itself
  (`config.json` settings groups, `origin`, `sources` names) is a
  permission; it is a request the control plane must grant or refuse.

---

## Critical / high — schedule now

### Cloud

- **Scene-declared settings groups are honoured as-is.** A store scene's
  own bundled `config.json` `settings` list decides which of the account's
  stored keys reach the scene: on the frame
  (`frame-service-settings.ts` ships every declared group;
  `app_runtime.nim` gates `getSetting` on the same self-declaration) and in
  the browser preview (`SceneLivePreview` seeds all stored groups). The
  preview is now gated behind a click for scenes carrying their own sources
  (this pass), but the device path is not. Make declared groups a
  per-install permission: show them at install/assign time, store the
  granted set on the assignment, and have `buildServiceSettingsPayload`
  filter to *granted*, not *declared*. Consider refusing `getSetting` for
  embedded-source apps unless granted.
- **Prompt injection reaches tools that deploy to frames.** `search_store_scenes`,
  `get_store_scene`, `get_frame_logs` and `read_repo_file` return attacker
  text straight into the model context, and `add_scene_to_frame` /
  `save_scene` act immediately (`src/lib/ai/tools.ts`). MCP
  `frame_scene_install` / `frame_scenes_set` / `frame_settings_update` /
  `frame_service_settings_enable` need no `confirm`. Make deploy-to-frame a
  proposal the SPA renders as an approve button; wrap tool results in an
  explicit untrusted-data frame; require `confirm: true` on the MCP frame
  mutators.
- **Third-party credentials are stored in plaintext and returned verbatim.**
  `account_settings.value` holds OpenAI / Unsplash / Home Assistant / Immich
  / GitHub keys unencrypted; `GET /api/settings` returns them to any session
  or token, including `fc_apiro_` read-only tokens, and `GET
  /api/account/export` embeds them despite its readme saying credentials
  are excluded. `encryptSecret` already exists (TOTP uses it). Encrypt at
  write, return masked hints from GET (the SPA treats them write-only; the
  device pull path decrypts server-side), strip or mask `settings` in the
  export, and refuse the export to read-only tokens.
- **The hub admits `pending` frames as full device sessions.**
  `deviceAuthError` refuses only `revoked`; a pending frame (anyone who
  boots a leaked multi-use SD image) gets `telemetry:*` and
  `settings:services` at enrol time, can ship logs that trigger the
  account-wide log cull (deleting the owner's real history), overwrite
  `last_state`, and — once the owner opens its page — answer `asset_get`
  with arbitrary bytes and content type into the cache. Refuse
  `status !== "active"` on the socket (or ignore telemetry/asset streams
  until confirmed) and make the log-budget cull per frame.
- **First redeemer of a multi-use claim token is born `active`** with
  `settings:services` and the provisioning scenes, so whoever boots a
  leaked image first pulls the account's Home Assistant / OpenAI keys.
  Never auto-activate multi-use tokens, or defer the scope grant and
  `applyProvisioningScenes` until the owner's `/confirm`.
- **Device-reported `content_type` is served verbatim from the app origin**
  (`hub.ts` stores it from `asset_chunk`; `asset/route.ts` and
  `image/route.ts` serve it, the former `inline`), and the prod CSP allows
  inline script. Allowlist cached types to `image/*` via
  `detectImageContentType`, else store `application/octet-stream` and serve
  non-images as `attachment`.
- **`POST /api/frames/{id}/event/uploadScenes` skips every assignment gate**
  (no shell-flag lint, no compiled-scene refusal, no origin stamp, nothing
  recorded in `frame_scene_assignments`). Run the store risk lint and
  `compiledSceneNames` on the uploaded array, refuse `shell`, audit the push.
- **Concurrent AI turns overshoot the daily cap by design**, and there is no
  per-account limit on `/api/ai/chat` or `/api/ai/apps/chat` (per IP only).
  On the shared operator key that is ~$11 per turn × 60 per 15 min per IP.
  Add `identityRateLimitResponse` per account, cap unfinished turns per
  account, reserve `cap − spent` in flight, bound context bytes.
- **Email verification is consumed by a GET** (`app/verify-email/page.tsx`
  on render) and a verified password account auto-links a later Google
  sign-in. A link scanner at the victim's mail provider verifies an
  attacker-created account under the victim's address; the victim's
  Google login then lands in the attacker's account. Make verification a
  POST behind a button; when Google is about to link into an existing
  password account, require the password or an explicit confirmation,
  revoke sessions, email both.
- **API tokens survive every account-recovery action** (password reset,
  admin "sign out everywhere", 2FA changes revoke `sessions` only) and can
  be minted without expiry. Revoke tokens on password reset and admin
  revocation, or at least surface them; default a TTL.
- **Superadmin mutations have no re-auth gate.** Tokens are now refused
  (this pass), but a 30-day-idle cookie can still grant superadmin or delete
  any account. `requireRecentAuth` on every `/api/admin/*` mutation and a
  reauth redirect in `AdminUsersTable`; uuid-validate `accountId` path
  params and add rate limits to the three user routes. Give the nightly
  accounting job its own token access level rather than superadmin.
- **Passkey / TOTP registration is now gated** (recent auth, no tokens) but
  does not yet require the password when one exists, and nothing emails the
  owner on `passkey_added` / `totp_enabled`. Do both.

### Self-hosted backend

- **User-supplied Nim is compiled on the backend host with no sandbox.**
  `nim compile --compileOnly` runs via `LocalBuildExecutor` on the host for
  any non-precompiled deploy and for `download_c_source_zip`; only the C
  stage is wrapped in Docker/Modal. `staticExec` in any app `app.nim` (or a
  `{.compile.}` pragma) runs on the backend. `POST /apps/validate_source`
  runs `nim check` on raw source (macros evaluate). Run the Nim stage
  inside the same sandbox as the C stage, refuse the local executor for
  frames with inline `sources` unless an operator opts in, drop or sandbox
  `nim check`, and sanitise `config.json` field names before they are
  interpolated into generated Nim identifiers/strings
  (`codegen/app_loader_nim.py`, `codegen/scene_nim.py`). Compiled scenes are
  deprecated; this is one more reason to finish `docs/convergence-todo.md`
  item 1.
- **Home Assistant ingress mode is an unauthenticated admin API on
  0.0.0.0:8990.** `api_user` is mounted without `get_current_user` in
  ingress mode and `/ws` is open; nothing checks that the peer is the
  Supervisor (`172.30.32.2`). Any add-on on the `hassio` network (or the
  LAN if the add-on maps the port) gets everything. Bind to the container
  IP or reject peers other than the ingress proxy; do the same for `/ws`.
- **`SECRET_KEY` production check is dead code** (`config.py` picks a random
  key at class-definition time, so `is None` never fires), and the web and
  worker processes each pick their own, so with `docker compose` the cloud
  link token cannot be decrypted by the worker (`secret_key_changed`
  forever, revocations never observed, backups never run). Refuse to boot in
  production without it unless `HASSIO_TOKEN` is set, and in that case
  generate once and persist to `/data`.
- **SSH host keys are never verified** (`known_hosts=None` for frames and
  the build host). With password auth a LAN impostor receives `ssh_pass`
  and the whole `frame.json`. TOFU: store the fingerprint on the frame row
  on first connect and refuse a change without an explicit reset.
- **SSRF via `frame_host` / `frame_port` with body reflection.**
  `is_safe_host` is syntax-only; `/ping?mode=http&path=`, `/state`,
  `/states` and the adopt flow reflect upstream bodies. Resolve and deny
  loopback / link-local / metadata (share one resolver-based guard with the
  preview proxy, which itself follows redirects — set
  `follow_redirects=False`), stop reflecting non-2xx bodies, cap body size.
  Same guard for repository URLs (PATCH skips the check entirely) and
  template `url` / `image` fetches.
- **Secrets in every `update_frame` websocket broadcast and in
  `last_successful_deploy` snapshots** (`ssh_pass`, `server_api_key`,
  `frame_access_key`, TLS server key, agent shared secret, admin password,
  mount passwords). Pop them from the WS payload and the stored snapshot.
- **Bodies are buffered before auth**: gzip bodies in `middleware.py`,
  `POST /api/log` (device key checked after parsing), asset uploads
  (`file.read()` into a `LargeBinary` with no cap), template zip fetch and
  in-memory `scenes.json`. Reject on `Content-Length`, stream with caps,
  cap log line bytes and rate-limit `/api/log` per key.
- **`curl | sudo sh` bootstrap defaults to `http://` and downloads
  `frameos-*.tar.gz` unverified**; the precompiled SD image and Remote
  binary are likewise unverified server-side (the Buildroot base image is
  sha256-checked). Publish and verify checksums; warn on plain HTTP.
- **Login lockout keys on `(peer IP, email)`**: behind any proxy it is a
  trivial owner lockout, and across IPs it is no brute-force limit at all.
  Per-account exponential backoff; derive the IP through the trusted-proxy
  logic that `api/cloud.py` already has.
- **Unhandled exceptions echo `str(exc)`** (`fastapi.py`
  `unhandled_exception_handler`, plus `ai_scenes.py` and `settings.py`
  test routes). Generic detail unless `DEBUG`.
- Smaller: cross-project leak via the first-loaded project's MQTT broker in
  `ha/sync.py`; `replayEnrollment`-style sync pulls `mode` / `agent` /
  `frame_admin_auth` / `https_proxy.server_key` from the device; email
  change needs no password and does not revoke sessions; `?token=` JWT in
  WebSocket query strings (dormant); no Origin check on WebSocket
  handshakes (SameSite=Lax is the only defence); `TrustedHostMiddleware`
  absent (DNS rebinding reaches `/api/cloud/setup/*` on a fresh install);
  `/api/cloud/login/start` has no local rate limit; `sudo` without `-n`
  can pin a worker slot for 1800 s; predictable unverified precompiled
  cache under `/tmp`; `X-Forwarded-For` trusted from anyone in
  `request_ip.py`; a device `bootup` event can rewrite `frame_host`.

### Device runtime (Nim) and ESP32

- **Self-hosted-backend OTA is unsigned and allowed over plain HTTP** on the
  ESP32 (`CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP=y`, no signature on the backend
  path, secure boot off, checked every 24 h). A LAN MITM of the backend host
  is persistent firmware RCE and captures the frame's `api_key`. Verify with
  the same minisign key as the cloud path (backend serves `.minisig`), or at
  least require https unless the host is local *and* the user opted in;
  refuse `ALLOW_HTTP` in release profiles. Consider Secure Boot v2 and flash
  + NVS encryption for production images (the NVS holds the Wi-Fi PSK, the
  cloud token, the Ed25519 seed, the API key, the admin password, the TLS
  key and the cached service keys).
- **The ESP32 frame JSON returns secrets** (`GET /api/frames`:
  `network.wifiPassword`, `admin.pass`, `server_api_key`,
  `certs.server_key`), and the backend's sync pull list depends on that
  shape. The unauthenticated path to it is closed (this pass), but the
  backend↔frame transport is plain HTTP by default with a bearer in every
  request, so anyone with the WPA2 PSK can still read it. Make those fields
  write-only on the device (return `""`), fix the backend pull list to
  match, and push `tls_enable` on when material exists.
- **Provisioning portal stays up after Wi-Fi recovers** and is an open AP.
  Auth is now enforced on it when credentials exist (this pass); still,
  on `STA_GOT_IP` while the portal is active, stop the AP and restart httpd
  without portal mode, and consider a per-device PSK on the AP.
- **Cloud OTA has no downgrade protection** (only "same version → skip";
  `version` is outside the signed payload). Sign `version || image` and
  refuse `≤ running` unless forced, or enable app anti-rollback.
- **Cloud `set_settings` can pin `gpio_buttons` / `battery_pin` to
  flash/PSRAM pins** → boot loop until a USB console fix. Reject reserved
  pins in the parser and the contract; skip invalid pins in
  `fos_buttons_start`.
- **Scene JS on a backend-managed frame has unrestricted LAN egress**
  (`netguard` is armed only when cloud-managed) and holds whatever keys it
  declared. Apply the private-network deny to store-origin scenes on
  backend-managed frames too; bound total render wall time including native
  HTTP calls (the 20 s interpreter budget pauses during them).
- Smaller ESP32: netguard exemptions are by hostname and a provider can
  point `ws_url` at a LAN address; OTA `downloadUrl` accepted as absolute
  with the bearer attached; backslash bypasses the dot-directory rule on
  FatFS writes; device key signs provider-chosen bytes with no domain
  separation; `strcmp` on credentials; unbounded SD consumption by
  provider `upload_id`s; console is unauthenticated (physical access,
  document it).
- **Setup hotspot has a well-known default PSK (`frame1234`) and
  `POST /setup` is unauthenticated while it is up.** Release images bake the
  same PSK with `wifiHotspot: "bootOnly"` for 300 s; the setup form accepts
  `controlMode`, `cloudUrl`, `claimToken`, `serverHost`, `adminUser/Pass`,
  `runDriverSetup` and persists them to `frame.json` (`portal.nim`
  `parseSetupOptions` / `persistPortalSetup`). Anyone in radio range during
  a boot where the home AP is down re-enrols the frame to their own "cloud"
  (which then owns the `set_schedule` / `uploadScenes` path) or repoints
  `serverHost` so the backend API key leaks in the log POST. Mint a
  per-device hotspot PSK at first boot and show it on the panel; require a
  panel-shown code for control-plane/admin fields; strip current config from
  the unauthenticated setup page; cache the root `iw scan` / `nmcli` Wi-Fi
  scans behind a rate limit.
- **The LAN deny and the refused-app list key on transport, not provenance.**
  `allowLocalNetworkAccess` is enforced only in `utils/http_client.nim`;
  `chromiumScreenshot` (root Chromium, any scheme incl. `file://`) and
  `rstpSnapshot` (`ffmpeg -i <url>`) never consult it, and both are refused
  only for cloud-origin payloads on Pi. A store scene installed through the
  self-hosted backend or the local `/uploadScenes` route has full LAN reach,
  `file://` reads via Chromium and `localImage.path` anywhere on disk. Key
  the deny and the refused list on `origin.storeSceneId`; make the two
  spawning apps opt-in via a local-admin toggle; enforce `http(s)://` + the
  LAN policy on their URL before spawning. Scheduler and scene `dispatch`
  can no longer fire `uploadScenes` (this pass), which closed the
  compromised-cloud route into this; the provenance model is still the fix.
- **Frame access key / `public` mode reaches runtime verbs**:
  `POST /event/@name` and `POST /uploadScenes` need only `hasAccess(Write)`,
  so the QR-printed key can reboot-loop or replace scenes. Restrict access-key
  callers to scene events; require an admin session for `uploadScenes` /
  `reboot` / `restart`.
- **Local-presence code is readable without presence**: the six-digit code
  is drawn into the image that `GET /image` and the cloud `image_get`
  return. Composite the overlay only on the driver path.
- **OTA signature binds archive bytes only**: version and target come from
  GitHub metadata, so anyone with release-upload rights (no signing key) can
  attach an older or other-arch signed archive under a new tag. Verify the
  global signature / trusted comment naming version + target.
- **Native HTTP client (Linux path) copies scene-controlled header values
  and paths raw** into the request (CRLF / request-line injection, `Host`
  override); mirror the embedded path's checks and reserve hop-by-hop names.
- **Interpreter robustness**: no recursion depth guard on producer inputs
  (self-referencing node → SIGSEGV replayed from `uploaded.json` until the
  boot guard trips); no cap on scene-requested image / SVG `viewBox`
  dimensions (`quit(1)` on alloc failure); interpreter time budget excludes
  native calls (`httpRequest` tarpit up to 600 s wedges the render thread
  until the 900 s watchdog, forever); 256 MB JS heap per runtime, one per
  JS app node; self-dispatching event loops starve rendering (Pi) or
  recurse synchronously (ESP32). Depth counter, `decodeImageWithDisplayBounds`
  for SVG, wall-clock render deadline, per-scene heap budget, per-render
  dispatch budget.
- Smaller: `haSensor.entityId` spliced raw into the HA URL (admin-bearer
  GET of any path); JS asset API is frame-wide by default (fonts, other
  scenes' assets, `.frameos/scene_images` writable) — default the `scene`
  sandbox for store-origin scenes; enrolment `timezone` reaches
  `/etc/localtime` symlink without `isIanaZone`; TLS key / CIFS credentials /
  `frame.json` written world-readable (matters once PR #415 lands — copy
  `link_state.nim`'s create-0600 pattern); Samba mount target unconfined;
  enrolment log dumps the whole `network` object incl. the hotspot password;
  `http://` providers accepted device-side; WS dial follows redirects with the
  bearer and never checks `Sec-WebSocket-Accept`; OTA has no free-disk check
  and extracts as root without `--no-same-owner`; `exiftool` runs on
  untrusted downloads (not on Buildroot); rate-limit table clears wholesale
  when full; spool spill dir never swept at boot.
- **Not reviewed on the device**: the HTTP-server lane (`server/*.nim`,
  routes, admin session mechanics, control-mode whitelist) did not complete;
  the prior second-pass fixes there (login rate limits, constant-time admin
  compare, `frame.json` memoisation, `/login/options`) were not re-verified.
  Worth a focused pass.

### Frontends, wasm preview, CI

- **Fork PRs run on the self-hosted runner pool with a shared writable
  `/mnt/cache`** that the Buildroot base-image and release jobs read
  (`ccache`, `dl/`, `nimcache`). A poisoned cache entry ends up in every
  release SD image. Run fork PRs on GitHub-hosted runners (or require a
  label), mount the cache read-only for PR VMs or give them a scratch
  subtree, check out `head.sha` not `head.ref`.
- **The CI deploy key is root on the production box and runs
  `scripts/db-migrate.sh` *from the shipped archive* with the whole env
  file exported**, then self-updates the two root scripts from the archive.
  Run migrations as the service user with only `DATABASE_URL`, keep the
  runner script on the box (or verify a checksum), drop the automatic
  self-update, fix the wrapper's comment. The key is now written only
  after every third-party action in the job (this pass). Pin all actions in
  the deploy job to commit SHAs; move ESP32 firmware signing to a
  GitHub-hosted job (the key currently lives in a VM on the same host as
  fork-PR VMs); pin `cryptography` there.
- **Prebuilt Nim compiler is fetched from `archive.frameos.net` with no
  integrity check** (Dockerfile, `docker-publish-multi.yml`,
  `frameos-cross.yml`). Record sha256 per target in the committed manifest
  and verify before extracting.
- **Off-site backups are plaintext and contain `/root/.ssh`, `/etc/letsencrypt`
  and every env file** (`pg-backup.sh`); the privacy policy calls them
  encrypted. `rclone crypt` with a passphrase held outside the box; drop
  `/root/.ssh` and live certs from the tarball; align `legal.ts`.
- **Migration runner is non-transactional** (`psql -f` per file in
  autocommit): a mid-file failure leaves partial DDL with no
  `schema_migrations` row and wedges every later deploy. `--single-transaction`
  with the ledger insert inside it.
- **Embedded editor postMessage protocol** accepts `init` /
  `previewProxyUrl` from any `event.source` / origin and replies to `'*'`
  (`EmbeddedEditor.tsx`, `mount.tsx`). Require an allowed-origin list at
  mount, check `event.origin`, reply to it, only honour a same-origin
  `previewProxyUrl`.
- **Preview worker isolation.** Same-origin direct requests from scene code
  are now refused in `frameos_library.js` (this pass), but the worker still
  shares the app origin. Host `preview-worker.js` + wasm in a sandboxed
  iframe or a dedicated origin and talk over postMessage.
- Smaller: `X-Forwarded-For` positional trust is spoofable if the origin is
  reachable around Cloudflare (verify nginx allowlists CF ranges or uses
  `real_ip` + `CF-Connecting-IP`; make `clientIpFromHeaders` refuse chains
  shorter than the trusted count); `DATABASE_SSL=require` disables cert
  verification in postgres.js (document `verify-full`); `/healthz` echoes
  the driver error; nightly job passes the superadmin token on the curl
  command line (use `-H @file`); integration global-setup drops `public`
  on any `TEST_DATABASE_URL` (require a `_test` suffix); `cloud-ci.yml`
  has no top-level `permissions:`; runtime Docker stage runs as root and
  compose sets no `SECRET_KEY`; `requirements.txt` has no `--hash` lines;
  `FramesHome.tsx` renders `origin.href` without a scheme check;
  `rel="noreferer"` typos; the OpenAI service-account key and R2 keys sit
  in plaintext `.env*` files on the dev laptop (rotate / scope).

## Medium / low — worth a pass

Cloud: body size caps before `request.json()` on `device/start`,
`backends/inventory`, `backends/scopes`, backups, and the scene routes;
`backends/{grants,inventory,rotate-token,scopes}` check no base scope or
`client_kind` (a frame-kind link can create `connected_backends` rows;
`parseScopes` allows `frame:*` for backends); backup `content_type` stored
verbatim and replayed as a response header (allowlist + `nosniff`);
`frameos/login/start` `state` / `redirect_to` unbounded; backups are only
encrypted client-side (verify the envelope on POST or say so);
`csrfResponse` skips the Origin check when the bearer merely *looks* like a
token while the cookie is the credential actually used (harmless without
CORS, but ignore the bearer when a cookie is present); `ssrf.ts` misses
192.0.0.0/24, 198.18.0.0/15, 64:ff9b::/96, 2002::/16 and does not pin the
resolved address (DNS rebinding); WebAuthn challenge and pending-2FA JWTs
are not single-use; sibling reset tokens survive a successful reset;
identity-keyed login / reset limits are a cheap lockout; passwordless
passkey profile picks an arbitrary identity row; scene image redirects are
cached a year and nothing purges the CDN when a scene goes private or is
pulled; convert/lint have quadratic paths on anonymous input
(`uniqueName`, `importSpecifierPattern`, gradient scan) and no parser
depth cap (a `RangeError` is an unhandled 500); `?ai=` / `?prompt=` links
auto-submit an AI turn; public scenes are unmetered storage; image-set
binding accepts any known digest; fork description uncapped; markdown
images load from any https host; `download_count` inflates on anonymous
requests; publish-time cover is not sniffed; `frame_commands` keeps base64
chunk bodies after ack; per-IP OTA budgets starve fleets behind one NAT;
`normalizeAssetPath` passes NUL / control chars; `replayEnrollment` binds by
account not by frame; MCP `ai_turn_wait` / `ai_turn_cancel` take an
unconstrained `turn_id` into a URL path; token sessions claim
`emailVerified: true`; model choice is client-controlled on the shared key;
`@posthog/mcp` would capture tool arguments if a token were ever set.

Backend: unquoted frame fields in a few frame-side shell strings
(`find {assets_path}`, crontab `tee`, `%I` → `ssh_user` in a unit file);
`scene_module_suffix` collisions; `\r` / NUL gaps in the Nim string
escapers; no artifact cleanup for SD images and firmware; `js_apps.py`
subprocesses have no timeout; `system_info` supervisor request has no
timeout; `history[].role` unvalidated in AI app chat.

## Fixed in this pass (2026-09-02)

Cloud
- `isLocalHostname` matched any DNS name starting with `fc` / `fd` /
  `fe80` as an IPv6 literal — `https://fdcloud.example.com` passed the
  device-flow `local_origin` allowlist that decides where login codes go.
  IPv6 prefix checks now apply to literals only.
- `rotate-token` accepted the retiring (previous) token, so a stolen old
  token could rotate again inside the grace window and lock the real backend
  out. `authenticateLinkedClient` reports which reference matched; rotation
  refuses the previous one.
- An approved device request that was never polled stayed redeemable
  forever, with the decryptable link token kept on the client row. Expires
  five minutes past the deadline, nulls the token, retires the client.
- `safeAuthReturnPath("/..//evil.example")` resolved to `//evil.example`
  (open redirect on login / reauth / Google callback / signup). Rejects a
  resolved pathname starting with `//`.
- Passkey and TOTP enrolment needed only a session or a full API token;
  a stolen cookie became a permanent credential that also satisfied sudo
  mode. `accountSecurityContext` refuses tokens on every mutation and the
  four enrolment routes require recent auth; `TwoFactorSettings` follows
  the reauth redirect.
- `DELETE /api/frames/{id}` revoked and erased a frame with no sudo gate
  (revoke has one) and was callable by API tokens / MCP. Now
  `requireRecentAuth`; the SPA's `deleteFrame` follows the reauth redirect
  on the cloud.
- `POST /api/account/delete` and every `/api/admin/*` route accepted API
  tokens. Both refuse them (`getSuperadminContext` takes
  `allowApiToken` for the nightly job only). Integration tests pin all of
  this (`api-token-boundaries.integration.test.ts`).
- The anonymous preview proxy mirrored upstream `Content-Type`, took a
  cross-site `text/plain` form POST, followed redirects with a single
  host check, and forwarded `Authorization`. Requires JSON + Origin,
  fetches through `guardedFetch` (per-hop SSRF check), strips
  `Authorization` / `Proxy-Authorization`, and answers
  `application/octet-stream` + `attachment` + `CSP: sandbox` with the
  upstream type in `x-upstream-content-type`. The headless renderer's
  fetch child follows redirects by hand with the same per-hop check and
  streams with a cap.
- `capitalizeAscii` emitted its receiver twice, so twenty nested calls in a
  300-byte anonymous convert request were tens of megabytes of output; the
  receiver is emitted once and every emitted fragment is capped at 256 KB
  (`NimConvertError`). `codeArgs[].name` was interpolated into a `RegExp`
  unescaped in both linters (`[` → 500, `(a*)*c` → ReDoS); escaped.
- The public scene preview seeded every stored key of the viewer into any
  scene and ran it on page open. Scenes carrying their own app sources that
  declare settings groups now wait for the same "Run preview" click as
  paid services, and the copy says why.
- `cloud-ci.yml` wrote the production deploy key to disk before running
  four tag-pinned third-party actions; the step now runs right before
  Deploy.

Self-hosted backend
- Scene `sources` file names and node ids were joined onto the build tree
  unchecked (`_frame_deployer.py`) — `"../../../../etc/cron.d/x"` in a
  scene wrote anywhere the backend process could, reachable synchronously
  via `download_build_zip`. Names must be plain file names and resolve
  inside their app directory; node ids must be identifiers.
- `embedded.firmware.path` and `buildroot.sdImage.path` are client-writable
  frame state and the download routes served whatever file they named
  (and gzip-wrote next to it). Both now require the path to resolve under
  the builder's artifact directory.
- Asset `path` accepted `..` and absolute segments and was later joined onto
  the local build tree and the frame's asset dir; validated on create and
  update.
- Virtual-frame kiosk page interpolated `frame.name` and the view token
  into HTML unescaped (stored XSS on the backend origin); escaped.
- An empty `server_api_key` matched an empty bearer on `/api/log` and the
  embedded device routes, and `/api/log` never checked the scheme word.

Device / preview
- ESP32: portal mode (open AP, also entered when the stored Wi-Fi merely
  fails to answer within 45 s at boot, and never left) made
  `require_protected_access` succeed unconditionally — `/api/frames`
  returned the Wi-Fi PSK, API key, admin login and TLS key to anyone in
  radio range. The bypass now applies only to a device with no API key and
  no admin login; otherwise the portal demands the same credentials.
- Nim runtime: the cloud's `set_schedule` was persisted verbatim and the
  scheduler fired any event name, so a schedule entry `{event:
  "uploadScenes"}` replaced the installed scenes with no origin stamp,
  bypassing every cloud-push guard (and lifting the LAN deny after
  demotion). The scheduler now refuses `uploadScenes`; scene `dispatch`
  nodes refuse `uploadScenes` / `reboot` / `restart` / `reload`.
- Nim runtime: reading a NetworkManager keyfile with `sudo cat` (non-root
  images) logged the whole file — `psk=` included — into the log stream the
  backend and the cloud `get_logs` read. `portal.run` withholds output when
  a logged command name is given, and the keyfile read gives one.
- Wasm preview: scene code could make a direct, cookie-bearing XHR to the
  app's own API from the same-origin worker (read `/api/frames`,
  `/api/settings`, and mutate). Same-origin targets are refused and go
  through the server-side proxy instead (no cookies, SSRF-guarded); Node
  renderers are unaffected.
