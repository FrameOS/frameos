import ../ical
import chrono

block test_lincoln:
    let iCalFile = readFile("./src/apps/ical/tests/data/lincoln.ics")
    let events = parseICalendar(iCalFile)
    doAssert len(events) == 1
    doAssert events[0].startTime == Timestamp(1202774400.0)
    doAssert events[0].endTime == Timestamp(1202860800.0)
    doAssert events[0].location == "Hodgenville, Kentucky"
    doAssert events[0].description == "Born February 12, 1809\nSixteenth President (1861-1865)\n\n\n\nhttp://AmericanHistoryCalendar.com"
    doAssert events[0].summary == "Abraham Lincoln"

block test_meetings:
    let iCalFile = readFile("./src/apps/ical/tests/data/meetings.ics")
    let events = parseICalendar(iCalFile)
    doAssert len(events) == 5
    doAssert events[0].startTime == Timestamp(1618419600.0)
    doAssert events[0].endTime == Timestamp(1618421400.0)
    doAssert events[0].location == "https://example.com/location-url/"
    doAssert events[0].description == ""
    doAssert events[0].summary == "Team Standup"
    doAssert events[0].rrules[0] == RRule(freq: weekly, interval: 1, byDay: @[(we, 0)], byMonth: @[], byMonthDay: @[],
            until: Timestamp(1619621999), count: 0, weekStart: none)
    doAssert events[1].startTime == Timestamp(1624528800.0)
    doAssert events[1].endTime == Timestamp(1624532400.0)
    doAssert events[1].location == ""
    doAssert events[1].description == ""
    doAssert events[1].summary == "Hacklunch for Project"
    doAssert events[2].startTime == Timestamp(1629448200.0)
    doAssert events[2].endTime == Timestamp(1629451800.0)
    doAssert events[2].location == "https://example.com/zoom-is-back"
    doAssert events[2].description == "Hey Team! The sugarly overlord commands me to set up a meeting. This is the meeting"
    doAssert events[2].summary == "One / Two - Meeting"
    doAssert events[3].startTime == Timestamp(1629309600.0)
    doAssert events[3].endTime == Timestamp(1629313200.0)
    doAssert events[3].location == "https://example.com/another-meeting-link"
    doAssert events[3].description == "Hey, let\'s try pairing for an hour and see where we end up :)."
    doAssert events[3].summary == "Pairing Two / Three"
    doAssert events[4].startTime == Timestamp(1629313200.0)
    doAssert events[4].endTime == Timestamp(1629316800.0)
    doAssert events[4].location == "https://example.com/link-again"
    doAssert events[4].description == "Hey, let\'s do a bit of pair coding :)"
    doAssert events[4].summary == "Pairing Three / One"

block test_holidays:
    let iCalFile = readFile("./src/apps/ical/tests/data/holidays.ics")
    let events = parseICalendar(iCalFile)
    doAssert len(events) == 49
