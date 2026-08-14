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

- **Single instance only.** Rate limiting (brute-force protection for device
  user codes and token endpoints) uses in-memory buckets that do not span
  replicas. Do not scale `apps/auth-web` beyond one instance until the rate
  limiter is backed by a shared store (e.g. Redis).
- **Database TLS.** `postgres.js` defaults to no TLS. If Postgres is not on
  the same host, set `DATABASE_SSL=require` (or `sslmode=require` in
  `DATABASE_URL`).
- **Periodic cleanup.** Schedule `pnpm db:cleanup` (e.g. daily cron) to prune
  finished device authorization requests, expired login codes, and expired or
  revoked sessions. These tables grow without bound otherwise.

## Initial Process

```sh
pnpm --filter @frameos-cloud/auth-web build
pnpm --filter @frameos-cloud/auth-web start
```

## Updating Production

Production runs on a single Hetzner host — set `FRAMEOS_CLOUD_DEPLOY_HOST`
(user@host) and optionally `FRAMEOS_CLOUD_DEPLOY_SSH_KEY`; host specifics live
in the private ops notes. It runs as the `frameos-cloud-auth-web.service`
systemd unit, which starts the Next.js standalone server
(`node cloud/apps/auth-web/server.js`) from `/opt/frameos-cloud`, with env in
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
   wasm packages as needed and produces `.next/standalone`
   (`output: "standalone"` in `next.config.ts`, traced from the monorepo root
   so pnpm workspace dependencies resolve into the bundle).
2. The script assembles `.next/standalone` + `.next/static` + `public/`
   (including the editor and wasm assets) + `apps/auth-web/scripts/` +
   `packages/db/drizzle/` + `scripts/db-migrate.sh` and `db-cleanup.sh`, and
   streams the tar into `/usr/local/bin/frameos-cloud-update --archive -` on
   the server.
3. `frameos-cloud-update` applies the SQL migrations via `psql` from the new
   release (before the swap, so a failed migration leaves the running app
   untouched), swaps `/opt/frameos-cloud` (previous release kept at
   `/opt/frameos-cloud.previous` for rollback), and restarts the service.

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

To roll back, move `/opt/frameos-cloud.previous` back to `/opt/frameos-cloud`
and restart `frameos-cloud-auth-web.service` (database migrations are not
rolled back automatically). The pre-monorepo pnpm-based release is not
startable by the current unit; the cutover-era backups
(`frameos-cloud-update.pre-monorepo`,
`frameos-cloud-auth-web.service.pre-monorepo`) would have to be restored to
run it.

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
# Same user/group as frameos-cloud-auth-web.service.
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
`{"connected_frames": N}`.

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
the existing `frameos-cloud-auth-web` upstream. The reverse proxy must preserve
the public `Host` and `X-Forwarded-Proto` headers. In nginx, the HTTP and HTTPS
server blocks can share the same proxy location for all three names:

```nginx
location / {
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_pass http://127.0.0.1:3000;
}
```

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

## Signup Notifications

When a brand new account is created (password signup or first Google
sign-in), auth-web fires two optional fire-and-forget notifications
(`src/lib/signup-notifications.ts`). Each is skipped silently when its
environment variable is unset, and failures never affect the signup:

```text
FRAMEOS_CLOUD_DISCORD_REPORTS_WEBHOOK_URL=…  # Discord webhook for a one-line
                                             # "new user" message in the
                                             # reports channel
NEXT_PUBLIC_POSTHOG_KEY=…                    # PostHog project key; also used
                                             # by the browser SDK
NEXT_PUBLIC_POSTHOG_HOST=…                   # optional; defaults to
                                             # https://eu.i.posthog.com
```

The PostHog event is `cloud user signed up` with the account id as
`distinct_id`, sent server-side to the `/capture` endpoint using the same
public project key as the browser SDK (no extra secret required).

## Service Boundaries

Keep the current deployment focused on auth, account sessions, backend linking,
and backend sync APIs. Do not add organizations, projects, hosted backend
lifecycle, billing, backups, or storage surfaces until those products are ready
to be designed and shipped.
