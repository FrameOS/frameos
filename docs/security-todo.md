# Security — what is still open

> **Local draft, not pushed (2026-11-24).** The High list below still
> describes open holes (the settings group), in a public repository. Keep it
> off `origin` until that group ships or its wording is cut down, and delete
> this note then.

Open work only, most severe first, from the full-repo security reviews of
2026-09-02 and 2026-09-09, the device HTTP-server pass of 2026-09-19 and the
full-repo audit of 2026-11-24; what has shipped is in git history. **When an
item ships, delete it** — a residue worth remembering goes to the medium / low
list, not into a "closed" paragraph here. Prior review of the cloud-link flow:
`docs/cloud-security-review.md`.

The 2026-11-24 audit's findings outside the settings group shipped the same
day: #1028–#1036 and #1038–#1041, plus the Dependabot pins (#1037). File and
line references below are as of the audit (main `2d0ced43c`); the code has
moved since. Items carry how far they were taken:

- **[confirmed]** — a second reader re-read the decisive lines.
- **[proven]** — a small harness ran the real functions.
- **[traced]** — one reader followed it from the entry point to the sink.
- **[partly]** — part of the path was not read; say so when picking it up.

**Where it stands.** What is open is, in order:

1. **The settings group**, deferred to the settings refactor (owner's call,
   2026-11-24): which stored keys and secrets reach a scene, a preview or a
   frame. Three of its items are High.
2. **Settings only the owner can change**: repository, organization and
   service settings no pull request can reach.
3. **Design decisions** and small residues the fix-up left, then leads.

Rules that came out of the reviews and apply to new code:

- **A personal API token is a script's credential, not the person's.** It
  must never satisfy a sudo-mode gate, enrol a credential, delete the
  account, or reach `/api/admin/*`. `readSession()` accepts tokens, so every
  route that is "the person at the keyboard" must check `session.apiToken`
  or go through `requireRecentAuth` (which reads the cookie only). **The
  backend has the same rule** (`require_session_credential`, also a route
  dependency): every cloud-link and sign-in mutation, the backup key and the
  preview's keys take a session; no token gets `reveal=1`; a read-only token
  reads no credential at all (`refuse_read_only_token`, `redact_frame_secrets`).
- **Scene code is untrusted, everywhere it runs.** A published scene is
  anyone's code: on the frame, in the wasm preview worker, in the headless
  renderer, and in the AI context window. Nothing it declares about itself
  (`config.json` settings groups, `permissions`, `origin`, `sources` names) is
  a permission; it is a request the control plane must grant or refuse, and
  the runtime must enforce the grant, not the request.
- **What a scene declares is parsed once, strictly, by everyone.** A
  `config.json` that is not strict JSON grants nothing on the device and is
  refused at save and publish (`docs/app-config-fixtures.json`). One
  extractor finds a zip's `scenes.json` (`scene-zip.ts`).
- **A stored secret belongs to its endpoint.** Changing the URL or host a
  kept secret is sent to needs the secret again.
- **Input from the HTTP write door is a scene's, not the frame's.** While a
  scene runs on an `http:write` event the dispatcher withholds the frame
  page's hooks, the code host and the store's actions. A new power a scene
  can reach is withheld the same way.

---

## High — the settings refactor (deferred)

Fix the first one properly (a per-scene grant the plane stamps and the
runtime enforces) and the next two shrink with it.

- **A scene reads service keys that were granted to another scene.**
  [confirmed] The cloud records a grant per assignment but sends the frame
  the union (`grantedServiceSettingGroupsUnion`,
  `cloud/apps/auth-web/src/lib/frames.ts:1752`; the device pull,
  `app/api/frames/[frameId]/service-settings/route.ts:106`), and the
  runtime's only gate is the app's own `settings` list over the frame-wide
  settings (`frameos/src/frameos/js_runtime/app_runtime.nim:2234`). A store
  scene with nothing granted (a declined grant, or a panel install:
  `panel-scenes.ts:328`) that declares `["openAI","homeAssistant"]` reads
  what another scene on that frame was granted and can `fetch` it out. The
  same union goes to server renders and the hub's virtual device
  (`server-render.ts:496-505`, `virtual-device.ts:651-663`); on a backend a
  store scene reads any group an owner-authored scene declares
  (`backend/app/models/frame.py:998-1003`). Fix: stamp each pushed scene
  with its granted groups and gate `getSetting` on the stamp, or strip
  ungranted `settings` entries from each config.json at push.
