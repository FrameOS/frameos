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
#   db-<stamp>.dump      pg_dump custom format. Every byte of user data —
#                        accounts, frames, scenes, uploaded asset contents
#                        (bytea columns) — lives in Postgres, so this is the
#                        entire data backup.
#   host-<stamp>.tar.gz  the parts of the host that are in neither the repo
#                        nor the database: /etc/frameos-cloud (secrets),
#                        nginx/postgres/pgbackrest/ufw config, letsencrypt
#                        state, the frameos-cloud systemd units, every
#                        /usr/local/bin script, /root ops scripts and logs,
#                        the rclone/SSH backup credentials, the release
#                        stamps, and a generated rebuild manifest (installed
#                        packages, enabled units, tool versions).
#
# Configuration comes from the systemd unit's EnvironmentFiles: auth-web.env
# supplies DATABASE_URL (no second copy of the password to rotate) and
# backup.env supplies the rest:
#
#   RCLONE_REMOTE     rclone destination (default storagebox:frameos-cloud-backups)
#   RETENTION_DAYS    prune remote files older than this (default 30)
#   HEALTHCHECKS_URL  optional hc-ping.com check URL; start/success/fail pings
#   LOCAL_DIR         staging dir (default /var/backups/frameos-cloud)

database_url="${DATABASE_URL:-postgres://frameos_cloud:frameos_cloud@localhost:5432/frameos_cloud}"
rclone_remote="${RCLONE_REMOTE:-storagebox:frameos-cloud-backups}"
retention_days="${RETENTION_DAYS:-30}"
healthchecks_url="${HEALTHCHECKS_URL:-}"
local_dir="${LOCAL_DIR:-/var/backups/frameos-cloud}"
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
# the database; /root/.ssh and the rclone config are the backup credentials
# themselves — needed to rebuild the box's access, and no more sensitive
# than the env secrets already in the tarball.
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
  /root/.ssh \
  /root/.config/rclone \
  /var/lib/postgresql/.ssh \
  /root/CODEX_LOG.md \
  /root/*.sh \
  /root/nginx-backups \
  /opt/frameos-cloud/RELEASE \
  /opt/frameos-cloud/RELEASE_REF \
  "$manifest"; do
  [ -e "$p" ] && host_paths+=("$p")
done
echo "Archiving host config: ${host_paths[*]}"
tar -czf "$host_file" "${host_paths[@]}"
chmod 600 "$host_file"

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
about_json="$(rclone about "${rclone_remote%%:*}:" --json 2>/dev/null | tr -d ' \n\t' || true)"
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

summary="ok db=$(du -h "$db_file" | cut -f1) host=$(du -h "$host_file" | cut -f1) remote=$rclone_remote retention=${retention_days}d${box_summary}"
echo "Backup complete: $summary"
ping "" "$summary"
