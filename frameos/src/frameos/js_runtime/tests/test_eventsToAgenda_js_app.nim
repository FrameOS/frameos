## The Events to Agenda code app (repo/apps/text/eventsToAgenda) run for real
## through the JS app runtime: the Nim app's tests, ported. Today is the
## clock's, so the test that starts with today builds its event around it.

import std/[json, os, strutils, times, unittest]

import frameos/js_runtime/app_runtime
import frameos/types
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "text" / "eventsToAgenda"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

type Harness = object
  scene: FrameScene
  owner: AppRoot
  runtime: JsAppRuntime

proc newHarness(): Harness =
  let config = FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false, settings: %*{}, timeZone: "UTC")
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) = discard
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: "tests/events-to-agenda-js-app".SceneId, frameConfig: config, state: %*{}, logger: logger)
  let owner = AppRoot(nodeId: 31.NodeId, nodeName: "eventsToAgenda", appKeyword: "eventsToAgenda", scene: scene,
    frameConfig: config)
  let runtime = newJsAppRuntime(category = "data", outputType = "string", source = appSource, settingsKeys = @[],
    sourceName = "app.ts", sources = %*{"app.ts": appSource, "config.json": appConfigJson})
  Harness(scene: scene, owner: owner, runtime: runtime)

proc agenda(events: JsonNode, startWithToday = false): string =
  ## The node config the Nim test's AppConfig held; colors as the runtime
  ## hands a color field to a JS app (toHtmlHex).
  let h = newHarness()
  let config = %*{"events": events, "baseFontSize": 24.0, "titleFontSize": 48.0, "textColor": "#445566",
    "timeColor": "#778899", "titleColor": "#112233", "startWithToday": startWithToday}
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  let value = h.runtime.get(h.owner, config, context)
  check value.kind == fkString
  value.asString()

suite "Events to Agenda code app":
  test "formats and sorts events across days":
    let output = agenda(%*[
      {"summary": "Holiday", "startTime": "2024-12-25", "endTime": "2024-12-25"},
      {"summary": "Breakfast", "startTime": "2024-12-24T08:00:00", "endTime": "2024-12-24T09:00:00"}
    ])
    check output.contains("^(48,#112233)Tuesday, December 24")
    check output.contains("^(24,#778899)08:00 - 09:00  ^(24,#445566)Breakfast")
    check output.contains("^(48,#112233)Wednesday, December 25")
    check output.contains("^(24,#778899)All day  ^(24,#445566)Holiday")
    check output.find("Breakfast") < output.find("Holiday")

  test "shows until text for multi-day events":
    let output = agenda(%*[{"summary": "Conference", "startTime": "2024-12-25", "endTime": "2024-12-27"}])
    check output.contains("^(48,#112233)Wednesday, December 25")
    check output.contains("^(24,#778899)Until Friday, December 27  ^(24,#445566)Conference")

  test "shows ongoing multi-day event when starting with today":
    let
      now = now().utc
      start = (now - 3.days).format("yyyy-MM-dd")
      until = now + 1.days
      title = now.format("dddd") & ", " & now.format("MMMM") & " " & $now.monthday
      untilTitle = until.format("dddd") & ", " & until.format("MMMM") & " " & $until.monthday
    let output = agenda(%*[{"summary": "Retreat", "startTime": start, "endTime": until.format("yyyy-MM-dd")}],
      startWithToday = true)
    check not output.contains("No events today")
    check output.count("^(48,#112233)" & title) == 1
    check output.contains("^(24,#778899)Until " & untilTitle & "  ^(24,#445566)Retreat")
