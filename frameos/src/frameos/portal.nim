# frameos/src/frameos/portal.nim
## Captive-portal helper for FrameOS – Raspberry Pi 5
import os, osproc, times, strformat, httpclient, json, strutils
import frameos/types

# ──────────────────────────────────────────────────────────────────────────────
#  Settings
# ──────────────────────────────────────────────────────────────────────────────
const
  setupSsid* = "FrameOS-Setup"
  setupPassword* = "frame1234"
  nmHotspotName = "frameos-hotspot" ## NetworkManager connection ID
  credentialsFile* = "/tmp/frameos_wifi_credentials.json"

# ──────────────────────────────────────────────────────────────────────────────
#  Globals & helpers
# ──────────────────────────────────────────────────────────────────────────────
var active* = false
var logger: Logger
var staleCleanupDone = false ## ensure we kill stale hotspot only once

proc setLogger*(l: Logger) = logger = l

proc pLog(ev: string, extra: JsonNode = %*{}) =
  {.gcsafe.}:
    let payload = copy(extra); payload["event"] = %*(ev)
    if logger != nil: logger.log(payload) else: echo "[portal] ", ev, " ", $extra

proc run(cmd: string): (string, int) =
  let (output, code) = execCmdEx("bash -c '" & cmd & "'")
  pLog("portal:exec", %*{"cmd": cmd, "code": code, "out": output.strip()})
  (output, code)

# ──────────────────────────────────────────────────────────────────────────────
#  Hot-spot state helpers
# ──────────────────────────────────────────────────────────────────────────────
proc hotspotRunning(): bool =
  ## True when NetworkManager reports our “frameos-hotspot” as active
  let (output, _) =
    run("sudo nmcli --colors no -t -f NAME connection show --active | grep '^" &
        nmHotspotName & "$' || true")
  return output.strip().len > 0

proc stopApForce*() =
  ## Force-kill the hotspot even if *this* process never set `active = true`.
  if not hotspotRunning(): return
  pLog("portal:stopAp:stale")
  discard run("sudo nmcli connection down '" & nmHotspotName & "' || true")
  discard run("sudo nmcli connection delete '" & nmHotspotName & "' || true")
  for proto in ["tcp", "udp"]:
    discard run("sudo iptables -t nat -D PREROUTING -i wlan0 -p " & proto &
                " -j REDIRECT --to-ports 8787 || true")
  active = false
  pLog("portal:stopAp:staleDone")

proc isLanConnected*(): bool =
  ## Returns true when *any* ethernet interface reports “connected”.
  ## NetworkManager abstracts away eth0 / enxXXXX names for us.
  let (output, _) = run("sudo nmcli --colors no -t -f DEVICE,TYPE,STATE dev | grep ':ethernet:' || true")
  for line in output.strip().splitLines:
    # DEVICE:TYPE:STATE  → want STATE=="connected"
    let parts = line.split(":")
    if parts.len >= 3 and parts[2] == "connected":
      return true
  return false

proc wifiProfilesPresent(): bool =
  ## True if NetworkManager has at least one *non-hotspot* Wi-Fi profile.
  let (output, _) = run("sudo nmcli -f NAME,TYPE connection show | grep wifi | grep -v '" & nmHotspotName & "' || true")
  return output.strip().len > 0

proc networkUp(url: string, timeout = 3000): bool =
  let c = newHttpClient(timeout = timeout)
  try: result = c.get(url).status.startsWith("200")
  except: result = false
  finally: c.close()

# ──────────────────────────────────────────────────────────────────────────────
#  Wi-Fi / NetworkManager helpers
# ──────────────────────────────────────────────────────────────────────────────
type WlanState = enum wsDisconnected, wsConnecting, wsConnected, wsUnknown

proc getWlanState(): WlanState =
  let (output, _) = run("sudo nmcli --colors no -t -f DEVICE,STATE dev | grep '^wlan0:' || true")
  let raw = output.strip()
  pLog("wlanState", %*{"line": raw})
  if raw.len == 0: return wsUnknown
  let parts = raw.split(":")
  if parts.len < 2: return wsUnknown
  case parts[1]
  of "connected": wsConnected
  of "activating": wsConnecting
  of "config": wsConnecting
  of "disconnected": wsDisconnected
  else: wsUnknown

# ──────────────────────────────────────────────────────────────────────────────
#  Hot-spot via NM
# ──────────────────────────────────────────────────────────────────────────────

proc startAp*() =
  if active: return
  pLog("portal:startAp")
  discard run("sudo nmcli connection delete '" & nmHotspotName & "' 2>/dev/null || true")

  # create hotspot
  let cmd = fmt"sudo nmcli device wifi hotspot ifname wlan0 con-name '{nmHotspotName}' " &
            fmt"ssid '{setupSsid}' password '{setupPassword}'"
  if (run(cmd)[1]) != 0:
    pLog("portal:startAp:error")
    return

  # force shared method (dnsmasq + NAT)
  discard run("sudo nmcli connection modify '" & nmHotspotName & "' ipv4.method shared")

  # redirect *all* traffic from hotspot clients to port 8787 ──
  let port = 8787
  for proto in ["tcp", "udp"]:
    discard run(fmt"sudo iptables -t nat -D PREROUTING -i wlan0 -p {proto} -j REDIRECT --to-ports {port} || true")
    discard run(fmt"sudo iptables -t nat -A PREROUTING -i wlan0 -p {proto} -j REDIRECT --to-ports {port}")
  active = true
  pLog("portal:startAp:done")

