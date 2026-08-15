#!/usr/bin/env bash
set -euo pipefail

# Rehearsal for frameos-cloud-update. Runs the real script against a fake
# host — stub systemctl / nginx / curl / psql, a throwaway /opt tree — inside
# a Debian container, so the orchestration can be exercised without a server
# and without an outage to learn from.
#
#   cloud/ops/deploy/rehearse.sh
#
# What it proves, in order: the one-time adoption of a pre-blue/green
# /opt/frameos-cloud, that a deploy starts on the idle port and only then
# moves nginx, that consecutive deploys alternate ports, that an unhealthy
# release is refused with traffic left where it was, that a failing migration
# never reaches the flip, that --rollback returns to the previous release,
# and that pruning keeps the pinned releases.
#
# The fakes are the point of failure to keep in mind: they model systemd and
# nginx as this script uses them, not as they are. Anything relying on real
# unit semantics (Restart=, ordering, ProtectSystem) still has to be checked
# on the box.

image="debian:bookworm-slim"

if [ "${1:-}" != "--inside" ]; then
  here="$(cd "$(dirname "$0")" && pwd)"
  echo "Rehearsing in $image"
  exec docker run --rm -v "$here:/deploy:ro" "$image" bash /deploy/rehearse.sh --inside
fi

# --- the fake host ----------------------------------------------------------

state=/tmp/fake
mkdir -p "$state/units" /usr/local/sbin /etc/frameos-cloud /etc/nginx/conf.d

cat >/usr/local/sbin/systemctl <<'FAKE'
#!/usr/bin/env bash
# Models only what frameos-cloud-update asks of systemd: whether a unit is
# active, and starting/stopping/enabling it. A "running" unit is a file.
state=/tmp/fake/units
# Options can appear anywhere in a systemctl command line, so filter them out
# before positional parsing — the script passes `is-active --quiet <unit>`.
quiet=false
now=false
args=()
for arg in "$@"; do
  case "$arg" in
    --quiet | -q) quiet=true ;;
    --now) now=true ;;
    --no-pager | --lines=*) ;;
    *) args+=("$arg") ;;
  esac
done
set -- "${args[@]:-}"
verb="${1:-}"; shift || true
unit="${1:-}"
say() { [ "$quiet" = true ] || echo "$1"; }
case "$verb" in
  is-active) [ -e "$state/$unit.active" ] && { say active; exit 0; }; say inactive; exit 3 ;;
  restart|start) : >"$state/$unit.active"; echo "$unit" >>/tmp/fake/log ;;
  stop) rm -f "$state/$unit.active"; echo "stop $unit" >>/tmp/fake/log ;;
  reload) echo "reload $unit" >>/tmp/fake/log ;;
  enable) : >"$state/$unit.enabled"; [ "$now" = true ] && : >"$state/$unit.active" ;;
  disable) rm -f "$state/$unit.enabled"; [ "$now" = true ] && rm -f "$state/$unit.active" ;;
  # Faithful to the real thing: a unit exists exactly while its file does.
  # Modelling it with a separate marker let the rehearsal miss a rerun where
  # the file had already been moved aside but systemd still knew the name.
  cat) [ -e "/etc/systemd/system/$unit" ] || exit 1; cat "/etc/systemd/system/$unit" ;;
  status) exit 0 ;;
  daemon-reload) : ;;
  show) echo "" ;;
esac
exit 0
FAKE

cat >/usr/local/sbin/nginx <<'FAKE'
#!/usr/bin/env bash
# -t succeeds unless the rehearsal asked it to fail.
[ -e /tmp/fake/nginx-broken ] && { echo "nginx: configuration file test failed" >&2; exit 1; }
exit 0
FAKE

cat >/usr/local/sbin/curl <<'FAKE'
#!/usr/bin/env bash
# Health of 127.0.0.1:<port>/healthz == "the fake unit is active", minus any
# port the rehearsal marked sick. Everything else about curl is ignored.
url="${!#}"
port="$(echo "$url" | sed -n 's|.*127\.0\.0\.1:\([0-9]*\)/.*|\1|p')"
if [ -e "/tmp/fake/sick-$port" ]; then echo -n 503; exit 0; fi
if [ -e "/tmp/fake/units/frameos-cloud-auth-web@$port.service.active" ]; then echo -n 200; exit 0; fi
echo -n 000
exit 0
FAKE

