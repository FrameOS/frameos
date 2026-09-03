# Deployment Notes

The deployment is two processes: the web/API process from `apps/auth-web`
and the frame hub WebSocket service from `apps/frame-hub` (see "Frame hub"
below). Background workers should be added only when email, webhooks,
cleanup, or sync jobs need separate execution.

## Required Runtime

- Node.js 22.
- pnpm workspace install.
- Postgres.
- HTTPS public URL for OAuth callbacks.
- Secret manager for `.env.local` values.

## Hard Constraints

- **One auth-web instance at a time.** Nothing in `apps/auth-web` requires it
  any more — rate limiting is backed by Postgres (`src/lib/rate-limit.ts`), and
  the remaining module-level state is caches — but the deployment is sized and
  configured for one process, and a deploy briefly overlaps two (see
  "Updating Production"). Running two permanently is untested; the overlap is
  seconds long and only doubles cache memory and the in-memory rate-limit
  fallback that a database outage would fall back to.
- **The frame hub is genuinely single instance.** It resets the `connected`
  flag of every frame on boot, so a second hub marks live frames offline. It
  is deliberately not blue/green — it restarts in place and frames reconnect.
- **Database TLS.** `postgres.js` defaults to no TLS. If Postgres is not on
  the same host, encrypt the connection — and know what each mode buys:
  - `DATABASE_SSL=require` (or `sslmode=require` in `DATABASE_URL`) encrypts
    the connection but **does not verify the server certificate**
    (`postgres.js` sets `rejectUnauthorized: false` for `require`, `allow`
    and `prefer`). It stops passive sniffing, not an active man in the
    middle. Only acceptable on a private network you control end to end.
  - `sslmode=verify-full` in `DATABASE_URL` verifies the certificate chain
    against the system trust store **and** that it matches the host name.
    Use it whenever the database is reached over a network you do not own
    (managed Postgres, a separate VPS). The server certificate must be
    signed by a CA the Node process trusts (a public CA, or one added via
    `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` in the env file). Leave
    `DATABASE_SSL` unset when you do this: the variable takes precedence
    over the URL, and the code only understands `require`/`true` — a
    `DATABASE_SSL=verify-full` is silently ignored, which means no TLS.
- **Periodic cleanup.** Schedule `pnpm db:cleanup` (e.g. daily cron) to prune
  finished device authorization requests, expired login codes, and expired or
  revoked sessions. These tables grow without bound otherwise.
- **Backups.** The host runs `frameos-cloud-backup.timer` nightly (pg_dump +
  host config to a Hetzner Storage Box, healthchecks.io ping). Setup,
  verification, and the restore runbook: [backups.md](backups.md).

## Initial Process

```sh
pnpm --filter @frameos-cloud/auth-web build
pnpm --filter @frameos-cloud/auth-web start
```

## Updating Production

Production runs on a single Hetzner host — set `FRAMEOS_CLOUD_DEPLOY_HOST`
(user@host) and optionally `FRAMEOS_CLOUD_DEPLOY_SSH_KEY`; host specifics live
in the private ops notes. auth-web runs as
`frameos-cloud-auth-web@<port>.service`, a systemd template instance named
after the port it listens on, which starts the Next.js standalone server
(`node cloud/apps/auth-web/server.js`) with env in
`/etc/frameos-cloud/auth-web.env`. The server has no pnpm and does not build.

Deploy the pushed HEAD with:

```sh
pnpm deploy:prod
```

Or deploy any other pushed ref — a branch, tag or commit — by naming it:

```sh
pnpm deploy:prod -- my-branch
```

A bare branch name resolves against the remote first, so this deploys what is
pushed rather than a local branch that happens to share the name. The script
checks that ref out (detached), builds, deploys, and returns you to where you
were, including when the build fails. Production running a branch is a normal
thing here — some frame-facing work can only be exercised against the real
cloud — so the goal is to make it deliberate rather than to prevent it: the
ref is named on the command line, a banner announces any non-default ref
before the build, and the server records what is live. **Redeploy `main` when
you are done.**

The deploy builds locally and ships a self-contained bundle:

1. `turbo run build --filter=@frameos-cloud/auth-web` builds the editor and
   wasm packages as needed, installs the wasm runtime from the pinned
   release (below), and produces `.next/standalone`
   (`output: "standalone"` in `next.config.ts`, traced from the monorepo root
   so pnpm workspace dependencies resolve into the bundle).
2. The script assembles `.next/standalone` + `.next/static` + `public/`
   (including the editor and wasm assets) + `apps/auth-web/scripts/` +
   `packages/db/drizzle/` + `scripts/db-migrate.sh` and `db-cleanup.sh`, and
   streams the tar into `/usr/local/bin/frameos-cloud-update --archive -` on
   the server.
