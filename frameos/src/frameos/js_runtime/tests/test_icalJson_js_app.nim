## The iCal app (repo/apps/json/icalJson) through the real JS app runtime, on
## a spool the way a scene hands it one: downloadUrl's body on disk. The feed
## must not reach the JS heap, so the big-file test runs with a heap far
## smaller than the feed.

import std/[json, os, strutils, unittest]

import frameos/js_runtime/app_runtime
import frameos/spool
import frameos/types
import frameos/values

const AppDir = currentSourcePath().parentDir() / ".." / ".." / ".." / ".." / ".." / "repo" / "apps" / "json" / "icalJson"
const ScratchDir = "tmp/ical-js-tests"
let appSource = readFile(AppDir / "app.ts")
let appConfigJson = readFile(AppDir / "config.json")

proc bigCalendar(events: int): string =
  ## Each event carries what a real feed is made of: attendees and a long
  ## folded description. All but the odd ones are outside the export window.
  result = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:UTC\r\n"
  for i in 0 ..< events:
    let day = align($(1 + (i mod 27)), 2, '0')
    let year = if i mod 2 == 0: "2020" else: "2030"
    result.add("BEGIN:VEVENT\r\nUID:event-" & $i & "\r\n")
    result.add("DTSTART:" & year & "01" & day & "T090000Z\r\nDTEND:" & year & "01" & day & "T100000Z\r\n")
    result.add("SUMMARY:Event number " & $i & "\r\n")
    for a in 0 ..< 6:
      result.add("ATTENDEE;CN=Someone " & $a & ";PARTSTAT=ACCEPTED:mailto:someone-" & $a & "@example.com\r\n")
    result.add("DESCRIPTION:A description long enough to fold over several\r\n")
    for fold in 0 ..< 8:
      result.add(" continuation lines, repeated so the body is large: " & repeat("padding ", 6) & "\r\n")
    result.add("END:VEVENT\r\n")
  result.add("END:VCALENDAR\r\n")

type Harness = object
  scene: FrameScene
  app: AppRoot
  errors: ref seq[string]

var harnessCount = 0

proc newHarness(config: JsonNode, heapMb = -1): Harness =
  inc harnessCount # the heap limit is per scene id
  let frame = FrameConfig(width: 200, height: 120, rotate: 0, scalingMode: "cover", debug: false,
    saveAssets: %*false, settings: %*{}, timeZone: "UTC",
    js: JsRuntimeConfig(executionTimeoutMs: -1, memoryLimitMb: heapMb, maxStackKb: -1))
  let errors = new(seq[string])
  var logger = Logger(frameConfig: frame, enabled: true)
  logger.log = proc(payload: JsonNode) =
    if payload.hasKey("error"):
      errors[].add(payload["error"].getStr())
  logger.enable = proc() = discard
  logger.disable = proc() = discard
  let scene = FrameScene(id: ("tests/ical-js-app-" & $harnessCount).SceneId, frameConfig: frame, state: %*{}, logger: logger)
  let node = DiagramNode(id: 41.NodeId, nodeType: "app", data: %*{"keyword": "icalJson", "config": config})
  Harness(scene: scene, errors: errors,
    app: initDynamicJsApp("icalJson", node, scene, %*{"app.ts": appSource, "config.json": appConfigJson}))

proc run(h: Harness, ical: Value): JsonNode =
  h.app.setDynamicJsAppField("ical", ical)
  let context = ExecutionContext(scene: h.scene, event: "render", payload: %*{}, hasImage: false)
  result = h.app.getDynamicJsApp(context).asJson()

let window = %*{"exportFrom": "2029-01-01", "exportUntil": "2031-01-01", "exportCount": 10000, "addDescription": true}

suite "icalJson JS app over a spool":
  setup:
    createDir(ScratchDir)

  test "a file-backed feed parses to exactly what the in-memory one does":
    let body = bigCalendar(400)
    let path = ScratchDir / "big.ics"
    writeFile(path, body)
    check body.len > 100_000
    let fromMemory = newHarness(window).run(VSpool(newMemorySpool(body)))
    let fromFile = newHarness(window).run(VSpool(newFileSpool(path, body.len, owned = false)))
    let fromString = newHarness(window).run(VString(body))
    check fromMemory.len == 200
    check fromFile == fromMemory
    check fromString == fromMemory
    # The folded DESCRIPTION survives the windows it was read through.
    check fromMemory[0]["description"].getStr().contains("continuation lines")

  test "a feed many times the JS heap is read without it":
    let body = bigCalendar(8000)
    let path = ScratchDir / "huge.ics"
    writeFile(path, body)
    check body.len > 8 * 1024 * 1024
    let h = newHarness(%*{"exportFrom": "2030-01-05", "exportUntil": "2030-01-06"}, heapMb = 1)
    let reply = h.run(VSpool(newFileSpool(path, body.len, owned = false)))
    check h.errors[].len == 0
    check reply.len > 0
    # The heap would have had to hold the feed for any other way to pass.
    for event in reply:
      check event["summary"].getStr().startsWith("Event number")

  test "the app reads a stream again on the next render":
    let body = bigCalendar(20)
    let path = ScratchDir / "again.ics"
    writeFile(path, body)
    let h = newHarness(window)
    let spool = VSpool(newFileSpool(path, body.len, owned = false))
    check h.run(spool).len == 10
    check h.run(spool).len == 10

  test "the temp file of a spool goes with the spool":
    let body = bigCalendar(3)
    let path = ScratchDir / "owned.ics"
    writeFile(path, body)
    block:
      let h = newHarness(window)
      discard h.run(VSpool(newFileSpool(path, body.len, owned = true)))
      discard h.run(VString("BEGIN:VCALENDAR\nEND:VCALENDAR\n"))
    # The harness let go of it, and no reader kept it open: the field was replaced.
    check not fileExists(path)

  test "a URL instead of a document is refused by name":
    let h = newHarness(%*{})
    check h.run(VSpool(newMemorySpool("https://example.com/calendar.ics"))).len == 0
    check h.errors[] == @["Pass in iCal data as a string, not a URL."]

  test "no document is an error too":
    let h = newHarness(%*{})
    check h.run(VSpool(newMemorySpool(""))).len == 0
    check h.errors[] == @["No iCal data provided."]

removeDir(ScratchDir)
