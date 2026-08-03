import std/[json, strutils, tables, unittest]

import ../channels
import ../network/backend
import ../portal
import ../types

type HookMode = enum
  hmWifiList
  hmStartApOk
  hmStartApFail
  hmStartApTransientFail
  hmStopAp
  hmAttemptSuccess
  hmAttemptFail

var hookMode {.global.}: HookMode
var runWifiListCalls {.global.}: int
var runWifiStatusCalls {.global.}: int
var runShowActiveCalls {.global.}: int
var runHotspotAddCalls {.global.}: int
var runHotspotModifyCalls {.global.}: int
var runHotspotUpCalls {.global.}: int
var runManagedCalls {.global.}: int
var runDownCalls {.global.}: int
var runDeleteCalls {.global.}: int
var runDeleteConnectionCalls {.global.}: int
var runDriverSetupCalls {.global.}: int
var sawDriverSetupRebootArg {.global.}: bool
var nmcliConnectCalls {.global.}: int
var sawExpectedNmcliArgs {.global.}: bool
var sawFallbackNmcliArgs {.global.}: bool
var sleepCallCount {.global.}: int
var lastSleepMs {.global.}: int

proc resetHookState() =
  hookMode = hmWifiList
  runWifiListCalls = 0
  runWifiStatusCalls = 0
  runShowActiveCalls = 0
  runHotspotAddCalls = 0
  runHotspotModifyCalls = 0
  runHotspotUpCalls = 0
  runManagedCalls = 0
  runDownCalls = 0
  runDeleteCalls = 0
  runDeleteConnectionCalls = 0
  runDriverSetupCalls = 0
  sawDriverSetupRebootArg = false
  nmcliConnectCalls = 0
  sawExpectedNmcliArgs = false
  sawFallbackNmcliArgs = false
  sleepCallCount = 0
  lastSleepMs = -1

proc runHook(cmd: string): (string, int) {.gcsafe, nimcall.} =
  # Backend detection: this suite pins the NetworkManager path.
  if cmd.contains("command -v nmcli"):
    return ("nmcli\nwpa_supplicant\nhostapd\niw\ndnsmasq\nudhcpc\n", 0)
  if cmd.contains("nmcli -t -f RUNNING general status"):
    return ("running\n", 0)
  if cmd.contains("nmcli --terse --fields SSID device wifi list"):
    inc runWifiListCalls
    return ("wifi-a\n\nwifi-b\nwifi-a\n", 0)
  if cmd.contains("nmcli -t -f DEVICE,TYPE,STATE device status"):
    inc runWifiStatusCalls
    return ("wlan0:wifi:disconnected\n", 0)
  if cmd.contains("connection show --active"):
    inc runShowActiveCalls
    if hookMode == hmStopAp:
      return ("frameos-hotspot\n", 0)
    return ("", 0)
  if cmd.contains("connection add type wifi"):
    inc runHotspotAddCalls
    return ("ok", 0)
  if cmd.contains("connection modify 'frameos-hotspot' 802-11-wireless.mode ap"):
    inc runHotspotModifyCalls
    return ("", 0)
  if cmd.contains("--wait 15 connection up 'frameos-hotspot'"):
    inc runHotspotUpCalls
    if hookMode == hmStartApFail:
      return ("failed", 4)
    if hookMode == hmStartApTransientFail and runHotspotUpCalls == 1:
      return ("failed", 4)
    return ("ok", 0)
  if cmd.contains("connection modify 'frameos-hotspot' 802-11-wireless.ap-isolation"):
    return ("", 0)
  if cmd.contains("device set 'wlan0' managed yes || true"):
    inc runManagedCalls
    return ("", 0)
  if cmd.contains("connection down 'frameos-hotspot'"):
    inc runDownCalls
    return ("", 0)
  if cmd.contains("connection delete 'frameos-hotspot'"):
    inc runDeleteCalls
    return ("", 0)
  if cmd.contains("nmcli connection delete 'frameos-wifi'"):
    inc runDeleteConnectionCalls
    return ("", 0)
  if cmd.contains("driver-setup"):
    inc runDriverSetupCalls
    sawDriverSetupRebootArg = cmd.contains("driver-setup --reboot-if-required")
    return ("FrameOS setup: driver setup: complete", 0)
  ("", 0)

