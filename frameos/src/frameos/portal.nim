import os, osproc, httpclient, json, strformat, strutils, streams, times, threadpool, locks
import std/monotimes
import frameos/config
import frameos/types
import frameos/scenes
import frameos/channels
import frameos/setup_proxy

const
  nmHotspotName = "frameos-hotspot"
  nmConnectionName = "frameos-wifi"

var logger: Logger
var lastErrorLock: Lock
var lastError: string

proc getLastError(): string =
  {.gcsafe.}:
    withLock lastErrorLock:
      return lastError & ""

proc rememberError(msg: string) =
  {.gcsafe.}:
    withLock lastErrorLock:
      lastError = strip(msg)[0 ..< min(len(msg), 160)] # 160‑char cap

proc isHotspotActive*(frameOS: FrameOS): bool =
  frameOS.network.hotspotStatus == HotspotStatus.enabled

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

proc availableNetworks*(frameOS: FrameOS): seq[string] =
  ## Return a list of nearby Wi-Fi SSIDs using nmcli
  let (output, rc) = run("sudo nmcli --terse --fields SSID device wifi list 2>/dev/null || true")
  if rc != 0:
    return @[]
  for line in output.splitLines():
    let ssid = line.strip()
    if ssid.len > 0 and ssid notin result:
      result.add ssid

proc hotspotRunning(frameOS: FrameOS): bool =
  let (output, _) = run("sudo nmcli --colors no -t -f NAME connection show --active | grep '^" &
                     nmHotspotName & "$' || true")
  result = output.strip().len > 0
  frameOS.network.hotspotStatus = if result: HotspotStatus.enabled else: HotspotStatus.disabled

proc anyWifiConfigured(frameOS: FrameOS): bool =
  let (output, _) = run("sudo nmcli --colors no -t -f NAME connection show | grep -v '^lo$' || true")
  result = output.strip().len > 0

proc stopAp*(frameOS: FrameOS) =
  ## Tear down the hotspot
  if not hotspotRunning(frameOS):
    pLog("portal:stopAp:notStarted")
    return
  pLog("portal:stopAp")
  frameOS.network.hotspotStatus = HotspotStatus.stopping
  discard run("sudo nmcli connection down " & shQuote(nmHotspotName) & " || true")
  discard run("sudo nmcli connection delete " & shQuote(nmHotspotName) & " || true")
  frameOS.network.hotspotStatus = HotspotStatus.disabled
  stopSetupProxy()
  pLog("portal:stopAp:done")

proc startAp*(frameOS: FrameOS) =
  ## Bring up Wi-Fi AP with hard-coded SSID/pw
  if hotspotRunning(frameOS):
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
  discard run("sudo nmcli connection modify " & shQuote(nmHotspotName) & " 802-11-wireless.ap-isolation 1 || true")

  frameOS.network.hotspotStatus = HotspotStatus.enabled
  startSetupProxy(frameOS.frameConfig)
  pLog("portal:startAp:setupProxy", %*{"port": setupProxyPort()})
  let hotspotStarted = getMonoTime()
  frameOS.network.hotspotStartedAt = epochTime()
  pLog("portal:startAp:done")
  sendEvent("setCurrentScene", %*{"sceneId": "system/wifiHotspot".SceneId})

  proc hotspotAutoTimeout(frameOS: FrameOS, startedAt: MonoTime) =
    while true:
      sleep(1000)
      if frameOS.network.hotspotStatus != HotspotStatus.enabled:
        return
      let timeoutSec = frameOS.frameConfig.network.wifiHotspotTimeoutSeconds
      if timeoutSec <= 0:
        return # disabled or mis-configured – bail out immediately

      if (getMonoTime() - startedAt) >= initDuration(milliseconds = int(timeoutSec * 1000)):
        pLog("portal:stopAp:autoTimeout")
        stopAp(frameOS)
        sendEvent("setCurrentScene", %*{"sceneId": getFirstSceneId()})
  spawn hotspotAutoTimeout(frameOS, hotspotStarted) # pass snapshot

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

  if frameOS.network.status == NetworkStatus.connected:
    sleep(5000) # give DHCP etc a moment

  sendEvent("setCurrentScene", %*{"sceneId": getFirstSceneId()})

proc masked*(s: string; keep: int = 2): string =
  if s.len <= keep: "*".repeat(s.len) else: s[0..keep-1] & "*".repeat(s.len - keep)

# Immediately sync the clock so HTTPS certificates validate
proc syncClock*() =
  ## Tries the best available tool on the current distro.
  try:
    # NixOS & any systemd host: systemd‑timesyncd one‑shot
    if fileExists("/run/systemd/system"):
      discard execShellCmd("sudo systemctl restart systemd-timesyncd.service")
    # Classic Debian / Raspberry Pi OS: one‑shot ntpd
    elif findExe("ntpd") != "":
      discard execShellCmd("sudo ntpd -gq") # exits after first successful poll
    # BusyBox systems (rare): fall back to sntp
    elif findExe("sntp") != "":
      discard execShellCmd("sudo sntp -sS pool.ntp.org")
  except CatchableError:
    echo "⚠️  Time‑sync failed – will retry later"