- **The self-hosted backend ships any settings group a scene names,
  `ssh_keys` included.** [confirmed] `shipped_frame_settings`
  (`backend/app/models/frame.py:973-1013`) copies `all_settings.get(key)`
  for every key a scene without a store origin declares — a zip import, a
  repository template, an AI-written or MCP-installed scene all count as
  owner-authored — and trims only `homeAssistant`. The settings table also
  holds `ssh_keys` (private keys), `buildHost`, `modalSandbox` and `github`
  (`schemas/settings.py:18-31`); the tag such a scene shows is the grey
  "uses ssh_keys key". Fix: an allow-list of deliverable groups and fields,
  as the cloud's `deviceDeliverableFields`.
- **The browser preview gives the previewed scene every saved secret.**
  [confirmed] `frontend/src/sceneWorkspace/SceneLivePreview.tsx:816` fetches
  `settings?reveal=1`, keeps every group with string fields (`:826-842`) and
  hands them all to the wasm runtime (`:954`), which releases a group to any
  app that names it. On the cloud that is the six service groups plus
  `openAI.backendApiKey`, inside the reveal window (two hours by default); a
  public store page `/s/<slug>` is enough and the Preview panel is on by
  default. On a backend a browser session gets them (API tokens no longer
  do, since #1028) and the groups include `buildHost.sshKey`,
  `defaults.wifiPassword`, `modalSandbox` and `homeAssistant.mqttPassword`.
  The "Run preview" gate (`sceneWorkspace/lib/preview-settings.ts`,
  `gatedServicesForScenes`) knows only the six service groups, stops at
  `node.data.sources = {}` where the runtime falls back to `scene.apps`
  (`interpreter.nim:324-331`), and exempts an unchanged repo app that
  shares its JS realm with the scene's other apps. The frames workspace's
  older consent (`previewKeyConsent.ts`, `secretSettings.ts`,
  `sceneApps.ts:157`) has the same holes. Fix: the preview gets only the
  service groups this scene was granted, `?reveal=1` narrows to those
  fields, and "declared" is computed in one place.

The rest of the group, Medium unless marked:

- **A kept secret follows a changed URL.** [traced] `POST /api/settings`
  (`app/api/settings/route.ts:149-205`) asks no recent auth and refuses no
  token; a masked secret means "keep" (`account-settings.ts:277`) and `url`
  is a plain field. Posting `{homeAssistant: {url: "https://attacker",
  accessToken: "••••"}}` nudges every frame holding the group to send the
  real token there (`repo/apps/json/haSensor/app.ts:21-24`); Immich the
  same. On the backend the MCP's `settings_update` does it with no
  `confirm` (`backend/app/mcp/tools/account.py:120-150`; the worker then
  posts to the new host with the kept token, `app/ha/client.py:42-45,113`;
  MQTT host and password alike). The cloud MCP's `account_settings_update`
  takes no `confirm` either (`packages/mcp/src/tools/account.ts:113`). Fix:
  rule four.
- **`panel/code` save gives a new scene the keys of a retired Nim keyword
  without `needs_owner`.** [traced] `declared_grants`
  (`backend/app/api/panel_code.py:126-135`, `:233`) looks keywords up in
  `get_app_configs()` only; the shipping walk also resolves retired ones
  (`models/frame.py:963-969`), and a panel-saved scene has no origin, so it
  counts as the owner's. A holder of a frame's `server_api_key` saves a
  scene naming `data/haSensor` and the next settings pull returns the Home
  Assistant token; an empty `data.sources: {}` skips the lookup the same
  way. Fix: build both checks from `scene_declared_setting_groups`.
- **A voice turn grants any key to code the model wrote.** [traced]
  `create_scene` / `change_scene` push the model's scene as a preview with no
  grant check (`backend/app/utils/voice_chat.py:813-818`) and the settings
  pull adds whatever a preview declares
  (`backend/app/api/embedded_device.py:1636-1646`). (The microphone switch is
  enforced on both planes since #1035.)
- **Preview worker isolation.** Same-origin direct requests from scene code
  are refused in `frameos_library.js` (the redirect and trailing-dot variants
  hold), but the worker still shares the app origin and holds the revealed
  keys. Host `preview-worker.js` + wasm in a sandboxed iframe or a dedicated
  origin and talk over postMessage. Blocked on the proxy: the backend's
  (`/api/frames/…/preview_proxy`) takes the session cookie, which an
  opaque-origin worker cannot send; the cloud's (`/api/store/preview-proxy`)
  takes no session, only an `Origin` on its allow-list, which a sandboxed
  worker's `Origin: null` fails (and which any non-browser client can set,
  so it is already an anonymous relay to public hosts). Both need a
  short-lived per-preview token.
- Low: the frame's TLS key and admin login ride the `/embedded/settings`
  pull in clear on an http backend; the admin password is stored and
  returned in clear to any admin session, cloud-login ones included, beside
  `server_api_key` and the TLS key (`server/api.nim:906-924`); the ESP32's
  cloud settings pull applies a `frame` object the contract reserves for
  backends (`fos_settings.c:1299-1303`), which can set the admin login and
  the TLS key that `set_settings` deliberately cannot.
- Low: the cloud origin keeps `{ssid, password}` in localStorage
  (`cloud-frontend/src/lib/remembered-wifi.ts`); "Convert" sends the
  project's OpenAI key and the raw scene to the cloud converter with no
  per-use consent (`backend/app/api/frames.py:1884-1890`); the Home Assistant
  link's MQTT client has no TLS option.
- Low: `app_runtime.nim` may refuse an embedded-source app's `getSetting`
  outright; `jsGetSetting`'s path parse and `applyServiceSettings`
  (`apps.nim`) read JSON with no depth bound on a board. Revisit with the
  per-scene grant.

## High — not code

- **Secure Boot v2 and flash + NVS encryption for production ESP32 images.**
  The NVS holds the Wi-Fi PSK, the cloud token, the Ed25519 seed, the API
  key, the admin password, the TLS key and the cached service keys. (OTA is
  already signed and verified against the release key on both planes, with
  the version and platform bound through the signed comment and an older
  release refused unless the console arms it. A self-hosted backend reached
  over plain http still carries the bearer in clear on every request; an
  https backend is the fix for that, on a Pico too since #1028.)
- Interpreter budgets (wall-clock deadline, JS heap ceiling, dispatch
  budget) are per run, not per scene per minute.

## Owner: settings no pull request can change

Nothing below was changed by the fix-up; each is a minute with `gh` or a
settings page.

- **Private vulnerability reporting** (`SECURITY.md` points at it):
  `gh api -X PUT repos/FrameOS/frameos/private-vulnerability-reporting`
- **Secret scanning and push protection:** `gh api -X PATCH
  repos/FrameOS/frameos -f
  'security_and_analysis[secret_scanning][status]=enabled' -f
  'security_and_analysis[secret_scanning_push_protection][status]=enabled'`
- **Dependabot security updates:** `gh api -X PUT
  repos/FrameOS/frameos/vulnerability-alerts && gh api -X PUT
  repos/FrameOS/frameos/automated-security-fixes`. Code scanning: `gh api
  -X PATCH repos/FrameOS/frameos/code-scanning/default-setup -f
  state=configured`. Immutable releases: Settings → General → Releases.
- **A ruleset on `main` (deletion and force-push only;** a pull-request
  requirement would block the release job, the timezone sync and direct
  commits): `gh api -X POST repos/FrameOS/frameos/rulesets --input -
  <<<'{"name":"main","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},"rules":[{"type":"deletion"},{"type":"non_fast_forward"}]}'`;
  the same for tags, `target: "tag"`, `refs/tags/v*`, rules deletion,
  update, non_fast_forward.
- **Runner labels are not a boundary.** [partly] `runs-on` comes from the
  pull request's own workflow file, so after one "Approve and run" a fork PR
  can pick `epyc-32`: passwordless sudo and all of `/mnt/cache` writable
  (`tools/gha-runners/bin/gha-slot.sh:53,83-87`), and
  `buildroot-base-image.yml` builds release SD images from that cache. Fix: a
  runner group limited to `docker-publish-multi.yml` and
  `buildroot-base-image.yml` at `refs/heads/main` for `epyc-32` and
  `epyc-8`. Runner groups hold organization runners only, so those slots
  are re-registered at org level first (`tools/gha-runners`), then `gh auth
  refresh -s admin:org` and `gh api -X POST
  orgs/FrameOS/actions/runner-groups -f name=release-pool -f
  visibility=selected -F restricted_to_workflows=true -f
  'selected_workflows[]=FrameOS/frameos/.github/workflows/docker-publish-multi.yml@refs/heads/main'
  -f
  'selected_workflows[]=FrameOS/frameos/.github/workflows/buildroot-base-image.yml@refs/heads/main'`.
  Keep "require approval for all outside collaborators" on meanwhile.
- **Release credentials on or near the pool.** A writable deploy key named
  `monster` (`gh api repos/FrameOS/frameos/keys --jq
  '.[]|select(.title=="monster").id'`, then delete it or re-add it
  read-only); a PAT with repository Administration on the runner host
  (revoke; an org "Self-hosted runners" token is enough once the runners are
  org-level); a Docker Hub login on `epyc-8`, which still pushes an unsigned
  image from a self-hosted job (`docker-publish-multi.yml`: move the push to
  a GitHub-hosted job, as `buildroot-base-image.yml` does).
- **Unused secrets:** `gh secret delete DEPOT_TOKEN -R FrameOS/frameos`,
  `gh secret delete TZ_REPO_TOKEN -R FrameOS/frameos`. In FrameOS/tz, once
  this repo's 02:17 UTC poll has worked a night: remove the "Trigger FrameOS
  timezone import" step from `generate-timezones.yml`, then `gh secret
  delete FRAMEOS_REPO_TOKEN -R FrameOS/tz` and revoke the PAT behind it.
- **The cloud box:** run `install.sh --scripts-only` there so the fixed
  `frameos-cloud-update` (#1030) is the one that runs.
- **Google re-auth:** a silent Google round trip satisfies sudo mode until
  `auth_time` is enabled for the OAuth client in Google's console and the
  cloud runs with `GOOGLE_REQUIRE_AUTH_TIME=1` (#1032, `cloud/docs/auth.md`).
- **The OpenAI service-account key and R2 keys** sit in plaintext `.env*`
  files on the dev laptop (rotate / scope).
- **Watch the next release run.** It is the first run of #1028's signing
  jobs and of #1037's fourteen major-version action bumps; a pull request
  cannot run that workflow. Same for the first nightly timezone poll and
  pixie-fuzz leg, the first Dependabot pull request, the next npm publish and
  the next image build (the corepack pin).
- **AI evals** were not run after #1031 changed the scene guide (they need
  the dev server and an OpenAI key).

## Accepted — the deprecated source-build path (not a priority)

Compiled scenes are deprecated and not recommended, and the path is not
being deleted before December 2026 (`docs/convergence-todo.md` item 1). Its
findings are recorded here so they are not rediscovered, not scheduled:
a self-hosted operator who chooses source builds runs user-supplied Nim on
their own host, and the fix is to use interpreted scenes.
`scene_module_suffix` collisions (`codegen/scene_nim.py`) belong to this
path too. One thing to check before leaning on "chooses": a scene with an
explicit `execution: "compiled"` that arrives by adoption or a sync pull
(`backend/app/api/frame_sync.py:1882`) may make the next full deploy take
this path without the operator choosing it (`binary_builder.py:220-237`;
not traced).

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

---

## Medium

- **The access key's input still reaches a power after an `await`.**
  [traced, #1033's residue] The dispatcher withholds the frame page, the code
  host and the store's actions while a scene runs on an `http:write` event,
  but code an app runs after an `await` is outside that run: a terminal or
  code-editor handler that awaits before calling `frameos.frame` /
  `frameos.code` still acts on the key holder's input. Fix: the JS runtime
  carries the event's origin across the continuation (`js_async.nim`).
- **The AI chat confirms for itself.** [traced] `confirm` is an argument the
  model fills on both planes (`prompts.ts:104` is the only guard), and the
  turn holds nearly every MCP tool under the user's cookie. Since #1032 a
  scene the user does not own is wrapped as untrusted, which narrows who can
  steer it. Fix: a `confirm` tool returns a proposal the user clicks.
- **Two parses of app text on a board have no depth bound.** [traced,
  #1034's residue] `storeChooseLayout` (the store's layout action) and
  `jsFrame` read with std/json; the rest of the runtime's own parses are
  bounded at 32 on a board. Fix: `parseJsonBounded` at both.

## Low

### Cloud

- Signup answers `email_taken…` (`auth/signup/route.ts:98,108`): an account
  oracle, needs a flow change. (The reset request's timing is even since
  #1032.)
- A deleted account's audit rows keep email, address and actor for 730 days,
  as the privacy policy says; whether to keep them is the policy's call.
- Going public publishes every old version, and there is no per-version
  delete: a key typed into an early private version becomes public. (Yanked
  versions are no longer served by number, #1032.)
- An image digest is a capability in one place and not in another
  (`images/[imageId]/route.ts:104-120` against `store-images.ts:171-176`),
  and private and pulled scenes' zips and images sit on the unauthenticated
  CDN alias under their sha256.
- Identity-keyed login / reset limits are a cheap lockout; public scenes are
  unmetered storage.
- The AI's `save_scene` still acts immediately (a private copy in the
  account; the prompt says to call it only on the user's ask).
- Spend reservations and the store's once-a-day download dedupe live in
  process memory (one auth-web instance today).
- CSP allows `form-action https:` and `script-src 'unsafe-inline'`. Next
  fixes the CSP at build time, but the cross-origin form targets are only
  known at runtime, so tightening it means a request-time CSP from
  `proxy.ts`, checked against a real `next start`.
- Ops, not code: the session cookie is scoped to the registrable domain, so
  the browser also sends it to `cloud-cdn.frameos.net`, to `frameos.net`
  itself and to the playground, and any `*.frameos.net` page can set
  cookies for it (none is `__Host-`). The fix is a registrable domain of its
  own for the CDN; the `/admin` system check flags it until then. (The
  playground host answers no signed-in API since #1032.)
- Backups: the object store's own copy is rehearsed only by count and hash,
  not by a restore into R2.

### Self-hosted backend

- A cloud restore trusts the provider for integrity
  (`cloud_backups.py:259-354`): unsealed backups are accepted and the sealed
  format is not signed, so it can set `frame_host`, `server_host`, scenes
  and mounts. A signed format is a design.
- Requests to a frame's own host (`utils/frame_http.py`) check it and then
  let httpx resolve it again, accepted because frame hosts are IP literals
  in practice; a frame whose SSH host key was impersonated before the TOFU
  pin stays pinned to the impostor until "Forget host key" (the fingerprint
  is shown so an owner can compare it with `ssh-keygen -lf
  /etc/ssh/ssh_host_ed25519_key.pub` on the device).
- The backend Docker image runs as root (`docs/todo.md`, "Backend Docker
  image"). The SPA has `nosniff` and `frame-ancestors` (#1035) but no full
  CSP.

### Device runtime (Linux)

- Admin sessions are stateless signed cookies, so a kept cookie stays good
  for its 24 h (changing the admin password is what revokes); login
  throttling is per source address in a 512-entry table; DNS rebinding is
  still open, as `origin.nim` says (it needs a Host allow-list the frame
  has no config field for); the cover-copy route fetches an admin-supplied
  URL from the frame (through the guarded client).
- The `exiftool` fallback hands untrusted bytes to exiftool's parser (not on
  Buildroot); a device `bootup` event, and the commands pull
  (`embedded_commands.py:221`), may still move `frame_host` on embedded
  frames when the claimed IP matches the request peer or
  `embedded.followBootIp` is set (deliberate: ESP32 DHCP follow).

### ESP32 and Pico

- No stack protector, no heap poisoning, no end-of-stack watchpoint (flash
  and time cost not measured); the hotspot passphrase is minted once and
  kept (`fos_wifi.c:670`), and the hotspot is full admin.
- A Pico's and a clockless ESP32's certificate dates rest on unauthenticated
  SNTP and a build-time floor (`pk_time.c`; the ESP32 judges "expired"
  against its release month until it has the time, #1036).

### Frontends

- A download or clipboard write from a preview needs a press on the scene
  since #1029. Open question: should a preview of someone else's scene
  always go through the page's notice, even after a press?

### Repository and CI

- The three `EndBug/add-and-commit` pins carry v11.1.1's commit since #1037
  but their comments still say `# v9.1.4` (Dependabot did not rewrite a
  comment with text after the version).
- The production origin's address is in the repo (`cloud/scripts/deploy.sh`
  and the installers, as a default under `FRAMEOS_CLOUD_DEPLOY_HOST`); it is
  public anyway, and answers 80/443 directly.

