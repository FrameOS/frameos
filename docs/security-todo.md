# Security — what is still open

Written 2026-09-02 after a full-repo security review (cloud, self-hosted
backend, device runtime, ESP32 firmware, frontends, CI). Open work only,
most severe first; what has shipped is in git history (the review commit
77e583d7 and the batches after it). **When an item ships, delete it.**
Prior review of the cloud-link flow: `docs/cloud-security-review.md`.

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
  preview is gated behind a click for scenes carrying their own sources,
  but the device path is not. Make declared groups a
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
  / GitHub keys unencrypted and `GET /api/settings` returns them to any
  session or token, including `fc_apiro_` read-only tokens. (The account
  export now masks setting values and refuses read-only tokens.)
  `encryptSecret` already exists (TOTP uses it). Encrypt at write, return
  masked hints from GET (the SPA treats them write-only; the device pull
  path decrypts server-side).
- **First redeemer of a multi-use claim token is born `active`** with
  `settings:services` and the provisioning scenes, so whoever boots a
  leaked image first pulls the account's Home Assistant / OpenAI keys.
  Never auto-activate multi-use tokens, or defer the scope grant and
  `applyProvisioningScenes` until the owner's `/confirm`.
- **Concurrent AI turns can still overshoot the daily cap.** Per-account
  rate limits (40 / 15 min) and a cap of three unfinished turns per account
  now bound it on both chat routes; what is left is to reserve `cap − spent`
  in flight so the third concurrent turn cannot be admitted under a cap the
  first two have already spent, and to bound context bytes.
- **A verified password account auto-links a later Google sign-in.**
  Verification is now a POST behind a button (so a link scanner can no
  longer verify an attacker-created account under the victim's address),
  but the link step itself still trusts the flag alone. When Google is about
  to link into an existing password account, require the password or an
  explicit confirmation, revoke sessions, email both.
- **API tokens can be minted without expiry** and survive 2FA changes
  (password reset and the admin "sign out everywhere" now revoke them).
  Default a TTL; consider revoking on `totp_enabled` / `passkey_added`.
- **The nightly accounting job runs on a superadmin API token.** Every
  `/api/admin/*` mutation is now behind `requireRecentAuth` (cookie
  sessions) and refuses tokens, except `billing/nightly`, which the job
  calls with a superadmin token from cron. Give it its own token access
  level (or a dedicated service credential) rather than superadmin.
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
- **The `last_successful_deploy` nested in `update_frame` broadcasts is the
  `to_dict()` form** — the stored snapshot now holds fingerprints, not
  secrets, and the WS payload drops the secret-bearing keys, but `to_dict()`
  fills a snapshot secret back in when it still matches the row so the
  editor's "changed since deploy" diff keeps working. Teach
  `frameLogic.ts` `frameKeyEqual` to compare secrets by presence /
  fingerprint and stop restoring them server-side.
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
  shape. The unauthenticated path to it is closed, but the
  backend↔frame transport is plain HTTP by default with a bearer in every
  request, so anyone with the WPA2 PSK can still read it. Make those fields
  write-only on the device (return `""`), fix the backend pull list to
  match, and push `tls_enable` on when material exists.
- **Provisioning portal stays up after Wi-Fi recovers** and is an open AP.
  Auth is enforced on it when credentials exist; still,
  on `STA_GOT_IP` while the portal is active, stop the AP and restart httpd
  without portal mode, and consider a per-device PSK on the AP.
- **Cloud OTA has no downgrade protection** (only "same version → skip";
  `version` is outside the signed payload). Sign `version || image` and
  refuse `≤ running` unless forced, or enable app anti-rollback.
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
  can no longer fire `uploadScenes`, which closed the compromised-cloud
  route into this; the provenance model is still the fix.
- **Local-presence code is readable without presence**: the six-digit code
  is drawn into the image that `GET /image` and the cloud `image_get`
  return. Composite the overlay only on the driver path.
- **OTA signature binds archive bytes only**: version and target come from
  GitHub metadata, so anyone with release-upload rights (no signing key) can
  attach an older or other-arch signed archive under a new tag. Verify the
  global signature / trusted comment naming version + target.
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
  self-update, fix the wrapper's comment. The key is written only after
  every third-party action in the job. Pin all actions in
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
- **Embedded editor postMessage protocol** accepts `init` /
  `previewProxyUrl` from any `event.source` / origin and replies to `'*'`
  (`EmbeddedEditor.tsx`, `mount.tsx`). Require an allowed-origin list at
  mount, check `event.origin`, reply to it, only honour a same-origin
  `previewProxyUrl`.
- **Preview worker isolation.** Same-origin direct requests from scene code
  are refused in `frameos_library.js`, but the worker still shares the app
  origin. Host `preview-worker.js` + wasm in a sandboxed
  iframe or a dedicated origin and talk over postMessage.
- Smaller: `X-Forwarded-For` positional trust is spoofable if the origin is
  reachable around Cloudflare (verify nginx allowlists CF ranges or uses
  `real_ip` + `CF-Connecting-IP`; make `clientIpFromHeaders` refuse chains
  shorter than the trusted count); `DATABASE_SSL=require` disables cert
  verification in postgres.js (document `verify-full`); `/healthz` echoes
  the driver error; integration global-setup drops `public`
  on any `TEST_DATABASE_URL` (require a `_test` suffix); runtime Docker
  stage runs as root and
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
