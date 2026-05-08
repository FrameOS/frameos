import std/[json, strutils, unittest]
import pixie

import ../app
import frameos/types

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