proc connectToWifi*(frameOS: FrameOS,
                    ssid, password, serverHost, serverPort: string) {.gcsafe.} =
  let frameConfig = frameOS.frameConfig
  stopAp(frameOS) # close hotspot before connecting

  if attemptConnect(frameOS, ssid, password):
    var connected = false
    syncClock()
    for attempt in 0..<4:
      let client = newHttpClient(timeout = 5000)
      try:
        let response = client.get(frameConfig.network.networkCheckUrl)
        if response.status.startsWith("200"):
          let oldServerHost = frameConfig.serverHost
          let oldServerPort = $frameConfig.serverPort

          if len(serverHost) > 0 and len(serverPort) > 0 and serverHost != oldServerHost or serverPort != oldServerPort:
            pLog("portal:connect:updatingConfig",
                 %*{"serverHost": serverHost, "serverPort": serverPort,
                     "oldServerHost": oldServerHost, "oldServerPort": oldServerPort})
            try:
              let filename = getConfigFilename()
              var data: JsonNode
              data = parseFile(filename)
              data["serverHost"] = %*(serverHost)
              data["serverPort"] = %*(parseInt(serverPort))
              pLog("portal:connect:writing...", %*{"serverHost": serverHost, "serverPort": serverPort})
              writeFile(filename, pretty(data, indent = 4))
              frameConfig.serverHost = serverHost
              frameConfig.serverPort = parseInt(serverPort)
              # TODO: reload config in the running FrameOS instance, or reload the instance
            except CatchableError as e:
              rememberError("Failed to persist new server host & port: " & e.msg)
              pLog("portal:connect:configUpdateError",
                   %*{"error": e.msg, "serverHost": serverHost, "serverPort": serverPort,
                       "oldServerHost": oldServerHost, "oldServerPort": oldServerPort})
              echo "[portal] failed to write updated frame.json"
          else:
            pLog("portal:connect:configUnchanged")

          log(%*{"event": "networkCheck", "status": "success"})
          sendEvent("setCurrentScene", %*{"sceneId": getFirstSceneId()})
          rememberError("")
          return
        else:
          log(%*{"event": "networkCheck", "status": "failed", "response": response.status})
          rememberError("Network check failed. Please try again." &
                        fmt" (HTTP {response.status})")
          sleep(3000 * (attempt + 1)) # wait before retrying
      except CatchableError as e:
        log(%*{"event": "networkCheck", "status": "error", "error": e.msg})
        rememberError("Network check failed: " & e.msg)
        sleep(3000 * (attempt + 1)) # wait before retrying
      finally:
        client.close()

    if not connected:
      log(%*{"event": "portal:connect:netCheckFailed"})
      startAp(frameOS) # fall back to AP
  else:
    log(%*{"event": "portal:connectFailed"})
    rememberError("Wifi connection failed. Check your credentials.")
    startAp(frameOS)

proc checkNetwork*(self: FrameOS): bool =
  if not self.frameConfig.network.networkCheck or self.frameConfig.network.networkCheckTimeoutSeconds <= 0:
    return false

  let url = self.frameConfig.network.networkCheckUrl
  let timeout = self.frameConfig.network.networkCheckTimeoutSeconds
  let timer = getMonoTime()
  var attempt = 1
  self.network.status = NetworkStatus.connecting
  self.logger.log(%*{"event": "networkCheck", "url": url})
  while true:
    if (getMonoTime() - timer) >= initDuration(milliseconds = int(timeout*1000)):
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

      # Error with SSL certificates. Most likely means the clock is wrong after a long downtime.
      if e.msg.contains("certificate verify failed") or e.msg.contains("error:0A000086"):
        self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "error", "error": e.msg,
            "action": "syncing clock and trying again"})
        syncClock()
        sleep(min(max(3, attempt), 60) * 1000)
        continue
      else:
        self.logger.log(%*{"event": "networkCheck", "attempt": attempt, "status": "error", "error": e.msg})

    finally:
      client.close()

    # If no wifi configured (first boot?), bail and show the AP
    if attempt == 1:
      if not anyWifiConfigured(self):
        self.network.status = NetworkStatus.error
        self.logger.log(%*{"event": "networkCheck", "status": "wifi_not_configured"})
        return false
      else:
        self.network.status = NetworkStatus.connecting
        self.logger.log(%*{"event": "networkCheck", "status": "wifi_connecting"})

    sleep(min(attempt, 60) * 1000)
    attempt += 1
  return false

proc htmlEscape(input: string): string =
  result = input.replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")
    .replace("'", "&apos;")

