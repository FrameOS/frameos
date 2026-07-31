# Deployment Notes

The first deployable can run as one web/API process from `apps/auth-web`.
Background workers should be added only when email, webhooks, cleanup, or sync
jobs need separate execution.

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
in the private ops notes. It runs as the `frameos-cloud-auth-web.service` systemd unit, with the app in
`/opt/frameos-cloud` and env in `/etc/frameos-cloud/auth-web.env`.

Deploy the pushed HEAD with:

```sh
pnpm deploy:prod
```

This streams `git archive HEAD` into `/usr/local/bin/frameos-cloud-update
--archive -` on the server, which swaps `/opt/frameos-cloud` (previous release
kept at `/opt/frameos-cloud.previous` for rollback), runs `pnpm install
--frozen-lockfile`, `scripts/db-migrate.sh`, builds, and restarts the service.
The script refuses to deploy a dirty tree or an unpushed commit, and checks the
service plus the public login URL afterwards. Override
`FRAMEOS_CLOUD_DEPLOY_HOST`, `FRAMEOS_CLOUD_DEPLOY_SSH_KEY`, or
`FRAMEOS_CLOUD_DEPLOY_CHECK_URL`, `FRAMEOS_ACCOUNT_DEPLOY_CHECK_URL`, or
`FRAMEOS_SCENES_DEPLOY_CHECK_URL` if the target changes. The default deployment
health check requires all three public origins to return a 2xx or 3xx response.

To roll back, move `/opt/frameos-cloud.previous` back to `/opt/frameos-cloud`
and restart `frameos-cloud-auth-web.service` (database migrations are not
rolled back automatically).

All three public hostnames point at the same process. `cloud.frameos.net` is
the login/auth domain, `account.frameos.net` owns account, device, and admin
pages, and `scenes.frameos.net` owns the public store and scene/publisher
pages. “My scenes” is the `/scenes` section of the account site. API routes
remain reachable on every hostname for compatibility with linked FrameOS
backends.

Production uses:

```text
FRAMEOS_CLOUD_APP_URL=https://cloud.frameos.net
FRAMEOS_ACCOUNT_APP_URL=https://account.frameos.net
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

After deployment, verify that `https://cloud.frameos.net/` redirects to its
login page, `https://account.frameos.net/` opens the root account page,
`https://account.frameos.net/scenes` opens “My scenes,” and public scenes stay
on `scenes.frameos.net`. Signing in on cloud must make both other sites
authenticated without another login, and the light/dark preference must carry
between them.

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

## Service Boundaries

Keep the current deployment focused on auth, account sessions, backend linking,
and backend sync APIs. Do not add organizations, projects, hosted backend
lifecycle, billing, backups, or storage surfaces until those products are ready
to be designed and shipped.
