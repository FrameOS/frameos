#!/usr/bin/env bash
set -euo pipefail

# Nightly off-box backup for the FrameOS Cloud host. Installed as
# /usr/local/bin/frameos-cloud-backup by ops/backup/install.sh and run daily
# by frameos-cloud-backup.timer. Setup and the restore runbook live in
# cloud/docs/backups.md.
#
# To run manually, use `systemctl start frameos-cloud-backup.service` — do
# NOT execute this script directly: DATABASE_URL and the backup settings
# come from the unit's EnvironmentFiles (/etc/frameos-cloud/auth-web.env +
# backup.env), so a direct invocation falls back to the placeholder
# defaults below and fails database auth.
#
# Two artifacts per run, shipped to a Hetzner Storage Box via rclone:
#
#   db-<stamp>.dump      pg_dump custom format: accounts, frames, scenes and
#                        the metadata of every stored blob. NOT the blob bytes
#                        — scene zips, previews and cached frame snapshots
#                        live in object storage now, and are copied separately
#                        by frameos-cloud-object-backup. A restore needs both.
#   host-<stamp>.tar.gz  the parts of the host that are in neither the repo
#                        nor the database: /etc/frameos-cloud (secrets),
#                        nginx/postgres/pgbackrest/ufw config, letsencrypt
#                        renewal state (not the private keys), the
#                        frameos-cloud systemd units, every /usr/local/bin
#                        script, /root ops scripts and logs, the release
#                        stamps, and a generated rebuild manifest (installed
#                        packages, enabled units, tool versions).
#
# Both are encrypted before they leave the box. The destination must be an
# rclone *crypt* remote (client-side AES, the passphrase lives in
# /root/.config/rclone/rclone.conf and in the password manager — never in a
# backup); the script refuses a plaintext remote so a mis-set RCLONE_REMOTE
# cannot quietly ship the secrets in clear. For the same reason the tarball
# carries no credential that opens the backups themselves: /root/.ssh, the
# rclone config and postgres' copy of the Storage Box key stay out, and so
# do the TLS private keys (certbot reissues them in a minute). All of those
# are recoverable from the laptop / the password manager, which is where a
# whole-box rebuild starts anyway (cloud/docs/backups.md).
#
# Configuration comes from the systemd unit's EnvironmentFiles: auth-web.env
# supplies DATABASE_URL (no second copy of the password to rotate) and
# backup.env supplies the rest:
#
#   RCLONE_REMOTE     rclone crypt destination (default boxcrypt:backups)
#   CAPACITY_REMOTE   the underlying remote whose free space is checked
#                     (default: the crypt remote itself, which passes the
#                     question through to the Storage Box)
#   RETENTION_DAYS    prune remote files older than this (default 30)
#   HEALTHCHECKS_URL  optional hc-ping.com check URL; start/success/fail pings
#   LOCAL_DIR         staging dir (default /var/backups/frameos-cloud)
#   PGBACKREST_STANZA          stanza whose health gates this run (default
#                              frameos); PGBACKREST_MAX_AGE_HOURS how old the
#                              newest base backup may be (default 36; 0 skips
#                              the pgBackRest check entirely)

database_url="${DATABASE_URL:-postgres://frameos_cloud:frameos_cloud@localhost:5432/frameos_cloud}"
rclone_remote="${RCLONE_REMOTE:-boxcrypt:backups}"
capacity_remote="${CAPACITY_REMOTE:-${rclone_remote%%:*}:}"
retention_days="${RETENTION_DAYS:-30}"
healthchecks_url="${HEALTHCHECKS_URL:-}"
local_dir="${LOCAL_DIR:-/var/backups/frameos-cloud}"
pgbackrest_stanza="${PGBACKREST_STANZA:-frameos}"
pgbackrest_max_age_hours="${PGBACKREST_MAX_AGE_HOURS:-36}"
keep_local=2

