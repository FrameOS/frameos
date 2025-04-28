import os, osproc, httpclient, json, strformat, strutils
import frameos/types
import frameos/channels

# ──────────────────────────────────────────────────────────────────────────────
#  Constants
# ──────────────────────────────────────────────────────────────────────────────
const
  setupSsid* = "FrameOS-Setup"
  setupPassword* = "frame1234"
  nmHotspotName = "frameos-hotspot" ## NetworkManager connection ID
  redirectPort = 8787               ## where we run the local web UI
  redirectPorts = ["80", "443"]     ## TCP ports we hijack for captive‑portal

# ──────────────────────────────────────────────────────────────────────────────
#  Globals / helpers
# ──────────────────────────────────────────────────────────────────────────────
var active* = false ## true while our hotspot is up
var logger: Logger ## injected from FrameOS once logging exists

proc setLogger*(l: Logger) = logger = l

proc pLog(ev: string, extra: JsonNode = %*{}) =
  {.gcsafe.}:
    let payload = copy(extra); payload["event"] = %*(ev)
    if logger != nil: logger.log(payload)
    else: echo "[portal] ", ev, " ", $extra

# Shell‑safe single‑quote wrapper (POSIX)
proc shQuote(s: string): string =
  "'" & s.replace("'", "'\"'\"'") & "'"

proc run(cmd: string): (string, int) =
  ## Execute a shell command (through /bin/sh -c) and log the result.
  let (output, rc) = execCmdEx(cmd) # no extra nested bash
  pLog("portal:exec", %*{"cmd": cmd, "rc": rc, "output": output.strip()})
  (output, rc)

# ──────────────────────────────────────────────────────────────────────────────
#  Hot‑spot helpers
# ──────────────────────────────────────────────────────────────────────────────
proc hotspotRunning(): bool =
  let (output, _) = run("sudo nmcli --colors no -t -f NAME connection show --active | grep '^" &
                     nmHotspotName & "$' || true")
  active = output.strip().len > 0
  return active

proc startAp*() =
  ## Bring up Wi‑Fi AP with hard‑coded SSID/pw and HTTP(S) redirect → 8787
  if hotspotRunning():
    pLog("portal:startAp:alreadyRunning"); return
  pLog("portal:startAp")

  discard run("sudo nmcli connection delete " & shQuote(nmHotspotName) & " 2>/dev/null || true")

  let rc = run(fmt"sudo nmcli device wifi hotspot ifname wlan0 con-name {shQuote(nmHotspotName)} " &
               fmt"ssid {shQuote(setupSsid)} password {shQuote(setupPassword)}")[1]
  if rc != 0:
    pLog("portal:startAp:error"); return

  discard run("sudo nmcli connection modify " & shQuote(nmHotspotName) & " ipv4.method shared")

  # Hijack :80/:443 while keeping DHCP/DNS/other UDP untouched.
  for port in redirectPorts:
    discard run(fmt"sudo iptables -t nat -D PREROUTING -i wlan0 -p tcp --dport {port} -j REDIRECT --to-ports {redirectPort} || true")
    discard run(fmt"sudo iptables -t nat -A PREROUTING -i wlan0 -p tcp --dport {port} -j REDIRECT --to-ports {redirectPort}")

  active = true
  pLog("portal:startAp:done")

proc stopAp*() =
  ## Tear down the hotspot and NAT rules (idempotent)
  if not hotspotRunning():
    pLog("portal:stopAp:notRunning"); return
  pLog("portal:stopAp")

  discard run("sudo nmcli connection down " & shQuote(nmHotspotName) & " || true")
  discard run("sudo nmcli connection delete " & shQuote(nmHotspotName) & " || true")

  for port in redirectPorts:
    discard run(fmt"sudo iptables -t nat -D PREROUTING -i wlan0 -p tcp --dport {port} -j REDIRECT --to-ports {redirectPort} || true")

  active = false
  pLog("portal:stopAp:done")

proc attemptConnect*(ssid, pwd: string): bool =
  ## Connect wlan0 to given network. Returns true if nmcli succeeds.
  discard run("sudo nmcli connection delete 'frameos-wifi' 2>/dev/null || true")
  let cmd = "sudo nmcli device wifi connect " & shQuote(ssid) &
            " password " & shQuote(pwd) &
            " ifname wlan0 name 'frameos-wifi'"
  run(cmd)[1] == 0

proc masked*(s: string; keep: int = 2): string =
  if s.len <= keep: "*".repeat(s.len) else: s[0..keep-1] & "*".repeat(s.len - keep)

proc getStatusMessage*(): string =
  if active:
    fmt"Not connected — join “{setupSsid}” (pw “{setupPassword}”) and open http://10.42.0.1/" else: ""

proc setupHtml*(): string = fmt"""
<!doctype html><html><head><meta charset="utf-8"><title>FrameOS Setup</title></head>
<body style="font-family:sans-serif;max-width:640px;margin:2rem auto;">
 <h1>Connect your Frame to Wi‑Fi</h1>
 <p>Join “<b>{setupSsid}</b>” (password <code>{setupPassword}</code>) and enter your Wi‑Fi below.</p>
 <form method="post" action="/setup">
   <label>Wi‑Fi SSID<br><input name="ssid" required style="width:100%"></label><br><br>
   <label>Password<br><input type="password" name="password" style="width:100%"></label><br><br>
   <button type="submit">Save &amp; Connect</button>
 </form></body></html>"""

proc connectToWifi*(ssid, pwd, networkCheckUrl: string) =
  stopAp() # close hotspot before connecting
  if attemptConnect(ssid, pwd):
    sleep(5000) # give DHCP etc a moment

    var connected = false
    let client = newHttpClient(timeout = 5000)
    try:
      let response = client.get(networkCheckUrl)
      if response.status.startsWith("200"):
        log(%*{"event": "networkCheck", "status": "success"})
        return
      else:
        log(%*{"event": "networkCheck", "status": "failed", "response": response.status})
    except CatchableError as e:
      log(%*{"event": "networkCheck", "status": "error", "error": e.msg})
    finally:
      client.close()

    if not connected:
      log(%*{"event": "portal:connect:netCheckFailed"})
      startAp() # fall back to AP
  else:
    log(%*{"event": "portal:connectFailed"})
    startAp()
