import ../app
import std/json
import tables

block test_group_events_merge:
  let events = %*[
    {"summary": "Trip", "startTime": "2024-07-01", "endTime": "2024-07-03"},
    {"summary": "Meeting", "startTime": "2024-07-02", "endTime": "2024-07-02"}
  ]
  var app = App(appConfig: AppConfig(events: events))
  let grouped = app.groupEvents()
  doAssert grouped.len == 2
  doAssert grouped["2024-07-01"][0] == "Trip"
  doAssert grouped["2024-07-02"][0] == "Meeting"
