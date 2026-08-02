#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Prunes rows that only exist for protocol bookkeeping and accumulate without
# bound: finished/expired device authorization requests, expired login handoff
# codes, and expired or revoked sessions. Audit and consent events are kept.
# Run periodically (e.g. daily via cron); see docs/operational-runbooks.md.

database_url="${DATABASE_URL:-postgres://frameos_cloud:frameos_cloud@localhost:5432/frameos_cloud}"
retention_days="${FRAMEOS_CLOUD_CLEANUP_RETENTION_DAYS:-7}"

# A non-positive retention would flip make_interval into the future and delete
# rows that have not aged out yet.
if ! [[ "$retention_days" =~ ^[0-9]+$ ]] || [ "$retention_days" -lt 1 ]; then
  echo "FRAMEOS_CLOUD_CLEANUP_RETENTION_DAYS must be a positive integer, got: ${retention_days}" >&2
  exit 1
fi

psql "$database_url" -v ON_ERROR_STOP=1 -v retention_days="$retention_days" <<'SQL'
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

UPDATE frame_commands
SET status = 'expired', error = 'expired'
WHERE status = 'pending'
  AND expires_at IS NOT NULL
  AND expires_at < now();

DELETE FROM frame_logs
WHERE inserted_at < now() - make_interval(days => :'retention_days'::int);
SQL

echo "Cleanup complete (retention: ${retention_days} days)"