proc stopAp*() =
  if not active: return
  pLog("portal:stopAp")
  discard run("sudo nmcli connection down '" & nmHotspotName & "' || true")
  discard run("sudo nmcli connection delete '" & nmHotspotName & "' || true")
  for proto in ["tcp", "udp"]:
    discard run("sudo iptables -t nat -D PREROUTING -i wlan0 -p " & proto &
                " -j REDIRECT --to-ports 8787 || true")
  active = false
  pLog("portal:stopAp:done")

proc attemptConnect(ssid, pwd: string): bool =
  run(fmt"sudo nmcli device wifi connect '{ssid}' password '{pwd}' name 'frameos-wifi'")[1] == 0

# ──────────────────────────────────────────────────────────────────────────────
#  UI helpers
# ──────────────────────────────────────────────────────────────────────────────
proc getStatusMessage*(): string =
  if active: fmt"Not connected — join “{setupSsid}” (pw “{setupPassword}”)" else: ""

proc setupHtml*(): string = fmt"""
<!doctype html><html><head><meta charset="utf-8"><title>FrameOS Setup</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:2rem auto;">
 <h1>Connect your Frame to Wi-Fi</h1>
 <p>Join “<b>{setupSsid}</b>” (password <code>{setupPassword}</code>) and enter your Wi-Fi below.</p>
 <form method="post" action="/setup">
   <label>Wi-Fi SSID<br><input name="ssid" required style="width:100%"></label><br><br>
   <label>Password<br><input type="password" name="password" style="width:100%"></label><br><br>
   <label>Server URL (optional)<br><input name="server" value="http://" style="width:100%"></label><br><br>
   <button type="submit">Save & Connect</button>
 </form></body></html>"""


# ──────────────────────────────────────────────────────────────────────────────
#  connectivity logic
# ──────────────────────────────────────────────────────────────────────────────
proc waitForNormalWifi(url: string, timeout: float): bool =
  pLog("networkCheck:start", %*{"url": url, "timeout": timeout})
  let start = epochTime()
  var attempt = 1
  var idleSecs = 0 # consecutive seconds with wlan0==disconnected/unknown

  while timeout <= 0 or epochTime() - start < timeout:
    # ----- wired ethernet always wins ---------------------------------------
    if isLanConnected() and networkUp(url):
      pLog("networkCheck:lanConnected")
      return true

    let st = getWlanState()
    let upOk = networkUp(url) # HTTP ping through default route
    pLog("networkCheck:tick", %*{
      "attempt": attempt,
      "wlanState": $st,
      "netPing": upOk,
      "idleSecs": idleSecs})

    # ----- Success only if Wi-Fi itself is up -----
    if st == wsConnected and upOk:
      pLog("networkCheck:success", %*{"attempt": attempt})
      return true # ready to proceed without captive portal

    # ----- Track “no activity” on wlan0 -----------
    if st in [wsDisconnected, wsUnknown]:
      inc(idleSecs)
      # when we don’t even have profiles, start AP much sooner
      let limit = if wifiProfilesPresent(): 10 else: 3
      if idleSecs >= limit:
        pLog("networkCheck:noActivity") # bail out early
        break
    else:
      idleSecs = 0 # reset on 'connecting/connected'

    sleep(1000)
    inc(attempt)

  pLog("networkCheck:timeout") # will trigger hotspot
  false

proc ensureConnection*(url: string, timeout: float): bool =
  ## 0️⃣  Wired ethernet present?  Nothing else to do, also shut AP if running.
  if isLanConnected() and networkUp(url):
    pLog("networkCheck:lanAtBoot")
    if not staleCleanupDone:
      stopApForce() ## kill any leftover hotspot from a crashed run
      staleCleanupDone = true
    else:
      stopAp() ## normal tidy-up for a hotspot we created this run
    return true

  ## Quick path: no saved Wi-Fi profiles ⇒ bring up hotspot immediately.
  if not wifiProfilesPresent():
    pLog("networkCheck:noProfiles")
    startAp()
    return false

  ## 1️⃣ wait up to `timeout` sec, unless wlan0 sits idle
  if waitForNormalWifi(url, timeout): return true

  ## 2️⃣ captive portal
  startAp()
  var lastCredTime: Time
  let begin = epochTime()
  while epochTime() - begin < 600: # 10 min failsafe
    # LAN cable plugged in while hotspot is up → stop AP & succeed
    if isLanConnected() and networkUp(url):
      pLog("portal:lanConnected")
      stopAp()
      return true
    if fileExists(credentialsFile):
      let fi = getFileInfo(credentialsFile)
      if fi.lastWriteTime != lastCredTime: # new credentials
        lastCredTime = fi.lastWriteTime
        let creds = parseFile(credentialsFile)
        let ssid = creds["ssid"].getStr()
        let pwd = creds["password"].getStr()
        pLog("portal:creds", %*{"ssid": ssid})

        stopAp()
        if attemptConnect(ssid, pwd):
          sleep(5000)
          if networkUp(url):
            pLog("portal:connected")
            removeFile(credentialsFile)
            return true
        pLog("portal:connectFailed")
        startAp()
    sleep(1000)
  pLog("portal:timeout")
  false

# helper to mask passwords/ssids in logs
proc masked*(s: string; keep: int = 2): string =
  if s.len <= keep: "*".repeat(s.len)
  else: s[0..keep-1] & "*".repeat(s.len - keep)
