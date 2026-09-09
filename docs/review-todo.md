# Full-repo review — 2026-09-09

Everything a whole-project review turned up, in one file: security, correctness,
usability, consistency, robustness, maintainability, tests and doc drift. Twelve
reviewers read one area each, end to end, and every item below was checked
against the code — line numbers are repo-relative and were current at
`f416dc1a`. **When an item ships, delete it.** Items that belong to a longer
track (security posture, convergence, store content, billing) should move to
their own file rather than living here twice.

Conventions:

- **Severity** is about this repo's threat model: *high* = a real user's
  secrets, device or account is reachable, or a device bricks; *medium* = a
  bounded compromise, a DoS, or a flow that fails in the field; *low/nit* =
  cleanup, drift, defence in depth.
- **[known — worse]** marks an item already listed in `docs/security-todo.md`
  that turned out to be more serious, or wrongly described, than that file says.
  Everything else already listed there was deliberately *not* re-reported.
- Findings the reviewers verified as **already fixed but still listed** in an
  existing todo are collected under "Corrections to the existing docs".

---

## 1. Cloud — identity, sessions, account

Paths are relative to `cloud/apps/auth-web/`.

### Medium

- **[known — worse] Passwordless passkey sign-in stamps an arbitrary identity
  into the session.** `app/api/auth/passkey/verify/route.ts:83-109` selects the
  first `accountIdentities` row with no `ORDER BY` and pairs it with the password
  issuer. The mismatched pair makes `frameos/login/authorize` answer
  `linked_client_required`, and `device/authorize` snapshots it into
  `approvedBy`, so the self-hosted backend maps the same person to different
  local identities depending on how they signed in.
- **The audit trail keeps the email after deletion**, contradicting
  `app/legal/privacy/page.tsx:207-210` ("no longer identifies you"):
  `account.self_deleted`, `admin.account_deleted`, `account.google_linked` store
  `metadata.email`, and every password sign-in stores the email as
  `actor.providerSubject`. Fix the copy
- **The parent-domain session cookie is sent to a third-party host.** Production
  sets `FRAMEOS_SESSION_COOKIE_DOMAIN=frameos.net`, so the `__Secure-` session
  cookie rides along to `cloud-cdn.frameos.net` (Cloudflare R2) on every store
  image fetch. Move the CDN to its own registrable domain, or hand the scenes
  host its session through a one-time handoff.
- **Enrolling a second factor silently revokes every API token.** The routes
  return `api_tokens_revoked`, `TwoFactorSettings.tsx` never reads it and the
  security mail does not mention it, so an agent's scripts start failing 401 with
  no explanation.
- **The Turnstile token is spent before the form is validated.**
  `app/api/auth/signup/route.ts:52-61` verifies Turnstile first, then rejects
  `email_taken` / `weak_password`; the widget never resets, so the corrected
  resubmit fails with "reload the page". Same shape on reset request.
- **Google accounts with `email_verified: false` get a full session and then dead
  end** — they can never add a password (`findVerifiedGoogleAccountByEmail`
  ignores them) and a stranger can create a second password account on the same
  address.
- **Failed password logins are not audited, and there is no self-serve "sign out
  everywhere".** The Activity page therefore cannot show credential guessing, and
  the only revoke-all lives behind `/api/admin`.
- **Sudo mode on a 2FA account is satisfied by the password alone**, and the same
  single factor turns 2FA off. Deliberate or not, say so in `docs/auth.md`.

### Low / nits

- `clientIpFromHeaders` (`src/lib/rate-limit.ts:258-278`) falls back to the
  client-controlled `x-real-ip` when the chain is empty, contradicting the
  comment above it.
- `POST /api/device/poll` inserts a rate-limit row per arbitrary `device_code`,
  unauthenticated, before any existence check.
- `GET /api/settings?reveal=1` hands every stored third-party key to any cookie
  session with no recent-auth gate.
- Every Google sign-in overwrites `displayName` and `primaryEmail`, so an account
  ends up with three different notions of "its address".
- `email_unverified` copy claims a mail was sent even when the resend limit
  suppressed it; signup accepts `return_to` and then loses it;
  `/login?error=<anything>` shows the sign-in form to a signed-in user.
- The account layout re-implements return-path validation instead of reusing
  `safeAuthReturnPath`; CSP allows `form-action https:`; PostHog receives the
  signup email regardless of consent while the processor list says otherwise.
- Recovery from a lost second factor is support-only and `/login/verify` does not
  say so; `jwtVerify` never pins `algorithms`; `verifySecondFactorCode` has a
  two-submission race that burns a spare recovery code.

---

## 2. Cloud — scene store, images, render

### Medium

- **Two copies of the SSRF guard, and the headless renderer's is the weaker
  one** — `src/lib/scene-render.ts:525-548` lacks the 192.0.0.0/24, 198.18/15,
  NAT64 and 6to4 rules that `ssrf.ts` has.
- **Share tokens cannot be rotated or turned off.** `storeScenes.shareToken` is
  minted at creation and no route writes it, so a leaked link is only fixable by
  deleting the scene or making it public.
- **Editor saves and forks accept compiled Nim scenes the publish path refuses**,
  which fails much later at assign time with `scene_requires_compilation`.
- **"My cloud drive" refuses personal API tokens** — `store/account/repository.json`
  hands any bearer to `authenticateLinkedClient`, so `fc_api_` gets
  `401 invalid_link_token`.
- **Owner actions swallow the server's reason**, collapsing
  `storage_quota_exceeded`, `scene_pulled` and `rate_limited` into "Failed",
  while the editor shows raw error codes.
- **Yanking the latest version leaves `latest_version` pointing at it**, so
  `?v=N` cover URLs marked `immutable, s-maxage=31536000` change meaning.
- **The preview-settings comment says the CORS proxy forwards headers verbatim;
  it strips `authorization`**, so an app that authenticates works on a frame and
  silently 401s in the browser preview.

### Low

- No per-account render concurrency: two global slots with an 8-deep queue and
  30 s renders, against a 60/15 min per-account limit.
