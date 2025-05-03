import os, osproc, httpclient, json, strformat, strutils, streams, times, threadpool
import frameos/types
import frameos/scenes
import frameos/channels

# ──────────────────────────────────────────────────────────────────────────────
#  Constants
# ──────────────────────────────────────────────────────────────────────────────
const
  nmHotspotName = "frameos-hotspot" ## NetworkManager connection ID
  nmConnectionName = "frameos-wifi" ## NetworkManager connection ID

# ──────────────────────────────────────────────────────────────────────────────
#  Globals / helpers
# ──────────────────────────────────────────────────────────────────────────────
var active* = false ## true while our hotspot is up
var logger: Logger ## injected from FrameOS once logging exists
var hotspotStartedAt = 0.0

proc isPortalActive*(): bool =
  result = active

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

proc stopAp*(frameOS: FrameOS) =
  ## Tear down the hotspot and NAT rules (idempotent)
  if not hotspotRunning():
    pLog("portal:stopAp:notRunning"); return
  pLog("portal:stopAp")

  frameOS.network.hotspotStatus = HotspotStatus.stopping
  discard run("sudo nmcli connection down " & shQuote(nmHotspotName) & " || true")
  discard run("sudo nmcli connection delete " & shQuote(nmHotspotName) & " || true")

  active = false
  frameOS.network.hotspotStatus = HotspotStatus.disabled
  pLog("portal:stopAp:done")
  sendEvent("setCurrentScene", %*{"sceneId": getFirstSceneId()})

proc startAp*(frameOS: FrameOS) =
  ## Bring up Wi-Fi AP with hard-coded SSID/pw and HTTP(S) redirect → 8787
  if hotspotRunning():
    pLog("portal:startAp:alreadyRunning")
    return
  pLog("portal:startAp")
  frameOS.network.hotspotStatus = HotspotStatus.starting

  discard run("sudo nmcli connection delete " & shQuote(nmHotspotName) & " 2>/dev/null || true")

  let wifiHotspotSsid = frameOS.frameConfig.network.wifiHotspotSsid
  let wifiHotspotPassword = frameOS.frameConfig.network.wifiHotspotPassword
  let rc = run(fmt"sudo nmcli device wifi hotspot ifname wlan0 con-name {shQuote(nmHotspotName)} " &
               fmt"ssid {shQuote(wifiHotspotSsid)} password {shQuote(wifiHotspotPassword)}")[1]
  if rc != 0:
    frameOS.network.hotspotStatus = HotspotStatus.error
    pLog("portal:startAp:error")
    return

  discard run("sudo nmcli connection modify " & shQuote(nmHotspotName) & " ipv4.method shared")

  active = true
  hotspotStartedAt = epochTime()
  frameOS.network.hotspotStatus = HotspotStatus.enabled
  frameOS.network.hotspotStartedAt = hotspotStartedAt
  pLog("portal:startAp:done")
  sendEvent("setCurrentScene", %*{"sceneId": "system/wifiHotspot".SceneId})

  proc watcher (frameOS: FrameOS) =
    while true:
      sleep(1000)
      if not active: return
      if epochTime() - hotspotStartedAt >= frameOS.frameConfig.network.wifiHostpotTimeoutSeconds:
        pLog("portal:stopAp:autoTimeout")
        stopAp(frameOS)
  spawn watcher(frameOS)

proc attemptConnect*(frameOS: FrameOS, ssid, password: string): bool =
  frameOS.network.status = NetworkStatus.connecting
  discard run(fmt"sudo -n nmcli connection delete '{nmConnectionName}' 2>/dev/null || true")

  let nmcliArgs = @[
    "--wait", "15", # abort if not connected in 15 s
    "device", "wifi", "connect", ssid,
    "password", password,
    "ifname", "wlan0", "name", nmConnectionName
  ]
  let sudoArgs = @["-n", "nmcli"] & nmcliArgs # -n = never prompt for pwd

  let p = startProcess("sudo",
                       args = sudoArgs,
                       options = {poUsePath, poStdErrToStdOut})

  let rc = waitForExit(p) # we know it will finish in ≤ 15 s
  let output = p.outputStream.readAll()

  pLog("portal:exec",
       %*{"cmd": "sudo " & $sudoArgs,
           "rc": rc, "output": output.strip()})

  result = (rc == 0)
  frameOS.network.status = if result: NetworkStatus.connected else: NetworkStatus.error

  sendEvent("render", %*{})

proc masked*(s: string; keep: int = 2): string =
  if s.len <= keep: "*".repeat(s.len) else: s[0..keep-1] & "*".repeat(s.len - keep)

