import std/[json, sets, strutils, tables, unittest]
import std/posix
import pixie

import ../app
import frameos/types
import frameos/local_access
import frameos/spawn_guard
import frameos/utils/http_client

type LogStore = ref object
  items: seq[JsonNode]

var
  ramProbeValue {.global.}: int
  ensureSystemDependenciesCalls {.global.}: int
  ensureVenvExistsCalls {.global.}: int
  ensureBackgroundBrowserCalls {.global.}: int
  ensureBackgroundBrowserResult {.global.}: bool

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

proc fakeRamProbe(): int =
  ramProbeValue

proc fakeEnsureSystemDependencies(self: App) =
  inc ensureSystemDependenciesCalls

proc fakeEnsureVenvExists(self: App): string =
  inc ensureVenvExistsCalls
  "/tmp/frameos-test-venv"

proc fakeEnsureBackgroundBrowser(self: App, width: int, height: int): bool =
  inc ensureBackgroundBrowserCalls
  ensureBackgroundBrowserResult

proc logContains(store: LogStore, needle: string): bool =
  for item in store.items:
    if ($item).contains(needle):
      return true
  false

proc makeApp(scene: FrameScene, frameConfig: FrameConfig): App =
  App(
    scene: scene,
    frameConfig: frameConfig,
    appConfig: AppConfig(url: "https://example.com")
  )

