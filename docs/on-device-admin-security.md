# On-device admin: security implications

This document covers the security model and the risks introduced by letting the frame's own admin UI
(`http://<frame>:8787/admin`) **edit and deploy scenes and apps**, not just view them. It complements
[`on-device-admin.md`](./on-device-admin.md), which describes the feature itself.

The short version: the on-device admin is a privileged surface. Anyone who can open `/admin` with a
valid admin session can run **arbitrary JavaScript on the device**, read the device's secrets, and
change its network/backend configuration. Treat admin access to a frame as roughly equivalent to a
shell on the device's render process.

## 1. The trust boundary

| Actor | Can reach | Gated by |
| --- | --- | --- |
| Anyone on the network | `/` display image, static assets | `frameAccess` (`public` / `protected` / `private` + access key) |
| Holder of the **access key** | Read endpoints, scene state, `/c` control, events | the `frameAccessKey` query param / cookie / `Authorization` header |
| Holder of an **admin session** | Everything below: edit config, scenes, apps; restart; reboot; adopt | `frameAdminAuth` (username/password → session cookie) |

Authentication primitives (`frameos/src/frameos/server/auth.nim`):

- **Admin session** — set by `POST`-ing credentials to the login flow; stored as an `HttpOnly`,
  `SameSite=Lax` cookie (`Secure` only when the request arrives over HTTPS, via
  `shouldUseSecureCookie`). Every `/api/frames/*`, `/api/apps/*` and the `/admin` SPA require it
  (`hasAdminAccess` / `hasAdminSession`).
- **Frame access key** — a bearer-style secret for the read/control surface; not sufficient for the
  admin API.
- `canAccessFrameSecrets()` == has an admin session. Secrets in API payloads are only returned to an
  authenticated admin (see §3).

The new scene/app editing endpoints are all behind `ensureFrameApiReadAccess` →
`hasAdminAccess`, i.e. the admin session. **No new unauthenticated surface was added.** The risk is
not a new door; it's that the existing admin door now leads to code execution.

## 2. Saved scenes are arbitrary code execution

This is the most important implication of making scenes editable on the device.

A FrameOS scene is interpreted from JSON at runtime (`frameos/src/frameos/interpreter.nim`). Scene
JSON can contain:

- **`code` nodes** — inline expressions/snippets that are transpiled to JavaScript and run in the
  scene's QuickJS context (`compileCodeInlineFn`, `frameos/src/frameos/js_runtime/`).
- **`app` nodes with inline `sources`** — a custom app whose `app.ts`/`app.js` source is embedded in
  the scene and run as a "dynamic JS app" (`initDynamicJsApp`).

The JS runtime exposes host functions including **`fetchText` / `fetchJson`** (outbound HTTP from
the device), state read/write, logging, and frame metadata (`app_runtime.nim`,
`registerFunction("jsFetchText", …)`). So a saved scene can:

- make arbitrary outbound network requests from the device's network position (LAN-internal
  services, cloud metadata endpoints, exfiltration targets),
- read and rewrite scene state,
- loop/allocate to degrade the device (the render loop runs these synchronously).

When the admin UI saves a scene, the frame writes it to `scenes.json.gz` and sends a `reload` event;
the runner **hot-swaps and starts executing it within one render cycle** — no second confirmation,
no backend in the loop. **Editing a scene on the device == deploying code to the device.** There is
no sandbox boundary between "the person editing scenes" and "the code FrameOS runs". This was already
true for backend-driven deploys; the device admin now offers the same capability locally.

Mitigation / non-mitigation:

- The QuickJS runtime is a JS interpreter, not an OS sandbox. It does **not** give filesystem or
  shell access from `code`/JS-app nodes, but `fetchText` is enough to matter.
- Some **catalog apps shell out** (e.g. `data/chromiumScreenshot` runs `sudo apt-get install …`,
  `rstpSnapshot` runs `ffmpeg`; `frameos/src/apps/data/*`). Those are compiled Nim apps, so adding
  one to a scene on the device only takes effect after a backend deploy of a compiled scene — but it
  is a reminder that the app catalog is not a low-privilege surface.
- **Compiled** scenes/apps still require the backend's Nim toolchain; the device can edit and persist
  their source but cannot build it (see §6).

