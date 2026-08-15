#!/usr/bin/env bash
set -euo pipefail

# One-time server-side install of the zero-downtime deploy machinery. Run as
# root ON the production host, from a copy of this directory:
#
#   cloud/scripts/install-deploy.sh          # copies and runs this for you
#
# It converts a host that restarts one auth-web process in place into the
# two-instance blue/green layout described in
# cloud/ops/deploy/frameos-cloud-update, and it does so without an outage of
# its own: traffic keeps flowing on the legacy process until the new instance
# is up and healthy on the other port.
#
# Order matters, and every step is reversible until the last one:
#
#   1. install frameos-cloud-update and the templated unit
#   2. add the nginx upstream, still pointing at the legacy port
#   3. repoint the vhosts at that upstream (backups kept, nginx -t gated)
#   4. reload nginx — still the legacy process, nothing has moved
#   5. --activate the current release, which brings it up on the idle port,
#      health-checks it, and flips the upstream
#   6. only then stop and disable the legacy unit
#
# --dry-run prints what would change and touches nothing.

here="$(cd "$(dirname "$0")" && pwd)"

legacy_unit="frameos-cloud-auth-web.service"
unit_name="frameos-cloud-auth-web@.service"
unit_dir="/etc/systemd/system"
bin_path="/usr/local/bin/frameos-cloud-update"
upstream_file="/etc/nginx/conf.d/frameos-cloud-upstream.conf"
upstream_name="frameos_cloud_auth_web"
app_link="/opt/frameos-cloud"
releases_dir="/opt/frameos-cloud.releases"
instances_dir="/opt/frameos-cloud.instances"
legacy_port=3000

dry_run=false
[ "${1:-}" = "--dry-run" ] && dry_run=true

log() { echo "[install] $*"; }
die() {
  echo "[install] $*" >&2
  exit 1
}
run() {
  if [ "$dry_run" = true ]; then
    echo "[install] would run: $*"
  else
    "$@"
  fi
}

[ "$(id -u)" -eq 0 ] || die "must run as root on the production host"
command -v nginx >/dev/null || die "nginx not found; this installer assumes nginx fronts the app"
command -v node >/dev/null || die "node not found"
[ -f "$here/frameos-cloud-update" ] || die "run this from a copy of cloud/ops/deploy"

# --- 0. show what the legacy unit does, so nothing is silently dropped ------

if systemctl cat "$legacy_unit" >/dev/null 2>&1; then
  log "the current $legacy_unit is:"
  systemctl cat "$legacy_unit" | sed 's/^/    /'
  echo
  log "the templated unit replacing it is:"
  sed 's/^/    /' "$here/$unit_name"
  echo
  log "compare Environment=, EnvironmentFile=, ReadWritePaths= and User= above."
  log "anything the old unit had and the new one does not will be lost."
  if [ "$dry_run" = false ] && [ -t 0 ]; then
    read -r -p "[install] continue? [y/N] " reply
    case "$reply" in
      y | Y) ;;
      *) die "aborted" ;;
    esac
  fi
  legacy_port="$(systemctl show -p Environment --value "$legacy_unit" 2>/dev/null |
    tr ' ' '\n' | sed -n 's/^PORT=//p' | head -n 1)"
  legacy_port="${legacy_port:-3000}"
else
  log "no $legacy_unit installed; assuming a fresh host"
fi
log "the port currently serving traffic is ${legacy_port}"
[ "$legacy_port" = "3000" ] || [ "$legacy_port" = "3001" ] ||
  die "the blue/green pair is 3000/3001; PORT=${legacy_port} needs frameos-cloud-update's \$ports changed too"

# --- 1. the deploy script and the templated unit ----------------------------

log "installing $bin_path"
run install -m 0755 "$here/frameos-cloud-update" "$bin_path"

log "installing $unit_dir/$unit_name"
run install -m 0644 "$here/$unit_name" "$unit_dir/$unit_name"
run systemctl daemon-reload

run mkdir -p "$releases_dir" "$instances_dir"

# --- 2. the upstream, still aimed where traffic already is ------------------

if [ ! -e "$upstream_file" ]; then
  log "writing $upstream_file (server 127.0.0.1:${legacy_port})"
  if [ "$dry_run" = false ]; then
    cat >"$upstream_file" <<UPSTREAM
