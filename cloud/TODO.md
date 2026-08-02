# FrameOS Cloud TODO

Current product scope:

- First-party login, signup, password reset, recovery, and logout flows, plus
  Google SSO via a direct OIDC Authorization Code + PKCE flow.
- FrameOS-owned account sessions and provider identity mapping.
- Superadmin-only admin panel for user management.
- Backend linking through device authorization, with the widened scope
  allowlist shown to the user at approval (see
  `docs/frameos-integration.md`). Linked clients carry a `client_kind`
  ("backend" or "frame", derived from `frame:link` or an explicit
  `client_kind` in device/start); the consent screen and account page word
  themselves accordingly.
- Linked backend revocation, backend self-unlink, inventory sync, owner
  grants (including the account email snapshot), and token rotation.
- Direct backend login handoff through an already linked backend, gated on
  the `auth:login` scope (`403 insufficient_scope` otherwise).
- Config backups for linked clients (`/api/backends/backups`): account-owned
  replace-in-place blobs for the `backup:scenes` / `backup:frames` scopes,
  scope-enforced per kind, 8 MB per blob, 500 per account
  (`client_backups` table, `src/lib/backups.ts`).
- Local Postgres setup and migrations for the current schema only.
- Cross-repo E2E: `scripts/e2e-frameos.sh` boots this app, creates a verified
  account, and runs the AGPL repo's `test_cloud_e2e.py` (link + login handoff
  + backups over real HTTP).

Current repository scope:

- `apps/auth-web`: Next.js UI and route handlers.
- `packages/auth-client`: shared OIDC, PKCE, provider URL, and backend-linking helpers.
- `packages/db`: Drizzle schema, migrations, and database helpers.
- `scripts`: local database setup, migration, and cleanup scripts, plus the
  production deploy script.
- `.github/workflows`: CI running `pnpm verify` and `pnpm test:integration`
  on push and pull request.

Keep out until there is a concrete product design (scope names for these are
already reserved in the device-flow allowlist, but no feature endpoints exist):

- Cloud organizations.
- Cloud projects.
- Cloud memberships and invitations.
- Hosted backend lifecycle.
- Billing and metered quotas (config backups exist with fixed caps; asset
  backups / storage billing do not).
- Placeholder service packages or UI packages.
- Scene and app repositories.

Cloud-managed frames (frame lists, frame-linking UI, the "Add frame" flow,
the WebSocket hub) now **have** a concrete design: see
`docs/cloud-frames.md`. Build them per that document and its phasing.

Near-term cleanup:

- Add operator-facing audit/event export only when there is an operator surface.

Done (kept for context):

- Change-password form on `/account/security` (current password required,
  other sessions revoked); accounts without a password use the reset flow.
- Rate limiting backed by Postgres (`rate_limit_buckets`, atomic upsert), so
  limits hold across `apps/auth-web` replicas and restarts; in-memory buckets
  remain only as the no-database fallback.
- `frameos_login_codes` stores account/identity references only; profile
  claims are resolved at redemption instead of released from a snapshot.
- Integration coverage for the full backend-linking flow against a local
  Postgres database (`pnpm test:integration`, also run in CI against a
  Postgres service container).
- One-time exchange protection for FrameOS backend login codes (single-use
  atomic claim with expiry in the token route).
