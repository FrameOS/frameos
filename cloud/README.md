# FrameOS Cloud

This is the source of the hosted service that runs at `cloud.frameos.net`
(accounts and frame management) and `scenes.frameos.net` (the scene store).
It lives in `cloud/` inside the FrameOS monorepo and is licensed
AGPL-3.0-only like the rest of it.

FrameOS Cloud is a TypeScript app — Next.js, Postgres, Drizzle — that
provides:

- **Accounts and identity**: first-party email/password auth and optional
  Google SSO, sessions, password reset, superadmin user management.
- **Linking**: a device-authorization flow that connects a self-hosted
  FrameOS backend, or an individual frame, to a cloud account — with scoped
  grants, revocation, and audit events.
- **The scene store**: publishing, browsing, and installing interpreted
  scenes.
- **Cloud-managed frames**: a WebSocket control plane (`apps/frame-hub`) for
  frames that enroll with the cloud directly and have no self-hosted backend
  at all — scene assignment, screenshots, logs, metrics, and signed OTA
  updates. Design: [`docs/cloud-frames.md`](docs/cloud-frames.md).
- **Config backups** for linked self-hosted backends.
- **API tokens and an MCP server**: personal bearer tokens for the JSON API,
  and `POST /api/mcp` — the whole account surface (frames, scenes, store,
  scene AI, server-side previews) as Model Context Protocol tools for AI
  agents, implemented in `packages/mcp` as a thin wrapper over the routes.
  Design: [`docs/mcp.md`](docs/mcp.md).

**You do not need any of this to use FrameOS.** The self-hosted backend and
the frames themselves work with zero cloud, forever — that is a hard rule of
the project, not a current state of affairs. The cloud is identity, store,
relay, and fleet view; the frame is the product. A cloud-managed frame is
also deliberately limited: the cloud never gets SSH access, never compiles
code, and can only install sandboxed interpreted scenes, because the
device-side protocol has no verbs for anything else.

The documented protocol (device linking, frame enrollment, store repository
format) can be reimplemented by anyone without permission from us — see
`NOTICE`.

## Work in progress — self-hosting is not recommended

This is early software developed against exactly one production deployment
(ours). It is published because the whole monorepo is AGPL, not because it is
ready to be run by other people. Concretely:

- There are no releases, no versioning, and no upgrade path. `main` changes
  under you, and hand-written SQL migrations come with no compatibility
  promise between commits.
- Deployment is one specific machine layout: `pnpm deploy:prod` streams a
  bundle to a host set up by `ops/deploy`, and both processes are effectively
  single-instance (the frame hub marks every frame offline on boot, so a
  second one fights the first).
- Configuration assumes the three-origin `frameos.net` domain layout and a
  shared session cookie domain. Nothing is parameterised for a different
  brand or topology.
- The docs under `docs/` are operational runbooks for our instance, not a
  self-hosting guide. There is no multi-tenant model, no billing, no quota
  enforcement beyond fixed caps, and no operator surface.
- The security posture is reviewed against our threat model, not a general
  one. Running an internet-facing auth service and frame control plane is on
  you.

If you want to run FrameOS yourself, run the self-hosted backend from the
repository root — that is the supported path, and it needs no cloud account.
If you want to experiment with this code anyway, the development setup below
works fine locally; just don't put it in front of frames you care about.

## Status

This directory is part of the monorepo's single pnpm workspace: one root
lockfile, `frameos-wasm` and `frameos-editor` consumed as `workspace:`
packages, and Turborepo building whatever a task depends on (frontend →
editor, wasm runtime → wasm) automatically and cached. Run pnpm commands
from `cloud/`; sharing the full frontend is the next step — see
`docs/cloud-frames.md`.

Current scope:

- Flox-managed Node/pnpm development environment.
- Flox-managed local Postgres setup through `pnpm db:setup`.
- pnpm monorepo with `apps/auth-web`, `apps/frame-hub`,
  `packages/auth-client`, and `packages/db`.
- Branded login, signup, reset, recovery, backend-code, and account screens.
- First-party email/password auth (scrypt-hashed credentials, single-use
  password reset links) and optional Google SSO through a direct OIDC
  Authorization Code + PKCE flow.
- Superadmin-only `/admin` panel for managing users (grant/revoke superadmin,
  revoke sessions, delete accounts), bootstrapped with `pnpm admin:grant`.
- Device authorization start, poll, approve, deny, revoke, and link-token
  rotation endpoints.
- Linked backend inventory sync and account-owner grant fetch endpoints.
- The cloud-managed frames control plane: `apps/frame-hub` (WebSocket), frame
  enrollment, scene assignment and deploys, current-image and per-scene
  previews, logs and metrics, and signed OTA updates for both esp32 and
  buildroot frames.