suite "data/chromiumScreenshot app":
  test "a store-origin scene is refused before any browser is spawned":
    let previousRamProbeHook = chromiumRamProbeHook
    let previousEnsureSystemDependenciesHook = chromiumEnsureSystemDependenciesHook
    let previousEnsureVenvExistsHook = chromiumEnsureVenvExistsHook
    let previousEnsureBackgroundBrowserHook = chromiumEnsureBackgroundBrowserHook
    defer:
      chromiumRamProbeHook = previousRamProbeHook
      chromiumEnsureSystemDependenciesHook = previousEnsureSystemDependenciesHook
      chromiumEnsureVenvExistsHook = previousEnsureVenvExistsHook
      chromiumEnsureBackgroundBrowserHook = previousEnsureBackgroundBrowserHook
      forgetStoredLocalNetworkAccess()

    ramProbeValue = 4_000_000
    ensureSystemDependenciesCalls = 0
    ensureVenvExistsCalls = 0
    ensureBackgroundBrowserCalls = 0
    ensureBackgroundBrowserResult = true
    chromiumRamProbeHook = fakeRamProbe
    chromiumEnsureSystemDependenciesHook = fakeEnsureSystemDependencies
    chromiumEnsureVenvExistsHook = fakeEnsureVenvExists
    chromiumEnsureBackgroundBrowserHook = fakeEnsureBackgroundBrowser

    let logs = LogStore(items: @[])
    # Provenance, not transport: the scene came from the store, whoever put
    # it on this frame (spawn_guard.nim).
    let scene = InterpretedFrameScene(id: "store".SceneId, logger: newLogger(logs), storeOrigin: true)
    let app = makeApp(scene, FrameConfig(width: 10, height: 6))
    app.init()
    let browserCallsAfterInit = ensureBackgroundBrowserCalls
    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 10
    check outputImage.height == 6
    check ensureBackgroundBrowserCalls == browserCallsAfterInit
    check logs.logContains("scene store")

  test "a bad target URL is refused before the browser opens it":
    let previousRamProbeHook = chromiumRamProbeHook
    let previousEnsureSystemDependenciesHook = chromiumEnsureSystemDependenciesHook
    let previousEnsureVenvExistsHook = chromiumEnsureVenvExistsHook
    let previousEnsureBackgroundBrowserHook = chromiumEnsureBackgroundBrowserHook
    defer:
      chromiumRamProbeHook = previousRamProbeHook
      chromiumEnsureSystemDependenciesHook = previousEnsureSystemDependenciesHook
      chromiumEnsureVenvExistsHook = previousEnsureVenvExistsHook
      chromiumEnsureBackgroundBrowserHook = previousEnsureBackgroundBrowserHook

    ramProbeValue = 4_000_000
    ensureBackgroundBrowserResult = true
    chromiumRamProbeHook = fakeRamProbe
    chromiumEnsureSystemDependenciesHook = fakeEnsureSystemDependencies
    chromiumEnsureVenvExistsHook = fakeEnsureVenvExists
    chromiumEnsureBackgroundBrowserHook = fakeEnsureBackgroundBrowser

    let logs = LogStore(items: @[])
    let app = App(
      scene: FrameScene(logger: newLogger(logs)),
      frameConfig: FrameConfig(width: 10, height: 6),
      appConfig: AppConfig(url: "file:///etc/shadow")
    )
    app.init()
    discard app.get(ExecutionContext(hasImage: false))
    check logs.logContains("refused to open the configured URL")

  test "as root, Chromium is refused until the panel ceremony allowed shell apps":
    let previousRamProbeHook = chromiumRamProbeHook
    let previousEnsureSystemDependenciesHook = chromiumEnsureSystemDependenciesHook
    let previousEnsureVenvExistsHook = chromiumEnsureVenvExistsHook
    let previousEnsureBackgroundBrowserHook = chromiumEnsureBackgroundBrowserHook
    defer:
      chromiumRamProbeHook = previousRamProbeHook
      chromiumEnsureSystemDependenciesHook = previousEnsureSystemDependenciesHook
      chromiumEnsureVenvExistsHook = previousEnsureVenvExistsHook
      chromiumEnsureBackgroundBrowserHook = previousEnsureBackgroundBrowserHook
      forgetStoredLocalNetworkAccess()

    ramProbeValue = 4_000_000
    ensureBackgroundBrowserCalls = 0
    ensureBackgroundBrowserResult = true
    chromiumRamProbeHook = fakeRamProbe
    chromiumEnsureSystemDependenciesHook = fakeEnsureSystemDependencies
    chromiumEnsureVenvExistsHook = fakeEnsureVenvExists
    chromiumEnsureBackgroundBrowserHook = fakeEnsureBackgroundBrowser

    let logs = LogStore(items: @[])
    let app = makeApp(FrameScene(logger: newLogger(logs)), FrameConfig(width: 10, height: 6))
    app.init()
    let browserCallsAfterInit = ensureBackgroundBrowserCalls
    let outputImage = app.get(ExecutionContext(hasImage: false))
    check outputImage.width == 10
    check outputImage.height == 6
    if geteuid() == 0:
      # Root (CI containers): the render is refused and the browser never
      # asked for, until the local admin accepted it at the panel.
      check ensureBackgroundBrowserCalls == browserCallsAfterInit
      check logs.logContains("unsandboxed as root")
      persistAllowShellApps(true)
      discard app.get(ExecutionContext(hasImage: false))
      check ensureBackgroundBrowserCalls > browserCallsAfterInit
    else:
      # Unprivileged (the frameos user, every dev laptop): no gate, and the
      # sandbox flag is never passed.
      check ensureBackgroundBrowserCalls > browserCallsAfterInit
      check not logs.logContains("unsandboxed as root")

  test "low RAM guard returns frame-sized error image and skips bootstrap":
    let previousRamProbeHook = chromiumRamProbeHook
    let previousEnsureSystemDependenciesHook = chromiumEnsureSystemDependenciesHook
    let previousEnsureVenvExistsHook = chromiumEnsureVenvExistsHook
    let previousEnsureBackgroundBrowserHook = chromiumEnsureBackgroundBrowserHook
    defer:
      chromiumRamProbeHook = previousRamProbeHook
      chromiumEnsureSystemDependenciesHook = previousEnsureSystemDependenciesHook
      chromiumEnsureVenvExistsHook = previousEnsureVenvExistsHook
      chromiumEnsureBackgroundBrowserHook = previousEnsureBackgroundBrowserHook

    ramProbeValue = 200_000
    ensureSystemDependenciesCalls = 0
    ensureVenvExistsCalls = 0
    ensureBackgroundBrowserCalls = 0
    ensureBackgroundBrowserResult = true

    chromiumRamProbeHook = fakeRamProbe
    chromiumEnsureSystemDependenciesHook = fakeEnsureSystemDependencies
    chromiumEnsureVenvExistsHook = fakeEnsureVenvExists
    chromiumEnsureBackgroundBrowserHook = fakeEnsureBackgroundBrowser

    let logs = LogStore(items: @[])
    let app = makeApp(
      FrameScene(logger: newLogger(logs)),
      FrameConfig(width: 10, height: 6, rotate: 90)
    )

    app.init()
    let outputImage = app.get(ExecutionContext(hasImage: false))

    check outputImage.width == 6
    check outputImage.height == 10
    check ensureSystemDependenciesCalls == 0
    check ensureVenvExistsCalls == 0
    check ensureBackgroundBrowserCalls == 0
    check logs.logContains("Not enough RAM")

  test "browser unavailable returns deterministic fallback behavior":
    let previousRamProbeHook = chromiumRamProbeHook
    let previousEnsureSystemDependenciesHook = chromiumEnsureSystemDependenciesHook
    let previousEnsureVenvExistsHook = chromiumEnsureVenvExistsHook
    let previousEnsureBackgroundBrowserHook = chromiumEnsureBackgroundBrowserHook
    defer:
      chromiumRamProbeHook = previousRamProbeHook
      chromiumEnsureSystemDependenciesHook = previousEnsureSystemDependenciesHook
      chromiumEnsureVenvExistsHook = previousEnsureVenvExistsHook
      chromiumEnsureBackgroundBrowserHook = previousEnsureBackgroundBrowserHook

    ramProbeValue = 2_000_000
    ensureSystemDependenciesCalls = 0
    ensureVenvExistsCalls = 0
    ensureBackgroundBrowserCalls = 0
    ensureBackgroundBrowserResult = false

    chromiumRamProbeHook = fakeRamProbe
    chromiumEnsureSystemDependenciesHook = fakeEnsureSystemDependencies
    chromiumEnsureVenvExistsHook = fakeEnsureVenvExists
    chromiumEnsureBackgroundBrowserHook = fakeEnsureBackgroundBrowser

    let logs = LogStore(items: @[])
    let app = makeApp(
      FrameScene(logger: newLogger(logs)),
      FrameConfig(width: 9, height: 5)
    )

    app.init()

    let withoutContext = app.get(ExecutionContext(hasImage: false))
    let withContext = app.get(ExecutionContext(hasImage: true, image: newImage(13, 7)))

    check withoutContext.width == 9
    check withoutContext.height == 5
    check withContext.width == 13
    check withContext.height == 7
    check ensureSystemDependenciesCalls == 1
    check ensureVenvExistsCalls == 3
    check ensureBackgroundBrowserCalls == 3

  test "resolver rules pin the page and every allowed sub-resource host, and deny the rest":
    # The deny is on: a literal page host maps to itself (the catch-all
    # would otherwise swallow it), each pinned host to the address this
    # runtime resolved, and `MAP * ~NOTFOUND` fails every other lookup —
    # first match wins, so the catch-all goes last.
    let target = SpawnTarget(hostname: "Example.com", port: 443, address: "93.184.216.34", denyActive: true)
    var pins = initOrderedTable[string, string]()
    pins["cdn.example.net"] = "203.0.113.7"
    pins["fonts.example.org"] = "198.51.100.9"
    check resolverRulesFor(target, pins) ==
      "MAP example.com 93.184.216.34, MAP cdn.example.net 203.0.113.7, MAP fonts.example.org 198.51.100.9, MAP * ~NOTFOUND"
    let literal = SpawnTarget(hostname: "93.184.216.34", port: 80, denyActive: true)
    check resolverRulesFor(literal, initOrderedTable[string, string]()) ==
      "MAP 93.184.216.34 93.184.216.34, MAP * ~NOTFOUND"
    # With the deny off nothing is pinned and Chromium resolves for itself.
    check resolverRulesFor(SpawnTarget(hostname: "example.com", port: 443), pins) == ""
    # The gate's allow-list is the page plus the allowed keys, host:port.
    check allowedTargetKeys(target, toHashSet(["cdn.example.net:443"])) == @["cdn.example.net:443", "example.com:443"]
    # The blocked-hosts file: junk lines are skipped, never pinned.
    let parsed = parseBlockedKeys("cdn.example.net:443\n\nnoport\n:80\nbad:port\n10.0.0.5:80\nx:70000\n")
    check parsed.len == 2
    check parsed[0].host == "cdn.example.net" and parsed[0].port == 443
    check parsed[1].key == "10.0.0.5:80"

  test "sub-resource hosts are resolved once by the runtime and captured again pinned":
    let previousRamProbeHook = chromiumRamProbeHook
    let previousEnsureSystemDependenciesHook = chromiumEnsureSystemDependenciesHook
    let previousEnsureVenvExistsHook = chromiumEnsureVenvExistsHook
    let previousEnsureBackgroundBrowserHook = chromiumEnsureBackgroundBrowserHook
    let previousCaptureHook = chromiumCaptureHook
    let previousPinHook = chromiumSubresourcePinHook
    defer:
      chromiumRamProbeHook = previousRamProbeHook
      chromiumEnsureSystemDependenciesHook = previousEnsureSystemDependenciesHook
      chromiumEnsureVenvExistsHook = previousEnsureVenvExistsHook
      chromiumEnsureBackgroundBrowserHook = previousEnsureBackgroundBrowserHook
      chromiumCaptureHook = previousCaptureHook
      chromiumSubresourcePinHook = previousPinHook
      setLocalNetworkPolicy(false)
      forgetStoredLocalNetworkAccess()

    ramProbeValue = 4_000_000
    ensureBackgroundBrowserResult = true
    chromiumRamProbeHook = fakeRamProbe
    chromiumEnsureSystemDependenciesHook = fakeEnsureSystemDependencies
    chromiumEnsureVenvExistsHook = fakeEnsureVenvExists
    chromiumEnsureBackgroundBrowserHook = fakeEnsureBackgroundBrowser
    if geteuid() == 0:
      persistAllowShellApps(true)

    var captures: seq[string] = @[]   # the ALLOWED line of each script run
    var resolved: seq[string] = @[]   # every host:port the runtime was asked about
    chromiumCaptureHook = proc(self: App, scriptFile, screenshotFile, blockedFile: string): tuple[output: string, exitCode: int] =
      for line in readFile(scriptFile).splitLines():
        if line.startsWith("ALLOWED = "):
          captures.add(line)
      # Pass one: the page asked for a CDN, a font host, a LAN address and
      # a loopback; pass two: everything it asked for was allowed.
      if captures.len == 1:
        writeFile(blockedFile, "10.0.0.5:80\ncdn.example.net:443\nfonts.example.org:443\nlocalhost:8787\n")
      else:
        writeFile(blockedFile, "")
      newImage(10, 6).writeFile(screenshotFile)
      ("", 0)
    chromiumSubresourcePinHook = proc(host: string, port: int): tuple[refusal: string, address: string] =
      resolved.add(host & ":" & $port)
      case host
      of "cdn.example.net": ("", "203.0.113.7")
      of "fonts.example.org": ("", "198.51.100.9")
      else: ("local network access is blocked on cloud-managed frames (" & host & ")", "")

    # A literal public page host: no lookup needed for the page itself, the
    # deny is on, so the gate is armed.
    setLocalNetworkPolicy(true)
    let logs = LogStore(items: @[])
    let app = App(
      scene: FrameScene(logger: newLogger(logs)),
      frameConfig: FrameConfig(width: 10, height: 6),
      appConfig: AppConfig(url: "http://93.184.216.34/dashboard")
    )
    app.init()
    let first = app.get(ExecutionContext(hasImage: false))
    check first.width == 10
    check first.height == 6
    # Two passes: gated to the page alone, then to the page plus the two
    # public hosts. The private ones were refused and never allowed.
    check captures.len == 2
    check captures[0] == "ALLOWED = [\"93.184.216.34:80\"]"
    check captures[1] == "ALLOWED = [\"93.184.216.34:80\",\"cdn.example.net:443\",\"fonts.example.org:443\"]"
    check resolved == @["10.0.0.5:80", "cdn.example.net:443", "fonts.example.org:443", "localhost:8787"]
    check chromiumLastResolverRules ==
      "MAP 93.184.216.34 93.184.216.34, MAP cdn.example.net 203.0.113.7, MAP fonts.example.org 198.51.100.9, MAP * ~NOTFOUND"
    check "10.0.0.5:80" in app.subresourceRefused
    check "localhost:8787" in app.subresourceRefused
    check not app.subresourceAllowed.contains("10.0.0.5:80")
    check logs.logContains("refused")

    # The next render keeps the pins: one pass, no second lookup of any host.
    discard app.get(ExecutionContext(hasImage: false))
    check captures.len == 3
    check captures[2] == captures[1]
    check resolved.len == 4

  test "with the deny off the page is not gated and nothing is pinned":
    let previousRamProbeHook = chromiumRamProbeHook
    let previousEnsureSystemDependenciesHook = chromiumEnsureSystemDependenciesHook
    let previousEnsureVenvExistsHook = chromiumEnsureVenvExistsHook
    let previousEnsureBackgroundBrowserHook = chromiumEnsureBackgroundBrowserHook
    let previousCaptureHook = chromiumCaptureHook
    defer:
      chromiumRamProbeHook = previousRamProbeHook
      chromiumEnsureSystemDependenciesHook = previousEnsureSystemDependenciesHook
      chromiumEnsureVenvExistsHook = previousEnsureVenvExistsHook
      chromiumEnsureBackgroundBrowserHook = previousEnsureBackgroundBrowserHook
      chromiumCaptureHook = previousCaptureHook
      forgetStoredLocalNetworkAccess()

    ramProbeValue = 4_000_000
    ensureBackgroundBrowserResult = true
    chromiumRamProbeHook = fakeRamProbe
    chromiumEnsureSystemDependenciesHook = fakeEnsureSystemDependencies
    chromiumEnsureVenvExistsHook = fakeEnsureVenvExists
    chromiumEnsureBackgroundBrowserHook = fakeEnsureBackgroundBrowser
    if geteuid() == 0:
      persistAllowShellApps(true)
    var allowedLines: seq[string] = @[]
    chromiumCaptureHook = proc(self: App, scriptFile, screenshotFile, blockedFile: string): tuple[output: string, exitCode: int] =
      for line in readFile(scriptFile).splitLines():
        if line.startsWith("ALLOWED = "):
          allowedLines.add(line)
      writeFile(blockedFile, "cdn.example.net:443\n")
      newImage(10, 6).writeFile(screenshotFile)
      ("", 0)

    setLocalNetworkPolicy(false)
    let app = App(
      scene: FrameScene(logger: newLogger(LogStore(items: @[]))),
      frameConfig: FrameConfig(width: 10, height: 6),
      appConfig: AppConfig(url: "http://192.168.1.20/panel")
    )
    app.init()
    discard app.get(ExecutionContext(hasImage: false))
    check allowedLines == @["ALLOWED = None"]
    check chromiumLastResolverRules == ""
    check app.subresourcePins.len == 0

  test "a document redirect to a new host is pinned and the page captured again":
    let previousRamProbeHook = chromiumRamProbeHook
    let previousEnsureSystemDependenciesHook = chromiumEnsureSystemDependenciesHook
    let previousEnsureVenvExistsHook = chromiumEnsureVenvExistsHook
    let previousEnsureBackgroundBrowserHook = chromiumEnsureBackgroundBrowserHook
    let previousCaptureHook = chromiumCaptureHook
    let previousPinHook = chromiumSubresourcePinHook
    defer:
      chromiumRamProbeHook = previousRamProbeHook
      chromiumEnsureSystemDependenciesHook = previousEnsureSystemDependenciesHook
      chromiumEnsureVenvExistsHook = previousEnsureVenvExistsHook
      chromiumEnsureBackgroundBrowserHook = previousEnsureBackgroundBrowserHook
      chromiumCaptureHook = previousCaptureHook
      chromiumSubresourcePinHook = previousPinHook
      setLocalNetworkPolicy(false)
      forgetStoredLocalNetworkAccess()

    ramProbeValue = 4_000_000
    ensureBackgroundBrowserResult = true
    chromiumRamProbeHook = fakeRamProbe
    chromiumEnsureSystemDependenciesHook = fakeEnsureSystemDependencies
    chromiumEnsureVenvExistsHook = fakeEnsureVenvExists
    chromiumEnsureBackgroundBrowserHook = fakeEnsureBackgroundBrowser
    if geteuid() == 0:
      persistAllowShellApps(true)

    var runs = 0
    chromiumCaptureHook = proc(self: App, scriptFile, screenshotFile, blockedFile: string): tuple[output: string, exitCode: int] =
      inc runs
      if runs == 1:
        # The navigation itself was gated: the page redirected elsewhere.
        writeFile(blockedFile, "www.example.com:443\n")
        return ("", 75)
      writeFile(blockedFile, "")
      newImage(10, 6).writeFile(screenshotFile)
      ("", 0)
    chromiumSubresourcePinHook = proc(host: string, port: int): tuple[refusal: string, address: string] =
      if host == "www.example.com": ("", "93.184.216.35") else: ("blocked", "")

    setLocalNetworkPolicy(true)
    let logs = LogStore(items: @[])
    let app = App(
      scene: FrameScene(logger: newLogger(logs)),
      frameConfig: FrameConfig(width: 10, height: 6),
      appConfig: AppConfig(url: "http://93.184.216.34/")
    )
    app.init()
    discard app.get(ExecutionContext(hasImage: false))
    check runs == 2
    check chromiumLastResolverRules ==
      "MAP 93.184.216.34 93.184.216.34, MAP www.example.com 93.184.216.35, MAP * ~NOTFOUND"
    check not logs.logContains("Playwright command failed")

    # A redirect to a refused host stays refused, and says so.
    runs = 0
    chromiumCaptureHook = proc(self: App, scriptFile, screenshotFile, blockedFile: string): tuple[output: string, exitCode: int] =
      inc runs
      writeFile(blockedFile, "10.0.0.9:80\n")
      ("", 75)
    discard app.get(ExecutionContext(hasImage: false))
    check runs == 1
    check logs.logContains("private-network policy refuses")