The whole admin surface — including the `/admin` SPA, all `/api/frames/*` and `/api/apps/*`
endpoints — is only served when `adminPanelEnabled()` is true, which requires
`frameAdminAuth.enabled` **and** a non-empty username **and** a non-empty password
(`frameos/src/frameos/server/auth.nim`). There is no "admin panel on, no credentials" state: clearing
the credentials turns the whole panel off (the SPA 401s and the login page redirects). So the
practical posture is binary — either the panel is off, or it is protected by a password whose
strength is the only thing standing between the network and code execution.

**Recommendation:** use a strong, unique admin password. Anyone who can route to port 8787 and knows
(or guesses, or sniffs over plain HTTP) that password gets code execution.

## 3. Secret exposure through the editing surface

The editor needs the frame's full config to render settings, so `GET /api/frames/1` returns secrets
**only to an authenticated admin** (`exposeSecrets = canAccessFrameSecrets(request)` in
`frameos/src/frameos/server/api.nim`). With an admin session you can read:

- `frame_access_key` — the read/control access key,
- `frame_admin_auth.user` / `.pass` — the admin credentials themselves (in cleartext),
- `server_api_key` — the bearer token the frame uses to authenticate to its backend
  (`/api/frame_device/request_update` etc.),
- `agent.agentSharedSecret` — the HMAC secret for the agent's authenticated channel to the backend,
- mountpoint passwords, device upload headers.

Implications:

- An admin session is a **credential-harvesting** position. Stealing it (or the device, or a backup —
  see §5) yields the backend API key and the agent shared secret, which authenticate actions against
  the backend on this frame's behalf (request a deploy of itself; the agent secret gates the
  command-execution channel — `agentRunCommands`).
- These secrets are returned in a JSON body. They will sit in browser memory, and in any HTTP
  intermediary that can see the (possibly plaintext) `/admin` traffic. **Run `/admin` over HTTPS or a
  trusted LAN/VPN only.** Over plain HTTP the admin session cookie is sent without `Secure` and the
  secrets travel in cleartext.

The redaction is binary: admin sees everything, non-admin sees none of it. There is no "edit scenes
but not secrets" role. Anyone you trust to edit scenes on the device, you are also trusting with all
of the above.

## 4. Configuration & network changes

The same `POST /api/frames/1` accepts device-editable config fields
(`frameos/src/frameos/server/config_update.nim`). Through it an admin can, on the device, without the
backend:

- change `frameAccess` and `frameAccessKey` (open up or lock down the read surface),
- change `frameAdminAuth` (rotate the admin credentials — changing admin auth clears existing
  sessions via `clearAdminSessions()`; clearing user/pass turns the admin panel off entirely),
- repoint the **backend connection** (`serverHost` / `serverPort` / `serverApiKey`) and the **agent**
  config (`agentEnabled`, `agentRunCommands`, `agentSharedSecret`),
- change network config and the QR control code.

Repointing `serverHost`/`serverApiKey` is effectively **re-homing the frame to a different backend**.
The adoption flow (`POST /api/frames/1/adopt`) does this deliberately, but the raw config save can
also do it. An attacker with an admin session could point a frame at a backend they control; if the
agent is enabled with `agentRunCommands`, that backend gains a command-execution channel to the
device. The whitelist deliberately **excludes** rebuild/redeploy-only fields (deployment mode, display
driver, SSH keys, HTTPS proxy certs, mountpoints, reboot crontabs) — those cannot be changed from the
device — but the runtime/network fields above are powerful on their own.

## 5. Backups, atomicity, and data at rest

Every config and scene save (`writeFrameConfig`, `writeScenesFile` in `config_update.nim`):

- writes to a `.tmp` file then `moveFile`s it into place (atomic; a crash mid-save can't corrupt the
  live file), and validates `frame.json` parses before activating it;
- copies the previous file to `frame.json.bak.<UTC timestamp>` / `all_scenes.json.gz.bak.<…>` /
  `scenes.json.gz.bak.<…>` in the same release folder, keeping the 10 newest.

Security implications of the backups:

- **`frame.json.bak.*` files contain the full config, including all the secrets in §3, in
  cleartext.** They live under `/srv/frameos/releases/release_*/`. Anyone who can read that directory
  (a shell on the device, a stolen SD card, a filesystem-level backup, the agent, an over-broad app)
  can read every secret the frame has held. Rotating a leaked secret does **not** scrub it from the
  older `.bak` files.
