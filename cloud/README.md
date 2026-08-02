# FrameOS Cloud

FrameOS Cloud: hosted auth, cloud account state, the scene store, and linked
backend records. Lives in `cloud/` inside the FrameOS monorepo and is licensed
AGPL-3.0-only like the rest of it.

This directory is part of the monorepo's single pnpm workspace: one root
lockfile, `frameos-wasm` and `frameos-editor` consumed as `workspace:`
packages, and Turborepo building whatever a task depends on (frontend →
editor, wasm runtime → wasm) automatically and cached. Run pnpm commands
from `cloud/`; sharing the full frontend is the next step — see
`docs/cloud-frames.md`.

## Status

Current scope:

- Flox-managed Node/pnpm development environment.
- Flox-managed local Postgres setup through `pnpm db:setup`.
- pnpm monorepo with `apps/auth-web`, `packages/auth-client`, and
  `packages/db`.
- Branded login, signup, reset, recovery, backend-code, and account screens.
- First-party email/password auth (scrypt-hashed credentials, single-use
  password reset links) and optional Google SSO through a direct OIDC
  Authorization Code + PKCE flow.
- Superadmin-only `/admin` panel for managing users (grant/revoke superadmin,
  revoke sessions, delete accounts), bootstrapped with `pnpm admin:grant`.
- Device authorization start, poll, approve, deny, revoke, and link-token
  rotation endpoints.
- Linked backend inventory sync and account-owner grant fetch endpoints.
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
  (login), `account.frameos.net` (account), and `scenes.frameos.net` (store),
  updated with `pnpm deploy:prod` (see `docs/deployment.md`).
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

## Layout

- `apps/auth-web`: FrameOS Cloud Auth UI and route handlers.
- `packages/auth-client`: generic OIDC discovery, PKCE, token exchange, and ID
  token verification helpers.
- `packages/db`: Drizzle schema and database helpers for cloud-owned data.
- `scripts`: local database setup, migration, and cleanup scripts, plus the
  production deploy script.
- CI: the repo-root workflow `.github/workflows/cloud-ci.yml` runs
  `pnpm verify` and `pnpm test:integration` for changes under `cloud/`.

## License

AGPL-3.0-only, as part of the FrameOS monorepo — see the `LICENSE` file at
the repository root and the `NOTICE` file here. Independent implementations
of the documented cloud protocol require no permission from us.
