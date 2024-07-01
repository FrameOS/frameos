import ../ical
import lib/tz
import chrono, times

block test_lincoln:
    echo "Test: lincoln"
    let iCalFile = readFile("./src/apps/data/icalJson/tests/data/lincoln.ics")
    let events = parseICalendar(iCalFile).events
    doAssert len(events) == 1
    doAssert events[0].startTs == Timestamp(1202774400.0)
    doAssert events[0].endTs == Timestamp(1202860800.0)
    doAssert events[0].location == "Hodgenville, Kentucky"
    doAssert events[0].description == "Born February 12, 1809\nSixteenth President (1861-1865)\n\n\n\nhttp://AmericanHistoryCalendar.com",
            events[0].description
    doAssert events[0].summary == "Abraham Lincoln", events[0].summary

block test_meetings:
    echo "Test: meetings"
    let iCalFile = readFile("./src/apps/data/icalJson/tests/data/meetings.ics")
    let events = parseICalendar(iCalFile).events
    doAssert len(events) == 5
    doAssert events[0].startTs == Timestamp(1618419600.0)
    doAssert events[0].endTs == Timestamp(1618421400.0)
    doAssert events[0].location == "https://example.com/location-url/"
    doAssert events[0].description == ""
    doAssert events[0].summary == "Team Standup"
    doAssert events[0].rrules[0] == RRule(freq: weekly, interval: 1, timeInterval: TimeInterval(weeks: 1), byDay: @[(
            we, 0)], byMonth: @[], byMonthDay: @[], until: Timestamp(1777388399.0), count: 0,
                    weekStart: none)
    doAssert events[1].startTs == Timestamp(1624528800.0)
    doAssert events[1].endTs == Timestamp(1624532400.0)
    doAssert events[1].location == ""
    doAssert events[1].description == ""
    doAssert events[1].summary == "Hacklunch for Project"
    doAssert events[2].startTs == Timestamp(1629309600.0)
    doAssert events[2].endTs == Timestamp(1629313200.0)
    doAssert events[2].location == "https://example.com/another-meeting-link"
    doAssert events[2].description == "Hey, let\'s try pairing for an hour and see where we end up :)."
    doAssert events[2].summary == "Pairing Two / Three"
    doAssert events[3].startTs == Timestamp(1629313200.0)
    doAssert events[3].endTs == Timestamp(1629316800.0)
    doAssert events[3].location == "https://example.com/link-again"
    doAssert events[3].description == "Hey, let\'s do a bit of pair coding :)"
    doAssert events[3].summary == "Pairing Three / One"
    doAssert events[4].startTs == Timestamp(1629448200.0)
    doAssert events[4].endTs == Timestamp(1629451800.0)
    doAssert events[4].location == "https://example.com/zoom-is-back"
    doAssert events[4].description == "Hey Team! The sugarly overlord commands me to set up a meeting. This is the meeting"
    doAssert events[4].summary == "One / Two - Meeting"

block test_holidays:
    echo "Test: holidays"
    let iCalFile = readFile("./src/apps/data/icalJson/tests/data/holidays.ics")
    let calendar = parseICalendar(iCalFile)
    doAssert calendar.timezone == "Europe/Tallinn"

    let events = calendar.events
    doAssert len(events) == 49
    doAssert events[0].startTs == Timestamp(1147564800.0)
    doAssert events[0].summary == "Emadepäev"


block test_parse_ical_datetime:
    echo "Test: parse_ical_datetime"
    doAssert parseICalDateTime("20240101", "UTC") == parseICalDateTime("20240101", "Europe/Brussels")
    doAssert parseICalDateTime("20240101T000000", "UTC") == parseICalDateTime("20240101T000000", "Europe/Brussels")
    doAssert parseICalDateTime("20240101T000000Z", "UTC") == parseICalDateTime("20240101T000000Z", "Europe/Brussels")
    initTimeZone()
    doAssert parseICalDateTime("20240101", "UTC") != parseICalDateTime("20240101", "Europe/Brussels")
    doAssert parseICalDateTime("20240101T000000", "UTC") != parseICalDateTime("20240101T000000", "Europe/Brussels")
    doAssert parseICalDateTime("20240101T000000Z", "UTC") == parseICalDateTime("20240101T000000Z", "Europe/Brussels")


block test_get_events:
    echo "Test: get_events"
    let iCalFile = readFile("./src/apps/data/icalJson/tests/data/meetings.ics")

    var calendar = parseICalendar(iCalFile)
    doAssert calendar.timezone == "Europe/Brussels"
    let allEvents = getEvents(calendar, parseICalDateTime("20240101", "UTC"), parseICalDateTime("20250101", "UTC"), "", 100)
    doAssert len(allEvents) == 52
    doAssert allEvents[0][0] == Timestamp(1704294000.0)
    doAssert allEvents[51][0] == Timestamp(1735138800.0)
    doAssert allEvents[0][1].summary == "Team Standup"

    calendar = parseICalendar(iCalFile)
    let allEventsOld = getEvents(calendar, parseICalDateTime("20210101", "UTC"), parseICalDateTime("20220101", "UTC"),
            "", 100)
    doAssert len(allEventsOld) == 42
    doAssert allEventsOld[0][0] == Timestamp(1618412400.0)
    doAssert allEventsOld[41][0] == Timestamp(1640790000.0)
    doAssert allEventsOld[0][1].summary == "Team Standup"
    doAssert allEventsOld[11][1].summary == "Hacklunch for Project"

    calendar = parseICalendar(iCalFile)
    let standupEvents = getEvents(calendar, parseICalDateTime("20210101", "UTC"), parseICalDateTime("20220101", "UTC"),
            "Team Standup", 1000)
    doAssert len(standupEvents) == 38


# block test_get_events_large:
#     echo "Test: get_events_large"
#     let iCalFile = readFile("./src/apps/data/icalJson/tests/data/large.ics")
#     let calendar = parseICalendar(iCalFile)
#     doAssert calendar.timezone == "Europe/Brussels"

#     let allEvents = getEvents(calendar, parseICalDateTime("20240630", "UTC"), parseICalDateTime("20250101", "UTC"), "", 100)
#     doAssert len(allEvents) == 100

proc toFullCal(event: string, timeZone = "UTC"): seq[(Timestamp, VEvent)] =
    let calendar = parseICalendar("""
BEGIN:VCALENDAR
BEGIN:VEVENT
""" & event & """
END:VEVENT
END:VCALENDAR
""", timeZone)
    return getEvents(calendar, parseICalDateTime("19900101", "UTC"), parseICalDateTime("20301231", "UTC"), "", 1000)


block test_rrules_1:
    echo "Daily for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=DAILY;COUNT=10
""")
    #  ==> (1997 9:00 AM EDT) September 2-11
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970903T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970904T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19970905T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19970911T090000", "America/New_York")

block test_rrules_2:
    echo "Daily until December 24, 1997"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=DAILY;UNTIL=19971224T000000Z
""")
    #  ==> (1997 9:00 AM EDT) September 2-30;October 1-25
    #      (1997 9:00 AM EST) October 26-31;November 1-30;December 1-23
    doAssert len(events) == 113
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[112][0] == parseICalDateTime("19971223T090000", "America/New_York")