3. `frameos-cloud-update` applies the SQL migrations via `psql` from the new
   release (before anything is flipped, so a failed migration leaves the
   running app untouched), then performs the zero-downtime flip below. Each
   migration file runs in one transaction together with its
   `schema_migrations` row, so a failure part-way through a file leaves the
   schema untouched too and the next deploy simply retries it (see the
   header of `scripts/db-migrate.sh`, including the `-- migrate:
   no-transaction` opt-out for statements Postgres refuses inside a
   transaction).

### Zero-downtime deploys

Until August 2026 the deploy restarted the one auth-web process in place, and
nginx answered 502 for the ten-odd seconds a cold Next.js start takes — every
deploy was a short visible outage. It no longer restarts the process serving
traffic at all.

Two instances exist, `frameos-cloud-auth-web@3000` and
`frameos-cloud-auth-web@3001`, and only one runs at a time. A deploy:

1. starts the new release on the **idle** port,
2. polls `http://127.0.0.1:<idle>/healthz` until it answers 200 — which also
   proves the new process reached Postgres,
3. rewrites `/etc/nginx/conf.d/frameos-cloud-upstream.conf` to point the
   `frameos_cloud_auth_web` upstream at that port and `systemctl reload
nginx` (graceful: in-flight requests finish on the old workers),
4. restarts the frame hub **if, and only if, its bundle changed** — the hub
   is not blue/green (see Hard Constraints), so restarting it drops every
   device socket and frames reconnect on their own, measured at about five
   minutes on 2026-08-15. That was a fair price for a deploy someone chose to
   run and a poor one for a deploy per merge, so the sha256 of the bundle the
   running hub started from is kept in
   `/etc/frameos-cloud/frame-hub-bundle.sha256` and the restart is skipped
   when the incoming bundle matches it. A missing or unreadable hash restarts,
   as does `FRAMEOS_CLOUD_FORCE_HUB_RESTART=1`. So a deploy is invisible to
   the web either way, and invisible to `connected_frames` unless
   `apps/frame-hub` actually changed,
5. drains for `FRAMEOS_CLOUD_DRAIN_SECONDS` (30) and stops the old instance.

If the new release never becomes healthy, or nginx rejects the config,
nothing is flipped and the old instance keeps serving: a bad deploy is a
failed deploy rather than an outage. `pnpm deploy:prod` polls the live site
twice a second for the whole deploy and prints any non-2xx it saw — the
expected count is zero.

Releases are directories rather than an in-place swap:

```text
/opt/frameos-cloud.releases/<sha>-<utc>/   unpacked bundles (last 5 kept)
/opt/frameos-cloud.instances/<port>        symlink: what that instance runs
/opt/frameos-cloud                         symlink -> active release
/opt/frameos-cloud.previous                symlink -> previous release
```

The per-instance symlink is what makes `Restart=always` safe: a crashed
instance comes back on the release it was already running instead of jumping
to whatever became current, and the draining instance keeps reading its own
directory while Next.js lazily loads route chunks out of it. The two
compatibility symlinks keep every documented path working (`cat
/opt/frameos-cloud/RELEASE_REF`, the frame-hub unit, the backup script).

One consequence to keep in mind: during a deploy the **old** code runs
against the **new** schema for a minute or so, so a migration has to stay
backward compatible with the previous release. That was already true (they
ran before the swap); the window is now longer and overlapping rather than
instantaneous.

The server half lives in `ops/deploy/` and is shipped inside the release it
deploys — `frameos-cloud-update` installs the newer copy over itself once the
release is live, so `/usr/local/bin/frameos-cloud-update` on the box equals
the file in this repo. (It used to exist only on the server and in the
backups, which is how the most dangerous script in the deployment stayed out
of review.) Changing the systemd unit is not automatic, since applying it
restarts both instances; rerun the installer when you want it.

Installing this on a host that still restarts in place is a one-time step:

```sh
pnpm deploy:install -- --dry-run   # print every change, touch nothing
pnpm deploy:install
```

The installer rewrites the vhosts' `proxy_pass http://127.0.0.1:3000;` to name
the upstream (backups kept next to each file, gated on `nginx -t`), installs
the templated unit, brings the current release up on the idle port, flips
nginx, and only then disables the legacy `frameos-cloud-auth-web.service` — so
the install itself is zero-downtime too. It prints the old unit next to the
new one first and asks before continuing: anything the old unit had in
`Environment=`, `EnvironmentFile=`, `ReadWritePaths=` or `User=` that the new
one lacks will be lost.

Useful on the box:

