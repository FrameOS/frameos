#!/usr/bin/env bash
# Make the running pool match slots/*.env: a slot reads its env file (and the
# image, and gha-slot.sh) only when its service starts, so after changing any
# of those every idle slot is restarted here — its waiting VM is destroyed
# and relaunched with the new settings. Slots whose runner is busy are left
# alone and listed; run again until nothing is listed. Slots with an env file
# but no unit are enabled, units whose env file is gone are stopped.
#
# Run as root on the host: sudo /srv/gha-runners/bin/gha-reload-slots.sh
set -euo pipefail
ROOT=/srv/gha-runners
# shellcheck disable=SC1091
. "$ROOT/env/github.env"
API=https://api.github.com/repos/${GITHUB_REPO}
# VM (= runner) names are gha-<slot>-<5 digits><3 alnum>; "big" must not match
# "big-b"'s VMs.
vm_re() { printf '^gha-%s-[0-9]{5}[a-z0-9]{3}$' "$1"; }

gh_api() { curl -fsS "$API$1" -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28"; }
# A waiting runner can be handed a job at any moment, and restarting its slot
# then kills that job ("lost communication with the server" a few minutes
# later — this happened to four PR jobs the first time this ran). So the
# check is per slot, right before the restart, and twice: GitHub's view of
# the runner and the runner's own log line, which appears within a second
# of the assignment.
slot_busy() {
  local slot=$1 vm=$2
  [ -n "$vm" ] || return 1
  [ "$(gh_api "/actions/runners?name=$vm" | jq -r '.runners[0].busy // false')" = true ] && return 0
  journalctl -u "gha-runner@$slot" --since "-3h" -o cat --no-pager 2>/dev/null \
    | grep -qF "[$slot:$vm] $(date -u +%Y)" && journalctl -u "gha-runner@$slot" --since "-3h" -o cat --no-pager \
    | grep -F "[$slot:$vm]" | grep -q "Running job:"
}
vms=$(incus list --format csv -c n)

for env in "$ROOT"/slots/*.env; do
  slot=$(basename "$env" .env)
  if ! systemctl is-enabled -q "gha-runner@$slot" 2>/dev/null; then
    echo "enable  $slot"; systemctl enable --now "gha-runner@$slot"; continue
  fi
  vm=$(grep -E "$(vm_re "$slot")" <<<"$vms" || true)
  if slot_busy "$slot" "$vm"; then
    echo "BUSY    $slot ($vm) — rerun later"; continue
  fi
  echo "restart $slot"; systemctl restart "gha-runner@$slot"
done

for unit in $(systemctl list-units 'gha-runner@*' --all --no-legend --plain | awk '{print $1}'); do
  slot=${unit#gha-runner@}; slot=${slot%.service}
  if [ ! -e "$ROOT/slots/$slot.env" ]; then
    vm=$(grep -E "$(vm_re "$slot")" <<<"$vms" || true)
    if slot_busy "$slot" "$vm"; then
      echo "BUSY    $slot ($vm) — removed from slots/, stop it later"; continue
    fi
    echo "remove  $slot"; systemctl disable --now "$unit"
    # ExecStopPost is what deletes the VM; belt and braces for the disable path.
    [ -n "$vm" ] && incus delete -f "$vm" >/dev/null 2>&1 || true
  fi
done
