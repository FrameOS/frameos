import std/[json, os, strutils, unittest]
import frameos/apps
import frameos/spool
import frameos/types
import frameos/values
import ../app as icalApp
import ../app_loader as icalLoader

# The byte-side fold (docs/value-pipeline.md, phase 2).
#
# An ICS feed is the one input in the app library that is routinely multi-MB
# while its output is a handful of events. These pin the two claims that makes
# worth doing: that a file-backed feed parses to exactly what the in-memory one
# does, and that getting there never materializes the document.

const ScratchDir = "tmp/ical-spool-tests"

proc bigCalendar(events: int): string =
  ## A calendar with enough events to be comfortably larger than a window,
  ## including a folded DESCRIPTION so the continuation handling is exercised
  ## across window boundaries rather than only within one.
  result = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:UTC\r\n"
  for i in 0 ..< events:
    let day = 1 + (i mod 27)
    result.add("BEGIN:VEVENT\r\n")
    result.add("UID:event-" & $i & "\r\n")
    result.add("DTSTART:203001" & align($day, 2, '0') & "T090000Z\r\n")
    result.add("DTEND:203001" & align($day, 2, '0') & "T100000Z\r\n")
    result.add("SUMMARY:Event number " & $i & "\r\n")
    result.add("DESCRIPTION:A description long enough to fold over several\r\n")
    result.add(" continuation lines, repeated so the body is large: " &
               repeat("padding ", 12) & "\r\n")
    result.add("END:VEVENT\r\n")
  result.add("END:VCALENDAR\r\n")

proc silentLogger(): Logger =
  Logger(log: proc(payload: JsonNode) = discard payload)

proc newApp(ical: Spool): icalApp.App =
  icalApp.App(
    nodeId: 1.NodeId,
    nodeName: "icalJson",
    scene: FrameScene(logger: silentLogger()),
    frameConfig: FrameConfig(timeZone: "UTC", settings: %*{}),
    appConfig: icalApp.AppConfig(
      ical: ical,
      exportFrom: "2029-01-01",
      exportUntil: "2031-01-01",
      exportCount: 10_000,
      addDescription: true,
    )
  )

suite "icalJson over a spool":
  setup:
    createDir(ScratchDir)

  test "a file-backed feed parses to exactly what the in-memory one does":
    let body = bigCalendar(400)
    let path = ScratchDir / "big.ics"
    writeFile(path, body)
    check body.len > 100_000 # comfortably past the 8K window

    let fromMemory = newApp(newMemorySpool(body)).get(ExecutionContext())
    let fromFile = newApp(newFileSpool(path, body.len, owned = false)).get(ExecutionContext())

    check fromMemory.len == 400
    check fromMemory == fromFile
    # The folded DESCRIPTION must survive being split across windows.
    check fromMemory[0]["description"].getStr().contains("continuation lines")
    removeFile(path)

  test "the value on the edge costs a window, not the document":
    let body = bigCalendar(400)
    let path = ScratchDir / "sized.ics"
    writeFile(path, body)
    let spooled = VSpool(newFileSpool(path, body.len, owned = false))
    let materialized = VString(body)
    check spooled.approxByteSize() == DefaultWindowBytes
    check materialized.approxByteSize() == body.len
    check spooled.approxByteSize() * 10 < materialized.approxByteSize()
    removeFile(path)

  test "a URL instead of a document is caught without reading the body":
    # The misconfiguration check has to be a prefix test; if it materialized,
    # it would be the very thing that blows the budget on a huge feed.
    let app = newApp(newMemorySpool("https://example.com/calendar.ics"))
    check app.get(ExecutionContext()).len == 0

  test "the loader hands the app a spool, not a materialized string":
    # `byteIter` in config.json is what makes this true; without it the
    # generated setField would call asString() and defeat the whole tier.
    let body = bigCalendar(3)
    let path = ScratchDir / "loader.ics"
    writeFile(path, body)
    let node = DiagramNode(id: 7.NodeId, nodeType: "app", data: %*{"config": {}})
    let root = icalLoader.init(node, FrameScene(
      logger: silentLogger(), frameConfig: FrameConfig(settings: %*{})))
    root.setField("ical", VSpool(newFileSpool(path, body.len, owned = false)))
    check icalApp.App(root).appConfig.ical.isFileBacked()
    check icalApp.App(root).appConfig.ical.len == body.len
    removeFile(path)

removeDir(ScratchDir)