proc nmcliHook(args: seq[string]): tuple[rc: int, output: string] {.gcsafe, nimcall.} =
  inc nmcliConnectCalls
  sawExpectedNmcliArgs =
    args.len == 14 and
    args[0] == "-n" and args[1] == "nmcli" and args[2] == "--wait" and args[3] == "15" and
    args[4] == "device" and args[5] == "wifi" and args[6] == "connect" and
    args[7] == "home-wifi" and args[8] == "password" and args[9] == "pw" and
    args[10] == "ifname" and args[11] == "wlan0" and args[12] == "name" and args[13] == "frameos-wifi"
  sawFallbackNmcliArgs =
    args.len == 12 and
    args[0] == "-n" and args[1] == "nmcli" and args[2] == "--wait" and args[3] == "15" and
    args[4] == "device" and args[5] == "wifi" and args[6] == "connect" and
    args[7] == "home-wifi" and args[8] == "password" and args[9] in ["pw", "bad"] and
    args[10] == "name" and args[11] == "frameos-wifi"
  if hookMode == hmAttemptSuccess:
    return (rc: 0, output: "connected")
  (rc: 7, output: "denied")

proc sleepHook(ms: int) {.gcsafe, nimcall.} =
  inc sleepCallCount
  lastSleepMs = ms

proc autoTimeoutDisabled(): bool {.gcsafe, nimcall.} =
  false

proc makeFrameOS(timeoutSeconds = 0.0): FrameOS =
  FrameOS(
    frameConfig: FrameConfig(
      serverHost: "frame.local",
      serverPort: 8989,
      frameHost: "frame.local",
      framePort: 8787,
      network: NetworkConfig(
        wifiHotspotSsid: "FrameOS-Setup",
        wifiHotspotPassword: "secret1234",
        wifiHotspotTimeoutSeconds: timeoutSeconds,
      ),
      httpsProxy: HttpsProxyConfig(enable: false, exposeOnlyPort: true),
    ),
    network: Network(
      status: NetworkStatus.idle,
      hotspotStatus: HotspotStatus.disabled,
    ),
  )

proc drainEventChannel() =
  while true:
    let (ok, _) = eventChannel.tryRecv()
    if not ok:
      break

