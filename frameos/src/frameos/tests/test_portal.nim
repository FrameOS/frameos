import std/[json, strutils, unittest]

import ../channels
import ../portal
import ../types

type HookMode = enum
  hmWifiList
  hmStartApOk
  hmStartApFail
  hmStopAp
  hmAttemptSuccess
  hmAttemptFail

var hookMode {.global.}: HookMode
var runWifiListCalls {.global.}: int
var runShowActiveCalls {.global.}: int
var runHotspotCalls {.global.}: int
var runModifySharedCalls {.global.}: int
var runDownCalls {.global.}: int
var runDeleteCalls {.global.}: int
var runDeleteConnectionCalls {.global.}: int
var nmcliConnectCalls {.global.}: int
var sawExpectedNmcliArgs {.global.}: bool
var sleepCallCount {.global.}: int
var lastSleepMs {.global.}: int

proc resetHookState() =
  hookMode = hmWifiList
  runWifiListCalls = 0
  runShowActiveCalls = 0
  runHotspotCalls = 0
  runModifySharedCalls = 0
  runDownCalls = 0
  runDeleteCalls = 0
  runDeleteConnectionCalls = 0
  nmcliConnectCalls = 0
  sawExpectedNmcliArgs = false
  sleepCallCount = 0
  lastSleepMs = -1

proc runHook(cmd: string): (string, int) {.gcsafe, nimcall.} =
  if cmd.contains("nmcli --terse --fields SSID device wifi list"):
    inc runWifiListCalls
    return ("wifi-a\n\nwifi-b\nwifi-a\n", 0)
  if cmd.contains("connection show --active"):
    inc runShowActiveCalls
    if hookMode == hmStopAp:
      return ("frameos-hotspot\n", 0)
    return ("", 0)
  if cmd.contains("device wifi hotspot"):
    inc runHotspotCalls
    if hookMode == hmStartApFail:
      return ("failed", 2)
    return ("ok", 0)
  if cmd.contains("connection modify 'frameos-hotspot' ipv4.method shared"):
    inc runModifySharedCalls
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
  ("", 0)

proc nmcliHook(args: seq[string]): tuple[rc: int, output: string] {.gcsafe, nimcall.} =
  inc nmcliConnectCalls
  sawExpectedNmcliArgs =
    args.len == 14 and
    args[0] == "-n" and args[1] == "nmcli" and args[2] == "--wait" and args[3] == "15" and
    args[4] == "device" and args[5] == "wifi" and args[6] == "connect" and
    args[7] == "home-wifi" and args[8] == "password" and args[9] == "pw" and
    args[10] == "ifname" and args[11] == "wlan0" and args[12] == "name" and args[13] == "frameos-wifi"
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
    check runHotspotCalls == 1
    check runModifySharedCalls == 1

    let (ok, ev) = eventChannel.tryRecv()
    check ok
    check ev[1] == "setCurrentScene"
    check ev[2]["sceneId"].getStr() == "system/wifiHotspot"

  test "startAp marks hotspot error when hotspot command fails":
    hookMode = hmStartApFail
    let frame = makeFrameOS()
    startAp(frame)

    check frame.network.hotspotStatus == HotspotStatus.error
    check runHotspotCalls == 1
    check runModifySharedCalls == 0

    let (ok, _) = eventChannel.tryRecv()
    check not ok

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
    check nmcliConnectCalls == 1
    check sleepCallCount == 0
