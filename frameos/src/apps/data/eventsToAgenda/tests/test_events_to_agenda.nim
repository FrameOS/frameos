import unittest
import std/json
import std/strutils
import pixie
import frameos/types
import ../app

proc newAgendaApp(events: JsonNode, startWithToday = false): App =
  var frameConfig = new(FrameConfig)
  frameConfig.timeZone = "UTC"

  App(
    appConfig: AppConfig(
      events: events,
      baseFontSize: 24.0,
      titleFontSize: 48.0,
      textColor: parseHtmlColor("#445566"),
      timeColor: parseHtmlColor("#778899"),
      titleColor: parseHtmlColor("#112233"),
      startWithToday: startWithToday
    ),
    frameConfig: frameConfig
  )

suite "eventsToAgenda app":
  test "formats and sorts events across days":
    let events = %*[
      {"summary": "Holiday", "startTime": "2024-12-25", "endTime": "2024-12-25"},
      {"summary": "Breakfast", "startTime": "2024-12-24T08:00:00", "endTime": "2024-12-24T09:00:00"}
    ]
    let app = newAgendaApp(events)
    let output = app.get(nil)

    check output.contains("^(48,#112233)Tuesday, December 24")
    check output.contains("^(24,#778899)08:00 - 09:00  ^(24,#445566)Breakfast")
    check output.contains("^(48,#112233)Wednesday, December 25")
    check output.contains("^(24,#778899)All day  ^(24,#445566)Holiday")
    check output.find("Breakfast") < output.find("Holiday")

  test "shows until text for multi-day events":
    let events = %*[
      {"summary": "Conference", "startTime": "2024-12-25", "endTime": "2024-12-27"}
    ]
    let app = newAgendaApp(events)
    let output = app.get(nil)

    check output.contains("^(48,#112233)Wednesday, December 25")
    check output.contains("^(24,#778899)Until Friday, December 27  ^(24,#445566)Conference")

  test "shows ongoing multi-day event when starting with today":
    let events = %*[
      {"summary": "Retreat", "startTime": "2024-12-23", "endTime": "2024-12-27"}
    ]
    let app = newAgendaApp(events, startWithToday = true)
    app.testOverrideToday = "2024-12-26"
    let output = app.get(nil)

    check not output.contains("No events today")
    check output.count("^(48,#112233)Thursday, December 26") == 1
    check output.contains("^(24,#778899)Until Friday, December 27  ^(24,#445566)Retreat")
