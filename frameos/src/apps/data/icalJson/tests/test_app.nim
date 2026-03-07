import std/[json, strutils, unittest]

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

suite "data/icalJson app":
  test "url input is rejected with explicit log error":
    let logs = LogStore(items: @[])
    let app = App(
      nodeId: 12.NodeId,
      nodeName: "data/icalJson",
      scene: FrameScene(logger: newLogger(logs)),
      frameConfig: FrameConfig(timeZone: "UTC"),
      appConfig: AppConfig(ical: "http://example.com/calendar.ics")
    )

    let payload = app.get(ExecutionContext())

    check payload.kind == JArray
    check payload.len == 0
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:12:data/icalJson")
    check logs.items[0]["error"].getStr() == "Pass in iCal data as a string, not a URL."

  test "empty iCal payload is rejected":
    let logs = LogStore(items: @[])
    let app = App(
      nodeId: 13.NodeId,
      nodeName: "data/icalJson",
      scene: FrameScene(logger: newLogger(logs)),
      frameConfig: FrameConfig(timeZone: "UTC"),
      appConfig: AppConfig(ical: "")
    )

    let payload = app.get(ExecutionContext())

    check payload.kind == JArray
    check payload.len == 0
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("error:13:data/icalJson")
    check logs.items[0]["error"].getStr() == "No iCal data provided."

  test "valid iCal outside requested range returns empty reply and reply log":
    let logs = LogStore(items: @[])
    let app = App(
      nodeId: 14.NodeId,
      nodeName: "data/icalJson",
      scene: FrameScene(logger: newLogger(logs)),
      frameConfig: FrameConfig(timeZone: "UTC"),
      appConfig: AppConfig(
        ical: "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nDTSTART:20000101\nDTEND:20000102\nSUMMARY:Past Event\nEND:VEVENT\nEND:VCALENDAR",
        exportFrom: "2100-01-01",
        exportUntil: "2100-01-02"
      )
    )

    let payload = app.get(ExecutionContext())

    check payload.kind == JArray
    check payload.len == 0
    check logs.items.len == 1
    check logs.items[0]["event"].getStr().contains("log:14:data/icalJson:reply")
    check logs.items[0]["eventsInRange"].getInt() == 0