```sh
frameos-cloud-update --status       # active port, release, both instances
frameos-cloud-update --release-ref  # just the live ref name, one line
frameos-cloud-update --rollback     # flip back to the previous release
```

Anything that moves traffic (`--archive`, `--rollback`, `--activate`) takes a
lock on `/run/lock/frameos-cloud-update.lock` first and waits up to
`FRAMEOS_CLOUD_LOCK_WAIT` (900s) for it. Deploys used to be one person at one
laptop; now that CI deploys every merge, a manual deploy and an automatic one
can arrive together, and two of them interleaving would race the same idle
port, upstream file and instance symlinks. The read-only commands are not
locked, so `--status` still answers while a deploy runs.

Before changing anything in `ops/deploy/`, run the rehearsal — it exercises
both scripts against a fake host in a container, including the failure paths:

```sh
cloud/ops/deploy/rehearse.sh
```

See [rehearsals.md](rehearsals.md#deploy-rehearsal) for what it does and does
not prove.

The script refuses to deploy a dirty tree, and refuses a commit that is on no
branch of the remote — production has to be a state someone else can check
out, roll forward from, or revert to. (Reachability from the remote, not an
`@{upstream}` test: a detached HEAD and a branch checked out without tracking
both have no upstream and are both perfectly deployable once pushed.)

Two files record the release next to each other on the server:
`/opt/frameos-cloud/RELEASE` is the bare commit SHA, and
`/opt/frameos-cloud/RELEASE_REF` adds the ref name, timestamp and deploying
user — so `cat RELEASE_REF` answers "which branch is prod on?" without
resolving a SHA against a repo you may not have.

It checks the service plus the public URLs afterwards. Override
`FRAMEOS_CLOUD_DEPLOY_HOST`, `FRAMEOS_CLOUD_DEPLOY_SSH_KEY`,
`FRAMEOS_CLOUD_DEPLOY_REMOTE` (default `origin`),
`FRAMEOS_CLOUD_DEPLOY_DEFAULT_BRANCH` (default `main`), or
`FRAMEOS_CLOUD_DEPLOY_CHECK_URL`, `FRAMEOS_ACCOUNT_DEPLOY_CHECK_URL`,
`FRAMEOS_SCENES_DEPLOY_CHECK_URL` if the target changes. The default deployment
health check requires all three public origins to return a 2xx or 3xx response.

To roll back, run `frameos-cloud-update --rollback` on the host. It takes the
same path a deploy does — previous release up on the idle port, health gate,
nginx flip — so a rollback is not an outage either. Database migrations are
not rolled back. The pre-monorepo pnpm-based release is not
startable by the current unit; the cutover-era backups
(`frameos-cloud-update.pre-monorepo`,
`frameos-cloud-auth-web.service.pre-monorepo`) would have to be restored to
run it.

### Automatic deploys

Every merge to `main` that Cloud CI approves is deployed to production
unattended, by the `deploy` job in `.github/workflows/cloud-ci.yml`. It runs
the same `pnpm deploy:prod` a person runs — there is no second deploy path to
keep in sync — so everything above still applies, including that a release
which never answers `/healthz` is a failed deploy rather than an outage.

Which merges count is the workflow's `paths:` filter, and it mirrors the
input closure of `turbo run build --filter=@frameos-cloud/auth-web` — the
shared `frontend/`, the frames SPA in `cloud-frontend/`, `repo/`, and
`versions.json` (the wasm runtime pin, below), not just `cloud/`. The Nim
runtime sources are deliberately absent: they reach the cloud through a
release, never through a merge. A path
missing from that list is not a saved CI run: it is a change that merges,
looks shipped, and never reaches production. Re-derive the closure with
`pnpm exec turbo run build --filter=@frameos-cloud/auth-web --dry=json`
before adding a package or trimming the list.

Releases come in through a second trigger, and they have to. "Release FrameOS"
pushes its `chore: version X` commit with the default `GITHUB_TOKEN`, and
GitHub fires no `push` workflows for commits pushed with that token — so even
though that commit touches paths in the filter above, no run is ever created
for it. 2026.8.23 shipped with the cloud still serving 2026.8.22 for exactly
that reason. (`release: published` would be no better: the release is created
with `github.token` too.) Cloud CI therefore also runs on `workflow_run` when
"Release FrameOS" completes successfully, which is the event the recursion
guard does not suppress — and it lands after the artefacts and images are
published, rather than at the version bump near the start of that run.

On that path the job deploys whatever `origin/main` is when it runs, not the
event's commit, and it verifies that same tip first.

Three things make it stand down instead of deploying:

- **`main` moved on.** Two merges minutes apart both reach the job; the older
  one would deploy older code over newer, so it defers to the tip's own run
  (which is queued behind it on the `frameos-cloud-deploy` concurrency group).
  This one does not apply to a release: the release run pushed the version
  bump itself and left no queued run to defer to, so standing down there would
  mean never deploying a release at all.
- **Production is running a branch.** Deploying a branch here is normal, and
  an automatic deploy must not silently take it away mid-session. The job asks
  the box `frameos-cloud-update --release-ref` and only proceeds when the
  answer is exactly `main`. **Running `pnpm deploy:prod` by hand when you are
  done with the branch is what resumes automatic deploys** — there is no
  separate switch to remember, and the job summary says so on every merge it
  held back.
- **The kill switch.** The job only exists while the repository variable
  `FRAMEOS_CLOUD_AUTO_DEPLOY` is `true`. Set it to anything else to pause
  automatic deploys entirely (Settings → Secrets and variables → Actions →
  Variables); manual deploys are unaffected.

Because it deploys `main` by name, the server records `main` in
`RELEASE_REF`, which is what the branch check reads next time.

One-time setup, in order:

1. **A deploy key that cannot do anything else.** On a machine that is not
   the server:

   ```sh
   ssh-keygen -t ed25519 -C frameos-cloud-ci -f frameos-cloud-ci -N ""
   ```

   Copy `ops/deploy/frameos-cloud-deploy-command` to the box as
   `/usr/local/bin/frameos-cloud-deploy-command` (`chmod 0755`), then
   **append** one line to `/root/.ssh/authorized_keys` — never rewrite that
   file, the keys already in it are how you get in:

   ```text
   command="/usr/local/bin/frameos-cloud-deploy-command",restrict ssh-ed25519 AAAA… frameos-cloud-ci
   ```

   `restrict` disables pty, agent, port and X11 forwarding; `command=` means
   the key can only ask for the four deploy commands, whatever the client
   sends. Verify from your laptop **before** wiring CI, and check that a
   second terminal still has a working root session in case you got it wrong:

   ```sh
   ssh -i frameos-cloud-ci root@<host> frameos-cloud-update --release-ref  # prints the ref
   ssh -i frameos-cloud-ci root@<host>                                     # refused
   ssh -i frameos-cloud-ci root@<host> 'cat /etc/frameos-cloud/auth-web.env'  # refused
   ```

   This does not make the key safe — a key that can deploy can run code on the
   box, which is what a deploy is. It removes the rest: the environment files
   (database URL, session secret, encryption key), the backups, and the SSH
   keys that open the storage box. Rotate it like any other production
   secret. After the first deploy, `frameos-cloud-update` keeps the wrapper
   equal to the copy in the release, the same way it does for itself.

2. **Secrets**, on the `production` environment (Settings → Environments →
   production), so nothing else in the repository can read them:

   | Name                               | Value                                                     |
   | ---------------------------------- | --------------------------------------------------------- |
   | `FRAMEOS_CLOUD_DEPLOY_KEY`         | the private key from step 1                               |
   | `FRAMEOS_CLOUD_DEPLOY_HOST`        | `root@<host>`                                             |
   | `FRAMEOS_CLOUD_DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <host>`, verified against the box |
   | `FRAMEOS_CLOUD_DEPLOY_WEBHOOK_URL` | optional Discord webhook for failed deploys               |

   The host key is pinned rather than learned on first connection: an
   unauthenticated host key means handing the deploy bundle to whoever
   answers the address.

3. **Reachability.** GitHub-hosted runners come from a wide, changing IP
   range. If the box's firewall restricts port 22, either allow the
   [GitHub Actions ranges](https://api.github.com/meta) or run this on a
   self-hosted runner instead — do not open SSH to the world for it.

4. **Set `FRAMEOS_CLOUD_AUTO_DEPLOY=true`** (repository variable) last, once
   the rest is verified.

A failed deploy posts to the webhook if one is configured, and fails visibly
in Actions either way. Production is untouched by a failure before the flip;
`frameos-cloud-update --status` on the box is the source of truth, and
`--rollback` is unchanged. Nothing about the automatic path is required — the
manual one keeps working with the switch off.

## The wasm runtime is a release asset

The interpreter the browser preview, the fleet tiles and the headless
renderer (`src/lib/scene-render.ts`, `POST /api/scenes/render`, MCP
`scene_render`) run is the FrameOS runtime compiled to WebAssembly —
`frameos.js`, `frameos.wasm`, `preview-worker.js`. It used to be compiled
from whatever `main` the deploy checked out, so the preview rendered with
features the frames' firmware did not have yet; one skew shipped a scene that
previewed fine and painted "No image provided" on the panel.

Since 2026-09 the cloud does not build it. Every "Release FrameOS" run
attaches `frameos-<version>-wasm.tar.gz` (the three files plus a
`version.json` stamp) and its `.minisig`, signed with the same key as the
firmware and the Pi release archives. auth-web's prebuild
(`scripts/copy-wasm-assets.mjs` and `copy-editor-assets.mjs`, through
`scripts/lib/wasm-runtime.mjs`) reads the release version from the repo's
`versions.json` (`docker`, the tag's version — the one place the release bump
already updates), downloads that asset once into `node_modules/.cache/`,
verifies the signature against the committed
`release-assets/firmware-signing.pub` on every run, and installs it under
`public/frameos-wasm/` and `public/frameos-editor/frameos-wasm/`. Nothing on
the production box changes: the bundle ships inside the deploy archive as
before.

Consequences worth knowing:

- **A new interpreter feature reaches the preview with the next release**, at
  the same moment it reaches frames. Merging runtime changes to `main` no
  longer moves the preview, and no longer triggers a cloud deploy.
- **Which runtime the preview is** is visible: the bundle answers
  `frameos_wasm_version()`, the preview panel shows "runtime 2026.9.0" next
  to the memory picker, `POST /api/scenes/render` returns `runtime_version`
  in its JSON reply (and an `x-frameos-runtime-version` header on the PNG
  reply). The `version.json` next to the bundle carries the interpreter
  version, the release it belongs to and the commit.
- **Working on the runtime itself**: `FRAMEOS_WASM_SOURCE=local pnpm dev`
  (or `build`) installs the workspace package's own build instead —
  `turbo run build:runtime --filter=frameos-wasm` after `nimble install -d`
  in `frameos/`, needs nim + emscripten. Nothing else changes.
- **A deploy in the window between a release's `chore: version X` commit and
  its assets landing** fails on the download with a message saying so; the
  release's own `workflow_run` deploy follows minutes later, or re-run the
  job. `FRAMEOS_WASM_RELEASE_REPO` points the download at a fork's releases
  for testing.

## Frame hub

The second service in the release is the frame hub
(`cloud/apps/frame-hub`), the WebSocket control plane for cloud-managed
frames (wire contract: `docs/cloud-frames.md` at the repo root). The deploy
script builds it as a single self-contained esbuild bundle
(`cloud/apps/frame-hub/dist/index.cjs` — no `node_modules` needed at
runtime), ships it inside the same release archive, and restarts
`frameos-cloud-frame-hub.service` after the swap (skipped with a notice if
the unit is not installed yet).

One-time host setup — create `/etc/systemd/system/frameos-cloud-frame-hub.service`:

```ini
[Unit]
Description=FrameOS Cloud frame hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Same user/group as frameos-cloud-auth-web@.service.
User=frameos-cloud
Group=frameos-cloud
WorkingDirectory=/opt/frameos-cloud/cloud/apps/frame-hub
ExecStart=/usr/bin/node /opt/frameos-cloud/cloud/apps/frame-hub/dist/index.cjs
EnvironmentFile=/etc/frameos-cloud/frame-hub.env
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/opt/frameos-cloud` in those paths is the symlink to the active release, and
the hub is meant to follow it: unlike auth-web it is not pinned to a release,
because it is restarted on every deploy anyway and only one may ever run.

`/etc/frameos-cloud/frame-hub.env` needs only:

```text
NODE_ENV=production
DATABASE_URL=…           # same database as auth-web
SESSION_SECRET=…         # MUST equal auth-web's, or browser sockets get 401
FRAME_HUB_PORT=3100
```

Optional, both with working defaults:

```text
FRAME_HUB_ALLOWED_ORIGINS=…  # browser WS upgrades; defaults to the three app
                             # origins (FRAMEOS_CLOUD/ACCOUNT/SCENES_APP_URL).
                             # WebSocket handshakes bypass CORS, so this is
                             # what stops a foreign page opening a fleet socket
                             # on a logged-in user's cookie. Set it explicitly
                             # if the SPA is served from another origin.
FRAME_HUB_MAX_CONNECTIONS=5000  # concurrent sockets before upgrades get 503
```

One nginx-specific trap: the hub rate-limits upgrades per client IP, and it
derives that IP the same way auth-web does — via `RATE_LIMIT_TRUSTED_PROXY_COUNT`.
Behind nginx that must count the proxy hops, otherwise every upgrade in the
fleet collapses onto the proxy's own address and the whole fleet shares one
budget.

(`FRAMEOS_CLOUD_ENCRYPTION_KEY` is not needed — the hub only ever compares
hashed tokens.) Then `systemctl daemon-reload && systemctl enable --now
frameos-cloud-frame-hub.service`.

Like auth-web, the hub is **single instance only**: on boot it resets the
`connected` flag of every frame, because a lone hub owns all device sockets.
Connection liveness and the command queue are keyed through Postgres so a
multi-instance hub stays possible later, but do not run two hubs today.

nginx routes only the two WebSocket paths to the hub; every other
`/api/frames/*` route stays on auth-web. Add to each HTTPS server block
(before the catch-all `location /`):

```nginx
# FrameOS frame hub WebSockets (device + browser live updates).
location = /api/frames/ws {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # The hub pings every 30s; anything over a minute of silence is dead.
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
}
# Covers both /api/frames/{id}/updates (one frame) and /api/frames/updates
# (account-wide fleet socket).
location ~ ^/api/frames/([^/]+/)?updates$ {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
}
```

Health check: `curl http://127.0.0.1:3100/healthz` on the host returns
`{"connected_frames": N}`. auth-web has its own `/healthz` on every public
hostname, which returns 200 only after it has actually reached Postgres and
503 otherwise; both the uptime timer and this script's post-deploy check use
it (see docs/operational-runbooks.md).

The public hostnames point at the same process. `cloud.frameos.net` owns
login/auth plus the account, device, admin, and frames pages (root redirects
to `/backends`, the linked-backends home), and `scenes.frameos.net` owns the
public store and scene/publisher pages. “My scenes” is the `/scenes` section
of the account surface. API routes remain reachable on every hostname for
compatibility with linked FrameOS backends — including the legacy
`account.frameos.net`, where nginx keeps `/api/*` and the frame-hub
WebSocket paths proxied but 308-redirects every other path to
`cloud.frameos.net` (the account surface lived there until 2026-08).

Production uses:

```text
FRAMEOS_CLOUD_APP_URL=https://cloud.frameos.net
# FRAMEOS_ACCOUNT_APP_URL is unset: the account surface shares the cloud
# origin and getAccountBaseUrl() falls back to it.
FRAMEOS_SCENES_APP_URL=https://scenes.frameos.net
FRAMEOS_SESSION_COOKIE_DOMAIN=frameos.net
```

`FRAMEOS_WEBAUTHN_RP_ID` is unset in production: passkeys default to the cloud
origin's hostname (`cloud.frameos.net`), which is also where `/login` and
`/account/security` run. Set it to the common parent domain only if those two
surfaces are ever split across subdomains (see `docs/auth.md`).

The cookie domain is required when the two app URLs have different origins.
It must cover both hostnames; startup fails instead of silently producing two
independent logins when it is missing or invalid. Because this gives every
FrameOS subdomain in that cookie domain access to the session cookie, only
trusted services may run beneath `frameos.net`.

Local development uses:

```text
FRAMEOS_CLOUD_APP_URL=http://localhost:3000
FRAMEOS_ACCOUNT_APP_URL=http://localhost:3000
FRAMEOS_SCENES_APP_URL=http://localhost:3000
# FRAMEOS_SESSION_COOKIE_DOMAIN is unset
```

That intentionally leaves host routing disabled, so `pnpm dev` still serves
the complete app on one localhost port exactly as before.

## Frame limits

Per-account limits for cloud-managed frames, all optional:

```text
FRAMEOS_CLOUD_MAX_FRAMES_PER_ACCOUNT=50       # enrolled frames
FRAMEOS_CLOUD_MAX_CLAIM_TOKENS_PER_ACCOUNT=50 # outstanding unused claim codes
FRAMEOS_CLOUD_CLAIM_TOKEN_TTL_HOURS=24        # how long a claim code lives
```

Values are read at startup; a non-integer or non-positive value logs a warning
and falls back to the default rather than failing the boot.

The claim-code cap bounds how many enrollment secrets can be live at once. It
is not a product limit: codes are stored only as hashes, so an outstanding one
can never be shown to the user again, and refusing at the cap would lock an
account out for a full TTL over codes nobody could use. Reaching the cap
therefore recycles the account's oldest never-used single-use code instead of
erroring. Multi-use codes — the ones behind SD-card images, which may already
be flashed to hardware — are never recycled, so an account whose cap is
entirely SD-image codes does still get `claim_token_quota_exceeded`.

Raising `FRAMEOS_CLOUD_MAX_FRAMES_PER_ACCOUNT` also raises the budget of a
multi-use SD-image code, which is capped at the frame limit.

## DNS and Reverse Proxy

Create DNS records and TLS certificates for all three hostnames, then send them to
the existing `frameos_cloud_auth_web` upstream. The reverse proxy must preserve
the public `Host` and `X-Forwarded-Proto` headers. In nginx, the HTTP and HTTPS
server blocks can share the same proxy location for all three names:

```nginx
location / {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Not a literal port: the upstream block is the one place a deploy moves
    # traffic between the two auth-web instances. It is generated into
    # /etc/nginx/conf.d/frameos-cloud-upstream.conf and rewritten on every
    # deploy — never edit it by hand.
    proxy_pass http://frameos_cloud_auth_web;
}
```

Production keeps those proxy lines in
`/etc/nginx/snippets/frameos-cloud-proxy.conf` and `include`s the snippet from
every location that needs them (`location /` on cloud/scenes, `location /api/`
and the two install-script paths on the legacy account host). So there is one
line to change and the installer looks in `snippets/` as well as
`sites-enabled/` and `conf.d/`.

Per-client rate limits (firmware downloads, login attempts, hub upgrades)
key on the client IP that `RATE_LIMIT_TRUSTED_PROXY_COUNT` picks out of the
`X-Forwarded-For` chain, counted from the right. That must equal the number of
proxy hops in front of auth-web: `1` for bare nginx, `2` when Cloudflare (or
any other CDN) sits in front of it — with `1` every visitor keys on the
Cloudflare edge address and the whole site shares one budget, which surfaces
as "Too many firmware downloads from your network" for a user who has
downloaded nothing.

Release lookups against api.github.com are cached in-process (fresh for five
minutes, stale copy served while GitHub is down or rate limiting) and sent
with `GITHUB_TOKEN` when one is set in the environment — set it if the host
shares its egress IP with anything else that talks to GitHub.

After deployment, verify that `https://cloud.frameos.net/` redirects to
`/backends` (which lands on login when signed out), that
`https://cloud.frameos.net/scenes` opens “My scenes,” that public scenes stay
on `scenes.frameos.net`, and that `https://account.frameos.net/` redirects to
`cloud.frameos.net` while `account.frameos.net/api/*` still answers. Signing
in on cloud must make the scenes site authenticated without another login,
and the light/dark preference must carry between them.

## Google SSO Redirect URIs

Auth is first-party (see `docs/auth.md`); the only external dependency is the
optional Google OAuth client. Register this redirect URI on the Google OAuth
2.0 Client ID for each deployed environment:

```text
{FRAMEOS_CLOUD_APP_URL}/api/auth/google/callback
```

Local development uses:

```text
http://localhost:3000/api/auth/google/callback
```

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment. When
they are unset, the login page hides the Google button and password sign-in
keeps working. Set `POSTMARK_SERVER_TOKEN` and `POSTMARK_FROM_EMAIL` so
password reset emails are delivered; without them reset links are only written
to the server log.

## Object Storage

Blobs — store scene zips, scene previews and gallery images, and the per-frame
device-snapshot cache — live in Cloudflare R2 (bucket `frameos-cloud`, public
alias `cloud-cdn.frameos.net`), not in Postgres. Set in **both**
`/etc/frameos-cloud/auth-web.env` and `/etc/frameos-cloud/frame-hub.env`:

```text
R2_CLOUD_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_CLOUD_ACCESS_KEY_ID=…
R2_CLOUD_SECRET_ACCESS_KEY=…
R2_CLOUD_BUCKET=frameos-cloud                       # optional, this is the default
R2_CLOUD_PUBLIC_BASE_URL=https://cloud-cdn.frameos.net
```

Both services, because the hub writes device snapshots through the same code
path auth-web reads them with. A hub missing these keys is the failure worth
naming: it keeps writing bytes into Postgres while auth-web looks for them in
R2, and the symptom is preview tiles that go blank only for frames that
re-rendered since the deploy.

With any of endpoint/key/secret unset the code falls back to a directory
(`db/object-storage`, override with `FRAMEOS_OBJECT_STORE_DIR`). That is the
development and CI default and needs no bucket, no credentials and no extra
process — but on the production host it silently means "blobs on the app
server's local disk", so check `/healthz`-adjacent logs after a credential
change.

Keys are content-addressed and namespaced, so the same preview PNG republished
a thousand times is one object:

```text
store/scene-versions/<sha256>.zip
store/scene-previews/<sha256>
store/scene-images/<sha256>
frames/<frame-id>/cache/<sha256>
```

`R2_CLOUD_PUBLIC_BASE_URL` only affects **public** store objects: a public
scene's preview and gallery images redirect (307) to the CDN. Private scenes
and every frame snapshot are proxied through the app, where the session check
still applies — the alias has no authentication in front of it.

Image content types are sniffed from the bytes when serving, not read from the
stored column — a `content_type` is only as good as whatever wrote it, and the
store has rows from before it was sniffed at all. The bytes cannot be wrong
about themselves. The CDN path is the exception, because the object's own
stored content type is what the edge returns: whatever writes an image object
has to hand `storeBlob` a sniffed type, and every current writer does.

### Running a one-off script against production

The release is a Next.js standalone bundle, and its `node_modules` holds only
what the server traced — third-party packages are compiled into the server
chunks, so a script placed in the release cannot `import` them. Stage it
somewhere with its own dependencies instead:

```sh
mkdir -p /root/frameos-oneoff && cd /root/frameos-oneoff
npm i postgres aws4fetch
set -a; . /etc/frameos-cloud/auth-web.env; set +a
node ./the-script.mjs
```

One gotcha worth inheriting: postgres.js opened with `max: 1` cannot write
inside a `.cursor()` loop — the cursor holds the only connection, so the write
queues behind a cursor that cannot advance until the write runs. It does not
error; it hangs, with Postgres reporting `ClientRead`. Page with `limit N`
instead.

## Operational Notifications

auth-web fires optional fire-and-forget server-side PostHog captures
(`src/lib/posthog-capture.ts`) for a few operational events. They are
skipped silently when the key is unset, and failures never affect the flow
that triggered them:

```text
NEXT_PUBLIC_POSTHOG_KEY=…                    # PostHog project key; also used
                                             # by the browser SDK
NEXT_PUBLIC_POSTHOG_HOST=…                   # optional; defaults to
                                             # https://eu.i.posthog.com
```

| Event                  | `distinct_id`        | Fired by                                          |
| ---------------------- | -------------------- | ------------------------------------------------- |
| `cloud user signed up` | the new account id   | password signup, first Google sign-in             |
| `store scene reported` | the reporter account | `POST /api/store/scenes/<id>/report` (new report) |

Both go to the `/capture` endpoint using the same public project key as the
browser SDK (no extra secret required). The Discord messages for these
("new user", "scene reported") are PostHog webhook destinations on the
events, configured in PostHog, not in auth-web. `DISCORD_REPORTS_WEBHOOK_URL`
(`src/lib/discord.ts`) is the older direct post for scene reports and is on
its way out (`docs/todo.md`).

**The browser SDK does not read this from the server's env file.**
`NEXT_PUBLIC_*` values are inlined into the client bundle when `next build`
runs, and the bundle is built wherever the deploy is run from — the GitHub
Actions runner for automatic deploys (the `NEXT_PUBLIC_POSTHOG_KEY`
repository variable, wired through `.github/workflows/cloud-ci.yml`), or the
local checkout for a manual `pnpm deploy:prod` (`.env.local`). The entry in
`/etc/frameos-cloud/auth-web.env` only feeds the server-side uses above. A
build without the key ships with browser analytics off entirely: the SDK is
never initialised and the consent banner does not render. turbo.json declares
the variable as an env input of `@frameos-cloud/auth-web#build`, so a keyed
build never replays a cached keyless one (or vice versa).

## Legal Pages

`/legal/terms`, `/legal/privacy` and `/legal/imprint` are served from the
cloud origin and linked from the footer of every page, on every surface.

**Quote any value with a space in `/etc/frameos-cloud/auth-web.env`.** The
legal values are the first settings here that routinely contain spaces, and
that file is read two ways on the server: systemd's `EnvironmentFile=`
accepts bare values, but `frameos-cloud-update` `source`s it as shell, where
`FRAMEOS_LEGAL_ENTITY_NAME=Example Frames BV` means "run `BV`". The deploy
then fails part-way through streaming the bundle with `BV: command not
found` and `tar: Write error`, which says nothing about quoting. Production
is left untouched when this happens — the swap has not run yet — so the fix
is to quote and redeploy.
They read the operator's identity from `FRAMEOS_LEGAL_*` (see
`.env.example` and `src/lib/legal.ts`) and render a visible
`[TO BE COMPLETED]` warning until `FRAMEOS_LEGAL_ENTITY_NAME` is set — the
`/admin` system checks flag it as a required setting for the same reason.
**Fill these in before opening signups to the public**: an imprint is a legal
requirement for an EU-established operator, not a nice-to-have, and the
privacy policy needs a named controller to be worth anything.

The privacy policy's processor table is generated from the `processors` list
in `src/lib/legal.ts`. That list is the promise the policy makes, so a new
outbound integration that touches personal data has to be added there in the
same change — `grep -rhoE 'https://[a-zA-Z0-9.-]+' apps/*/src apps/*/app` is
the audit that produced the current list.

Browser analytics is gated behind the consent banner and captures nothing
before the visitor accepts; server-side error reports carry no user identity
and run without consent. Withdrawal is one click from the footer's "Cookie
settings" on any page.

## Service Boundaries

Keep the current deployment focused on auth, account sessions, backend linking,
and backend sync APIs. Do not add organizations, projects, hosted backend
lifecycle, billing, backups, or storage surfaces until those products are ready
to be designed and shipped.
