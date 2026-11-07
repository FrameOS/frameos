# FrameOS Cloud — scope guardrails

What the cloud app is and is not; open work is tracked in `docs/todo.md`
at the repo root. (Until 2026-09-09 this file was `cloud/TODO.md`.)

Shipped scope, in brief: first-party auth (login/signup/reset/recovery/
logout, Google SSO via OIDC + PKCE), FrameOS-owned sessions and identity
mapping, superadmin user management, backend/frame linking via device
authorization (`client_kind` "backend"/"frame"), revocation/self-unlink/
inventory/grants/token rotation, the `auth:login` login handoff, config
backups (`/api/backends/backups`, 8 MB per blob / 500 per account), the
scene store, the cloud-managed frames control plane + `apps/frame-hub`
(design: `docs/cloud-frames.md`), virtual frames (no hardware: the hub
renders them, a paid-plan entitlement), optional 2FA plus re-authentication for
sensitive actions and the audit trail (`docs/auth.md`), Postgres-backed rate
limiting (`rate_limit_buckets`), hand-written SQL migrations, cross-repo
E2E (`scripts/e2e-frameos.sh`), and the accounting module — a double-entry
ledger in `packages/ledger`, AI metering (shadow mode), the per-account AI
switch and daily cap, plans and subscriptions, paid plans sold through
Stripe (`docs/billing.md`), and `/admin/billing`
(`docs/accounting-todo.md`, which also holds the billing todo).

Keep out until there is a concrete product design (scope names for these
are already reserved in the device-flow allowlist, but no feature
endpoints exist):

- Cloud organizations, projects, memberships, and invitations.
- Hosted backend lifecycle.
- Charging for metered AI usage, and storage and asset backup billing
  (config backups have fixed caps only).
- Placeholder service packages or UI packages.