- `POST /api/scenes/render` and the lint route have no Origin/CSRF check (safe
  today only via `SameSite=Lax`).
- The zip-bomb bound relies on fflate's declared `originalSize`, which a crafted
  local header can understate; the real bound is Node memory.
- `scene-images.ts` caches the transparency verdict on `frame:id:scene:length`,
  so a replaced snapshot of equal length keeps the old verdict.
- Deleting a scene is a bare `window.confirm` although versions are otherwise
  immutable and yankable.

---

## 3. Cloud — the AI

### Medium

- **`get_store_scene` "installed on your frame" reads the latest non-yanked
  version, not the pinned one** (`tools.ts:1743-1790`), so a scene made private
  after install leaks its new versions to the installer's chat.
- **No byte cap on what one assistant message persists**: delivered scenes and
  proposals go whole into `ai_chat_messages.payload`, capped only by count.
- **Race on the per-account active-turn cap** — the count is checked long before
  `startTurn` registers the turn.
- **App chat is invisible to LLM telemetry**, so the meter-vs-PostHog reconcile
  is blind to that surface.

### Low

- `get_frame` hands the model device-written `last_state` / `last_metrics`
  outside the untrusted frame.
- Deleting or evicting a chat while its turn runs ends the turn with an FK error
  rather than a clean stop; chats never get a title; `messageCount` keeps growing
  after messages are trimmed.
- `turn` is referenced inside `onRound` before its `const` initialiser returns —
  works only because the first round follows an await.
- The relay's `maxDuration` (10 min) is shorter than the turn ceiling (15 min),
  and the client's resume budget is ~18 s for a failure that can last minutes.

---

## 4. Cloud — billing and ledger

The four §9.2 audit items in `cloud/docs/accounting-todo.md` were verified as
genuinely fixed (surface spoof, gap billing, cap off-by-overdraft, cascade FK).
Nothing here is critical.

- **[medium] A personal API token can subscribe an account to a paid plan** —
  `app/api/account/plan/route.ts:100-132` gates on `readSession()` only, and
  `setAccountPlan` charges the first period immediately. Dormant until
  `FRAMEOS_CLOUD_PLANS_SELF_SERVE` is flipped.
- **[medium] Reversing a `subscription_*` journal entry desynchronises
  `subscription_periods`** — only `ai_usage_charge` is fixed up, so the nightly
  invariant then fires every night. Reversing a reversal is also accepted.
- **[medium] Subscription mutations are not serialised**: select → upsert →
  charge outside any transaction or row lock, so a double-submitted PUT can open
  and charge two overlapping periods.
- **[low]** Admin billing routes 500 instead of 400 on malformed uuids;
  anniversary drift clamps a 31st subscription to the 28th forever;
  `/api/account/usage` reports the wrong cap for shared-key accounts; the
  unposted-usage sweep re-includes permanently failing rows and can stall; a
  pending downgrade to a deleted plan is silently ignored; the nightly script
  posts revenue figures in the healthchecks ping body; the settings form takes
  micro-dollars with no dollar preview.

---

## 5. Cloud — MCP server and the Nim→JS converter

**No authorisation escalation found**: the MCP package holds no authz logic, every
tool is one or two documented HTTP calls, and the REST routes remain the trust
boundary. The problems are the confirm gate and cost.

- **[medium] MCP scene import reads the whole remote body before the 8 MB check,
  with no timeout** (`tools/scene-source.ts:193-205`); the converter route parses
  an unbounded body because it uses raw `request.json()`.
- **[medium] Still open from `docs/security-todo.md` (verified):** the converter
  has no parser depth cap, so `"(".repeat(1e6)` is a `RangeError` → 500, and
  `uniqueName` is quadratic.
- **[low]** The error-hint table has no entry for the codes the tools hit most
  (`invalid_frame`, `scene_pulled`, `insufficient_scope`, the AI 402s); `- -x`
  emits `--x`; `let` shadowing an argument produces a TDZ error; the stdio server
  caches `repository.json` for 5 minutes so a scene created in the same session
  does not resolve; `frame_logs` pulls every stored line and filters client-side;
  the anonymous key-validity oracle distinguishes `invalid_openai_key` from other
  failures.

---

## 6. Cloud — device plane (hub, enrollment, device routes)

**No cross-account or cross-frame IDOR was found**: every owner route resolves
through `frameForAccount`, every device route pins the bearer to the path frame,
and command, backup and asset ids are frame- or account-bound.

### High

### Medium

- **`frameWsUrl` in the enroll route lacks the production gate** the SPA route
  has, so behind nginx it hands devices `ws://localhost:3100`. Masked only
  because the Nim runtime ignores the field and the ESP32 refuses a loopback one.
- **`device/revoke` and `backends/unlink` leave `frames.status = 'active'`** — no
  queue expiry, no notify — unlike `revokeFrame`.
- **Pending frames can still write the frame row**: `isConfirmedFrame` guards
  four handlers, but `state`, `scene_ack`, `sleep`, `render` and the hello-time
  writes run regardless, contradicting the comment on that helper.
- **Oldest-code eviction can delete a bound rescue token already on an SD card**
  (`frames.ts:1777-1791`); the comment protecting multi-use codes applies equally.
- **Sweeps are not re-entrancy guarded** and cost ~5 queries per connected device
  every 30 s; `expireStaleCommands` has no usable index.
- **Scope changes never reach a live session** — the hub re-reads the link row
  every 30 s but looks only at `revoked_at`.