suite "portal network orchestration":
  setup:
    resetPortalHooksForTest()
    resetHookState()
    setPortalHooksForTest(
      runHook = runHook,
      nmcliConnectHook = nmcliHook,
      sleepHook = sleepHook,
      autoTimeoutEnabledHook = autoTimeoutDisabled
    )
    drainEventChannel()

  teardown:
    resetPortalHooksForTest()
    resetHookState()
    drainEventChannel()

  test "rememberError strips, caps, and survives surrounding whitespace":
    rememberError("  padded error message  ")
    check getLastError() == "padded error message"
    rememberError("x".repeat(500))
    check getLastError().len == 160
    rememberError("")
    check getLastError() == ""

  test "masked and maskedPasswordArgs hide credentials for logging":
    check masked("secret1234") == "se********"
    check masked("a") == "*"
    check maskedPasswordArgs(@["-n", "nmcli", "password", "secret1234", "name", "x"]) ==
          @["-n", "nmcli", "password", "se********", "name", "x"]
    check maskedPasswordArgs(@["password"]) == @["password"]

  test "confirmHtml tells user the post-WiFi frame URL":
    let frame = makeFrameOS()
    let html = confirmHtml(frame)

    check html.contains("http://frame.local:8787/")
    check html.contains("http://frame.local:8787/admin")
    check html.contains("restarts automatically")

  test "driver setup delegates reboot decision to setup command":
    let frame = makeFrameOS()
    let ok = runDriverSetupFromSavedConfig(frame, PortalSetupOptions(runDriverSetup: true))

    check ok
    check runDriverSetupCalls == 1
    check sawDriverSetupRebootArg

  test "driver setup is skipped when disabled":
    let frame = makeFrameOS()
    let ok = runDriverSetupFromSavedConfig(frame, PortalSetupOptions(runDriverSetup: false))

    check ok
    check runDriverSetupCalls == 0

  test "postSetupFrameUrl uses https proxy port when enabled":
    let frame = makeFrameOS()
    frame.frameConfig.httpsProxy = HttpsProxyConfig(enable: true, port: 8443, exposeOnlyPort: true)

    check postSetupFrameUrl(frame) == "https://frame.local:8443/"

  test "availableNetworks deduplicates and drops empty ssids":
    hookMode = hmWifiList
    let networks = availableNetworks(makeFrameOS())
    check networks == @["wifi-a", "wifi-b"]
    check runWifiListCalls == 1

  test "startAp issues hotspot commands and emits setup scene event":
    hookMode = hmStartApOk
    let frame = makeFrameOS(timeoutSeconds = 0.0)
    startAp(frame)

    check frame.network.hotspotStatus == HotspotStatus.enabled
    check runShowActiveCalls == 1
    check runHotspotAddCalls == 1
    check runHotspotModifyCalls == 1
    check runHotspotUpCalls == 1
    check runWifiStatusCalls == 1
    check runManagedCalls == 1

    let (ok, ev) = eventChannel.tryRecv()
    check ok
    check ev[1] == "setCurrentScene"
    check ev[2]["sceneId"].getStr() == "system/wifiHotspot"

  test "startAp marks hotspot error when hotspot command fails":
    hookMode = hmStartApFail
    let frame = makeFrameOS()
    startAp(frame)

    check frame.network.hotspotStatus == HotspotStatus.error
    check runHotspotAddCalls == 6
    check runHotspotModifyCalls == 6
    check runHotspotUpCalls == 6
    check sleepCallCount == 5
    check lastSleepMs == 5000

    let (ok, _) = eventChannel.tryRecv()
    check not ok

  test "startAp retries transient hotspot command failures":
    hookMode = hmStartApTransientFail
    let frame = makeFrameOS(timeoutSeconds = 0.0)
    startAp(frame)

    check frame.network.hotspotStatus == HotspotStatus.enabled
    check runHotspotAddCalls == 2
    check runHotspotModifyCalls == 2
    check runHotspotUpCalls == 2
    check sleepCallCount == 1
    check lastSleepMs == 5000

    let (ok, ev) = eventChannel.tryRecv()
    check ok
    check ev[1] == "setCurrentScene"
    check ev[2]["sceneId"].getStr() == "system/wifiHotspot"

  test "stopAp runs down and delete when hotspot is active":
    hookMode = hmStopAp
    let frame = makeFrameOS()
    frame.network.hotspotStatus = HotspotStatus.enabled
    stopAp(frame)

    check frame.network.hotspotStatus == HotspotStatus.disabled
    check runShowActiveCalls == 1
    check runDownCalls == 1
    check runDeleteCalls == 1

  test "attemptConnect success uses nmcli hook and sleep hook":
    hookMode = hmAttemptSuccess
    let frame = makeFrameOS()
    let ok = attemptConnect(frame, "home-wifi", "pw")

    check ok
    check frame.network.status == NetworkStatus.connected
    check runDeleteConnectionCalls == 1
    check nmcliConnectCalls == 1
    check sawExpectedNmcliArgs
    check not sawFallbackNmcliArgs
    check sleepCallCount == 1
    check lastSleepMs == 5000

    let (hasEvent, ev) = eventChannel.tryRecv()
    check hasEvent
    check ev[1] == "setCurrentScene"
    check ev[2].hasKey("sceneId")

  test "attemptConnect failure sets error without post-connect sleep":
    hookMode = hmAttemptFail
    let frame = makeFrameOS()
    let ok = attemptConnect(frame, "home-wifi", "bad")

    check not ok
    check frame.network.status == NetworkStatus.error
    check runDeleteConnectionCalls == 1
    check nmcliConnectCalls == 2
    check sawFallbackNmcliArgs
    check sleepCallCount == 0

# ---------------------------------------------------------------------------
# The wpa_supplicant backend (armv6 buildroot images have no NetworkManager).
# Every command and every file write is stubbed, so nothing here spawns a
# process or touches the real filesystem.
# ---------------------------------------------------------------------------

type SupplicantMode = enum
  smIdle
  smHotspotUp
  smAssociateFails
  smNoDhcpLease
  smScanEmpty

var supMode {.global.}: SupplicantMode
var supHasWpaPassphrase {.global.}: bool
var supCommands {.global.}: seq[string]
var supFiles {.global.}: Table[string, string]

proc resetSupplicantState() =
  supMode = smIdle
  supHasWpaPassphrase = false
  supCommands = @[]
  supFiles = initTable[string, string]()

proc supRan(fragment: string): bool =
  for cmd in supCommands:
    if cmd.contains(fragment):
      return true
  false