cat >/usr/local/sbin/psql <<'FAKE'
#!/usr/bin/env bash
[ -e /tmp/fake/psql-broken ] && exit 1
cat >/dev/null 2>&1 || true
exit 0
FAKE

# Only ever checked for existence by install.sh; nothing here runs the app.
printf '#!/bin/sh\nexit 0\n' >/usr/local/sbin/node

chmod +x /usr/local/sbin/systemctl /usr/local/sbin/nginx /usr/local/sbin/curl \
  /usr/local/sbin/psql /usr/local/sbin/node
export PATH=/usr/local/sbin:$PATH

install -m 0755 /deploy/frameos-cloud-update /usr/local/bin/frameos-cloud-update
install -m 0644 "/deploy/frameos-cloud-auth-web@.service" /etc/systemd/system/ 2>/dev/null ||
  mkdir -p /etc/systemd/system && install -m 0644 "/deploy/frameos-cloud-auth-web@.service" /etc/systemd/system/
echo "DATABASE_URL=postgres://fake/fake" >/etc/frameos-cloud/auth-web.env

# The frame hub exists on the real host, so model it as installed and up.
printf '[Service]\nExecStart=/bin/true\n' >/etc/systemd/system/frameos-cloud-frame-hub.service
: >"$state/units/frameos-cloud-frame-hub.service.active"

# Deploys are instant here; the drain only slows the rehearsal down.
export FRAMEOS_CLOUD_DRAIN_SECONDS=0
export FRAMEOS_CLOUD_HEALTH_TIMEOUT=10
export FRAMEOS_CLOUD_KEEP_RELEASES=3
export FRAMEOS_CLOUD_SERVICE_USER=root

# --- helpers ----------------------------------------------------------------

failures=0
check() {
  local what="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok   $what"
  else
    echo "  FAIL $what: expected '$expected', got '$actual'"
    failures=$((failures + 1))
  fi
}

# Build a release tarball the way scripts/deploy.sh does. The second argument
# is the frame-hub bundle's contents: identical bytes across two deploys are
# what lets the hub keep running, so the rehearsal has to be able to vary it.
make_bundle() {
  local sha="$1" hub="${2:-// hub v1}" dir
  dir="$(mktemp -d)"
  mkdir -p "$dir/cloud/apps/auth-web" "$dir/cloud/apps/frame-hub/dist" \
    "$dir/cloud/scripts" "$dir/cloud/packages/db/drizzle" "$dir/cloud/ops/deploy"
  echo "// server" >"$dir/cloud/apps/auth-web/server.js"
  echo "$hub" >"$dir/cloud/apps/frame-hub/dist/index.cjs"
  cp /deploy/frameos-cloud-update "$dir/cloud/ops/deploy/frameos-cloud-update"
  cp /deploy/frameos-cloud-deploy-command "$dir/cloud/ops/deploy/"
  cp "/deploy/frameos-cloud-auth-web@.service" "$dir/cloud/ops/deploy/"
  cat >"$dir/cloud/scripts/db-migrate.sh" <<'MIG'
#!/usr/bin/env bash
set -euo pipefail
psql "${DATABASE_URL:?}" -c "select 1" >/dev/null
MIG
  chmod +x "$dir/cloud/scripts/db-migrate.sh"
  echo "$sha" >"$dir/RELEASE"
  printf 'ref rehearsal\ncommit %s\n' "$sha" >"$dir/RELEASE_REF"
  tar -C "$dir" -cf - .
  rm -rf "$dir"
}

deploy() { make_bundle "$1" "${2:-// hub v1}" | frameos-cloud-update --archive -; }