- **The OTA manifest always serves latest and never checks the device-chosen
  `platform` against `frame.hardware`.** The `auto_update` channel work is on the
  unmerged `auto-update-toggle` branch (PR #457), not on `main` (verified).

### Low

- Replayed enrollment reports mint-time scopes, not current ones; Flow-B first
  enrollment races itself into a 500; asset reply streams (4 × 8 MiB) are never
  timed out; the log broadcast re-selects rows a cull may have deleted; a
  too-large command payload closes every socket and is redelivered forever.
- Read-only API tokens still enqueue device commands through GETs; `/asset`
  long-polls 25 s for offline frames; `normalizeAssetPath` is duplicated and the
  copy on the read path lost its control-character check; `scene_images` POST
  accepts any scene id and 32 junk posts evict every real snapshot.
- Font sync ignores `request.signal` and keeps pushing ~53 MB after the tab
  closes; backup quota is read-then-insert; `/command set_current_scene` forwards
  a store uuid verbatim while `/event/setCurrentScene` translates it.

---

## 7. Cloud — database, ops scripts, deployment

- **[medium] `DATABASE_URL` with the password goes on a command line in every ops
  script**, which defeats the deploy script's own 0600-file precaution
  (`ops/deploy/frameos-cloud-update:405-436` vs `scripts/db-migrate.sh`,
  `db-cleanup.sh`, `pg-backup.sh`, `grant-superadmin.sh`,
  `accounting-service-account.sh`, `object-store-sweep.sh`). Pass it in the
  environment; `accounting-nightly.sh` already shows the right pattern for the
  bearer.
- **[medium] Every device log batch runs an account-wide `SUM(size_bytes)` over
  `frame_logs`** inside the insert transaction, on an index that does not cover
  the column.
- **[medium] The 30 s command sweep is a sequential scan** — the only index leads
  with `frame_id`. Add a partial index on `expires_at` where status is pending or
  sent.
- **[medium] `db-cleanup.sh` silently caps frame-log retention at 7 days**, is not
  described that way in the runbook, and ships no timer, so whether production
  runs it at all is unverifiable from the repo. `frame_metrics` is never aged.
- **[low]** `grant-superadmin.sh` matches on the unverified email snapshot the
  schema says never to use for lookup; the accounting job token has no expiry;
  `password_reset_tokens` and `email_verification_tokens` only grow; several FK
  columns with ON DELETE actions are unindexed; schema.ts is missing indexes that
  exist only in SQL, so a first `drizzle-kit generate` would drop them;
  `--rollback` is a toggle, not a stack; the restore drill never asserts on frame
  tables; the hub unit lacks `Requires=postgresql.service`.

---

## 8. Self-hosted backend — request layer

### Medium

- **The Terminal panel is dead under Home Assistant ingress** — `ws/terminal_ws.py`
  requires a session cookie that never exists in ingress mode, while `/ws`
  special-cases it. The user sees "connection closed" with no reason.
- **`FrameBase` drops `ssh_host_key`, `ssh_host_key_fingerprint`,
  `compiled_scene_count` and `project_id`**, so the TOFU fingerprint
  `docs/security-todo.md` says is shown is absent on a fresh page load. Same
  class as the uncommitted `secret_fingerprints` fix, which is correct.
- **Unlinking a cloud identity can lock a password-less user out** — refuse while
  `password` is empty.
- **The drive-image proxy and `…/asset?mode=image` serve SVG and HTML inline from
  the backend origin** with only `nosniff` — stored XSS from a project member's
  upload.
- **HA sync republishes device discovery from partial `update_frame` payloads**,
  renaming the device "Frame N" with a retained null status.
- **`GET /deploy_plan` mutates the frame row** through
  `_sync_frame_mode_with_detected_distro`.
- **`GET /settings` returns every secret in clear and `POST` accepts any key**
  (`extra='allow'`).
- **Unbounded request bodies** on image upload, multipart assets, chunked upload,
  import, preview-proxy and scene images (which PIL-decodes twice on the event
  loop); **event-loop-blocking sync work** in `validate_js_source` (30 s
  subprocess, plus a 600 s Nim compile under a lock), `validate_nim` (no timeout),
  RSA keygen and thumbnail decode; **unbounded queries** in full-log download,
  reboot markers on every metrics GET, and the assets listing which loads every
  blob to call `len()`.
- **`POST /log` commits junk rows before validating shape** — `log`/`logs` are
  typed `Any` and the assert that follows is stripped under `-O`.
- **Device-facing:** `/api/log` writes untyped `width`/`color` onto the frame row;
  the adoption target and `server_host` are not policy-checked before being
  written into the device; the render queue for `/embedded/render` and
  `/virtual/image` has unbounded waiters; the ESP32 settings pull hard-codes four
  service groups although `get_frame_json` already computed the granted set; the
  virtual-frame docstring names the wrong revocation lever.

### Low / nits

Case-sensitive login lookup against a case-insensitive lockout; first-signup
race; the Remote websocket lets malformed frames raise out and shares a
per-second nonce; `MAX_REMOTES` checked before authentication; sqlite-only column
widths (`user.password` is `String(128)` against a ~162-char scrypt hash — it
would break on Postgres, and nothing documents whether Postgres is supported);
client-supplied `chatId` as a primary key is a cross-project id oracle;
`HTTPException` swallowed into 500 in four places; the bootstrap URL is a
permanent bearer for the full `frame.json`; `get_frame_json` mints an unpersisted
`agentSharedSecret` on every call so Remote can never handshake; dead scoped-token
minting path and a dead `enhance_source` route; the root `Procfile` still starts
flask, huey and vite; `AGENTS.md:70` names routers that no longer exist.

---

## 9. Self-hosted backend — deploy machinery

The shell surface is in good shape: every frame-derived string traced into an SSH
or Remote command is quoted or validated, host-key TOFU is real on both paths,
and release archives are minisign-verified on download and on every cache hit.
The gaps are inbound and in job lifecycle.

- **[medium] `CrossCompiler._safe_extract` is a check-then-extract TOCTOU** with a
  separator-less prefix test, so symlink escapes still work.
- **[medium] The precompiled Buildroot SD image is downloaded, cached forever and
  patched with no integrity check**, and the release workflow's "a signature would
  be decoration" rationale is stale now that the backend and the browser flasher
  fetch it automatically.
- **[medium] ESP32 provisioning derives the scheme from the port alone**, so an
  HTTPS backend on 8443 is provisioned as `http://`.
- **[low]** `run_commands(timeout=…)` is dropped on the SSH path; a duplicate arq
  job id returns `None` and the API still answers Success; GPIO button labels with
  a comma break the console spec; the reboot crontab is unvalidated; the Remote
  shell-upload writes `frame.json` at 0644; task error handling differs by verb;
  the legacy QuickJS fallback downloads an unchecked tarball while a pinned sha256
  sits unused; Modal and build-host credentials are stored in plaintext settings.

---

## 10. Frontend — frames, frame settings, workspace, wrappers

The uncommitted `frameLogic.ts` change is a benign kea-typegen sync and should be
kept; the sibling backend WIP adding `secret_fingerprints` / `settings_fingerprints`
to `FrameBase` is what makes `restoreDeployedSecrets()` work at all. Worth a unit
test pinning the baseline when fingerprints agree.

### Medium

- `deleteFrame` navigates away regardless of `response.ok` and prefix-matches
  frame ids.
- The cloud delete confirmation describes Archive and "all of its scenes", neither
  of which exists on the cloud, and does not say the device demotes to standalone.
- Reboot, Restart and Stop run on one click with no confirmation and no outcome
  feedback; `stopFrame` ignores the response and two others throw from a listener.
- The Wi-Fi PSK is persisted in plaintext `localStorage` on the cloud and POSTed
  into project-wide defaults by default on the backend.
- Login and signup POST ignore `getBasePath()`, which matters as soon as anything
  sets `x-ingress-path`.
- An unknown frame id shows the loading skeleton forever, and the 404 scene in all
  three shells is a bare `<div>404</div>`.
- The tool segment in a frame URL is validated against every panel rather than the
  mode's allow-list, so `/frames/<id>/terminal` on the cloud silently renders the
  overview.
- `FrameSettings.tsx` is 4,297 lines holding forty sections × three mode profiles.
  Reviewing surface gating there by hand is not realistic, which is how the first
  finding survived.

### Low

Export ships every secret and Import `console.log`s them; the hotspot password is
a plain text input; cloud Disconnect has no confirmation; terminology drift
("ESP32" for all embedded modes including virtual and Pico, "Zero W2", `->` vs
`→`, Re-render vs "Render frame now", deploy/install/push/update); the `frame`
subscription deep-compares every scene on every log line; the device catalog is
verified in sync today but hand-maintained with no CI diff; accessible names sit
on SVGs rather than buttons.

---

## 11. Frontend — scene editor

This area was reviewed twice, independently. No XSS was found: the one
`dangerouslySetInnerHTML` (Terminal) escapes correctly, react-markdown runs
without `rehype-raw`, scene JS only ever reaches a Worker as a string, and the
iframe editor's origin lock is real. What both reviews found instead is a cluster
of correctness bugs in editor logics that have **no tests at all**. Findings
marked ✓ were reported independently by both reviewers.

### High

- **Inline source validation is a guaranteed 404 on the cloud.** `editAppLogic`
  and `sceneSourceLogic` POST `/api/apps/validate_source` on every keystroke and
  read `response.json()` with no `ok` check. The cloud has no such route and
  `cloudEmptyCatalogs` only short-circuits an exact GET, while the Apps surface
  *is* enabled on cloud. Result: one unhandled rejection per keystroke, and syntax
  errors that are never shown and never cleared.
- **Undo/redo is an undiscoverable shortcut and half the editing paths break it.**
  `diagramLogic.tsx:1438-1475` has no toolbar or menu entry and no Ctrl+Y; picker
  insertion records two snapshots 200 ms apart so one Cmd+Z leaves a dangling
  node; `updateNodeConfig` never goes through `nodesChanged`; and `undo` clears
  its ignore flag on a `setTimeout(0)`, so any edit in that tick is unrecorded.
  Delete Node has no confirm and relies on exactly this.

### Medium

- **Copy, scene JSON export, template export and store publish carry
  `secret: true` field values in plain text** (`diagramLogic.tsx:1576-1595`,
  `scenesLogic.tsx:1367`, `templatesLogic.tsx:577-623`) although the node UI hides
  them behind `RevealDots`. Verified: neither cloud nor backend publish strips
  them server-side, and no built-in app declares the flag today — so the exposure
  is limited to custom apps, but a user who marks their key secret will assume it
  is not in the zip they publish.
- **Duplicating a scene keeps every node id**, and node ids key the Monaco models
  (`inmemory://code-node/${id}.tsx`). Open the original and the copy and both code
  nodes share one buffer; scene nodes in the copy still point at the original.
- **A non-string `markdown` or `hint` in an app config crashes the diagram.**
  `AppNode.tsx:280,357` pass the value straight to react-markdown 9.1.0, which
  *throws* on non-string children. That config comes from store scenes, imported
  JSON and AI output, so one `"markdown": {"x": 1}` white-screens the editor —
  the exact failure `components/Select.tsx:37-40` already guards against with a
  comment explaining why.
- **Copy works on plain HTTP but paste silently does not.** Copy goes through
  `copy-to-clipboard` (execCommand fallback); paste uses
  `navigator.clipboard.readText()`, undefined outside a secure context — which is
  the default self-hosted deployment over `http://<ip>:8989`. Two other call sites
  use raw `writeText`, an uncaught TypeError there.
- **`openLivePreview` can orphan a wasm worker.** It terminates the old worker,
  then awaits a settings fetch *and* a consent dialog with no `breakpoint()`
  before assigning the new one, so two overlapping opens leave a full runtime
  rendering and holding revealed API keys until the tab closes.
- **Undo covers only `{nodes, edges, apps}`**, so pressing Cmd+Z after deleting a
  state field leaves the field deleted and reverts something unrelated.
- **Asset delete, rename and mkdir fail completely silently** while the same file
  uses toasts for uploads.
- **`<Select>` silently shows the wrong value** when the stored value is not among
  the options.
- **`editCodeField`'s rename branch is dead and wrong** (writes a `codeFields:`
  key that does not exist), `editCodeFieldOutput` has no callers, and the real
  rename path in `CodeNode.tsx:200-214` validates neither empty nor duplicate
  argument names.
