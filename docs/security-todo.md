# Security — what is still open

Written 2026-09-02 after a full-repo security review (cloud, self-hosted
backend, device runtime, ESP32 firmware, frontends, CI); trimmed 2026-09-03
after #438, #439 and #440. Open work only, most severe first; what has
shipped is in git history (the review commit 77e583d7 and the batches after
it). **When an item ships, delete it** — a residue worth remembering goes
to the medium / low list, not into a "what remains" paragraph here.
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

Nothing critical is open. The nine items that were here (scene-declared
settings groups honoured as-is, prompt injection reaching deploy tools,
plaintext third-party credentials, multi-use claim tokens born active,
concurrent AI turns overshooting the cap, Google auto-linking into a
password account, non-expiring API tokens surviving 2FA changes, the nightly
job on a superadmin token, second-factor enrolment without the password)
shipped in the batch after the third one; what they left behind is in the
medium / low list below.

### Self-hosted backend

- The precompiled SD image and Remote binary are unverified server-side
  (the Buildroot base image is sha256-checked). The `curl | sudo sh`
  bootstrap is closed (2026-09-06): the script downloads the archive's
  `.minisig` and verifies minisign's prehashed Ed25519 signature with
  openssl against the release key before `tar -xzf`
  (`backend/app/utils/release_signing.py`, pinned to `ota_pubkey.nim`), and
  the API answers `plain_http` + a warning the drawer shows when the
  script URL is `http://` (the key and Remote secret cross the LAN in
  clear, once).
- Smaller, what is left: a device `bootup` event may still move
  `frame_host` on embedded frames when the claimed IP matches the request
  peer or `embedded.followBootIp` is set (deliberate: ESP32 DHCP follow).
  Closed 2026-09-06 — the HA sync connects to one broker per run and shares
  only the projects that configured that broker (others are logged and
  skipped; `partition_projects_by_broker`); the frame sync never pulls
  `mode`, `agent` or `frame_admin_auth` from a device and drops certificate
  material from `https_proxy` (`FRAME_SYNC_BACKEND_OWNED_KEYS`); WebSocket
  handshakes are cookie-only (the dormant `?token=` JWT form is gone) and
  refuse a cross-site `Origin` before reading the cookie; the unauthenticated
  `/api/cloud/setup/*` routes answer only on IP literals and local names
  (`.local`, `.lan`, `.home.arpa`, …) or `FRAMEOS_SETUP_ALLOWED_HOSTS`, which
  is what a DNS-rebinding page cannot present; the precompiled release cache
  under `/tmp` keeps each archive's `.minisig` beside it and verifies the
  signature on download and on every hit (a planted archive is discarded and
  fetched again).

### Device runtime (Nim) and ESP32

- **Secure Boot v2 and flash + NVS encryption for production images.** The
  NVS holds the Wi-Fi PSK, the cloud token, the Ed25519 seed, the API key,
  the admin password, the TLS key and the cached service keys. (The OTA half
  of this item shipped: both control planes now relay the signed release
  manifest and the device verifies the release key before switching slots —
  `esp_https_ota`, `CONFIG_ESP_HTTPS_OTA_ALLOW_HTTP` and the per-install key
  are gone. A self-hosted backend reached over plain http still carries the
  bearer in clear on every request, OTA included; that is the http-backend
  problem, not an OTA one.)
