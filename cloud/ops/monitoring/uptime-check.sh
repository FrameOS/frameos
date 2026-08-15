#!/usr/bin/env bash
set -euo pipefail

# Uptime dead-man check for FrameOS Cloud. Installed as
# /usr/local/bin/frameos-cloud-uptime and run every 5 minutes by
# frameos-cloud-uptime.timer; the ping URL comes from
# /etc/frameos-cloud/monitoring.env (the unit's EnvironmentFile).
#
# The trick is that the healthchecks ping is sent ONLY after all public URLs
# answer, so one check catches both failure modes: a broken app sends an
# explicit /fail ping (immediate alert), and a dead box simply stops
# pinging (alert after the check's period + grace). Running on the server
# itself is fine for exactly that reason — if this script can't run, the
# silence IS the signal.
#
# Same URL set and 2xx/3xx rule as scripts/deploy.sh's post-deploy check.
#
# Every URL is /healthz (app/healthz/route.ts), not a page. The check used to
# curl /login and the two site roots, which the App Router renders happily
# with a dead database — so the single failure most worth paging on was the
# one this script could not see. /healthz returns 503 unless it has actually
# reached Postgres. All three hostnames are kept: they are one app behind
# three nginx server blocks, so hitting each still proves each vhost routes.

healthchecks_url="${UPTIME_HEALTHCHECKS_URL:?set UPTIME_HEALTHCHECKS_URL in /etc/frameos-cloud/monitoring.env}"

#
# frame-hub is checked on loopback because nothing else does: it has no
# public URL of its own (nginx only proxies its /api/frames/ws path), so a
# hub that died would leave every connected frame offline while all three
# public checks stayed green. This script runs on the box, so 127.0.0.1 is
# reachable and needs no extra exposure.

urls=(
  https://cloud.frameos.net/healthz
  https://account.frameos.net/healthz
  https://scenes.frameos.net/healthz
  http://127.0.0.1:3100/healthz
)

ok=true
summary=""
for url in "${urls[@]}"; do
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || echo 000)"
  summary="${summary}${summary:+, }${url} -> ${status}"
  case "$status" in
    2* | 3*) ;;
    *) ok=false ;;
  esac
done

if [ "$ok" = true ]; then
  curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "$summary" "$healthchecks_url" || true
  echo "ok: $summary"
else
  curl -fsS -m 10 --retry 2 -o /dev/null --data-raw "$summary" "${healthchecks_url}/fail" || true
  echo "FAIL: $summary" >&2
  exit 1
fi
