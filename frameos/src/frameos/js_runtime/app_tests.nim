## Runs a JavaScript app's tests (`<name>.test.ts` next to its `app.ts`;
## docs/js-apps-and-code-nodes.md, "Testing an app") in the interpreter the
## app itself runs in: the app prelude, then the harness
## (app_test_harness.js: describe / it / expect / mock / makeApp), then the
## test file as the main module, whose `import './app'` resolves against the
## app's own sources like any other import. The wasm preview exports it
## (frameos_wasm_run_app_tests) for the editor's Run button, and
## test_js_app_tests.nim runs every repo app's tests through it.
import std/[algorithm, json, math, strutils, times]
import frameos/types
import frameos/js_runtime/app_runtime

const appTestHarness* = staticRead("app_test_harness.js")

proc isAppTestFile*(name: string): bool =
  ## `x.test.ts`, `x.test.tsx`, `x.test.js`, `x.test.jsx`, in any folder of the app.
  let lower = name.toLowerAscii()
  for ext in [".test.ts", ".test.tsx", ".test.js", ".test.jsx"]:
    if lower.endsWith(ext):
      return true
  false

proc appTestFiles*(sources: JsonNode): seq[string] =
  ## The app's test files, in name order.
  if sources.isNil or sources.kind != JObject:
    return @[]
  for name, _ in sources.pairs:
    if isAppTestFile(name):
      result.add(name)
  result.sort()

proc failedReport(message: string): JsonNode =
  %*{"ok": false, "error": message, "counts": {"passed": 0, "failed": 0, "skipped": 0, "total": 0},
     "durationMs": 0, "children": [], "logs": []}

proc runJsAppTests*(sources: JsonNode, testFile: string, frameConfig: FrameConfig): JsonNode =
  ## The report of one test file: `{ok, counts, durationMs, children, logs}`
  ## as the harness builds it, or `{ok: false, error}` when the file (or
  ## what it imports) does not load. Every log line the tests make stays in
  ## the report; nothing reaches the frame's logger.
  if sources.isNil or sources.kind != JObject or not sources.hasKey(testFile):
    return failedReport("No such file in the app: " & testFile)
  if not isAppTestFile(testFile):
    return failedReport("Not a test file (name it <something>.test.ts): " & testFile)
  var config = %*{}
  if sources.hasKey("config.json"):
    try:
      config = parseJson(sources["config.json"].getStr("{}"))
      if config.kind != JObject:
        config = %*{}
    except CatchableError:
      config = %*{}
  var settingsKeys: seq[string] = @[]
  if config.hasKey("settings") and config["settings"].kind == JArray:
    for key in config["settings"]:
      if key.kind == JString:
        settingsKeys.add(key.getStr())

  let started = epochTime()
  var logs = new(seq[JsonNode])
  var logger = Logger(frameConfig: frameConfig, enabled: true)
  logger.log = proc(payload: JsonNode) = logs[].add(payload)
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: ("tests/" & testFile).SceneId, frameConfig: frameConfig, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 1.NodeId, nodeName: config{"name"}.getStr("app"), appKeyword: "app",
    scene: scene, frameConfig: frameConfig)
  let runtime = newJsAppRuntime(category = config{"category"}.getStr("data"), outputType = "json",
    source = sources[testFile].getStr(), settingsKeys = settingsKeys, sourceName = testFile, sources = sources,
    assetGrant = assetGrantFromConfig(config))
  runtime.extraPrelude = "globalThis.__frameosTestAppConfig = " & escapeJson($config) & ";\n" & appTestHarness
  let context = ExecutionContext(scene: scene, event: "test", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  try:
    let report = parseJson(runtime.callAppGlobalForText(owner, %*{}, context, "__frameosRunAppTests"))
    if report.kind != JObject:
      return failedReport("The test harness returned no report")
    report["file"] = %testFile
    report["wallMs"] = %(round((epochTime() - started) * 1000, 2))
    return report
  except CatchableError as error:
    result = failedReport(error.msg)
    result["file"] = %testFile
  finally:
    releaseJsAppRuntime(AppRoot(DynamicJsApp(nodeId: owner.nodeId, nodeName: owner.nodeName,
      appKeyword: owner.appKeyword, scene: scene, frameConfig: frameConfig, configJson: %*{}, runtime: runtime)))

proc runAllJsAppTests*(sources: JsonNode, frameConfig: FrameConfig): JsonNode =
  ## Every test file of the app, one report each, as `{ok, files: [...]}`.
  var files = newJArray()
  var ok = true
  for name in appTestFiles(sources):
    let report = runJsAppTests(sources, name, frameConfig)
    if not report{"ok"}.getBool(false):
      ok = false
    files.add(report)
  %*{"ok": ok, "files": files}
