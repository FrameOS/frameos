# Security — what is still open

Open work only, most severe first, from the full-repo security reviews of
2026-09-02 and 2026-09-09 and the device HTTP-server pass of 2026-09-19;
what has shipped is in git history. **When an item ships, delete it** — a
residue worth remembering goes to the medium / low list, not into a "closed"
paragraph here. Prior review of the cloud-link flow:
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

## High — schedule

Nothing critical is open on any plane. The cloud has no open high item; what
is left there is in the medium / low list.

### Device runtime (Nim) and ESP32

- **Secure Boot v2 and flash + NVS encryption for production ESP32 images.**
  The NVS holds the Wi-Fi PSK, the cloud token, the Ed25519 seed, the API
  key, the admin password, the TLS key and the cached service keys. (OTA is
  already signed and verified against the release key on both planes. A
  self-hosted backend reached over plain http still carries the bearer in
  clear on every request; an https backend is the fix for that.)
- **`POST /setup` on the Pi hotspot is unauthenticated while it is up**, and
  the hotspot keeps its well-known default PSK (`frame1234`) — decided
  2026-09-03: a Pi with no configured display could not show a minted one.
  Release images bake the default with `wifiHotspot: "bootOnly"` for 300 s;
  the setup form accepts `controlMode`, `cloudUrl`, `claimToken`,
  `serverHost`, `adminUser/Pass`, `runDriverSetup`, `device` and
  `httpUploadUrl` and persists them to `frame.json` (`portal.nim`
  `parseSetupOptions` / `persistPortalSetup`), so anyone in radio range
  during a boot where the home AP is down can re-enrol the frame, repoint
  `serverHost`, or make the frame POST every rendered image to a URL of
  their choosing. Require a panel-shown code for the control-plane/admin
  fields (a headless frame then needs the local admin password instead), and
  strip current config from the unauthenticated setup page.
- Store-origin scenes: `localImage.path` reads anywhere on disk, and the JS
  asset API is frame-wide (fonts, other scenes' assets,
  `.frameos/scene_images` writable). The `scene` asset sandbox is the answer
  and is opt-in — default it for store-origin scenes.
- Interpreter budgets (wall-clock deadline, JS heap ceiling, dispatch
  budget) are per run, not per scene per minute.
- ESP32 OTA does not compare the image's own `esp_app_desc` version with the
  name the signature binds (a release that mis-stamps its version would
  re-flash daily; `ci_build_image.sh` already refuses to build one).
- Smaller: the frame's TLS material and admin login ride the
  `/embedded/settings` pull in clear on an http backend; Samba mount target
  unconfined; `http://` providers accepted device-side; the `exiftool`
  fallback hands untrusted bytes to exiftool's parser and lacks a `--`
  before the path (not on Buildroot); the cloud link-code overlay is still
  drawn into the stored render; a device `bootup` event may still move
  `frame_host` on embedded frames when the claimed IP matches the request
  peer or `embedded.followBootIp` is set (deliberate: ESP32 DHCP follow).

### Frontends, wasm preview, CI

- **Preview worker isolation.** Same-origin direct requests from scene code
  are refused in `frameos_library.js`, but the worker still shares the app
  origin. Host `preview-worker.js` + wasm in a sandboxed iframe or a
  dedicated origin and talk over postMessage. Blocked on one thing: the
  worker reaches the preview proxy (`/api/store/preview-proxy`,
  `/api/frames/…/preview_proxy`) with the app's session cookie, and an
  opaque-origin worker cannot send it — the proxy has to move to a
  short-lived per-preview token first, on both control planes.
- **`ACTIONS_WRITE_TOKEN` scope is unverified.** The release workflow's
  `update-addon-repo` job checks out `frameos/frameos-home-assistant-addon`
  with it. If it is a classic PAT its blast radius is the whole account;
  confirm on the GitHub secrets page and swap it for a fine-grained token
  limited to that one repository.
- Smaller: the runner pool's `/mnt/cache` is writable from every VM (fork
  PRs do not land there — mount it read-only or a scratch subtree for any
  job that is not building a release, and keep "require approval for all
  outside collaborators" on); the backend Docker image runs as root
  (`docs/todo.md`, "Backend Docker image"); the OpenAI service-account key
  and R2 keys sit in plaintext `.env*` files on the dev laptop (rotate /
  scope).

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

**Dated:** the pre-encryption pgBackRest repo `storagebox:pgbackrest` is frozen
plaintext — **delete it on 2026-10-03** (`rclone purge storagebox:pgbackrest`
on the box), once the encrypted repo has its own four-week window; the
object store's own copy is rehearsed only by count and hash, not by a
restore into R2.

Cloud: the AI's `save_scene` still acts
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

Device HTTP server: admin sessions are
stateless signed cookies, so logout clears the browser's copy but a cookie
someone kept stays good for its 24 h (changing the admin password is what
revokes — the fingerprint is in the signature); the signature is
`sha256(salt ‖ …)` rather than an HMAC — length extension only reaches the
nonce, under the same expiry, so nothing is gained, but HMAC is the right
primitive; unfinished uploads sit under `getTempDir()/frameos-upload-chunks`
with predictable names (local users only, and a frame has one); login
throttling is per source address in a 512-entry table (the listeners are
IPv4-only, so no /64 rotation); DNS rebinding is still open, as `origin.nim`
says — it needs a Host allow-list the runtime has no source for; the
cover-copy route fetches an admin-supplied URL from the frame (through the
LAN-egress deny on a managed frame, and only a decoded PNG or an error
string comes back).

Backend: `scene_module_suffix` collisions; no artifact cleanup for SD
images and firmware; the resolver-based target guard (`app/utils/network.py`)
resolves once per request, so a DNS rebind between check and connect is
accepted for project-authenticated features (frame hosts are IP literals in
practice); a frame whose SSH host key was already impersonated before the
TOFU pin stays pinned to the impostor until "Forget host key" — the
fingerprint is shown so an owner can compare it with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the device.

Cloud identity: `clientIpFromHeaders`
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