# How many times the frame hub has been restarted so far. The fake systemctl
# appends the unit name on every start/restart.
hub_restarts() { grep -c '^frameos-cloud-frame-hub\.service$' /tmp/fake/log 2>/dev/null || true; }

active_port() { sed -n 's/.*127\.0\.0\.1:\([0-9]*\);.*/\1/p' /etc/nginx/conf.d/frameos-cloud-upstream.conf; }
live_sha() { cat /opt/frameos-cloud/RELEASE; }
running() {
  local n=0 p
  for p in 3000 3001; do
    [ -e "$state/units/frameos-cloud-auth-web@$p.service.active" ] && n=$((n + 1))
  done
  echo "$n"
}

# --- 1. a host that predates all of this ------------------------------------

echo "1. adopting a pre-blue/green /opt/frameos-cloud"
mkdir -p /opt/frameos-cloud/cloud/apps/auth-web
echo "// old server" >/opt/frameos-cloud/cloud/apps/auth-web/server.js
echo "aaaaaaaaaaaa" >/opt/frameos-cloud/RELEASE
: >"$state/units/frameos-cloud-auth-web.service.active" # the legacy unit
deploy bbbbbbbbbbbb >/tmp/out1 2>&1 || { cat /tmp/out1; exit 1; }
check "the old release was adopted, not deleted" "yes" \
  "$([ -n "$(find /opt/frameos-cloud.releases -maxdepth 1 -name 'adopted-*' -print -quit)" ] && echo yes || echo no)"
check "nginx points at the idle port" "3001" "$(active_port)"
check "the new release is live" "bbbbbbbbbbbb" "$(live_sha)"
check "exactly one instance is left running" "1" "$(running)"
check "the instance is pinned to the live release" "$(readlink -f /opt/frameos-cloud)" \
  "$(readlink -f /opt/frameos-cloud.instances/3001)"

# --- 2. consecutive deploys alternate ---------------------------------------

echo "2. a second deploy flips back"
deploy cccccccccccc >/tmp/out2 2>&1 || { cat /tmp/out2; exit 1; }
check "nginx moved to the other port" "3000" "$(active_port)"
check "the new release is live" "cccccccccccc" "$(live_sha)"
check "previous points at the release before it" "bbbbbbbbbbbb" "$(cat /opt/frameos-cloud.previous/RELEASE)"
check "still one instance" "1" "$(running)"
# Deploy 1 restarted the hub (nothing was recorded about it yet); deploy 2
# shipped the same bundle, so the fleet's sockets are left alone. Sections 11
# and 12 exercise the decision on purpose.
check "the frame hub was restarted at least once" "yes" \
  "$([ "$(hub_restarts)" -ge 1 ] && echo yes || echo no)"
check "an unchanged hub bundle was not restarted again" "yes" \
  "$(grep -q 'frame hub bundle is unchanged' /tmp/out2 && echo yes || echo no)"

# --- 3. a release that never becomes healthy --------------------------------

echo "3. an unhealthy release is refused"
: >/tmp/fake/sick-3001
if deploy dddddddddddd >/tmp/out3 2>&1; then
  check "the deploy failed" "yes" "no"
else
  check "the deploy failed" "yes" "yes"
fi
check "traffic never moved" "3000" "$(active_port)"
check "the old release is still live" "cccccccccccc" "$(live_sha)"
check "the failed instance was stopped" "1" "$(running)"
rm -f /tmp/fake/sick-3001

# --- 4. a failing migration never reaches the flip --------------------------

echo "4. a failing migration stops before anything moves"
: >/tmp/fake/psql-broken
if deploy eeeeeeeeeeee >/tmp/out4 2>&1; then
  check "the deploy failed" "yes" "no"
else
  check "the deploy failed" "yes" "yes"
fi
check "traffic never moved" "3000" "$(active_port)"
check "the old release is still live" "cccccccccccc" "$(live_sha)"
check "no half-unpacked release was left behind" "0" \
  "$(find /opt/frameos-cloud.releases -maxdepth 1 -name '.incoming.*' | wc -l | tr -d ' ')"
rm -f /tmp/fake/psql-broken

