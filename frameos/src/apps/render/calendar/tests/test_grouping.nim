import std/[json, options, tables]
import pixie
import ../app
import frameos/types

proc newTestApp(events: JsonNode; showEventTimes = true): App =
  App(
    nodeName: "render/calendar",
    nodeId: 1.NodeId,
    frameConfig: FrameConfig(width: 800, height: 480, rotate: 0),
    appConfig: AppConfig(
      inputImage: none(Image),
      events: events,
      showEventTimes: showEventTimes,
      eventColorCount: 1,
      eventColorBackground: @[parseHtmlColor("#112233")],
      eventColorForeground: @[parseHtmlColor("#ffffff")],
    ),
  )

block test_grouping_and_sorting_all_day_before_timed:
  let app = newTestApp(%*[
    {
      "summary": "All Day",
      "startTime": "2026-03-05",
      "allDay": true
    },
    {
      "summary": "Standup",
      "startTime": "2026-03-05T09:00:00"
    },
    {
      "summary": "Breakfast",
      "startTime": "2026-03-05T08:30:00"
    },
    {
      "summary": "Malformed Time",
      "startTime": "2026-03-05Tbad"
    }
  ])

  var grouped = app.groupEvents()
  doAssert grouped.hasKey("2026-03-05")
  sortEventLines(grouped)

  let lines = grouped["2026-03-05"]
  doAssert lines.len == 4
  doAssert lines[0].display == "All Day"
  doAssert lines[1].display == "08:30 Breakfast"
  doAssert lines[2].display == "09:00 Standup"
  doAssert lines[3].display == "Malformed Time"

block test_grouping_expands_multi_day_events:
  let app = newTestApp(%*[
    {
      "summary": "Trip",
      "startTime": "2026-03-10",
      "endTime": "2026-03-12",
      "all_day": "yes"
    }
  ])

  let grouped = app.groupEvents()
  doAssert grouped.hasKey("2026-03-10")
  doAssert grouped.hasKey("2026-03-11")
  doAssert grouped.hasKey("2026-03-12")
  doAssert grouped["2026-03-10"].len == 1
  doAssert grouped["2026-03-11"].len == 1
  doAssert grouped["2026-03-12"].len == 1

block test_grouping_skips_malformed_or_unusable_inputs:
  let appNonArray = newTestApp(%*{"summary": "not an array"})
  doAssert appNonArray.groupEvents().len == 0

  let appBadStart = newTestApp(%*[
    {
      "summary": "Bad",
      "startTime": "invalid"
    }
  ])
  doAssert appBadStart.groupEvents().len == 0

  let appReversedRange = newTestApp(%*[
    {
      "summary": "Reverse",
      "startTime": "2026-03-20",
      "endTime": "2026-03-19",
      "allDay": true
    }
  ])
  let grouped = appReversedRange.groupEvents()
  doAssert grouped.len == 1
  doAssert grouped.hasKey("2026-03-20")
  doAssert grouped["2026-03-20"].len == 1