- **The embedded editor's SceneJSON save bypasses `sanitizeScene`**, so JSON with
  a node lacking `position` takes reactflow down — the exact crash
  `sanitizeIncomingScenes.ts` exists to prevent inbound.
- **App-source validation in the embed rejects on every keystroke**: the synthetic
  404 returns the body `null`, and the callers destructure it, so every validation
  is an unhandled rejection and errors are never cleared. It also posts `.md`,
  `.json` and `.ts` files to a Nim `nim check` endpoint on every keystroke.
- **`persistUntilClosed` editors are never unmounted** when the workspace goes
  away, and `frameLogic`'s Cmd+S handler uses the `cache` pattern that
  `diagramLogic` documents as unsafe under StrictMode.
- **`deleteSceneAndSave` saves with no task, no toast and no try/catch**, so a
  failure leaves the scene gone from the UI and present on the server.
- **Duplicate state-field codenames are accepted while custom event names are
  checked** (`frameFormSceneErrors.ts:13-27`). Two fields named `city` deploy, the
  second silently wins on the device, and the Control panel renders two identical
  inputs writing one key. Names are validated after `trim()` but stored untrimmed.
- **"Save" means three different things** — SceneJSON and EditApp Save apply to
  the form while the workspace Save persists.
- **The embed's screenshot message posts to `'*'`** and its ack checks neither
  source nor origin, against a protocol comment that promises "never `'*'`"; the
  preview-key consent gate is origin-blind for scenes arriving over postMessage.
  Contained today by `frame-ancestors 'self'` and the no-backend build.