- The scene store at `scenes.frameos.net`, with the hosted scene editor
  served at `/frameos-editor`.
- Shared FrameOS Cloud database schema for accounts, identities, linked clients,
  connected backends, device authorization requests, consent events, and audit
  events.
- Rate limits, CSRF origin checks for cookie-authenticated mutations, encrypted
  link credentials, audit events, and baseline security headers.
- Vitest unit and component tests (Testing Library) plus Postgres-backed
  integration tests for the backend-linking flow, with GitHub Actions CI
  running lint, typecheck, tests, build, and the integration suite on every
  push and pull request.
- Single-instance production deployment shared by `cloud.frameos.net`
  (login + account) and `scenes.frameos.net` (store), updated with
  `pnpm deploy:prod` (see `docs/deployment.md`). The legacy
  `account.frameos.net` redirects to `cloud.frameos.net` (APIs stay).
- Deployment, auth, FrameOS integration, operational runbook, rehearsal, and
  service-boundary documentation.

Password login works locally out of the box. Google SSO additionally needs
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `.env.local` (see `docs/auth.md`).

## Development

The toolchain comes from the monorepo's single Flox environment at the repo
root (Node, pnpm, and Postgres included — there is no separate `cloud/.flox`
env). From the repo root:

```sh
flox activate
cd cloud
pnpm db:setup
pnpm dev
```

Or start it as the `cloud` pane of the repo-level `pnpm dev` (mprocs) runner,
which runs `db:setup` and the dev server in one step. The root activation
hook installs workspace dependencies when package files or the lockfile
change; local Postgres data lives in the repo root's `.flox/postgres/`
(gitignored, `FRAMEOS_CLOUD_PGROOT` overrides).

Useful commands:

```sh
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm db:migrate
pnpm verify
pnpm deploy:prod
```

`pnpm verify` runs the same checks as CI. `pnpm deploy:prod` deploys the
pushed HEAD to production; see `docs/deployment.md` for the mechanics and
rollback procedure.

The scene editor served at `/frameos-editor` is the `frameos-editor`
workspace package: `pnpm build` (turbo) builds the frontend and snapshots
`frontend/dist-editor` into `frameos/editor/dist`, and the prebuild copy
step serves it from `public/`. The wasm runtime is reused from
`frameos/wasm/dist/assets` unless regenerated with
`turbo run build:runtime --filter=frameos-wasm` (needs nim + emscripten).

`pnpm test:integration` exercises the full backend-linking flow (device
authorization, token issuance and rotation, deny/revoke) against a real
Postgres. It uses the local server from `pnpm db:setup` and creates a separate
`frameos_cloud_test` database, rebuilt from the SQL migrations on every run;
set `TEST_DATABASE_URL` to use another server. CI runs it against a Postgres
service container.

`pnpm db:setup` starts a local Flox-provided Postgres instance on port `55432`,
applies migrations, and creates `.env.local` with local database settings and
generated development secrets when needed. Fill in the Google OAuth client
values to exercise Google SSO; password auth needs no extra configuration.

**Edit `cloud/.env.local`, and only that one.** Next.js loads `.env.local`
from its own project root, so `apps/auth-web/.env.local` is a symlink to it
that `db-setup.sh` creates. If yours is a real file instead (checkouts
predating the symlink have one), Next reads *that* copy and every variable
you add to `cloud/.env.local` is silently ignored by the web app while the
frame hub and the scripts still see it — the page just renders as though the
value were unset. `db-setup.sh` warns when it finds one and prints the fix.

## Layout

- `apps/auth-web`: the web app — auth UI, account and store surfaces, and all
  HTTP route handlers.
- `apps/frame-hub`: the WebSocket service cloud-managed frames connect to.
- `packages/auth-client`: generic OIDC discovery, PKCE, token exchange, and ID
  token verification helpers.
- `packages/db`: Drizzle schema and database helpers for cloud-owned data.
- `scripts`: local database setup, migration, and cleanup scripts, plus the
  production deploy script.
- `ops`: the production host's deploy, backup, and monitoring pieces.
- `docs`: design and operational documentation for our deployment.
- CI: the repo-root workflow `.github/workflows/cloud-ci.yml` runs
  `pnpm verify` and `pnpm test:integration` for changes under `cloud/`.

## License

AGPL-3.0-only, as part of the FrameOS monorepo — see the `LICENSE` file at
the repository root and the `NOTICE` file here. Independent implementations
of the documented cloud protocol require no permission from us.
