#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Prunes rows that only exist for protocol bookkeeping and accumulate without
# bound: finished/expired device authorization requests, expired login handoff
# codes, expired or revoked sessions, and spent or expired password-reset and
# email-verification tokens. Audit and consent events are kept
# while their account exists; the security trail of a DELETED account (its
# account_id went NULL with the deletion) is kept for the period the privacy
# policy promises and then removed. Run periodically (e.g. daily via cron);
# see docs/operational-runbooks.md.

# The URL never goes on a command line (ps / /proc show argv to every local
# account): it becomes libpq's PG* environment and psql runs bare.
# shellcheck source=scripts/lib/pg-env.sh
. scripts/lib/pg-env.sh
pg_env_from_url "${DATABASE_URL:-postgres://frameos_cloud:frameos_cloud@localhost:5432/frameos_cloud}"

# Bookkeeping rows (device-flow requests, login codes, sessions, claim
# tokens, finished commands) age out after this many days.
retention_days="${FRAMEOS_CLOUD_CLEANUP_RETENTION_DAYS:-7}"
# Device telemetry is the owner's history, not bookkeeping, and is bounded
# per frame at insert time (5000 log rows / metrics samples per frame, plus
# the account's byte budget), so its age limit is separate and longer. The
# defaults are what production runs; a plan that sells longer retention
# raises them here.
log_retention_days="${FRAMEOS_CLOUD_FRAME_LOG_RETENTION_DAYS:-30}"
metrics_retention_days="${FRAMEOS_CLOUD_FRAME_METRICS_RETENTION_DAYS:-30}"
# The audit trail a deleted account leaves behind (apps/auth-web
# app/legal/privacy/page.tsx, "How long we keep things": up to two years).
# Rows still attached to a live account are never pruned here.
orphan_audit_retention_days="${FRAMEOS_CLOUD_ORPHAN_AUDIT_RETENTION_DAYS:-730}"

# A non-positive retention would flip make_interval into the future and delete
# rows that have not aged out yet.
for pair in "FRAMEOS_CLOUD_CLEANUP_RETENTION_DAYS=$retention_days" \
  "FRAMEOS_CLOUD_FRAME_LOG_RETENTION_DAYS=$log_retention_days" \
  "FRAMEOS_CLOUD_FRAME_METRICS_RETENTION_DAYS=$metrics_retention_days" \
  "FRAMEOS_CLOUD_ORPHAN_AUDIT_RETENTION_DAYS=$orphan_audit_retention_days"; do
  value="${pair#*=}"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ]; then
    echo "${pair%%=*} must be a positive integer, got: ${value}" >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 -v retention_days="$retention_days" \
  -v log_retention_days="$log_retention_days" \
  -v metrics_retention_days="$metrics_retention_days" \
  -v orphan_audit_retention_days="$orphan_audit_retention_days" <<'SQL'
-- The security trail of deleted accounts: audit_events.account_id is
-- ON DELETE SET NULL, so these rows are exactly the ones the privacy policy
-- says outlive the account for up to two years.
DELETE FROM audit_events
WHERE account_id IS NULL
  AND created_at < now() - make_interval(days => :'orphan_audit_retention_days'::int);

DELETE FROM device_authorization_requests
WHERE expires_at < now() - make_interval(days => :'retention_days'::int)
  AND status <> 'pending';

DELETE FROM device_authorization_requests
WHERE status = 'pending'
  AND expires_at < now() - make_interval(days => :'retention_days'::int);

DELETE FROM frameos_login_codes
WHERE expires_at < now() - make_interval(days => :'retention_days'::int);

DELETE FROM sessions
WHERE expires_at < now() - make_interval(days => :'retention_days'::int)
   OR (revoked_at IS NOT NULL
       AND revoked_at < now() - make_interval(days => :'retention_days'::int));

-- Single-use email tokens: a row is spent the moment it is used and worthless
-- the moment it expires (both are ~1 h links). Until this they only grew —
-- one row per password reset ever requested and per signup ever made.
DELETE FROM password_reset_tokens
WHERE expires_at < now() - make_interval(days => :'retention_days'::int)
   OR (used_at IS NOT NULL
       AND used_at < now() - make_interval(days => :'retention_days'::int));

DELETE FROM email_verification_tokens
WHERE expires_at < now() - make_interval(days => :'retention_days'::int)
   OR (used_at IS NOT NULL
       AND used_at < now() - make_interval(days => :'retention_days'::int));

-- Cloud-managed frames: spent/expired claim tokens, finished/expired queue
-- entries, and aged log retention (the per-frame row cap is enforced at
-- insert; this bounds retention by age as well — retained bytes count
-- toward the account's storage usage).
DELETE FROM frame_enrollment_tokens
WHERE (used_at IS NOT NULL AND used_at < now() - make_interval(days => :'retention_days'::int))
   OR expires_at < now() - make_interval(days => :'retention_days'::int);

DELETE FROM frame_commands
WHERE status IN ('acked', 'failed', 'expired')
  AND created_at < now() - make_interval(days => :'retention_days'::int);

-- 'sent' too: a command written to a socket that died before the ack stays
-- undelivered, and the hub redelivers it. Without this a frame that is revoked
-- or never reconnects leaves TTL-less rows behind forever.
UPDATE frame_commands
SET status = 'expired', error = 'expired'
WHERE status IN ('pending', 'sent')
  AND expires_at IS NOT NULL
  AND expires_at < now();

-- Revoked frames themselves are deliberately NOT pruned here: the row is the
-- owner's record of a device that existed, and deleting it takes its logs with
-- it. The quota stops counting them after revokedFrameQuotaGraceMs, so they
-- cost quota nothing. Reaping them (and the revoked linked_clients row, which
-- would cascade to that client's backups) is a data-retention decision.

DELETE FROM frame_logs
WHERE inserted_at < now() - make_interval(days => :'log_retention_days'::int);

-- Metrics samples have the same per-frame cap at insert and, until this
-- line, no age limit at all.
DELETE FROM frame_metrics
WHERE inserted_at < now() - make_interval(days => :'metrics_retention_days'::int);
SQL

echo "Cleanup complete (retention: bookkeeping ${retention_days} days, frame logs ${log_retention_days} days, frame metrics ${metrics_retention_days} days)"
