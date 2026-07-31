# Operational Runbooks

These runbooks cover the first private FrameOS Cloud deployment.

## Key Rotation

Rotate `SESSION_SECRET` when session signing is suspected compromised or as a
scheduled maintenance task.

1. Announce a short maintenance window.
2. Deploy support for multiple session verification keys if zero logout is
   required.
3. Replace `SESSION_SECRET` in the deployment secret manager.
4. Restart the web/API process.
5. Verify login, logout, and callback flows.
6. Record an operator audit event.

Rotate `FRAMEOS_CLOUD_ENCRYPTION_KEY` only with a re-encryption migration for
stored linked-client credentials.

1. Add a new key id and dual decrypt support.
2. Re-encrypt linked-client credentials in batches.
3. Verify backend polling and inventory sync.
4. Retire the old key after all rows move.
5. Record migration counts and failures.

## Google SSO Outage

Symptoms:

- Google OIDC discovery or token exchange errors.
- `/api/auth/google/*` redirects to `?error=provider_unavailable`.
- Password login keeps working; only the Google button is affected.

Response:

1. Check Google OAuth status and FrameOS Cloud network egress.
2. Confirm password login and existing sessions still work.
3. Point affected users at password sign-in (or a password reset) while
   Google is down.
4. Post status guidance if sign-in remains degraded.
5. After recovery, verify discovery, login, callback, device approval, and grant
   fetch.

## Token Compromise

For a suspected linked backend token leak:

1. Revoke the linked client from the account page or operator tooling.
2. Confirm `linked_clients.revoked_at` is set.
3. Confirm `/api/backends/grants` and `/api/backends/inventory` reject the old
   token.
4. Ask the backend owner to reconnect through device authorization.
5. Review audit events for inventory syncs after the suspected leak time.

For a broad encryption-key compromise, rotate the encryption key using the key
rotation process and revoke all link credentials that may have been exposed.

## Account Recovery Abuse

Signals:

- Repeated reset/recovery attempts for the same account or IP range.
- Device authorization approvals from unexpected account sessions.

Response:

1. Rate-limit recovery and device authorization endpoints.
2. Require stronger verification before sensitive recovery changes.
3. Review account, consent, and device authorization audit events.
4. Revoke suspicious linked clients.
5. Preserve logs needed for abuse analysis.

## Revocation Incident

If a backend retains access after its link is revoked:

1. Confirm `linked_clients.revoked_at` is set.
2. Confirm `/api/backends/grants`, `/api/backends/inventory`, and
   `/api/frameos/login/start` reject the old token.
3. Rotate or revoke any suspicious linked-client credentials.
4. Inspect backend inventory sync timestamps.
5. Add a regression test for the propagation path that failed.

## Maintenance Tasks

Run `pnpm db:cleanup` on a schedule (daily is fine). It deletes:

- Device authorization requests past their expiry plus the retention window.
- Expired FrameOS login handoff codes.
- Expired or revoked sessions past the retention window.

The retention window defaults to 7 days and can be overridden with
`FRAMEOS_CLOUD_CLEANUP_RETENTION_DAYS`. Audit and consent events are never
deleted by this job.

## Session Compromise

If a session cookie is suspected stolen:

1. Sessions are server-backed: revoke the affected rows by setting
   `sessions.revoked_at` (logout does this for the user's own session).
2. To force-logout an entire account:
   `UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL;`
3. Review `audit_events` for actions taken during the compromise window.
