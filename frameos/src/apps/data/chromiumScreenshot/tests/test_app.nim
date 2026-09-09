import std/[json, strutils, unittest]
import std/posix
import pixie

import ../app
import frameos/types
import frameos/local_access

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