### Low

Boolean node fields compare `== 'true'` so a real boolean default renders
unchecked and needs two clicks to agree with the runtime; `addFile` overwrites an
existing file with no check; paste fails silently and validates nothing; the
picker insertion has a 200 ms stale-edge window; the Select-option textarea cannot
express a `|`; `updateSceneFromRepo` overwrites the user's field values; 22
blocking `alert`/`confirm`/`prompt` sites sit next to the toast system the save
paths use; Markdown links get `target=_blank` without `rel`, and app-supplied
markdown can fetch a tracking pixel from any host; Monaco URIs and font CSS
interpolate unencoded scene-supplied names; three different object-URL revocation
conventions; icon-only buttons and node handles have no accessible name; 68 `any`
annotations, including `frameId`/`sceneId` leaking `any` into every connected
logic.

### Tests

The editor's core logic has **zero** unit tests — `frontend/package.json` has no
test runner and there are no `*.test.*` files under `frontend/src`. The only
coverage is the cloud's shared-spa suite. Untested: `diagramLogic` (history,
copy/paste, `hasChanges`), `appNodeLogic`, the 300-line picker insertion listener,
`utils/duplicateScenes.ts` (the `remapSceneIds` bug is a one-line test),
`selectOptions` round-trips, `sceneJSONLogic`, `sceneStateLogic`. Most are pure
functions or logics the embed shim already builds headlessly.

---

## 12. Nim device runtime core

The designed security machinery is excellent and matches its documentation — the
privileged door, OTA signing, the no-follow ownership model, the HTTP client's
SSRF/redirect/TLS handling and the local-presence ceremony are all genuinely well
built, and no way through any of them was found. The problems are in the plumbing
around it. A full authz matrix for the on-device HTTP API is in the reviewer's
notes and confirms the lane `docs/security-todo.md` says "did not complete".

### Medium

- **DNS-rebinding bypass for the process-spawning apps**: the guard resolves and
  classifies the host, then hands the raw hostname to Chromium and ffmpeg, which
  resolve again independently.
- **A minimal `POST /setup` silently orphans the frame from its backend** — the
  default `controlMode` branch clears `serverHost` and the pending claim.
- **`wpa_supplicant.conf` and `hostapd.conf` are written world-readable and then
  chmod'ed**, with the plaintext passphrase in the window; `writeFileAtomically`
  already exists and does it correctly.
- **The timezone update inflates a gzip bomb before checking the size**, on a
  config-settable URL with no publisher signature.
- **`masked()` leaks the first two characters and the exact length** of the
  Wi-Fi PSK, admin password and claim token into logs that leave the device.
- **`writeTextFileAtomically` removes the target before the rename**, so a crash
  in that window leaves no `frame.json` plus a predictably-named `.tmp` holding
  every secret.
- **A `ValueError` in one metrics probe discards the whole sample.**
- **`/api/cloud/login/start` is unauthenticated and builds `redirect_uri` from the
  `Host` header** when `local_origin` is unset — which is the case for every
  claim-token-enrolled frame, since only `device_flow.nim` records it. Verified on
  the cloud side: `app/api/frameos/login/start/route.ts:52` pins `redirect_uri` to
  the linked client's `local_origin` and refuses when it is null, so this is
  defence-in-depth rather than an exploit — **but it also means "Sign in with
  FrameOS Cloud" on a claim-token-enrolled frame always fails with
  `invalid_redirect_uri`.** Record `local_origin` during claim-token enrollment
  and stop deriving the redirect from `Host`.
- **The server-side asset guard is lexical only** and does not resolve symlinks,
  while the JS runtime's guard fixed exactly that and says so in a comment.
- **The cloud store fetch is unbounded**, uses the plain stdlib client, holds the
  body in a process global and re-parses it per request with no single-flight.
- **`settings` is copied back into the "masked" frame payload** — dead today
  because both branches pass the same admin check, but whoever wires the
  non-admin reader ships a key leak.
- Threadpool `spawn` hands shared refs to another thread; the process wrapper's
  defaults are "wait forever, buffer unbounded" and its deadlines use wall-clock
  time on a device that steps its clock during setup.

### Low / nits

