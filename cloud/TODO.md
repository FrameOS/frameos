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
(design: `docs/cloud-frames.md`), optional 2FA plus re-authentication for
sensitive actions and the audit trail (`docs/auth.md`), Postgres-backed rate
limiting (`rate_limit_buckets`), hand-written SQL migrations, cross-repo
E2E (`scripts/e2e-frameos.sh`), and the accounting module — a double-entry
ledger in `packages/ledger`, AI metering (shadow mode), the per-account AI
switch and daily cap, plans and subscriptions with self-serve purchase
behind `FRAMEOS_CLOUD_PLANS_SELF_SERVE`, and `/admin/billing`
(`docs/accounting-todo.md`, which also holds the billing todo).

Keep out until there is a concrete product design (scope names for these
are already reserved in the device-flow allowlist, but no feature
endpoints exist):

- Cloud organizations, projects, memberships, and invitations.
- Hosted backend lifecycle.
- A payment provider integration: parked until there are users to invoice
  (2026-09-03), then `docs/accounting-todo.md` §8.15 (legal entity, VAT)
  and §8.7 (provider — Stripe or a merchant-of-record) get answered first;
  storage and asset backup billing (config backups have fixed caps only).
- Placeholder service packages or UI packages.