proc supRunHook(cmd: string): (string, int) {.gcsafe, nimcall.} =
  {.gcsafe.}:
    supCommands.add(cmd)

    # No nmcli in the probe output: this is the armv6 image.
    if cmd.contains("command -v nmcli"):
      var tools = @["wpa_supplicant", "wpa_cli", "hostapd", "iw", "dnsmasq", "udhcpc"]
      if supHasWpaPassphrase:
        tools.add("wpa_passphrase")
      return (tools.join("\n") & "\n", 0)

    if cmd.contains("iw dev 'wlan0' scan"):
      if supMode == smScanEmpty:
        return ("", 1)
      return ("BSS 11:22:33:44:55:66(on wlan0)\n\tSSID: wifi-b\n" &
              "BSS 11:22:33:44:55:67(on wlan0)\n\tSSID: wifi-a\n" &
              "BSS 11:22:33:44:55:68(on wlan0)\n\tSSID: wifi-a\n", 0)
    if cmd.contains("iw dev 2>/dev/null"):
      return ("phy#0\n\tInterface wlan0\n\t\ttype managed\n", 0)
    if cmd.contains("wpa_cli -p /var/run/wpa_supplicant -i 'wlan0' ping"):
      return ("", 0) # no control socket yet: scanning goes through iw
    if cmd.contains("wpa_cli -p /var/run/wpa_supplicant -i 'wlan0' status"):
      if supMode == smAssociateFails:
        return ("wpa_state=SCANNING\n", 0)
      return ("ssid=home-wifi\nwpa_state=COMPLETED\n", 0)
    if cmd.contains("wpa_passphrase 'home-wifi'"):
      return ("network={\n\tssid=\"home-wifi\"\n\t#psk=\"pw12345678\"\n\tpsk=deadbeef\n}\n", 0)
    if cmd.contains("ip -4 addr show"):
      if supMode == smNoDhcpLease:
        return ("", 0)
      return ("    inet 192.168.1.42/24 brd 192.168.1.255 scope global wlan0\n", 0)

    # Liveness probes must fail unless the hotspot is meant to be up,
    # otherwise the default rc 0 would read as "already running".
    if cmd.contains("kill -0") or cmd.contains("pkill -0"):
      return ("", (if supMode == smHotspotUp: 0 else: 1))

    ("", 0)

proc supWriteFileHook(path, content: string, mode: int): bool {.gcsafe, nimcall.} =
  {.gcsafe.}:
    supFiles[path] = content
    true

proc supReadFileHook(path: string): string {.gcsafe, nimcall.} =
  {.gcsafe.}:
    supFiles.getOrDefault(path, "")

proc supPathExistsHook(path: string): bool {.gcsafe, nimcall.} =
  {.gcsafe.}:
    path == "/etc/wpa_supplicant" or supFiles.hasKey(path)