---

## Leads, not traced

Worth a second look; none of these is a finding yet.

- **Scenes and the runtime.** Events a scene may emit (`sceneSettings`,
  pointer, key, `textInput`) are delivered like real input
  (`event_loop.nim:791` checks the origin for `render` only): a scene that
  keeps running might drive the frame page without `frame` (#1033 withholds
  the page from `http:write` input, not from the scene's own `eoScene`
  events). A scene's apps share one JS realm, so a per-app `settings` or
  `permissions` list is a per-scene grant in practice. On a frame with no
  plane a `code` app's save writes a scene with any permissions
  (`saveHereCode`). `frameos setup` installs apt packages a deployed scene's
  app names (`setup.nim:23-31,889`, rpios, charset checked).
  `frameos.draw(canvas, "<svg…>")` hands scene markup to pixie's SVG and XML
  reader, whose recursion depth is unchecked. `storeAction('layout')` is not
  behind the `store` permission (it picks a look).
- **Device.** The root worker reads `./frame.json` by path
  (`privileged_worker.nim:97-100`, `setup.nim:913-924`); a predictable
  `/tmp/frameos-setup-<epoch>-<name>` precedes a `sudo install`
  (`device_setup.nim:385-392`); two worker routes read live config strings
  without `liveConfigValue` (`server/api.nim:1164-1175,1259`,
  `web_routes.nim:92,112`); `scenes.json.gz` is written world-readable
  (`setup.nim:1039`). ESP32: the microphone pins, `gpio_buttons` and
  `event_map` are cloud-settable (`fos_cloud.c:2724-2843`), so check a pin
  held low cannot open the microphone with nobody there.
