#!/bin/sh
# FrameOS network diagnostics for a frame that cannot reach the network.
#
# There is no SSH without networking, so this is built for a keyboard on the
# console and a card you can read on another computer afterwards: copy it to
# the FAT boot partition, then on the frame run
#
#   sh /boot/frameos-netdebug.sh
#
# It writes /boot/frameos-netdebug.txt (plus stdout) and syncs, so pulling the
# card straight afterwards is safe.
#
# Stop the render loop first if it is fighting you for the screen:
#   systemctl stop frameos

out=/boot/frameos-netdebug.txt
[ -w /boot ] || out=/tmp/frameos-netdebug.txt

{
  echo "=== frameos-netdebug $(date 2>/dev/null) ==="
  echo "--- release ---"
  cat /etc/os-release 2>/dev/null | head -3
  readlink -f /srv/frameos/current 2>/dev/null
  /srv/frameos/current/frameos --version 2>/dev/null || true

  echo
  echo "--- tools (MISSING lines are the interesting ones) ---"
  for c in wpa_supplicant wpa_cli wpa_passphrase hostapd hostapd_cli iw \
           dnsmasq udhcpd udhcpc dhcpcd ip rfkill nmcli; do
    p=$(command -v "$c" 2>/dev/null) && echo "ok      $c -> $p" || echo "MISSING $c"
  done

  echo
  echo "--- radio + interfaces ---"
  iw dev 2>&1
  ip -br link 2>&1
  ip -br addr 2>&1
  rfkill list 2>&1
  iw dev wlan0 link 2>&1

  echo
  echo "--- resolver (an address + route but no DNS looks exactly like no network) ---"
  ip route 2>&1
  ls -l /etc/resolv.conf 2>&1
  cat /etc/resolv.conf 2>&1
  grep '^hosts:' /etc/nsswitch.conf 2>/dev/null
  command -v resolvectl >/dev/null 2>&1 && resolvectl status 2>&1
  cat /run/frameos/udhcpc-*.lease 2>/dev/null
  cat /srv/frameos/state/network/udhcpc.script >/dev/null 2>&1 && echo "frameos udhcpc.script: present" || echo "frameos udhcpc.script: MISSING (old binary?)"

  echo
  echo "--- what FrameOS chose (grep for portal:networkBackend) ---"
  journalctl -u frameos --no-pager -n 400 2>/dev/null |
    grep -iE "networkBackend|portal|wifi|wpa|hostapd|dhcp|network|diagnostics" | tail -60
  # Buildroot images without persistent journald: fall back to the file log.
  tail -n 200 /srv/frameos/logs/frameos.log 2>/dev/null |
    grep -iE "networkBackend|portal|wifi|wpa|hostapd|dhcp" | tail -40

  echo
  echo "--- credentials on disk ---"
  echo "NetworkManager keyfiles (useless without NetworkManager, but tell us"
  echo "whether the image personalization delivered your SSID at all):"
  ls -la /etc/NetworkManager/system-connections/ 2>&1
  # SSIDs only, never the PSK.
  grep -h "^ssid=" /etc/NetworkManager/system-connections/* 2>/dev/null
  echo "wpa_supplicant config:"
  ls -la /etc/wpa_supplicant/ /srv/frameos/state/wpa_supplicant/ 2>&1
  grep -h "^[[:space:]]*ssid=" /etc/wpa_supplicant/*.conf \
    /srv/frameos/state/wpa_supplicant/*.conf 2>/dev/null
  echo "generated hotspot config:"
  ls -la /srv/frameos/state/network/ /run/frameos/ 2>&1

  echo
  echo "--- running daemons ---"
  ps w 2>/dev/null | grep -E "wpa_supplicant|hostapd|dnsmasq|udhcp|dhcp|frameos" |
    grep -v grep

  echo
  echo "--- services ---"
  systemctl is-enabled wpa_supplicant.service 2>&1
  systemctl is-active wpa_supplicant.service 2>&1
  systemctl status frameos --no-pager -n 5 2>&1 | head -12

  echo
  echo "--- live probe: can the radio scan at all? ---"
  ip link set wlan0 up 2>&1
  iw dev wlan0 scan 2>&1 | grep -E "^BSS|SSID:" | head -20

  echo "=== end ==="
} 2>&1 | tee "$out"

sync 2>/dev/null
echo
echo "Wrote $out — power off, pull the card, and read it on your computer."
