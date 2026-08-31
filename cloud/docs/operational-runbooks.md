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

## Uptime Monitoring

`frameos-cloud-uptime.timer` (every 5 minutes, on the host, installed from
`cloud/ops/monitoring/`) curls `/healthz` on each of the three public
hostnames plus frame-hub on loopback, and pings the healthchecks.io "FrameOS
cloud went offline" check only when all answer 2xx/3xx. A broken app sends an
explicit `/fail` ping (immediate alert); a dead host stops pinging (alert
after the check's period + grace). Ping URL: `UPTIME_HEALTHCHECKS_URL` in
`/etc/frameos-cloud/monitoring.env`. With 5-minute pings, setting the check
to period 10 min / grace 5 min gives ~15-minute worst-case detection.

`/healthz` (auth-web: `app/healthz/route.ts`; frame-hub: `src/hub.ts`)
returns 200 only after auth-web has actually reached Postgres, and 503
otherwise. That is the point of it: the check used to curl `/login` and the
two site roots, which the App Router renders happily with a dead database —
so the single failure most worth paging on was the one the monitor could not
see. `scripts/deploy.sh` uses the same endpoint for its post-deploy check, so
a deploy that boots but cannot serve fails loudly instead of looking green.
frame-hub is checked on `127.0.0.1:3100` because it has no public URL of its
own; without that, a dead hub leaves every frame offline while all three
public checks stay green.

## Error Tracking

Server-side failures go through `reportError` (`apps/auth-web/src/lib/log.ts`),
which writes a structured JSON line to the journal AND files a `$exception`
event in PostHog error tracking. Browser exceptions land in the same PostHog
project via `capture_exceptions` (`PostHogProvider.tsx`). One vendor on
purpose: it keeps the privacy policy down to a single analytics subprocessor.

What to search when someone reports a vague problem:

- `frameos_event` on a PostHog exception carries our own event name, e.g.
  `email.verification_send_failed`, `auth.google_code_exchange_failed`,
  `frames.enroll_encryption_unavailable`.
- On the host, `journalctl -u 'frameos-cloud-auth-web@*' -o cat | jq 'select(.level=="error")'`
  (the glob covers both blue/green instances, so a deploy does not split the
  log in two)
  — every log line from auth-web and frame-hub is single-line JSON with
  `event`, `level`, `service` and `time`.
- Credential-shaped field names (`*token*`, `*secret*`, `*password*`,
  `*cookie*`, `*api_key*`) are redacted before they reach either sink, so a
  redacted value in a log line is expected, not a bug.

Email is the silent failure worth knowing about: login requires a verified
address, and Postmark sends are best-effort, so a bad token or a Postmark
outage locks out every new signup while showing them "check your inbox". Both
send paths now `reportError`, and `/admin` runs a live Postmark probe (see
below) that also catches a server left in Sandbox mode — which accepts every
message and delivers none.

## Admin Live Checks

`/admin` has two tables. **System checks** is configuration presence only.
**Live checks** actually probes: `select 1` against Postgres, Postmark's
`/server` endpoint (to confirm the token works and the server is Live rather
than Sandbox), and the object store — a probe object written, read back and
deleted. Both are re-run on every page load, and neither can 500 the page: a
failing probe renders as a failing row.

Two object-store rows are worth reading carefully. "Object storage" reporting
the **filesystem** driver is a warning rather than a pass — correct in
development, but on the production host it means the `R2_CLOUD_*` credentials
did not reach the process and blobs are landing on local disk where no backup
will find them. "Frame hub object storage" watches for the other half of the
same mistake: the hub reads its own environment file, so it can be writing
bytes into Postgres while auth-web reads R2, and nothing errors — only
previews go blank for frames that re-rendered.

## Backups

Nightly `frameos-cloud-backup` (systemd timer on the host, installed from
`cloud/ops/backup/`) dumps Postgres and the host config to the Hetzner
Storage Box and pings healthchecks.io, so a job that stops running raises an
alert. Setup, verification, and the restore runbook: [backups.md](backups.md).

Rehearse a restore quarterly with `ops/backup/restore-drill.sh` (or
`/usr/local/bin/frameos-cloud-restore-drill` on the box): it restores the
newest dump into a scratch database, verifies it, and exits non-zero if the
backups are not known-good. Both paths were rehearsed for the first time on
2026-08-15 and passed; the measured numbers and the two gotchas found are
recorded in [backups.md](backups.md#results-so-far). Take a manual
`frameos-cloud-backup` run before risky migrations.

## Maintenance Tasks

Run `pnpm db:cleanup` on a schedule (daily is fine). It deletes:

- Device authorization requests past their expiry plus the retention window.
- Expired FrameOS login handoff codes.
- Expired or revoked sessions past the retention window.

The retention window defaults to 7 days and can be overridden with
`FRAMEOS_CLOUD_CLEANUP_RETENTION_DAYS`. Audit and consent events are never
deleted by this job.

### Sweeping the object store

`scripts/object-store-sweep.sh` deletes blobs no row points at. The app
already removes an object when the last row referencing it goes; what it
cannot see is a row that vanishes underneath it — `delete from accounts`
cascades through scenes, versions, images and frames with no application code
running, orphaning every object those rows named.

```sh
# on the app host, from the release directory
set -a; . /etc/frameos-cloud/auth-web.env; set +a
cloud/scripts/object-store-sweep.sh              # dry run
cloud/scripts/object-store-sweep.sh --apply
```

Monthly is plenty — the waste is bounded by how often accounts are deleted.
It needs the `r2` rclone remote (`cloud/ops/backup/rclone.conf.example`).

Two safeties worth knowing before trusting it with `--apply`: objects younger
than `OBJECT_STORE_SWEEP_MIN_AGE` (7 days) are never candidates, because a
publish writes the object *before* the row that points at it and a sweep
racing a publish would otherwise delete a live scene; and every candidate is
re-checked against the database immediately before its delete, so a key
claimed between the listing and the delete is skipped and said so.

It also reports the opposite problem — a referenced key that is **not** in the
store, i.e. a row pointing at bytes that are gone. That line should never
appear.

### The nightly accounting job

`ops/accounting/frameos-cloud-accounting.timer` runs
`scripts/accounting-nightly.sh` at 04:20, which curls
`POST /api/admin/billing/nightly`. Two things happen: AI usage records whose
ledger entries never landed are re-posted (idempotent by turn id, so a night
that already posted is a no-op), and every ledger invariant runs — each
violation is `reportError`ed and the run exits non-zero.

Install with `cloud/ops/accounting/install.sh`. The one manual step is the
token: create a personal API token as a superadmin at `/account/api-tokens`
and put it in `/etc/frameos-cloud/accounting.env` as
`ACCOUNTING_API_TOKEN`. Optionally set `ACCOUNTING_HEALTHCHECKS_URL` for the
same dead-man pattern the backup and uptime jobs use.

**A violation is an alert, not something to fix by hand from the psql
prompt.** The ledger is append-only in the database — `UPDATE` and `DELETE`
on `ledger_entries`, `ledger_postings` and `financial_events` raise — and
that is deliberate: a wrong entry is corrected with a reversing entry from
`/admin/billing`, never edited. Start at `/admin/billing`, which runs the
same checks live and drills from any number into the entries behind it.

The daily line to grep for is `billing.nightly` (revenue, COGS, margin,
customer liability, sweep counts, violation count). A *missing* line is
itself the signal — the job did not run.

## Data Subject Requests

Most of this is self-serve and needs no operator at all — which is the point,
because a right that requires a support ticket is a right with a queue in
front of it.

- **Access / portability (GDPR arts. 15, 20)** — the user downloads
  `/api/account/export` from their account security page: a JSON document
  with their account, identities, settings, frames, scenes, chats and audit
  trail. It deliberately excludes credentials (password hash, session/share/
  enrollment tokens, encrypted backend credentials) and embeds no binary
  blobs — scene zips, images and backups are listed with size, checksum and
  a download path instead.
- **Erasure (art. 17)** — the user deletes their own account from the same
  page, re-authenticating first (password, or typing their email for
  Google-only accounts). Everything cascades from `accounts.id`;
  `audit_events.account_id` is `ON DELETE SET NULL`, so the security trail
  survives de-identified. Superadmins cannot self-delete (the panel must keep
  a way in) — hand the flag over first.
- **What an operator still has to do**: rectification, restriction, objection,
  and anything the export does not cover. One month to respond (art. 12(3)).
- **Backups**: deleted data persists in off-site backups for up to 30 days
  until retention rolls them over. This is stated in the privacy policy. Do
  not restore a backup to recover a deleted account.

Requests arrive at `FRAMEOS_LEGAL_CONTACT_EMAIL`. The public-facing wording
of all of the above is `/legal/privacy`; keep the two in step.

## Session Compromise

If a session cookie is suspected stolen:

1. Sessions are server-backed: revoke the affected rows by setting
   `sessions.revoked_at` (logout does this for the user's own session).
2. To force-logout an entire account:
   `UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL;`
3. Review `audit_events` for actions taken during the compromise window.