const styleBlock* = """
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background-color:#111827;color:#f9fafb}
.card{background:color-mix(in oklch,#1f2937 70%,oklch(27.8% 0.033 256.848) 30%);padding:2rem 2.5rem;border-radius:.5rem;width:100%;max-width:28rem;box-shadow:0 2px 6px rgba(0,0,0,.35)}
h1{margin:0 0 1rem;font-size:1.5rem;font-weight:600;line-height:1.2}
p,li{font-size:.875rem;color:#d1d5db;margin:0 0 1rem}
label{display:block;font-weight:500;font-size:.875rem;margin-bottom:.25rem}
input,select{box-sizing:border-box;width:100%;padding:.5rem .75rem;font-size:.875rem;color:#f9fafb;background-color:#111827;border:1px solid #374151;border-radius:.375rem;margin-bottom:1rem;margin-top:.5rem;}
input:focus,select:focus{outline:none;border-color:#4a4b8c;box-shadow:0 0 0 1px #4a4b8c}
a{text-decoration:none;color:#8283bf;} a:hover{text-decoration:underline;}
button{display:block;width:100%;padding:.5rem;font-size:.875rem;font-weight:500;color:#fff;background-color:#4a4b8c;border:none;border-radius:.375rem;cursor:pointer;text-align:center}
button:hover{background-color:#484984}
button:focus{outline:none;box-shadow:0 0 0 1px #484984}
select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath fill='%23d1d5db' d='M5.23 7.21a.75.75 0 0 1 1.06 0L10 10.92l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.24a.75.75 0 0 1-1.06 0L5.23 8.27a.75.75 0 0 1 0-1.06z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .75rem center;background-size:1rem}
</style>"""

proc layout*(inner: string): string =
  fmt"""<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta charset="utf-8"><title>FrameOS Setup</title>{styleBlock}</head>
<body><div class="card">{inner}</div></body></html>"""

proc setupHtml*(frameOS: FrameOS): string =
  layout(fmt"""
<h1>Connect your Frame to Wi-Fi</h1>
<p>If the connection fails, reconnect to this access point and try again.</p>
<p id="err" style="color:#f87171">{htmlEscape(getLastError())}</p>
<form method="post" action="/setup">
  <label><a href='#' onclick='updateNetworks();return false;' style='float:right'>Reload</a>Wi-Fi SSID
    <select id="ssid" name="ssid" required>
      <option disabled selected>Loading…</option>
    </select>
  </label>
  <label>Password<input type="password" name="password"></label>
  <div style="margin:0 0 1rem;font-size:.875rem;color:#f9fafb;cursor:pointer;" id="portal-server-toggle">
    ► Server connection
  </div>
  <div id="portal-server" style="display:none">
    <label>Server Host
      <input type="text" name="serverHost"
            placeholder="my.frameos.server"
            value="{htmlEscape(frameOS.frameConfig.serverHost)}" required>
    </label>

    <label>Server Port
      <input type="number" min="1" max="65535"
            name="serverPort"
            value="{frameOS.frameConfig.serverPort}">
    </label>
  </div>
  <button type="submit">Save &amp; Connect</button>
</form>
""" & """
<script>
const sel = document.getElementById('ssid');
const toggleEl = document.getElementById('portal-server-toggle');
const paneEl   = document.getElementById('portal-server');

function setOptions(list, current) {
  sel.innerHTML = '';
  list.forEach(s => {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  });
  if (current && list.includes(current)) sel.value = current;
}

function loadCached() {
  try {
    const cached = JSON.parse(localStorage.getItem('wifiSsids') || '[]');
    if (Array.isArray(cached) && cached.length) {
      setOptions(cached);
    }
  } catch (e) {
    console.error(e);
  }
}

function updateNetworks() {
  fetch('/wifi')
    .then(r => r.json())
    .then(d => {
      const unique = [...new Set(d.networks.filter(n => n.trim()))]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      localStorage.setItem('wifiSsids', JSON.stringify(unique));
      const current = sel ? sel.value : null;
      setOptions(unique, current);
    })
    .catch(console.error);
}

function updateUI(open = false) {
  paneEl.style.display = open ? 'block' : 'none';
  toggleEl.textContent = (open ? '▼' : '►') + ' Server connection';
}

toggleEl.addEventListener('click', () =>
  updateUI(paneEl.style.display === 'none')
);

loadCached();      // show cached list immediately if we have one
updateNetworks();  // initial fetch to refresh list
setInterval(updateNetworks, 10000); // refresh every 10 sec on a loop
setTimeout(updateNetworks, 1000); // refresh in 1 sec
setTimeout(updateNetworks, 4000); // refresh in 4 sec
updateUI(false);         // start collapsed
</script>""")

proc confirmHtml*(): string =
  layout("""
<h1>Saved!</h1>
<p>The frame is now attempting to connect to Wi-Fi. You may close this tab.</p>
<h2>Troubleshooting</h2>
<ul>
  <li>Wait about 60 seconds—your device can stay stuck on the setup network for a short time.</li>
  <li>If the “FrameOS-Setup” access-point reappears, the Wi-Fi credentials were likely wrong.</li>
  <li>Reconnect to the access-point and run the setup again, double-checking SSID and password.</li>
</ul><script>
// Reload the page when it comes back
window.setInterval(() => {
  window.fetch('/').then(() => {
    window.location.href = '/';
  }).catch(() => {
    // ignore errors, we just want to reload the page
  });
}, 10000);
</script>""")
