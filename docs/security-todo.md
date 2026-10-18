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
- Interpreter budgets (wall-clock deadline, JS heap ceiling, dispatch
  budget) are per run, not per scene per minute.
- Smaller: the frame's TLS material and admin login ride the
  `/embedded/settings` pull in clear on an http backend; Samba mount target
  unconfined; `http://` providers accepted device-side; the `exiftool`
  fallback hands untrusted bytes to exiftool's parser (not on Buildroot);
  the cloud link-code overlay is still drawn into the stored render (the
  status screen draws the code into its own render too, and on a
  `web_only` frame the stored image is the only place it shows); a device `bootup` event may still move
  `frame_host` on embedded frames when the claimed IP matches the request
  peer or `embedded.followBootIp` is set (deliberate: ESP32 DHCP follow);
  `POST /setup` takes anyone on the Pi hotspot, and a frame without a screen
  keeps the hotspot's fixed `FrameOS-Setup` / `frame1234` (decided
  2026-10-18: it has nowhere to show a made-up pair; frames with a screen
  make up their own, `frameos/hotspot_credentials.nim`).

### Frontends, wasm preview, CI

- **Preview worker isolation.** Same-origin direct requests from scene code
  are refused in `frameos_library.js`, but the worker still shares the app
  origin. Host `preview-worker.js` + wasm in a sandboxed iframe or a
  dedicated origin and talk over postMessage. Blocked on one thing: the
  worker reaches the preview proxy (`/api/store/preview-proxy`,
  `/api/frames/…/preview_proxy`) with the app's session cookie, and an
  opaque-origin worker cannot send it — the proxy has to move to a
  short-lived per-preview token first, on both control planes.
- Smaller: the runner pool's `/mnt/cache` is writable from every VM (fork
  PRs do not land there — mount it read-only or a scratch subtree for any
  job that is not building a release, and keep "require approval for all
  outside collaborators" on); the backend Docker image runs as root
  (`docs/todo.md`, "Backend Docker image"); the OpenAI service-account key
  and R2 keys sit in plaintext `.env*` files on the dev laptop (rotate /
  scope).

## Accepted — the deprecated source-build path (not a priority)

Compiled scenes are deprecated and not recommended, and the path is not
being deleted before December 2026 (`docs/convergence-todo.md` item 1). Its
findings are recorded here so they are not rediscovered, not scheduled:
a self-hosted operator who chooses source builds runs user-supplied Nim on
their own host, and the fix is to use interpreted scenes.
`scene_module_suffix` collisions (`codegen/scene_nim.py`) belong to this
path too.

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

Backups: the object store's own copy is rehearsed only by count and hash,
not by a restore into R2.

Cloud: the AI's `save_scene` still acts
immediately (it only creates a private copy in the account; the prompt now
says to call it only on the user's ask, and it is not a proposal); the
device's `app_runtime.nim` still gates `getSetting` on the scene's own
declaration — harmless now that the cloud ships only granted groups, but an
embedded-source app could still be refused there outright; spend
reservations and the store's once-a-day download dedupe live in process
memory (one auth-web instance today — a second instance would need them in
Postgres/Redis).

Cloud: identity-keyed login / reset limits are a cheap lockout; public
scenes are unmetered storage; markdown images load from any https host.

Device HTTP server: admin sessions are
stateless signed cookies, so logout clears the browser's copy but a cookie
someone kept stays good for its 24 h (changing the admin password is what
revokes — the fingerprint is in the signature); login
throttling is per source address in a 512-entry table (the listeners are
IPv4-only, so no /64 rotation); DNS rebinding is still open, as `origin.nim`
says — it needs a Host allow-list the runtime has no source for; the
cover-copy route fetches an admin-supplied URL from the frame (through the
LAN-egress deny on a managed frame, and only a decoded PNG or an error
string comes back).

Backend: requests to a frame's own host (`app/utils/frame_http.py`)
check it and then let httpx resolve it again, accepted because frame hosts
are IP literals in practice (user-supplied URLs connect through
`guarded_transport`); a frame whose SSH host key was already impersonated before the
TOFU pin stays pinned to the impostor until "Forget host key" — the
fingerprint is shown so an owner can compare it with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the device.

Cloud identity: CSP allows `form-action https:`. Next fixes the CSP at
build time, but the cross-origin form targets (the scenes host's logout
form, `CreateSceneWithAiBox`, the my-scenes filter) are only known at
runtime, so tightening it means a request-time CSP from `proxy.ts`, checked
against a real `next start`.

Ops, not code: the session cookie is scoped to the registrable domain, so
the browser also sends it to `cloud-cdn.frameos.net` (R2 behind
Cloudflare). The fix is to serve the CDN from its own registrable domain;
the `/admin` system check flags the shared domain until that is done.
Re-seal the `account_settings` rows nobody has read since sealing shipped:
`pnpm --filter @frameos-cloud/auth-web settings:reseal-legacy` against prod
(`DATABASE_URL` + `FRAMEOS_CLOUD_ENCRYPTION_KEY` from `auth-web.env`), dry
run first, then `--apply`.