const styleBlock* = """
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background-color:#111827;color:#f9fafb}
.card{background:color-mix(in oklch,#1f2937 70%,oklch(27.8% 0.033 256.848) 30%);padding:2rem 2.5rem;border-radius:.5rem;width:100%;max-width:28rem;box-shadow:0 2px 6px rgba(0,0,0,.35)}
h1{margin:0 0 1rem;font-size:1.5rem;font-weight:600;line-height:1.2}
p,li{font-size:.875rem;color:#d1d5db;margin:0 0 1rem}
label{display:block;font-weight:500;font-size:.875rem;margin-bottom:.25rem}
input{box-sizing:border-box;width:100%;padding:.5rem .75rem;font-size:.875rem;color:#f9fafb;background-color:#111827;border:1px solid #374151;border-radius:.375rem;margin-bottom:1rem;margin-top:0.5rem;}
input:focus{outline:none;border-color:#4a4b8c;box-shadow:0 0 0 1px #4a4b8c}
button{display:block;width:100%;padding:.5rem;font-size:.875rem;font-weight:500;color:#fff;background-color:#4a4b8c;border:none;border-radius:.375rem;cursor:pointer;text-align:center}
button:hover{background-color:#484984}
button:focus{outline:none;box-shadow:0 0 0 1px #484984}
</style>"""


proc layout*(inner: string): string =
  fmt"""<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta charset="utf-8"><title>FrameOS Setup</title>{styleBlock}</head>
<body><div class="card">{inner}</div></body></html>"""

proc setupHtml*(): string =
  layout("""
<h1>Connect your Frame to Wi-Fi</h1>
<p>If the connection fails, reconnect to this access point and try again.</p>
<form method="post" action="/setup">
  <label>Wi-Fi SSID<input name="ssid" required></label>
  <label>Password<input type="password" name="password"></label>
  <button type="submit">Save &amp; Connect</button>
</form>""")

proc confirmHtml*(): string =
  layout("""
<h1>Saved!</h1>
<p>The frame is now attempting to connect to Wi-Fi. You may close this tab.</p>
<h2>Troubleshooting</h2>
<ul>
  <li>Wait about 60 seconds—your device can stay “stuck” on the frame’s network for a short time.</li>
  <li>Manually disconnect from that network. If the “FrameOS-Setup” access-point reappears, the Wi-Fi credentials were likely wrong.</li>
  <li>Reconnect to the access-point and run the setup again, double-checking SSID and password.</li>
</ul>""")

proc connectToWifi*(ssid, password: string, frameOS: FrameOS) {.gcsafe.} =
  let frameConfig = frameOS.frameConfig
  stopAp(frameOS) # close hotspot before connecting
  if attemptConnect(frameOS, ssid, password):
    sleep(5000) # give DHCP etc a moment

    var connected = false
    let client = newHttpClient(timeout = 5000)
    try:
      let response = client.get(frameConfig.network.networkCheckUrl)
      if response.status.startsWith("200"):
        log(%*{"event": "networkCheck", "status": "success"})
        sendEvent("setCurrentScene", %*{"sceneId": getFirstSceneId()})
        return
      else:
        log(%*{"event": "networkCheck", "status": "failed", "response": response.status})
    except CatchableError as e:
      log(%*{"event": "networkCheck", "status": "error", "error": e.msg})
    finally:
      client.close()

    if not connected:
      log(%*{"event": "portal:connect:netCheckFailed"})
      startAp(frameOS) # fall back to AP
  else:
    log(%*{"event": "portal:connectFailed"})
    startAp(frameOS)

proc checkNetwork*(self: FrameOS): bool =
  if not self.frameConfig.network.networkCheck or self.frameConfig.network.networkCheckTimeoutSeconds <= 0:
    return false

  let url = self.frameConfig.network.networkCheckUrl
  let timeout = self.frameConfig.network.networkCheckTimeoutSeconds
  let timer = epochTime()
  var attempt = 1
  self.network.status = NetworkStatus.connecting
  self.logger.log(%*{"event": "networkCheck", "url": url})
  while true:
    if epochTime() - timer >= timeout:
      self.network.status = NetworkStatus.timeout
      self.logger.log(%*{"event": "networkCheck", "status": "timeout", "seconds": timeout})
      return false
    let client = newHttpClient(timeout = 5000)
    try:
      let response = client.get(url)
      if response.status.startsWith("200"):
        self.network.status = NetworkStatus.connected
        self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "success"})
        return true
      else:
        self.network.status = NetworkStatus.error
        self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "failed",
            "response": response.status})
    except CatchableError as e:
      self.network.status = NetworkStatus.error
      self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "error", "error": e.msg})
    finally:
      client.close()
    sleep(attempt * 1000)
    attempt += 1
  return false
