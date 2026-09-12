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

Nothing critical is open (the nine items that were here shipped in the
batch after the third one; residue is in the medium / low list).

### Self-hosted backend

- **The precompiled Buildroot SD image is unverified server-side** (the
  base image is sha256-checked; the FrameOS runtime and Remote archives are
  minisign-verified on download and on every cache hit, and the cache is
  pinned to the version it claims since 2026-09-09). The release workflow's
  "a signature would be decoration" rationale is stale now that the backend
  and the browser flasher fetch the image automatically — sign it.
- Smaller, what is left: a device `bootup` event may still move
  `frame_host` on embedded frames when the claimed IP matches the request
  peer or `embedded.followBootIp` is set (deliberate: ESP32 DHCP follow).
  Closed 2026-09-06 (pointers, not open work): one HA broker per run
  (`partition_projects_by_broker`); `FRAME_SYNC_BACKEND_OWNED_KEYS`;
  cookie-only WebSocket handshakes with an Origin check; `/api/cloud/setup/*`
  answers local names only or `FRAMEOS_SETUP_ALLOWED_HOSTS`; the release
  cache verifies on every hit.

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
- Closed (pointers): store-scene service keys are granted per frame on
  the backend too (2026-09-07, `frame.service_setting_groups`, migration
  `e1f2a3b4c5d6`) and a changed grant is an undeployed change
  (`settings_fingerprints`, 2026-09-08); the browser preview asks before a
  store scene gets the account's keys (2026-09-08); the LAN-egress deny is
  armed on all three runtimes for store-origin scenes (device planes
  2026-09-06, the backend's headless renderer 2026-09-09); ESP32 OTA
  refuses downgrades (`fos_version.c`) — signing `version || image` is
  still the fuller fix (below).
- **`POST /setup` on the Pi hotspot is unauthenticated while it is up**,
  and the hotspot keeps its well-known default PSK (`frame1234`) — decided
  2026-09-03: security is layered, the default still deters some, and a Pi
  with no configured display could not show a minted one (the ESP32 AP got
  a per-device PSK in #443 because its USB console can always print it).
  Release images bake the default with `wifiHotspot: "bootOnly"` for
  300 s; the setup form accepts `controlMode`, `cloudUrl`, `claimToken`,
  `serverHost`, `adminUser/Pass`, `runDriverSetup`, `device` and
  `httpUploadUrl` (the last two mean whoever is in range can also make the
  frame POST every rendered image to a URL of their choosing) and persists
  them to `frame.json` (`portal.nim` `parseSetupOptions` /
  `persistPortalSetup`), so anyone in radio range during a boot where the
  home AP is down can re-enrol the frame or repoint `serverHost`.
  `/setup/status` answers cross-origin only to the hotspot's own origin and
  drops its error text once the hotspot is down (2026-09-09). Require a panel-shown code
  for the control-plane/admin fields (a headless frame then needs the
  local admin password instead); strip current config from the
  unauthenticated setup page; cache the root `iw scan` / `nmcli` Wi-Fi
  scans behind a rate limit.
- Closed (pointer): `chromiumScreenshot` / `rstpSnapshot` are refused for
  store-origin scenes unless the admin allows shell apps on the panel
  (`frameos/spawn_guard.nim`, 2026-09-07); `localImage.path` reads anywhere
  on disk remain — the `scene` asset sandbox is the answer and is opt-in.
- **OTA signature binds archive bytes only**: version and target come from
  GitHub metadata, so anyone with release-upload rights (no signing key) can
  attach an older or other-arch signed archive under a new tag. Verify the
  global signature / trusted comment naming version + target.
- Closed (pointer): interpreter robustness — per-run wall-clock deadline,
  per-scene JS heap ceiling, dispatch budget (2026-09-06;
  `docs/js-apps-and-code-nodes.md`, "What the runtime will not let a scene
  do"). Left: the budgets are per run, not per scene per minute.
- Smaller: the frame's TLS material and admin login now ride the
  `/embedded/settings` pull (bearer-authenticated, but in clear on an http
  backend — same exposure as the API keys that pull already carried; an
  https backend is the fix); JS asset API is frame-wide
  by default (fonts, other scenes' assets, `.frameos/scene_images` writable) — default the `scene` sandbox
  for store-origin scenes; Samba mount target unconfined; `http://`
  providers accepted device-side; the EXIF reader is pure Nim
  (`utils/exif.nim`) and the `exiftool` fallback is argv with a timeout and
  an output cap — what is left is that exiftool's parser sees untrusted
  bytes, plus a missing `--` before the path (not on Buildroot); the cloud
  link-code overlay is still drawn into the
  stored render (the local-presence code no longer is).
- **Not reviewed on the device**: the HTTP-server lane (`server/*.nim`,
  routes, admin session mechanics, control-mode whitelist) did not complete;
  the prior second-pass fixes there (login rate limits, constant-time admin
  compare, `frame.json` memoisation, `/login/options`) were not re-verified.
  Worth a focused pass.

### Frontends, wasm preview, CI

- Closed (pointers): the production deploy key's reach ends at the service
  account (#451, 2026-09-07); ESP32 firmware is signed on GitHub-hosted
  runners only; the iframe-hosted editor accepts postMessage only from its
  declared parent origin (`frontend/src/embed/embedOrigins.ts`).
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

- **`ACTIONS_WRITE_TOKEN` scope is unverified.** The release workflow's
  `update-addon-repo` job checks out `frameos/frameos-home-assistant-addon`
  with it. If it is a classic PAT its blast radius is the whole account, not
  the add-on repo; confirm on the GitHub secrets page and swap it for a
  fine-grained token limited to that one repository (open question left
  from the 2026-09-09 full-repo review, 2026-09-12).

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

Cloud identity, from the 2026-09-09 full-repo review (its Medium items
shipped in PR #461): `clientIpFromHeaders`
(`cloud/apps/auth-web/src/lib/rate-limit.ts`) falls back to the
client-controlled `x-real-ip` when the chain is empty, contradicting the
comment above it; `POST /api/device/poll` inserts a rate-limit row per
arbitrary `device_code`, unauthenticated, before any existence check; every
Google sign-in overwrites `displayName` and `primaryEmail`, so an account
ends up with three different notions of "its address"; `email_unverified`
copy claims a mail was sent even when the resend limit suppressed it; signup
accepts `return_to` and then loses it; `/login?error=<anything>` shows the
sign-in form to a signed-in user; the account layout re-implements
return-path validation instead of reusing `safeAuthReturnPath`; CSP allows
`form-action https:`; PostHog receives the signup email regardless of
consent while the processor list says otherwise; recovery from a lost second
factor is support-only and `/login/verify` does not say so; `jwtVerify`
never pins `algorithms`; `verifySecondFactorCode` has a two-submission race
that burns a spare recovery code.

Ops, not code: the session cookie is scoped to the registrable domain, so
the browser also sends it to `cloud-cdn.frameos.net` (R2 behind
Cloudflare). The fix is to serve the CDN from its own registrable domain;
the `/admin` system check flags the shared domain until that is done.