# --- 5. nginx refusing the config -------------------------------------------

echo "5. nginx refusing the new config leaves the upstream alone"
: >/tmp/fake/nginx-broken
if deploy ffffffffffff >/tmp/out5 2>&1; then
  check "the deploy failed" "yes" "no"
else
  check "the deploy failed" "yes" "yes"
fi
check "the upstream still names the serving port" "3000" "$(active_port)"
check "the old release is still live" "cccccccccccc" "$(live_sha)"
rm -f /tmp/fake/nginx-broken

# --- 6. rollback ------------------------------------------------------------

echo "6. rollback returns to the previous release"
frameos-cloud-update --rollback >/tmp/out6 2>&1 || { cat /tmp/out6; exit 1; }
check "the previous release is live" "bbbbbbbbbbbb" "$(live_sha)"
check "it flipped ports to get there" "3001" "$(active_port)"
check "still one instance" "1" "$(running)"

# --- 7. pruning -------------------------------------------------------------

echo "7. pruning keeps the pinned releases"
deploy 111111111111 >/dev/null 2>&1
deploy 222222222222 >/dev/null 2>&1
deploy 333333333333 >/dev/null 2>&1
kept="$(find /opt/frameos-cloud.releases -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')"
check "old releases were pruned" "yes" "$([ "$kept" -le 4 ] && echo yes || echo no)"
check "the live release survived pruning" "333333333333" "$(live_sha)"
check "the previous release survived pruning" "yes" \
  "$([ -f /opt/frameos-cloud.previous/RELEASE ] && echo yes || echo no)"

# --- 8. the one-time installer ----------------------------------------------

echo "8. install.sh converts a legacy host without moving traffic first"
# Back to a host that has never seen any of this.
rm -rf /opt/frameos-cloud /opt/frameos-cloud.releases /opt/frameos-cloud.instances \
  /opt/frameos-cloud.previous /etc/nginx/conf.d/frameos-cloud-upstream.conf \
  /etc/frameos-cloud/active-port /etc/systemd/system/frameos-cloud-auth-web@.service
rm -f "$state"/units/frameos-cloud-auth-web@*
mkdir -p /opt/frameos-cloud/cloud/apps/auth-web /etc/nginx/sites-enabled /etc/nginx/snippets
echo "// old server" >/opt/frameos-cloud/cloud/apps/auth-web/server.js
echo "999999999999" >/opt/frameos-cloud/RELEASE
# Shaped like production: the proxy_pass lives in a snippet that every
# location includes, not inline in the vhost.
cat >/etc/nginx/sites-enabled/frameos <<'VHOST'
server {
    server_name cloud.frameos.net;
    include /etc/nginx/snippets/frameos-frame-hub.conf;
    location / {
        include /etc/nginx/snippets/frameos-cloud-proxy.conf;
    }
}
VHOST
cat >/etc/nginx/snippets/frameos-cloud-proxy.conf <<'SNIP'
proxy_pass http://127.0.0.1:3000;
proxy_set_header Host $host;
SNIP
cat >/etc/nginx/snippets/frameos-frame-hub.conf <<'SNIP'
location = /api/frames/ws {
    proxy_pass http://127.0.0.1:3100;
}
SNIP
cat >/etc/systemd/system/frameos-cloud-auth-web.service <<'UNIT'
[Service]
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/frameos-cloud/cloud/apps/auth-web/server.js
UNIT
: >"$state/units/frameos-cloud-auth-web.service.active"

bash /deploy/install.sh --dry-run >/tmp/out8dry 2>&1 ||
  check "the dry run succeeded" "yes" "no"
check "the dry run changed no config" "yes" \
  "$(grep -q 'proxy_pass http://127.0.0.1:3000;' /etc/nginx/snippets/frameos-cloud-proxy.conf && echo yes || echo no)"

bash /deploy/install.sh >/tmp/out8 2>&1 || { cat /tmp/out8; exit 1; }
check "the proxy snippet names the upstream" "yes" \
  "$(grep -q 'proxy_pass http://frameos_cloud_auth_web;' /etc/nginx/snippets/frameos-cloud-proxy.conf && echo yes || echo no)"