ping() {
  # $1: "" (success) | "/start" | "/fail"; $2: body shown in the check's log.
  # Never lets a monitoring hiccup fail the backup itself.
  [ -n "$healthchecks_url" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${2:-}" "${healthchecks_url}${1}" || true
}

log_file="$(mktemp)"
on_exit() {
  status=$?
  if [ "$status" -ne 0 ]; then
    ping /fail "$(tail -c 2000 "$log_file")"
  fi
  rm -f "$log_file"
}
trap on_exit EXIT
# Mirror all output into the log so the failure ping can carry the tail of it
# (the journal still gets everything via tee's stdout).
exec > >(tee "$log_file") 2>&1

ping /start ""

# A non-positive retention would prune everything, including last night.
if ! [[ "$retention_days" =~ ^[0-9]+$ ]] || [ "$retention_days" -lt 1 ]; then
  echo "RETENTION_DAYS must be a positive integer, got: ${retention_days}" >&2
  exit 1
fi

# The backups leave the box only encrypted. A crypt remote encrypts file
# names and contents with a key that never reaches the Storage Box, so the
# check is on the remote's type, not on anything the upload could get wrong.
# ALLOW_PLAINTEXT_REMOTE=1 is for a rehearsal VM with no key material — never
# set it in /etc/frameos-cloud/backup.env on the production host.
remote_name="${rclone_remote%%:*}"
if [ "${ALLOW_PLAINTEXT_REMOTE:-0}" != "1" ] &&
  ! rclone config show "$remote_name" 2>/dev/null | grep -qE '^type *= *crypt$'; then
  echo "RCLONE_REMOTE=${rclone_remote} is not an rclone crypt remote — refusing to ship plaintext backups off the box" >&2
  echo "(see cloud/ops/backup/rclone.conf.example for the [boxcrypt] section)" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$local_dir"
chmod 700 "$local_dir"

db_file="$local_dir/db-$stamp.dump"
host_file="$local_dir/host-$stamp.tar.gz"

echo "Dumping database to $db_file"
pg_dump --format=custom --compress=6 --file "$db_file" "$database_url"
chmod 600 "$db_file"

# A dump pg_restore cannot read is not a backup. --list parses the full TOC
# and fails on a truncated or corrupt file, without touching any database.
pg_restore --list "$db_file" >/dev/null
echo "Dump verified ($(du -h "$db_file" | cut -f1))"

# Rebuild manifest: what was installed and enabled, so a fresh box can be
# reconstructed without archaeology. Regenerated every run; travels inside
# the host tarball. Individual probes are best-effort — a missing tool
# should leave a gap in the manifest, not kill the backup.
manifest="$local_dir/manifest.txt"
{
  date -u
  cat /etc/os-release
  uname -a
  echo "--- versions"
  node --version 2>/dev/null
  psql --version
  pgbackrest version 2>/dev/null
  rclone version 2>/dev/null | head -1
  nginx -v 2>&1
  echo "--- enabled units"
  systemctl list-unit-files --state=enabled --no-pager
  echo "--- timers"
  systemctl list-timers --all --no-pager
  echo "--- firewall"
  ufw status verbose 2>/dev/null
  echo "--- packages"
  dpkg --get-selections
} > "$manifest" 2>&1 || true

# Host config: only paths that exist, so a box that predates one of these
# (or never ran certbot) does not fail the whole backup. The list is the
# 2026-08 audit of everything on the box that is in neither the repo nor
# the database, minus (since 2026-09-05) anything that opens the backups or
# is a live private key: /root/.ssh, /root/.config/rclone and postgres'
# .ssh hold the Storage Box key and the crypt passphrase — a backup must
# not contain the credential that decrypts it — and letsencrypt's
# live/archive/keys are TLS private keys that certbot reissues on a fresh
# box (the renewal configs and the ACME account stay in, so `certbot renew`
# knows what to ask for).
host_paths=()
for p in \
  /etc/frameos-cloud \
  /etc/nginx \
  /etc/letsencrypt \
  /etc/postgresql \
  /etc/pgbackrest \
  /etc/ufw \
  /etc/systemd/system/frameos-cloud-*.service \
  /etc/systemd/system/frameos-cloud-*.timer \
  /usr/local/bin \
  /root/CODEX_LOG.md \
  /root/*.sh \
  /root/nginx-backups \
  /opt/frameos-cloud/RELEASE \
  /opt/frameos-cloud/RELEASE_REF \
  "$manifest"; do
  [ -e "$p" ] && host_paths+=("$p")
done
echo "Archiving host config: ${host_paths[*]}"
tar -czf "$host_file" \
  --exclude=/etc/letsencrypt/live \
  --exclude=/etc/letsencrypt/archive \
  --exclude=/etc/letsencrypt/keys \
  "${host_paths[@]}"
chmod 600 "$host_file"

# Belt and braces for the rule above: fail the run if a credential path
# slipped into the archive anyway (a future edit to the list, a symlink).
if tar -tzf "$host_file" | grep -qE '^(root/\.ssh|root/\.config/rclone|var/lib/postgresql/\.ssh|etc/letsencrypt/(live|archive|keys))(/|$)'; then
  echo "the host tarball contains backup credentials or TLS private keys — refusing to upload it" >&2
  exit 1
fi

echo "Uploading to $rclone_remote"
rclone copy "$db_file" "$rclone_remote"
rclone copy "$host_file" "$rclone_remote"

echo "Pruning remote files older than ${retention_days} days"
rclone delete "$rclone_remote" --min-age "${retention_days}d"

# Keep a couple of recent runs on-box for fast restores; the Storage Box is
# the real archive.
for prefix in db host; do
  ls -1t "$local_dir/$prefix"-* 2>/dev/null | tail -n +$((keep_local + 1)) | xargs -r rm -f --
done

# Storage Box fullness, surfaced in every success ping so the healthchecks
# log doubles as a capacity history. Hard-fail below 50 GiB free — months of
# warning at current growth, and a full repo would break WAL archiving too.
box_summary=""
about_json="$(rclone about "$capacity_remote" --json 2>/dev/null | tr -d ' \n\t' || true)"
if [ -n "$about_json" ]; then
  free_bytes="$(printf '%s' "$about_json" | sed -n 's/.*"free":\([0-9]*\).*/\1/p')"
  used_bytes="$(printf '%s' "$about_json" | sed -n 's/.*"used":\([0-9]*\).*/\1/p')"
  if [ -n "$free_bytes" ] && [ -n "$used_bytes" ]; then
    box_summary=" box_used=$((used_bytes / 1024 / 1024))MiB box_free=$((free_bytes / 1024 / 1024 / 1024))GiB"
    if [ "$free_bytes" -lt $((50 * 1024 * 1024 * 1024)) ]; then
      echo "Storage Box is nearly full:${box_summary} — grow the box or tighten retention." >&2
      exit 1
    fi
  fi
fi

# The pgBackRest layer (continuous WAL archiving + daily base backups, the
# one that actually gives point-in-time recovery) has its own timers and,
# until this check, no alarm: a broken archive-push or a stuck base backup
# only showed up to someone running `pgbackrest info` by hand. Fold its
# health into this run so the single healthchecks.io check covers both
# layers — a stale or errored stanza fails the run, which pages. Checked
# LAST so the dump and the host tarball are already shipped when it fires.
# Skipped, loudly, where pgBackRest is not set up (a rehearsal VM, a dev box)
# or with PGBACKREST_MAX_AGE_HOURS=0.
pitr_summary=""
if ! [[ "$pgbackrest_max_age_hours" =~ ^[0-9]+$ ]]; then
  echo "PGBACKREST_MAX_AGE_HOURS must be a non-negative integer, got: ${pgbackrest_max_age_hours}" >&2
  exit 1
fi
if [ "$pgbackrest_max_age_hours" -eq 0 ]; then
  echo "pgBackRest check disabled (PGBACKREST_MAX_AGE_HOURS=0)"
elif ! command -v pgbackrest >/dev/null 2>&1 || [ ! -e /etc/pgbackrest/pgbackrest.conf ]; then
  echo "pgBackRest check skipped: not installed/configured on this host"
  pitr_summary=" pitr=unconfigured"
else
  # Runs as postgres: that user owns the repo key and the stanza lock, and
  # root would leave root-owned files in the spool/lock directories.
  if ! info_json="$(runuser -u postgres -- pgbackrest --stanza="$pgbackrest_stanza" --output=json info 2>&1)"; then
    echo "pgbackrest info failed:" >&2
    echo "$info_json" >&2
    exit 1
  fi
  pitr_summary="$(PGBACKREST_INFO_JSON="$info_json" python3 -c '
import json, os, sys, time
stanza_name = sys.argv[1]
max_age_hours = int(sys.argv[2])
try:
    stanzas = json.loads(os.environ["PGBACKREST_INFO_JSON"])
except ValueError as exc:
    sys.exit("pgbackrest info did not return JSON: %s" % exc)
stanza = next((s for s in stanzas if s.get("name") == stanza_name), None)
if stanza is None:
    sys.exit("stanza %r missing from pgbackrest info" % stanza_name)
status = stanza.get("status") or {}
if status.get("code") != 0:
    sys.exit("stanza %s status: %s (code %s)" % (stanza_name, status.get("message"), status.get("code")))
backups = stanza.get("backup") or []
if not backups:
    sys.exit("stanza %s has no base backups" % stanza_name)
latest = max(backups, key=lambda b: (b.get("timestamp") or {}).get("stop") or 0)
stop = (latest.get("timestamp") or {}).get("stop") or 0
age_hours = (time.time() - stop) / 3600
if age_hours > max_age_hours:
    sys.exit("newest base backup (%s, %s) is %.1f h old, limit %d h — a pgbackrest timer is stuck"
             % (latest.get("label"), latest.get("type"), age_hours, max_age_hours))
if latest.get("error"):
    sys.exit("newest base backup %s is flagged with an error" % latest.get("label"))
archives = stanza.get("archive") or []
wal_max = next((a.get("max") for a in reversed(archives) if a.get("max")), None)
if not wal_max:
    sys.exit("stanza %s has no archived WAL — archive_command is not reaching the repo" % stanza_name)
print(" pitr_latest=%s@%.1fh wal_max=%s" % (latest.get("type"), age_hours, wal_max), end="")
' "$pgbackrest_stanza" "$pgbackrest_max_age_hours")" || {
    echo "pgBackRest health check failed (reason above) — the dump and host tarball were still shipped." >&2
    exit 1
  }
  echo "pgBackRest ok:${pitr_summary}"
fi

summary="ok db=$(du -h "$db_file" | cut -f1) host=$(du -h "$host_file" | cut -f1) remote=$rclone_remote retention=${retention_days}d${box_summary}${pitr_summary}"
echo "Backup complete: $summary"
ping "" "$summary"
