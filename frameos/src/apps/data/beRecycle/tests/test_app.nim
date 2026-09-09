import std/[json, strutils, unittest]

import ../app
import frameos/types
import frameos/utils/http_client

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

  test "query parameters are percent-encoded so the runtime client accepts them":
    # "Rue de la Loi" used to go out unencoded; validateHttpRequestUrl refuses a
    # request line with a space, so every street with one failed to resolve.
    let streets = streetsUrl("Rue de la Loi", "zip-1")
    validateHttpRequestUrl(streets)
    check streets.contains("/streets?q=Rue%20de%20la%20Loi&zipcodes=zip-1")
    check not streets.contains(" ")
    check not streets.contains("+")

    let accented = streetsUrl("Sint-Jorisstraat & Co/é", "z&1")
    validateHttpRequestUrl(accented)
    check accented.contains("q=Sint-Jorisstraat%20%26%20Co%2F%C3%A9&zipcodes=z%261")

    check zipcodesUrl(1000).endsWith("/zipcodes?q=1000")
    let collections = collectionsUrl("zip 1", "street/2", 12, "2026-01-05", "2026-01-07")
    validateHttpRequestUrl(collections)
    check collections.contains("zipcodeId=zip%201&streetId=street%2F2&houseNumber=12" &
      "&fromDate=2026-01-05&untilDate=2026-01-07&size=200")