check "the hub's own proxy_pass was left alone" "yes" \
  "$(grep -q 'proxy_pass http://127.0.0.1:3100;' /etc/nginx/snippets/frameos-frame-hub.conf && echo yes || echo no)"
check "a backup of the snippet was kept" "yes" \
  "$([ -f /etc/nginx/snippets/frameos-cloud-proxy.conf.pre-blue-green ] && echo yes || echo no)"
check "traffic moved to the idle port" "3001" "$(active_port)"
check "the legacy unit was retired" "no" \
  "$([ -e "$state/units/frameos-cloud-auth-web.service.active" ] && echo yes || echo no)"
check "the legacy unit file was kept as a backup" "yes" \
  "$([ -f /etc/systemd/system/frameos-cloud-auth-web.service.pre-blue-green ] && echo yes || echo no)"
check "one templated instance is running" "1" "$(running)"
check "the adopted release is what it serves" "999999999999" "$(live_sha)"

echo "9. rerunning the installer does not eat its own backup"
# The first production run failed halfway and had to be rerun; the second
# pass found the untouched backup and rewrote that too.
bash /deploy/install.sh >/tmp/out9i 2>&1 || { cat /tmp/out9i; exit 1; }
check "the backup still holds the original config" "yes" \
  "$(grep -q 'proxy_pass http://127.0.0.1:3000;' /etc/nginx/snippets/frameos-cloud-proxy.conf.pre-blue-green && echo yes || echo no)"
check "no backup of a backup was made" "0" \
  "$(find /etc/nginx/snippets -name '*.pre-blue-green.pre-blue-green' | wc -l | tr -d ' ')"

echo "10. and the next deploy on the converted host is normal"
before="$(active_port)"
deploy 444444444444 >/tmp/out9 2>&1 || { cat /tmp/out9; exit 1; }
check "traffic flipped to the other port" "yes" \
  "$([ "$(active_port)" != "$before" ] && echo yes || echo no)"
check "the new release is live" "444444444444" "$(live_sha)"

# --- 11. the frame hub is left alone when it did not change -----------------

# Most merges do not touch apps/frame-hub, and restarting it drops every
# device socket in the fleet for minutes. Since deploys are automatic, that
# cost has to be paid only when the hub bundle actually differs.
echo "11. an unchanged frame hub survives a deploy"
before_restarts="$(hub_restarts)"
deploy 555555555555 >/tmp/out11 2>&1 || { cat /tmp/out11; exit 1; }
check "the release still went live" "555555555555" "$(live_sha)"
check "the hub was not restarted" "$before_restarts" "$(hub_restarts)"
check "and the deploy said so" "yes" \
  "$(grep -q 'frame hub bundle is unchanged' /tmp/out11 && echo yes || echo no)"

# --- 12. and restarted when it did ------------------------------------------

echo "12. a changed frame hub is restarted"
before_restarts="$(hub_restarts)"
deploy 666666666666 "// hub v2" >/tmp/out12 2>&1 || { cat /tmp/out12; exit 1; }
check "the hub was restarted once" "$((before_restarts + 1))" "$(hub_restarts)"
check "the recorded hash is the new bundle's" "yes" \
  "$([ "$(cat /etc/frameos-cloud/frame-hub-bundle.sha256)" = \
    "$(sha256sum /opt/frameos-cloud/cloud/apps/frame-hub/dist/index.cjs | cut -d' ' -f1)" ] &&
    echo yes || echo no)"
# The next deploy of the same bundle skips again — the marker tracks what the
# process is running, not what the previous release happened to contain.
before_restarts="$(hub_restarts)"
deploy 777777777777 "// hub v2" >/tmp/out12b 2>&1 || { cat /tmp/out12b; exit 1; }
check "the following deploy left it alone" "$before_restarts" "$(hub_restarts)"

# --- 13. two deploys at once ------------------------------------------------