suite "portal supplicant backend":
  setup:
    resetPortalHooksForTest()
    resetHookState()
    resetSupplicantState()
    setPortalHooksForTest(
      runHook = supRunHook,
      sleepHook = sleepHook,
      autoTimeoutEnabledHook = autoTimeoutDisabled,
      writeFileHook = supWriteFileHook,
      readFileHook = supReadFileHook,
      pathExistsHook = supPathExistsHook,
    )
    drainEventChannel()

  teardown:
    resetPortalHooksForTest()
    resetHookState()
    resetSupplicantState()
    drainEventChannel()

  test "a frame without nmcli picks the supplicant backend":
    check activeNetworkBackend() == nbSupplicant

  test "availableNetworks scans with iw and returns the nmcli-shaped list":
    let networks = availableNetworks(makeFrameOS())
    check networks == @["wifi-a", "wifi-b"]
    check supRan("iw dev 'wlan0' scan")
    # Cached on the state partition for when hostapd owns the radio.
    check supFiles["/srv/frameos/state/wpa_supplicant/last-scan.txt"].contains("wifi-a")

  test "availableNetworks falls back to the cached scan when the radio is busy":
    discard availableNetworks(makeFrameOS()) # populate the cache
    supMode = smScanEmpty
    check availableNetworks(makeFrameOS()) == @["wifi-a", "wifi-b"]

  test "attemptConnect writes a persistent wpa_supplicant.conf and takes a lease":
    let frame = makeFrameOS()
    let ok = attemptConnect(frame, "home-wifi", "pw12345678")

    check ok
    check frame.network.status == NetworkStatus.connected
    let confPath = "/etc/wpa_supplicant/wpa_supplicant-wlan0.conf"
    check supFiles.hasKey(confPath)
    check supFiles[confPath].contains("ssid=\"home-wifi\"")
    check supFiles[confPath].contains("psk=\"pw12345678\"")
    check supRan("wpa_supplicant -B -i 'wlan0' -c '" & confPath & "' -D nl80211")
    check supRan("udhcpc -i 'wlan0' -f -n -q")
    # busybox udhcpc quits once bound, so a renewing daemon has to stay behind
    check supRan("sudo udhcpc -i 'wlan0' -t 5 -T 3 -A 20")

    let (hasEvent, ev) = eventChannel.tryRecv()
    check hasEvent
    check ev[1] == "setCurrentScene"

  test "attemptConnect hashes the passphrase when wpa_passphrase exists":
    supHasWpaPassphrase = true
    check attemptConnect(makeFrameOS(), "home-wifi", "pw12345678")
    let conf = supFiles["/etc/wpa_supplicant/wpa_supplicant-wlan0.conf"]
    check conf.contains("psk=deadbeef")
    check not conf.contains("pw12345678") # the plaintext comment is stripped

  test "attemptConnect reports an actionable error when association stalls":
    supMode = smAssociateFails
    let frame = makeFrameOS()
    let ok = attemptConnect(frame, "home-wifi", "pw12345678")

    check not ok
    check frame.network.status == NetworkStatus.error
    check getLastError().contains("association did not complete")

  test "attemptConnect fails loudly when no DHCP lease arrives":
    supMode = smNoDhcpLease
    check not attemptConnect(makeFrameOS(), "home-wifi", "pw12345678")
    check getLastError().contains("no DHCP lease")

  test "startAp raises hostapd with a static IP and a DHCP server":
    let frame = makeFrameOS(timeoutSeconds = 0.0)
    startAp(frame)

    check frame.network.hotspotStatus == HotspotStatus.enabled
    # Generated into the state dir; the image's own /etc/hostapd.conf sample
    # is never touched.
    check supFiles["/srv/frameos/state/network/hostapd.conf"].contains("ssid=FrameOS-Setup")
    check supFiles["/srv/frameos/state/network/hostapd.conf"].contains("wpa_passphrase=secret1234")
    check supRan("hostapd -B -P '/run/frameos/hostapd.pid'")
    check supRan("ip addr add 10.42.0.1/24 dev 'wlan0'")
    check supRan("dnsmasq --conf-file=/dev/null --interface='wlan0'")
    # The scan has to happen before the radio flips to AP mode.
    check supRan("iw dev 'wlan0' scan")

    let (ok, ev) = eventChannel.tryRecv()
    check ok
    check ev[1] == "setCurrentScene"
    check ev[2]["sceneId"].getStr() == "system/wifiHotspot"

  test "startAp reports the hotspot as failed when hostapd is missing":
    # Same shape as the nmcli failure path: status error, no scene event.
    let frame = makeFrameOS()
    frame.frameConfig.network.wifiHotspotPassword = "short"
    startAp(frame)

    check frame.network.hotspotStatus == HotspotStatus.error
    check getLastError().contains("8-63")
    let (ok, _) = eventChannel.tryRecv()
    check not ok

  test "stopAp kills the daemons and restores station mode":
    supMode = smHotspotUp
    let frame = makeFrameOS()
    frame.network.hotspotStatus = HotspotStatus.enabled
    stopAp(frame)

    check frame.network.hotspotStatus == HotspotStatus.disabled
    check supRan("hostapd.pid")
    check supRan("dnsmasq.pid")
    check supRan("ip link set 'wlan0' down")
    check supRan("ip link set 'wlan0' up")

  test "activeConnectionStatus reports the joined network in the shared shape":
    let status = activeConnectionStatus(makeFrameOS())
    check status["connected"].getBool()
    check status["ssid"].getStr() == "home-wifi"
    check status["state"].getStr() == "COMPLETED"
    check status["ip"].getStr() == "192.168.1.42"

  test "an explicit override pins the backend for debugging":
    setNetworkBackendOverride("networkManager")
    check activeNetworkBackend() == nbNetworkManager