- Service keys on a backend-managed frame — closed 2026-09-07: a scene from
  the public store no longer receives every settings group its apps declare.
  `get_frame_json` ships a group declared only by store-origin scenes when the
  owner granted it on the frame (`frame.service_setting_groups`, Frame
  settings → "Service keys for store scenes", migration `e1f2a3b4c5d6`);
  scenes the owner authored keep declaration-as-grant. Installing a store
  scene from the workspace is the grant (the declared groups join
  `service_setting_groups` on install, as the cloud's assignment call does),
  so nothing changes for the owner until they untick a key. The same field
  name and meaning as the cloud's per-frame grant. The LAN-egress half is closed
  (2026-09-06): both runtimes arm the private-network deny when the
  resident scene carries `origin.storeSceneId`, whoever installed it
  (`storeOriginScenesResident` / `fos_scenes_store_origin_resident`), with
  the frame's own backend host exempted; `allowLocalNetworkAccess` still
  lifts it. Also closed: ESP32 OTA now refuses an offered version below the
  running one on both planes (`fos_version.c`, `ota:… downgrade-refused`)
  unless the console arms `ota downgrade` for one fetch — the manifest's
  `version` stays outside the signed payload, so this is device-side
  policy, not a signature; signing `version || image` remains the fuller
  fix. The Pi door already refused downgrades.
- Smaller ESP32: netguard exemptions are by hostname and a provider can
  point `ws_url` at a LAN address; `esp_http_client` still auto-follows
  redirects during the OTA download, so a first-party 302 carries the
  bearer to its target (the bearer is now attached only for the cloud /
  `ws_url` origin; `disable_auto_redirect` would break CDN-hosted images —
  decide); device key signs provider-chosen bytes with no domain
  separation; unbounded SD consumption by provider `upload_id`s; console
  is unauthenticated (physical access, document it).
- **`POST /setup` on the Pi hotspot is unauthenticated while it is up**,
  and the hotspot keeps its well-known default PSK (`frame1234`) — decided
  2026-09-03: security is layered, the default still deters some, and a Pi
  with no configured display could not show a minted one (the ESP32 AP got
  a per-device PSK in #443 because its USB console can always print it).
  Release images bake the default with `wifiHotspot: "bootOnly"` for
  300 s; the setup form accepts `controlMode`, `cloudUrl`, `claimToken`,
  `serverHost`, `adminUser/Pass`, `runDriverSetup` and persists them to
  `frame.json` (`portal.nim` `parseSetupOptions` / `persistPortalSetup`),
  so anyone in radio range during a boot where the home AP is down can
  re-enrol the frame or repoint `serverHost`. Require a panel-shown code
  for the control-plane/admin fields (a headless frame then needs the
  local admin password instead); strip current config from the
  unauthenticated setup page; cache the root `iw scan` / `nmcli` Wi-Fi
  scans behind a rate limit.
- Provenance for the process-spawning apps — closed 2026-09-07:
  `data/chromiumScreenshot` and `data/rstpSnapshot` are refused for any
  scene that carries `origin.storeSceneId`, however it reached the frame
  (`frameos/spawn_guard.nim`), unless the local admin allowed "shell apps
  for store scenes" through the same on-panel ceremony as the LAN elevation
  (`POST /api/network/local-access` with `scope: "shellApps"`, stored in
  `state/local_access.json`); and whatever the scene's origin, the URL they
  hand to the child process must be http(s) (rtsp(s) for the camera) with a
  host that passes the private-network policy when it is on — `file://` and
  router addresses never reach Chromium or ffmpeg. `localImage.path` reads
  anywhere on disk remain: the asset sandbox (`js.assetSandbox: "scene"`) is
  the answer there and is still opt-in.
- **OTA signature binds archive bytes only**: version and target come from
  GitHub metadata, so anyone with release-upload rights (no signing key) can
  attach an older or other-arch signed archive under a new tag. Verify the
  global signature / trusted comment naming version + target.
- **Interpreter robustness — closed 2026-09-06** (the node depth /
  self-reference guard and the SVG / canvas dimension cap were already in):
  every run of a scene now arms a wall-clock deadline that counts native
  calls (`js.renderDeadlineMs`, 120 s Pi / 90 s ESP32; the HTTP client caps
  each request to what is left and the interrupt handler stops the script
  when it passes — a 600 s `httpRequest` tarpit costs one render, not the
  900 s watchdog), the JS heap ceiling is per scene and shared by all of the
  scene's runtimes (`js.memoryLimitMb`, 256 MB Pi / 8 MB ESP32, through
  budgeted QuickJS allocators on both planes), and a run may fire at most
  `js.dispatchBudget` (64) events — the Pi's message loop also yields to the
  render loop every 32 events, and the ESP32 refuses events nested more
  than four deep. Reference: `docs/js-apps-and-code-nodes.md`, "What the
  runtime will not let a scene do". Left: the budgets are per run, not per
  scene per minute — a scene that spends its whole deadline on every render
  is slow, not stopped.
- Smaller: the frame's TLS material and admin login now ride the
  `/embedded/settings` pull (bearer-authenticated, but in clear on an http
  backend — same exposure as the API keys that pull already carried; an
  https backend is the fix); JS asset API is frame-wide
  by default (fonts, other scenes' assets, `.frameos/scene_images` writable) — default the `scene` sandbox
  for store-origin scenes; Samba mount target unconfined; `http://`
  providers accepted device-side; `exiftool` runs on untrusted downloads
  (not on Buildroot); the cloud link-code overlay is still drawn into the
  stored render (the local-presence code no longer is).
- **Not reviewed on the device**: the HTTP-server lane (`server/*.nim`,
  routes, admin session mechanics, control-mode whitelist) did not complete;
  the prior second-pass fixes there (login rate limits, constant-time admin
  compare, `frame.json` memoisation, `/login/options`) were not re-verified.
  Worth a focused pass.

### Frontends, wasm preview, CI

- The CI deploy key on the production box — closed 2026-09-07: the forced
  command (`frameos-cloud-update --archive -`) now unpacks the uploaded
  archive as the service user (`runuser … tar --no-same-owner
  --no-same-permissions` into a directory that user owns), so the key's
  reach ends at the service account; root only moves the finished tree into
  place and flips the units, with scripts that come from a human's checkout
  (#451). ESP32 firmware built on the self-hosted runner is no longer signed
  there: the GitHub-hosted `github-release` job signs every `frameos-*.bin`
  without a `.minisig` alongside the Linux archives, and refuses to publish
  an unsigned asset. The signing key is unsealed on GitHub-hosted runners
  only.
- Embedded editor postMessage — closed 2026-09-07: an iframe-hosted editor
  accepts `init` / `get-scenes` / `select-scene` only from its parent window
  and only from an origin the host declared (`?parentOrigin=` on the iframe
  URL, else the framing document's referrer origin), replies to that origin
  (never `'*'`), and honours `previewProxyUrl` only when it is same-origin
  with the editor (`frontend/src/embed/embedOrigins.ts`; the direct mount
  talks to its own window and is unchanged).
- **Preview worker isolation.** Same-origin direct requests from scene code
  are refused in `frameos_library.js`, but the worker still shares the app
  origin. Host `preview-worker.js` + wasm in a sandboxed iframe or a
  dedicated origin and talk over postMessage. Not done with the 2026-09-07
  batch, deliberately: the worker reaches the preview proxy
  (`/api/store/preview-proxy`, `/api/frames/…/preview_proxy`) with the
  app's session cookie, and an opaque-origin worker cannot send it — the
  proxy has to move to a short-lived per-preview token first, on both
  control planes, before the worker can leave the origin.
- Smaller: the runner pool's `/mnt/cache` is writable from every VM (fork
  PRs no longer land there since #440 — mount it read-only or a scratch
  subtree for any job that is not building a release, and keep "require
  approval for all outside collaborators" on — verified on 2026-09-05:
  `approval_policy: all_external_contributors`); runtime Docker stage runs as root and
  compose sets no `SECRET_KEY` (the key now persists to a file, so compose
  works; still worth setting explicitly); `requirements.txt` has no
  `--hash` lines; the OpenAI service-account key and R2 keys sit in
  plaintext `.env*` files on the dev laptop (rotate / scope).

## Accepted — the deprecated source-build path (not a priority)

Compiled scenes are deprecated and not recommended, and the path is not
being deleted before October 2026 (`docs/convergence-todo.md` item 1). Its
findings are recorded here so they are not rediscovered, not scheduled:
a self-hosted operator who chooses source builds runs user-supplied Nim on
their own host, and the fix is to use interpreted scenes.

- **User-supplied Nim is compiled on the backend host with no sandbox.**
  `nim compile --compileOnly` runs via `LocalBuildExecutor` on the host for
  any non-precompiled deploy and for `download_c_source_zip`; only the C
  stage is wrapped in Docker/Modal. `staticExec` in any app `app.nim` (or a
  `{.compile.}` pragma) runs on the backend. `POST /apps/validate_source`
  runs `nim check` on raw source (macros evaluate). `config.json` field
  names are interpolated into generated Nim identifiers/strings
  (`codegen/app_loader_nim.py`, `codegen/scene_nim.py`). If it ever has to
  be fixed rather than deleted: run the Nim stage inside the same sandbox
  as the C stage, refuse the local executor for frames with inline
  `sources` unless an operator opts in, drop or sandbox `nim check`.

## Medium / low — worth a pass

Cloud, left behind by the encrypted-backups rollout (#451, 2026-09-05):
the pre-encryption pgBackRest repo `storagebox:pgbackrest` is frozen
plaintext — **delete it on 2026-10-03** (`rclone purge storagebox:pgbackrest`
on the box), once the encrypted repo has its own four-week window; the
object store's own copy is rehearsed only by count and hash, not by a
restore into R2.

Cloud, left behind by the critical batch: `save_scene` still acts
immediately (it only creates a private copy in the account; the prompt now
says to call it only on the user's ask, and it is not a proposal); the
device's `app_runtime.nim` still gates `getSetting` on the scene's own
declaration — harmless now that the cloud ships only granted groups, but an
embedded-source app could still be refused there outright; personal API
tokens minted before the 90-day default keep their `NULL` expiry (sweep or
re-mint), and tokens are revoked on second-factor *enrolment* but not on
removal; spend reservations live in process memory (one auth-web instance
today — a second instance would need them in Postgres/Redis); the
legacy-plaintext re-seal of `account_settings` happens on first read, so a
row nobody reads stays plaintext until then (a one-off sweep would finish it).

Cloud: `backends/{grants,inventory,rotate-token,scopes}` check no base
scope or `client_kind` (a frame-kind link can create `connected_backends`
rows; `parseScopes` allows `frame:*` for backends); backups are only
encrypted client-side (verify the envelope on POST or say so);
`csrfResponse` skips the Origin check when the bearer merely *looks* like a
token while the cookie is the credential actually used (harmless without
CORS, but ignore the bearer when a cookie is present); `ssrf.ts` does not
pin the resolved address (DNS rebinding); identity-keyed login / reset
limits are a cheap lockout; passwordless passkey profile picks an arbitrary
identity row; scene image redirects are cached a year and nothing purges
the CDN when a scene goes private or is pulled; convert/lint have quadratic
paths on anonymous input (`uniqueName`, `importSpecifierPattern`, gradient
scan) and no parser depth cap (a `RangeError` is an unhandled 500); `?ai=`
/ `?prompt=` links auto-submit an AI turn; public scenes are unmetered
storage; image-set binding accepts any known digest; markdown images load
from any https host; `download_count` inflates on anonymous requests;
`frame_commands` keeps base64 chunk bodies after ack; per-IP OTA budgets
starve fleets behind one NAT; `replayEnrollment` binds by account not by
frame; model choice is client-controlled on the shared key; `@posthog/mcp`
would capture tool arguments if a token were ever set.

Backend: `scene_module_suffix` collisions; no artifact cleanup for SD
images and firmware; the resolver-based target guard (`app/utils/network.py`)
resolves once per request, so a DNS rebind between check and connect is
accepted for project-authenticated features (frame hosts are IP literals in
practice); a frame whose SSH host key was already impersonated before the
TOFU pin stays pinned to the impostor until "Forget host key" — the
fingerprint is shown so an owner can compare it with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the device.