- **Cloud.** `replayEnrollment` (`enroll/route.ts:470`) hands a fresh bearer
  to a holder of the claim token and the frame's public key; a spent rebind
  token keeps rotating the link for up to 7 days; a rebind onto a virtual
  frame is not refused. If the Stripe portal configuration `frameos_cloud:
  plans` is missing, the dashboard default may allow a plan switch that
  `billing-provider.ts:955-985` grants before payment. The app sign-in
  handoff to `frameos://sign-in` shows no consent step to a victim who signs
  in after an attacker began it. `sendEmail` logs whole bodies, reset links
  included, when `POSTMARK_SERVER_TOKEN` is unset.
- **Backend.** `render_scene` in the chat runs model-written code under the
  frame's network policy, LAN and backend loopback included when that is on
  (`embedded_render.py:83-104`); a template zip's `image` URL gets the cloud
  link token on any `provider/…` GET (`templates.py:341-348`); SSH connects
  have no `assert_target_allowed`; `_survey_jpeg` walks `0xFF` runs a byte
  at a time (`photo_metadata.py:466`; it must stay byte-for-byte with the
  cloud's reader).
- **CI and ops.** The pool VMs' network isolation; the scopes of
  `ACTIONS_WRITE_TOKEN` and `DOCKERHUB_TOKEN`; the nginx vhosts and the hub
  unit, which exist only on the box; `frameos.net/setup.sh`, the `curl |
  sudo sh` entry point, hosted outside this repo.

## What the 2026-11-24 pass did not reach

So the next one starts there: `jsx.nim`, `js_async.nim`, `js_io.nim`,
`run_budget.nim`; `frameos_library.js` beyond the same-origin refusal and the
headless renderers' own code; the ESP32 hosts for the store, code and frame
hooks beyond their gates, the console, `fos_assets_sd.c`, the display drivers
and the C3 configuration; the mummy fork's request parsing;
`server_render.py`, the FOSB and panel-pack parsers on both planes,
`voice_scene_builder`, the sync diff/apply logic and the deploy workflow's
command strings; the cloud's ledger beyond `applyProviderPayment`, refunds,
disputes, quotas and the admin pages; iOS views beyond a grep; the Home
Assistant add-on repo; and any confirmation on a running system. One lead in
the ESP32 network slice was dropped unfinished. (The pixie decoders now have
fuzzers in CI with checks on, #1030 and #1041.)

What held up, briefly: every frame route's ownership check and CSRF on the
cloud, the hub's origin check and device handshake, SSRF guards with the
check in the connect on both planes, OTA and release-archive signatures,
asset and photo path handling on every runtime, shell quoting on the Pi,
zip handling, share tokens, the Stripe webhook and checkout, the ESP32's
bounds in the scene store, FOSB and press map (6000 sanitizer rounds), and
git history, which holds no secret. `pnpm audit` is clean.