# A manual deploy and a CI deploy can now collide. Interleaving them would
# race the idle port, the nginx upstream and the instance symlinks.
echo "13. a concurrent deploy is refused rather than interleaved"
if ! command -v flock >/dev/null 2>&1; then
  check "flock is available to test the lock" "yes" "no"
else
  (
    flock 9
    : >/tmp/fake/lock-held
    sleep 5
  ) 9>/run/lock/frameos-cloud-update.lock &
  holder=$!
  while [ ! -e /tmp/fake/lock-held ]; do sleep 0.1; done

  port_before="$(active_port)"
  sha_before="$(live_sha)"
  export FRAMEOS_CLOUD_LOCK_WAIT=1
  if deploy 888888888888 >/tmp/out13 2>&1; then
    check "the second deploy was refused" "yes" "no"
  else
    check "the second deploy was refused" "yes" "yes"
  fi
  unset FRAMEOS_CLOUD_LOCK_WAIT
  check "it said why" "yes" \
    "$(grep -q 'another deploy' /tmp/out13 && echo yes || echo no)"
  check "traffic never moved" "$port_before" "$(active_port)"
  check "the live release is untouched" "$sha_before" "$(live_sha)"
  wait "$holder"
  rm -f /tmp/fake/lock-held

  # And the queue drains: the same deploy works once the lock is free.
  deploy 888888888888 >/tmp/out13b 2>&1 || { cat /tmp/out13b; exit 1; }
  check "it succeeds once the lock is free" "888888888888" "$(live_sha)"
fi

# --- 14. the forced command the CI deploy key is pinned to ------------------

# This is the whole difference between a leaked Actions secret that can
# deploy and one that has a root shell on the box, so the refusals are worth
# asserting rather than assuming.
echo "14. the deploy key's forced command allows only the deploy commands"
install -m 0755 /deploy/frameos-cloud-deploy-command /usr/local/bin/frameos-cloud-deploy-command
wrapper_says() {
  SSH_ORIGINAL_COMMAND="$1" SSH_CONNECTION="203.0.113.1 1 203.0.113.2 22" \
    /usr/local/bin/frameos-cloud-deploy-command >/dev/null 2>&1 && echo allowed || echo refused
}
check "--status is allowed" "allowed" "$(wrapper_says 'frameos-cloud-update --status')"
check "--release-ref is allowed" "allowed" "$(wrapper_says 'frameos-cloud-update --release-ref')"
check "an interactive session is refused" "refused" "$(wrapper_says '')"
check "a shell is refused" "refused" "$(wrapper_says '/bin/bash')"
check "reading the env file is refused" "refused" "$(wrapper_says 'cat /etc/frameos-cloud/auth-web.env')"
check "a chained command is refused" "refused" \
  "$(wrapper_says 'frameos-cloud-update --status; cat /etc/shadow')"
check "an unlisted subcommand is refused" "refused" \
  "$(wrapper_says 'frameos-cloud-update --activate /tmp/evil')"
check "a prefix of an allowed command is refused" "refused" \
  "$(wrapper_says 'frameos-cloud-update --statusx')"
# And the self-update keeps the box's copy equal to the release's.
sed -i 's/^# Rotate it like any other prod secret\./# Rotate it like any other prod secret. (edited on the box)/' \
  /usr/local/bin/frameos-cloud-deploy-command
deploy 999999999999 "// hub v2" >/tmp/out14 2>&1 || { cat /tmp/out14; exit 1; }
check "a drifted wrapper is restored from the release" "yes" \
  "$(cmp -s /usr/local/bin/frameos-cloud-deploy-command /deploy/frameos-cloud-deploy-command &&
    echo yes || echo no)"

echo
frameos-cloud-update --status
echo "release ref:      $(frameos-cloud-update --release-ref)"
check "--release-ref prints just the ref" "rehearsal" "$(frameos-cloud-update --release-ref)"
echo
if [ "$failures" -eq 0 ]; then
  echo "rehearsal passed"
else
  echo "rehearsal FAILED: $failures check(s)" >&2
  exit 1
fi
