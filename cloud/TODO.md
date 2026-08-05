# FrameOS Cloud TODO

Remaining work is tracked in one place: `docs/todo.md` at the repo root.
This file keeps only the cloud app's scope guardrails.

Shipped scope, in brief: first-party auth (login/signup/reset/recovery/
logout, Google SSO via OIDC + PKCE), FrameOS-owned sessions and identity
mapping, superadmin user management, backend/frame linking via device
authorization (`client_kind` "backend"/"frame"), revocation/self-unlink/
inventory/grants/token rotation, the `auth:login` login handoff, config
backups (`/api/backends/backups`, 8 MB per blob / 500 per account), the
scene store, the cloud-managed frames control plane + `apps/frame-hub`
(design: `docs/cloud-frames.md`), Postgres-backed rate limiting
(`rate_limit_buckets`), hand-written SQL migrations, and cross-repo E2E
(`scripts/e2e-frameos.sh`).

Keep out until there is a concrete product design (scope names for these
are already reserved in the device-flow allowlist, but no feature
endpoints exist):

- Cloud organizations, projects, memberships, and invitations.
- Hosted backend lifecycle.
- Billing and metered quotas (config backups exist with fixed caps; asset
  backups / storage billing do not).
- Placeholder service packages or UI packages.

Near-term cleanup:

- Add operator-facing audit/event export only when there is an operator
  surface.
