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

healthchecks_url="${UPTIME_HEALTHCHECKS_URL:?set UPTIME_HEALTHCHECKS_URL in /etc/frameos-cloud/monitoring.env}"

urls=(
  https://cloud.frameos.net/login
  https://account.frameos.net/
  https://scenes.frameos.net/
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