- Scene backups (`all_scenes.json.gz.bak.*`) contain whatever code was in previous scene versions.

This is not new for `frame.json` (settings saves already backed up), but scene saving extends the
same exposure to scene/app source. **Protect the release folder and any device backups as
secret-bearing material.** Consider scrubbing `.bak.*` files when decommissioning a device or after a
credential rotation.

## 6. Compiled vs interpreted: a deliberate capability split

Only `settings.execution == "interpreted"` scenes are written to the runner's `scenes.json.gz` and
executed on the device (`filterInterpretedScenes`, mirroring the backend's deploy-time filter).
Compiled scenes/apps require the backend's Nim compiler and a full deploy.

- Interpreted scenes loaded from disk **override** a compiled scene of the same ID
  (`buildExportedScenesTable`, `frameos/src/frameos/scenes.nim`). This is what lets an admin "fork" a
  built-in compiled scene into an editable interpreted one on the device. It also means an admin can
  **shadow a trusted compiled scene with arbitrary interpreted code** under the same ID. Backend
  deploys never write a compiled scene into `scenes.json`, so the override only ever triggers for
  on-device edits — but be aware the ID is not a trust anchor once `/admin` is reachable.
- The device's `POST /api/apps/validate_source` only validates JSON; it does **not** lint Nim/JS and
  is **not** a security control. Malformed/malicious JS is "validated" fine and only fails (loudly, in
  the logs) when the scene actually runs. Never treat the validate endpoint as a gate.

## 7. CSRF, sessions, and transport

- Admin session and access cookies are `SameSite=Lax`. State-changing calls are `POST`/`PATCH` with a
  JSON content type and custom headers, which a cross-site form can't trivially forge; `SameSite=Lax`
  blocks the cookie on cross-site subrequests. There is **no separate CSRF token**, so the protection
  rests on `SameSite` + the JSON/`Authorization` shape of requests. A same-site XSS (e.g. via a
  rendered scene that injects script into the admin origin) would bypass this — another reason saved
  scenes are sensitive.
- `Secure` is conditional on HTTPS. On a plain-HTTP frame the session cookie and all secrets are
  exposed to anyone on-path. **Strongly prefer HTTPS or an isolated network for `/admin`.**
- The admin SPA is now served for every `/admin/**` path (`web_routes.nim`). These all require an
  admin session and only return the static `index.html`; no data is exposed by the wildcard itself.

## 8. Embedded app sources

The build now embeds every system app's source files into the binary
(`tools/generate_apps_asset_nim.py` → `getAppSourcesJson`), served by `GET /api/apps/source`
(admin-only). These are the same open-source app sources shipped in the repo, so this is **not** a
secret-exposure concern, but note:

- it grows the binary (sources are gzip+base64 in the binary; ~0.5 MB of source compresses to a much
  smaller blob, parsed lazily on first request and cached),
- the endpoint is admin-gated like the rest, so it doesn't widen the unauthenticated surface.

## 9. Backend pull is read-then-apply

`config_drift` / `pull_config` (`backend/app/api/frames.py`) read the device's `frame.json` and
`all_scenes.json.gz` over the agent/SSH channel and copy device edits into the backend record. The
device is the source of truth for its own running config; the backend trusts what the device reports.
This is intentional (the device's running config **is** the deployed state), but it means a
compromised device can push arbitrary scene code and config field values into the backend's stored
record for that frame the next time an operator clicks "Pull changes from frame". The pull only
touches the device-editable whitelist plus scenes — it can't, for example, rewrite SSH keys — and an
operator action is required, but review what you pull from a frame you don't fully trust.

## Hardening checklist

- [ ] Set a strong, unique `frameAdminAuth` password on every frame whose `/admin` is reachable.
- [ ] Serve `/admin` over HTTPS, or restrict port 8787 to a trusted LAN/VPN.
- [ ] Treat an admin session as code-execution-equivalent; don't hand it out for "just editing
      scenes".
- [ ] Protect `/srv/frameos/releases/**` and device/SD backups as secret-bearing; scrub `.bak.*`
      after credential rotation or before decommissioning.
- [ ] Rotate `serverApiKey` and `agentSharedSecret` if a frame (or its backups) may have been
      exposed.
- [ ] Review scenes before clicking "Pull changes from frame" on a device you don't fully control.
- [ ] Keep `agentRunCommands` off unless the backend genuinely needs to run commands on the device.