A NUL byte defeats the "not the assets root" guard, so `path=%00` on the admin
delete route wipes the whole assets tree; the Samba mount target is unconstrained
(backend-owned config only, hence low); a failed `pvSetHostname` door call is
discarded and setup still reports success; the logger drains one message per
wakeup while its channel overflows and the drop counter is never reset when
remote logging is off; the log file has no cap when the path has no `{date}`;
local chunked uploads leak `.part` files the sweep does not match and have no
cumulative cap; the thumbnail cache keys on the path string, not the content, so
a replaced image shows the old thumbnail forever; there is no Origin or Host
check on any state-changing route, leaving DNS rebinding open; raw OS error
strings with absolute paths are returned to callers.

---

## 13. Nim apps, drivers, image pipeline, wasm, Remote

### High

### Medium

- **`data/beRecycle` cannot work for any street name containing a space** — the
  URL is built without encoding and the runtime's own validator rejects it; the
  tests bypass the path through a hook.
- **`chromiumScreenshot` writes and executes a Python script under predictable
  `/tmp` names** (`rand` without `randomize()`), and the root unit sets neither
  `PrivateTmp` nor `ProtectSystem`.
- **The spawn guard validates only the first URL**, and Chromium and ffmpeg then
  follow redirects and sub-resources; ffmpeg gets no `-protocol_whitelist`.
- **Chromium runs untrusted pages with `--no-sandbox`**, as root on personalised
  images.
- **`rstpSnapshot` lets the scene pick an unbounded ffmpeg timeout**, so a dead
  camera parks the render thread until the 900 s watchdog restarts the frame.
- **The `httpUpload` driver uses the stdlib client for https and a hand-rolled
  reader for http**, neither bounded the way the runtime's own client is, and
  copies header values in with no CRLF check.
- **The Remote `shell` verb blocks the async loop with no timeout** and uses raw
  `osproc`, which the runtime forbids.
- **`vendor/inkyHyperPixel2r` is dead but still installed and synced** on every
  HyperPixel deploy.

### Low

`render/calendar` divides by a scene-supplied
`eventColorCount`; several apps interpolate query parameters without encoding;
`data/immich` takes a file extension unsanitised from `originalFileName`;
`openaiText` logs full prompts and writes errors to an undeclared state key;
`beRecycle` ships a scraped third-party secret; the 12.48" HAL still `popen`s
`cat /proc/cpuinfo` after the main HAL removed it for a documented deadlock; the
busy-timeout budget can exceed the watchdog; the prebuilt-dependency installer
skips verification for multipart ETag-shaped hashes; the wasm preview allows sync
XHR from scene code to private hosts.

### Test coverage

Every app has a unit-test directory. The e2e snapshot harness covers the seven
renderers plus five data apps and two logic apps; **not covered**:
`render/calendar`, `render/chart`, `render/zoomPan`, and eighteen data apps
including `clock`, `parseJson`, `xmlToJson`, `prettyJson`, `icalJson` and
`eventsToAgenda` — all deterministic enough to snapshot against fixtures. The
`frameos-editor` embed test does not cover the origin filter, which is the whole
point of that code.

---

## 14. Embedded firmware — ESP32 and Pico

Careful, defensive C. Path sanitisation, the netguard, the contract walker, the
power and battery logic and the verify-before-switch OTA are all correct as far
as they can be traced. The findings are parity gaps, authenticated-peer DoS, one
privacy gap and doc drift.

### Medium

- **The local HTTP chunked upload has no total-size or part-count cap** while the
  cloud path has 64 MB; an authenticated LAN client fills the card.
- **The OTA rollback window is "reached Wi-Fi", not "reached rendering"** — a
  release that crashes in Nim or scene init is marked valid and boot-loops, while
  any non-Wi-Fi reset rolls a good update back.
- **The UART console has no flow control and runs at priority 2**, so a
  `usb_api upload-scenes` during a render loses bytes on CH340-only boards, and
  the fixed 180 s timeout cannot carry the 32 MB layout's 4 MB cap at 115200 baud.

### Low

`require_protected_access` decides "on the hotspot" by peer IP range rather than
interface; `/api/setup` skips the panel and `assets_path` validation the console
does; cloud and backend OTA share no mutex; a too-long provisioning line runs its
tail as a command; the asset job queue sits in scarce internal RAM;
`wake_schedule` aligns to UTC not local time; the status JSON reports retired OTA
fields; Wi-Fi accepts WPA1 and mixed mode; `usb_api upload-asset` / `asset-op` /
`get-asset` are implemented but nothing calls them.

### Pico

The Pico does authenticate the server for https (root bundle plus SNI hostname
check, with a build-time validity floor), so the open question is answered — but
`pk_http.h:9-11` still says v1 is http-only, there is no chunked
transfer-encoding handling, an SSID with spaces cannot be provisioned, and a
15–59 s interval rounds to zero minutes.

### Tests

The IDF-free security-relevant code has no host tests although eight sibling
modules do: `fos_assets_sanitize_path` / `sanitize_write_path` (the traversal
boundary for every asset verb), `host_is_local` / `url_transport_ok` /
`ws_url_matches_provider`, `parse_minisig` / `url_origin` /
`download_url_is_first_party`, the config parsers, and schedule catch-up.

---

## 15. CI, build, release, repo hygiene

Repo hygiene itself is clean: no untracked clutter (everything at the root is
gitignored), no private keys, no token literals in tracked files, no
`pull_request_target`, no `set -x`, no secret echoed to a log. Every lockfile
version spot-checked is current, and every `pnpm-workspace.yaml` security-floor
override resolves. The problems are in the release chain.

### High

### Medium

- **The backend has no lint or typecheck gate in CI.** `ruff` and `mypy` appear
  nowhere in `.github/workflows/`; the only Python gate is an opt-in pre-commit
  config pinned at ruff v0.1.14 (January 2024) and pre-commit-hooks v2.3.0
  (2019). The cloud half has a real `turbo run lint typecheck` gate, so the two
  halves are held to very different standards.
- **Two workflows ship no `permissions:` block at all** — `frameos-cross.yml`
  (none anywhere) and `e2e-docker.yml`'s `docker_image` (the job that builds and
  runs the PR's Dockerfile) and `build-and-test`.
