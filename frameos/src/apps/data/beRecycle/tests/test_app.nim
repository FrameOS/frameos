import std/[json, unittest]

import ../app
import frameos/types

type LogStore = ref object
  items: seq[JsonNode]

var
  authCalls {.global.}: int
  capturedFromDay {.global.}: string
  capturedToDay {.global.}: string

proc newLogger(store: LogStore): Logger =
  Logger(
    log: proc(payload: JsonNode) =
      store.items.add(payload)
  )

proc fakeAuthenticate(self: App) =
  inc authCalls

proc fakeFetchCollections(self: App, fromDate: string, toDate: string): JsonNode =
  capturedFromDay = fromDate
  capturedToDay = toDate
  %*{
    "items": [
      {
        "timestamp": "2026-01-06T00:00:00Z",
        "fraction": {"name": {"en": "Paper"}}
      }
    ]
  }

suite "data/beRecycle app":
  test "collectionsToEvents maps payload into event shape":
    let app = App(
      scene: FrameScene(logger: newLogger(LogStore(items: @[]))),
      frameConfig: FrameConfig(timeZone: "Europe/Brussels"),
      appConfig: AppConfig(language: "en")
    )
    let collections = %*{
      "items": [
        {
          "timestamp": "2026-02-10T05:00:00Z",
          "fraction": {"name": {"en": "PMD"}}
        }
      ]
    }

    let events = app.collectionsToEvents(collections)
    check events.len == 1
    check events[0]["summary"].getStr() == "Trash: PMD"
    check events[0]["startTime"].getStr() == "2026-02-10T08:00:00"
    check events[0]["endTime"].getStr() == "2026-02-10T08:15:00"
    check events[0]["timezone"].getStr() == "Europe/Brussels"

  test "get uses hooks and forwards configured day range":
    let previousAuthHook = beRecycleAuthenticateHook
    let previousCollectionsHook = beRecycleFetchCollectionsHook
    beRecycleAuthenticateHook = fakeAuthenticate
    beRecycleFetchCollectionsHook = fakeFetchCollections
    defer:
      beRecycleAuthenticateHook = previousAuthHook
      beRecycleFetchCollectionsHook = previousCollectionsHook

    authCalls = 0
    capturedFromDay = ""
    capturedToDay = ""

    let app = App(
      scene: FrameScene(logger: newLogger(LogStore(items: @[]))),
      frameConfig: FrameConfig(timeZone: "UTC"),
      appConfig: AppConfig(
        exportFrom: "2026-01-05",
        exportUntil: "2026-01-07",
        language: "en",
        streetName: "Main",
        postalCode: 1000,
        number: 1
      )
    )

    let output = app.get(ExecutionContext())
    check authCalls == 1
    check capturedFromDay == "2026-01-05"
    check capturedToDay == "2026-01-07"
    check output.len == 1
    check output[0]["summary"].getStr() == "Trash: Paper"
