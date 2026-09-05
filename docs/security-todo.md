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

- **`curl | sudo sh` bootstrap defaults to `http://` and downloads
  `frameos-*.tar.gz` unverified**; the precompiled SD image and Remote
  binary are likewise unverified server-side (the Buildroot base image is
  sha256-checked). Publish and verify checksums; warn on plain HTTP.
- Smaller: cross-project leak via the first-loaded project's MQTT broker in
  `ha/sync.py`; `replayEnrollment`-style sync pulls `mode` / `agent` /
  `frame_admin_auth` / `https_proxy.server_key` from the device; `?token=`
  JWT in WebSocket query strings (dormant); no Origin check on WebSocket
  handshakes (SameSite=Lax is the only defence); `TrustedHostMiddleware`
  absent (DNS rebinding reaches `/api/cloud/setup/*` on a fresh install);
  predictable unverified precompiled cache under `/tmp`; a device `bootup`
  event may still move `frame_host` on embedded frames when the claimed IP
  matches the request peer or `embedded.followBootIp` is set (deliberate:
  ESP32 DHCP follow).

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
- **OTA has no downgrade protection** on either control plane (only "same
  version → skip"; `version` is outside the signed payload). Sign
  `version || image` and refuse `≤ running` unless forced, or enable app
  anti-rollback.
- **Scene JS on a backend-managed frame has unrestricted LAN egress**
  (`netguard` is armed only when cloud-managed) and holds whatever keys it
  declared. Apply the private-network deny to store-origin scenes on
  backend-managed frames too; bound total render wall time including native
  HTTP calls (the 20 s interpreter budget pauses during them).
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
- **OTA signature binds archive bytes only**: version and target come from
  GitHub metadata, so anyone with release-upload rights (no signing key) can
  attach an older or other-arch signed archive under a new tag. Verify the
  global signature / trusted comment naming version + target.
- **Interpreter robustness, what is left** (the node depth / self-reference
  guard and the SVG / canvas dimension cap are in): the interpreter time
  budget excludes native calls (`httpRequest` tarpit up to 600 s wedges the
  render thread until the 900 s watchdog, forever); 256 MB JS heap per
  runtime, one per JS app node; self-dispatching event loops starve
  rendering (Pi) or recurse synchronously (ESP32). Wall-clock render
  deadline, per-scene heap budget, per-render dispatch budget.
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

- **The CI deploy key still reaches root on the production box** through
  its forced command (`frameos-cloud-update --archive -`), which unpacks the
  archive and manages systemd/nginx as root. Since 2026-09-05 migrations run
  as the service user with only `DATABASE_URL` (the runner still comes from
  the archive, as the service user), and the self-update is gone — the two
  root scripts come only from `install.sh --scripts-only` on a human's
  checkout, a deploy merely reports drift. Left: the root-side `tar -xf` +
  `chown` of an archive the key uploaded (move the unpack under the service
  user, or verify the archive against a checksum the workflow signs).
  The key is written only after every third-party action in the job, and
  the deploy job's actions are pinned to commit SHAs. Move ESP32 firmware
  signing to a GitHub-hosted job (the key currently lives in a VM on the
  same host as fork-PR VMs).
- **Embedded editor postMessage protocol** accepts `init` /
  `previewProxyUrl` from any `event.source` / origin and replies to `'*'`
  (`EmbeddedEditor.tsx`, `mount.tsx`). Require an allowed-origin list at
  mount, check `event.origin`, reply to it, only honour a same-origin
  `previewProxyUrl`.
- **Preview worker isolation.** Same-origin direct requests from scene code
  are refused in `frameos_library.js`, but the worker still shares the app
  origin. Host `preview-worker.js` + wasm in a sandboxed
  iframe or a dedicated origin and talk over postMessage.
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