- **Both signing steps `pip install cryptography==50.0.0` unhashed from PyPI on
  the one runner where the firmware signing key exists in cleartext.** Everything
  else about that flow is careful, which makes this the weak link; there is no
  revocation path because the public key is compiled into firmware.
- **`npm-publish.yml` extracts an arbitrary run's artifact and publishes it to
  npm** — `runtime_run_id` is a free-form input, nothing verifies the `.minisig`
  the release attaches, and nothing checks the run was a release run.
- **Docker toolchain digest pinning degrades to the mutable `:latest` tag**
  whenever the pinned digest is not cached locally
  (`cross_compile.py:1025-1075`), and `workflow_dispatch` publishes do not commit
  refreshed digests, so the digest file goes stale silently.
- **`metrics-lock` and `metrics-uuid` are tracked at the root**, referenced by
  nothing since the nix removal — the latter is a persisted installation
  identifier now published in a public repo.
- **pnpm is pinned three ways that disagree**: flox 10.33.2, `packageManager`
  10.27.0, and a hard-coded 10.27.0 in five CI jobs.
- **`README.md:83` breaks the first Docker command a new user copies** — a
  backslash followed by a space, so the line continuation does not continue.
- **The customer-facing AI serves `docs/security-todo.md` verbatim.**
  `generate-ai-context.mjs:175-196` sweeps every `docs/*.md` except `todo.md` into
  the AI's `search_docs` / `read_doc` tools; the committed context contains
  `security-todo.md`, `cloud-security-review.md`, `deployment.md`, `backups.md`
  and `operational-runbooks.md`. The repo is public so it is not a leak, but it
  turns "the open-vulnerability list is findable" into "the product recites it on
  request". `read_repo_file` has an allowlist; this has an exclude-list of one.

### Low / nits

`actions/checkout@v2` and `setup-python@v2` in seven places alongside v4/v6;
`.github/actionlint.yaml` declares six dead `depot-*` labels, omits the live
`epyc-*` ones, and nothing runs actionlint; an unpinned `emsdk` clone in an
otherwise admirably hash-pinned Dockerfile; the runtime image runs as root and
ships a full build toolchain; `CONTRIBUTING.md` documents `frameos/Dockerfile`,
`frameos/test.py` and a `--privileged` recipe the README contradicts;
`ai-context.json` (1.3 MB) is regenerated on every build yet tracked, so it
reappears in every unrelated diff; `frameos-setup.sh` pins a release nine versions
stale; `requirements.txt` has no `--hash` lines; `backend-docker.sh` truncates
`.env.docker.local` with `>` and leaves it 0644; `config.py` appends to `.env`
with no leading newline; R2 write credentials are exposed to the shared-cache
self-hosted runner pool; `turbo.json` uses `envMode: "loose"`.

---

## 16. Docs drift and cross-plane parity

The good news first: **the contract fixtures really are run by all three
walkers** — the Nim test suite, an ESP32 host build compiled and run in
`e2e-docker.yml:160-167`, and the cloud's vitest, with a fourth guard asserting
the generated tables are not stale. The parity claim in `docs/convergence-todo.md`
item 6 was recounted and is accurate: 23 settings keys, 8 both / 8 linux /
7 esp32, and all 15 single-plane keys carry `parity: {only, why}`. The generated
contract feeding four tables, three walkers and one fixture corpus is the
strongest discipline in the repo, and it had not drifted.

The parity *matrix* is a different story.

### High

- **The README promises the source-build path dies "one release after the
  converter shipped (2026-08-30)"** while `convergence-todo.md` and `todo.md` say
  "not before October 2026, possibly never". We are eleven releases past, so the
  README reads as a broken promise to the user deciding whether to convert.
  `docs/legacy-source-builds.md` also cross-references a "Stage 5" that belongs to
  a different item.
- **Two contract verbs no provider ever sends.** `get_state` and `get_logs` are
  implemented and fixture-tested on both device planes but issued by nothing on
  the cloud. `get_logs` replays the ESP32's on-device 128-line ring — exactly the
  data users get nothing of when their telemetry grant post-dates the frame — and
  `get_state` is the per-scene state the cloud workspace currently fakes as `{}`.
  Verbs have no `parity: {only, why}` field the way settings keys do, so nothing
  catches this.

### Medium

- **Both "complete" permission-scope tables omit `frame:managed` and
  `settings:services`** — the base scope of every cloud-managed frame and the
  service-key grant the whole store-scene flow hangs on. The code has 15 scopes,
  the tables list 11–13, and the docs explicitly invite reimplementation of the
  protocol.
- **`cloud/README.md`'s Layout omits `packages/{ledger,mcp,scene-convert}`**,
  including `mcp` which the same README documents four bullets earlier; it also
  still says sharing the full frontend "is the next step" (shipped) and that there
  is "no quota enforcement beyond fixed caps" (plan quotas enforce at enrolment).
- **`AGENTS.md` and `CONTRIBUTING.md` describe an mprocs layout that does not
  exist**: there is no frame-frontend pane, `redis` and `postgres` *do* autostart
  where the docs say they do not, and `postgres`, `wasm`, `cloud-hub` and
  `migrate` are undocumented — `wasm` runs a Nim/emscripten build on every
  `pnpm dev`.
- **`CONTRIBUTING.md`'s on-frame Docker command runs `frameos/test.py`**, which
  does not exist, builds one tag and runs another, and frames the runtime as
  Python.
- **`cloud/docs/cloud-frames.md` still lists signed OTA as remaining work**; it
  shipped 2026-08-13.
- **`AGENTS.md` points the runtime at `frameos/frameos`**, an untracked build
  directory, and cites a 6-line entry point that is now a ~140-line CLI whose
  `--version` behaviour has already bitten a release.

### Low