# Managed by frameos-cloud-update. Edits are overwritten on every deploy;
# change cloud/ops/deploy/ in the repo instead.
upstream ${upstream_name} {
    server 127.0.0.1:${legacy_port};
}
UPSTREAM
  fi
else
  log "$upstream_file already exists; leaving it alone"
fi

# --- 3. point the vhosts at the upstream ------------------------------------

# The config proxies to a literal 127.0.0.1:3000 today. It has to name the
# upstream instead, because that is the single place a deploy can move
# traffic from. Backups are kept next to each file and nginx -t gates the
# change, so a mangled config is reverted rather than reloaded.
#
# snippets/ is in the list because that is where production keeps it: one
# snippets/frameos-cloud-proxy.conf holds the proxy_pass and every location
# in every vhost includes it. Searching only sites-enabled and conf.d would
# find nothing and stop with a confusing "point one at the upstream by hand".
patched=()
mapfile -t candidates < <(
  find /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/nginx/snippets \
    -type f -o -type l 2>/dev/null | sort -u
)
for conf in "${candidates[@]}"; do
  [ "$conf" = "$upstream_file" ] && continue
  # Never patch our own backups. A rerun of this installer would otherwise
  # find the untouched .pre-blue-green copy, rewrite it, and back THAT up as
  # .pre-blue-green.pre-blue-green — leaving the file named "the original"
  # holding something that never was.
  case "$conf" in *.pre-blue-green) continue ;; esac
  grep -q "proxy_pass http://127\.0\.0\.1:${legacy_port};" "$conf" 2>/dev/null || continue
  log "repointing $(readlink -f "$conf") at upstream ${upstream_name}"
  if [ "$dry_run" = false ]; then
    real="$(readlink -f "$conf")"
    # Keep the first backup: it is the only copy of the pre-blue/green config.
    [ -e "${real}.pre-blue-green" ] || cp -p "$real" "${real}.pre-blue-green"
    sed -i "s|proxy_pass http://127\.0\.0\.1:${legacy_port};|proxy_pass http://${upstream_name};|g" "$real"
    patched+=("$real")
  fi
done

if [ "${#patched[@]}" -eq 0 ] && [ "$dry_run" = false ]; then
  grep -rq "proxy_pass http://${upstream_name};" /etc/nginx 2>/dev/null ||
    die "no vhost proxies to 127.0.0.1:${legacy_port}; point one at http://${upstream_name} by hand and rerun"
fi

if [ "$dry_run" = false ]; then
  if ! nginx -t; then
    # cp, not mv: the backup is the only copy of the original config and has
    # to survive the revert too.
    for real in "${patched[@]}"; do
      cp -p "${real}.pre-blue-green" "$real"
    done
    die "nginx rejected the patched config; reverted, nothing changed"
  fi
  log "reloading nginx (still serving from ${legacy_port})"
  systemctl reload nginx
fi

# --- 4. hand the current release to a templated instance --------------------

[ -e "$app_link" ] || die "$app_link does not exist; deploy once the old way first"

log "activating the current release on the idle port"
run "$bin_path" --activate "$app_link"

# --- 5. retire the legacy unit ----------------------------------------------

if systemctl cat "$legacy_unit" >/dev/null 2>&1; then
  log "stopping and disabling $legacy_unit (traffic has already moved)"
  # `disable` warns and exits non-zero for a unit with no [Install] section,
  # which must not abort the install one step from the end — the stop is the
  # part that matters, and the unit file is moved aside right after.
  run systemctl disable --now "$legacy_unit" || run systemctl stop "$legacy_unit" || true
  # Guarded: a rerun after a half-finished install finds systemd still aware
  # of a unit whose file has already been moved aside.
  if [ -f "$unit_dir/$legacy_unit" ]; then
    run mv -f "$unit_dir/$legacy_unit" "$unit_dir/${legacy_unit}.pre-blue-green"
  fi
  run systemctl daemon-reload
fi

if [ "$dry_run" = false ]; then
  echo
  "$bin_path" --status
  echo
  log "done. deploys are now zero-downtime: pnpm deploy:prod"
  log "rollback at any time: frameos-cloud-update --rollback"
fi