One user action has five names across four surfaces — **install** (MCP and store),
**add** (SPA button and cloud route), **assign** (data model and MCP docs),
**deploy** (SPA status copy) and **push** (`cloud-frames.md`); the MCP description
papers over it in one sentence, which is itself the evidence. Similarly the clean
URL says `/backends`, the app route says `installs`, the nav label says
"Backends", the design doc says "install", and the schema has both
`connected_backends` and `linked_clients`. `e2e/README.md` is six lines and never
mentions the Playwright visual suite, although `AGENTS.md` sends agents to that
README and the "never run these, never commit these snapshots" rules live only in
`AGENTS.md`.

---

## Test gaps worth closing

- No test asserts that a websocket broadcast is secret-free — it would have caught
  both backend leaks (§8).
- No test that a private flip stops foreign frames receiving new versions, that
  unbound image uploads are reclaimed, or that content/fork refuse compiled
  scenes (§2).
- No hub test for a pending frame sending `state`, for metrics flooding, for an
  asset stream that never finishes, or for the `ws_url` production case (§6).
- No test for `filter="data"` refusal of a symlink member in the two unfiltered
  extract paths, nor for the stuck-`deploying` branch or `CancelledError` (§9).
- No host tests for the ESP32's path sanitisers, transport rules or minisig
  parser, all of which are IDF-free (§14).
- The e2e snapshot harness covers 14 of ~35 built-in apps (§13).
- Nothing in the backend suite runs against Postgres, and several column widths
  would fail there.
- The scene editor has no test runner at all; `remapSceneIds` and
  `sceneStateLogic.removeField` would each have been a one-line test (§11).
- No test pins `_next_calver` monotonicity, and no CI job runs `ruff` or `mypy`
  over the backend (§15).
- No test pins `frameos-setup.sh`'s default release version to `versions.json`,
  the way `test_release_signing.py` pins the signing key to `ota_pubkey.nim` (§15).

---

## What is good, and worth not breaking

- **The privileged door** (`frameos/src/frameos/privileged.nim`) is exemplary:
  enum verbs only, arguments validated by the same function on both sides,
  nothing from a request reaching a shell, and root never following the runtime's
  links. No way through it was found.
- **OTA is signed the whole way on both planes** and bound to more than the bytes
  — the device re-verifies as root against a root-owned copy, refuses downgrades
  against the worker binary's compiled version, and the ESP32 verifies before
  `esp_ota_end`.
- **Router-level auth in the backend is structural**, and no cross-project read or
  write path was found in any module.
- **No cross-account or cross-frame IDOR was found anywhere in the cloud device
  plane**, and the command queue is honest about at-least-once delivery.
- **The runtime's HTTP client** resolves once and connects to the literal, which
  defeats DNS rebinding, strips credential headers across origins, and ties the
  redirect budget to the render deadline.
- **The accounting kernel** is one writer, one transaction, one idempotency key,
  with append-only enforced by Postgres triggers and all money in bigint
  micro-USD.
- **`workspaceSurfaces`** allow-lists per control plane and disables with a
  reason rather than hiding, and is unit-tested from the cloud's node suite.
- **The fingerprint-based deploy baseline** (`frame_secrets.py` plus
  `frameSecrets.ts`) shows pending changes without ever shipping a secret.
- **Blue/green cloud deploys**: health-gated flip, migrations before the flip,
  atomic symlinks, encrypted backups with a restore drill that asserts.
- **The ESP32 netguard and path sanitiser**, and the contract-driven
  `set_settings` walker that is fixture-tested in CI.
- **Shell composition discipline in the backend**: every frame-derived value
  traced into a command is quoted or validated, and the first-boot script is pure
  POSIX sh with `printf '%s'` and `install -m 600`.
- **The generated cloud verb contract** feeding four tables, three walkers and one
  fixture corpus, all actually run in CI, with single-plane settings keys carrying
  a `parity: {only, why}` field. It had not drifted. Extend the same field to
  verbs.
- **The `cloud-ci.yml` deploy job**: SHA-pinned actions with the reason written
  down, the key written only after all third-party code has run, pinned host keys,
  and a stand-down when `main` moved on. Nearly every comment records the incident
  that produced the line under it.
- **Fork PRs are kept off the self-hosted runner pool** by an explicit check on
  all four jobs, with the shared-cache reasoning spelled out at each one.
- **pnpm 10 with an empty build-script allowlist**, so dependency postinstall
  scripts are refused across the whole workspace.
- **`utils/keaSubscriptions.ts`** is imported at every subscription site, closing
  the StrictMode stale-subscription trap, with a regression test.

---

## Open questions for whoever picks this up

1. Is Postgres a supported `DATABASE_URL` for the self-hosted backend? Several
   column widths would break there and nothing documents it either way.
3. Is `FRAME_HUB_PUBLIC_URL` set in the production `auth-web.env`? It decides
   whether devices are being handed `ws://localhost:3100` today.
4. What is `client_max_body_size` on the production nginx? Several body-size
   findings depend on it and nothing in the repo states it.
5. Is `db-cleanup.sh` scheduled in production, and with what retention? It
   silently caps frame logs at seven days and ships no timer.
6. Is `FRAMEOS_AI_SHARED_KEY_ACCESS=all` in production? If so the aborted-round
   metering gap is a live free-tier leak rather than a Phase-3 concern.
7. Does R2 log request headers for `cloud-cdn.frameos.net`? That decides whether
   the parent-domain session cookie is a live leak into a third party's logs.
8. Was the `exposeSecrets = false` branch of `frameApiPayload` meant to serve a
   frame-access-key viewer? It is dead today and would ship service keys if wired.
9. Does the ESP32 build use `--panics:on`? It decides whether a Defect in scene
   code is caught by the interpreter or takes the board down.
11. Does `ACTIONS_WRITE_TOKEN` have scope beyond the Home Assistant add-on repo?
    If it is a classic PAT, the unpinned action's blast radius is the account.
12. Is serving `docs/security-todo.md` through the customer-facing AI a deliberate
    choice? The repo is public, so it is a posture question, not a leak.
13. Is scene order in `scenes.json` load-bearing on the device (the ESP32 split
    index, schedule fallback, "next scene")? If so, the sorted-view mutation bug
    in §11 changes device behaviour after a Save, not just the diff.
