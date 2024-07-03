import ../ical
import lib/tz
import chrono

proc toFullCal(event: string, timeZone = "UTC"): seq[(Timestamp, VEvent)] =
    let calendar = parseICalendar("""
BEGIN:VCALENDAR
BEGIN:VEVENT
""" & event & """
END:VEVENT
END:VCALENDAR
""", timeZone)
    return getEvents(calendar, parseICalDateTime("19900101", "UTC"), parseICalDateTime("20301231", "UTC"), "", 1000)

block test_parse_ical_datetime:
    echo ">> Testing: parse_ical_datetime"
    doAssert parseICalDateTime("20240101", "UTC") == parseICalDateTime("20240101", "Europe/Brussels")
    doAssert parseICalDateTime("20240101T000000", "UTC") == parseICalDateTime("20240101T000000", "Europe/Brussels")
    doAssert parseICalDateTime("20240101T000000Z", "UTC") == parseICalDateTime("20240101T000000Z", "Europe/Brussels")
    initTimeZone()
    doAssert parseICalDateTime("20240101", "UTC") != parseICalDateTime("20240101", "Europe/Brussels")
    doAssert parseICalDateTime("20240101T000000", "UTC") != parseICalDateTime("20240101T000000", "Europe/Brussels")
    doAssert parseICalDateTime("20240101T000000Z", "UTC") == parseICalDateTime("20240101T000000Z", "Europe/Brussels")

block test_get_simple_next_interval:
    echo ">> Testing: get_simple_next_interval"
    let daily = RRule(freq: daily, interval: 1, byDay: @[], byMonth: @[], byMonthDay: @[], until: Timestamp(0.0),
            count: 0, weekStart: none)
    let weeklyMo = RRule(freq: weekly, interval: 1, byDay: @[(mo, 0)], byMonth: @[], byMonthDay: @[], until: Timestamp(
            0.0), count: 0, weekStart: none)
    let monthly = RRule(freq: monthly, interval: 1, byDay: @[], byMonth: @[], byMonthDay: @[], until: Timestamp(0.0),
            count: 0, weekStart: none)
    proc assertInterval(date: string, rrule: RRule, expected: string, timezone: string = "UTC", comment = "") =
        block:
            var cal = parseIsoCalendar(date)
            cal.applyTimezone(timezone)
            let next = getSimpleNextInterval(cal, rrule, timezone)
            doAssert next == parseIsoCalendar(expected), "Expected: " & expected & ", got: " & next.formatIso() & ", " &
                    comment

    assertInterval("2024-07-01T18:30:00Z", weeklyMo, "2024-07-08T20:30:00+02:00", "Europe/Brussels", "mo -> mo")
    # assertInterval("2024-07-03T18:30:00Z", weeklyMo, "2024-07-08T20:30:00+02:00", "Europe/Brussels", "we -> mo")
    assertInterval("2024-07-03T18:30:00Z", monthly, "2024-08-03T20:30:00+02:00", "Europe/Brussels", "next month same day")
    assertInterval("2024-07-03T18:30:00Z", daily, "2024-07-04T20:30:00+02:00", "Europe/Brussels", "next day")

block test_lincoln:
    echo ">> Testing: lincoln"
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
    echo ">> Testing: meetings"
    let iCalFile = readFile("./src/apps/data/icalJson/tests/data/meetings.ics")
    let events = parseICalendar(iCalFile).events
    doAssert len(events) == 5
    doAssert events[0].startTs == Timestamp(1618412400.0)
    doAssert events[0].endTs == Timestamp(1618414200.0)
    doAssert events[0].location == "https://example.com/location-url/"
    doAssert events[0].description == ""
    doAssert events[0].summary == "Team Standup"
    doAssert events[0].rrules[0] == RRule(freq: weekly, interval: 1, byDay: @[(
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

block test_meetings_events:
    echo ">> Testing: meetings_events"
    let iCalFile = readFile("./src/apps/data/icalJson/tests/data/meetings.ics")

    var calendar = parseICalendar(iCalFile)
    doAssert calendar.timezone == "Europe/Brussels"
    let allEvents = getEvents(calendar, parseICalDateTime("20240101", "UTC"), parseICalDateTime("20250101", "UTC"), "", 100)
    # echo allEvents
    # echo len(allEvents)
    doAssert len(allEvents) == 52
    doAssert allEvents[0][0] == Timestamp(1704297600.0)
    doAssert allEvents[51][0] == Timestamp(1735142400.0)
    doAssert allEvents[0][1].summary == "Team Standup"

    calendar = parseICalendar(iCalFile)
    let allEventsOld = getEvents(calendar, parseICalDateTime("20210101", "UTC"), parseICalDateTime("20220101", "UTC"),
            "", 100)
    doAssert len(allEventsOld) == 42
    doAssert allEventsOld[0][0] == Timestamp(1618412400.0)
    doAssert allEventsOld[41][0] == Timestamp(1640793600.0)
    doAssert allEventsOld[0][1].summary == "Team Standup"
    doAssert allEventsOld[11][1].summary == "Hacklunch for Project"

    calendar = parseICalendar(iCalFile)
    let standupEvents = getEvents(calendar, parseICalDateTime("20210101", "UTC"), parseICalDateTime("20220101", "UTC"),
            "Team Standup", 1000)
    doAssert len(standupEvents) == 38


block test_holidays:
    echo ">> Testing: holidays"
    let iCalFile = readFile("./src/apps/data/icalJson/tests/data/holidays.ics")
    let calendar = parseICalendar(iCalFile)
    doAssert calendar.timezone == "Europe/Tallinn"

    let events = calendar.events
    doAssert len(events) == 49
    doAssert events[0].startTs == Timestamp(1147554000.0)
    doAssert events[0].summary == "Emadepäev"

# block test_get_events_large:
#     echo ">> Testing: get_events_large"
#     let iCalFile = readFile("./src/apps/data/icalJson/tests/data/large.ics")
#     let calendar = parseICalendar(iCalFile)
#     doAssert calendar.timezone == "Europe/Brussels"

#     let allEvents = getEvents(calendar, parseICalDateTime("20240630", "UTC"), parseICalDateTime("20250101", "UTC"), "", 100)
#     doAssert len(allEvents) == 100


block test_rrules_1:
    echo ">> Testing: Daily for 10 occurrences"
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
    echo ">> Testing: Daily until December 24, 1997"
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

block test_rrules_3:
    echo ">> Testing: Every other day - forever"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=DAILY;INTERVAL=2
""")
    #  ==> (1997 9:00 AM EDT) September 2-30;October 1-25
    #      (1997 9:00 AM EST) October 26-31;November 1-30;December 1-23
    doAssert len(events) == 1000 # the limit
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[56][0] == parseICalDateTime("19971223T090000", "America/New_York")
    doAssert events[999][0] == parseICalDateTime("20030221T090000", "America/New_York")

block test_rrules_4:
    echo ">> Testing: Every 10 days, 5 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=DAILY;INTERVAL=10;COUNT=5
""")
    #  ==> (1997 9:00 AM EDT) September 2,12,22;
    #                         October 2,12
    doAssert len(events) == 5
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970912T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970922T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971002T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19971012T090000", "America/New_York")

block test_rrules_5a:
    echo ">> Testing: Every day in January, for 3 years"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19980101T090000
DTEND;TZID=America/New_York:19980101T093000
RRULE:FREQ=YEARLY;UNTIL=20000131T140000Z;
 BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA
""")
    #  ==> (1998 9:00 AM EST)January 1-31
    #      (1999 9:00 AM EST)January 1-31
    #      (2000 9:00 AM EST)January 1-31
    doAssert len(events) == 93
    doAssert events[0][0] == parseICalDateTime("19980101T090000", "America/New_York")
    doAssert events[92][0] == parseICalDateTime("20000131T090000", "America/New_York")

block test_rrules_5b:
    echo ">> Testing: Every day in January, for 3 years"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19980101T090000
DTEND;TZID=America/New_York:19980101T093000
RRULE:FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1
""")
    #  ==> (1998 9:00 AM EST)January 1-31
    #      (1999 9:00 AM EST)January 1-31
    #      (2000 9:00 AM EST)January 1-31
    doAssert len(events) == 93
    doAssert events[0][0] == parseICalDateTime("19980101T090000", "America/New_York")
    doAssert events[92][0] == parseICalDateTime("20000131T090000", "America/New_York")

block test_rrules_6:
    echo ">> Testing: Weekly for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;COUNT=10
""")
    #  ==> (1997 9:00 AM EDT) September 2,9,16,23,30;October 7,14,21
    #      (1997 9:00 AM EST) October 28;November 4
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970909T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970916T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19970923T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19970930T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19971007T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19971014T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19971021T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19971028T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19971104T090000", "America/New_York")

block test_rrules_7:
    echo ">> Testing: Weekly until December 24, 1997"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;UNTIL=19971224T000000Z
""")
    #  ==> (1997 9:00 AM EDT) September 2,9,16,23,30;October 7,14,21
    #      (1997 9:00 AM EST) October 28;November 4,11,18,25;December 2,9,16,23
    doAssert len(events) == 17
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970909T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970916T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19970923T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19970930T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19971007T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19971014T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19971021T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19971028T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19971104T090000", "America/New_York")
    doAssert events[10][0] == parseICalDateTime("19971111T090000", "America/New_York")
    doAssert events[11][0] == parseICalDateTime("19971118T090000", "America/New_York")
    doAssert events[12][0] == parseICalDateTime("19971125T090000", "America/New_York")
    doAssert events[13][0] == parseICalDateTime("19971202T090000", "America/New_York")
    doAssert events[14][0] == parseICalDateTime("19971209T090000", "America/New_York")
    doAssert events[15][0] == parseICalDateTime("19971216T090000", "America/New_York")
    doAssert events[16][0] == parseICalDateTime("19971223T090000", "America/New_York")


block test_rrules_8:
    echo ">> Testing: Every other week - forever"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU
""")
    #  ==> (1997 9:00 AM EDT) September 2,16,30;
    #                         October 14
    #      (1997 9:00 AM EST) October 28;
    #                         November 11,25;
    #                         December 9,23
    #      (1998 9:00 AM EST) January 6,20;
    #                         February 3, 17
    doAssert len(events) == 870
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970916T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970930T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971014T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19971028T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19971111T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19971125T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19971209T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19971223T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19980106T090000", "America/New_York")
    doAssert events[869][0] == parseICalDateTime("20301224T090000", "America/New_York") # test limit

block test_rrules_9a:
    echo ">> Testing: Weekly on Tuesday and Thursday for five weeks"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;UNTIL=19971007T000000Z;WKST=SU;BYDAY=TU,TH
""")
    #  ==> (1997 9:00 AM EDT) September 2,4,9,11,16,18,23,25,30;
    #                         October 2
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970904T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970909T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19970911T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19970916T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19970918T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19970923T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19970925T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19970930T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19971002T090000", "America/New_York")

block test_rrules_9b:
    echo ">> Testing: Weekly on Tuesday and Thursday for five weeks"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH
""")
    #  ==> (1997 9:00 AM EDT) September 2,4,9,11,16,18,23,25,30;
    #                         October 2
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970904T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970909T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19970911T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19970916T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19970918T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19970923T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19970925T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19970930T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19971002T090000", "America/New_York")

block test_rrules_10:
    echo ">> Testing: Every other week on Monday, Wednesday, and Friday until December 24, 1997, starting on Monday, September 1, 1997"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970901T090000
DTEND;TZID=America/New_York:19970901T093000
RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR
""")
    #  ==> (1997 9:00 AM EDT) September 1,3,5,15,17,19,29;
    #                         October 1,3,13,15,17
    #      (1997 9:00 AM EST) October 27,29,31;
    #                         November 10,12,14,24,26,28;
    #                         December 8,10,12,22
    doAssert len(events) == 25
    doAssert events[0][0] == parseICalDateTime("19970901T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970903T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970905T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19970915T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19970917T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19970919T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19970929T090000", "America/New_York")
    doAssert events[24][0] == parseICalDateTime("19971222T090000", "America/New_York")

block test_rrules_11:
    echo ">> Testing: Every other week on Tuesday and Thursday, for 8 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH
""")
    #  ==> (1997 9:00 AM EDT) September 2,4,16,18,30;
    #                         October 2,14,16
    doAssert len(events) == 8
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970904T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970916T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19970918T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19970930T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19971002T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19971014T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19971016T090000", "America/New_York")

block test_rrules_12:
    echo ">> Testing: Monthly on the first Friday for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970905T090000
DTEND;TZID=America/New_York:19970905T093000
RRULE:FREQ=MONTHLY;COUNT=10;BYDAY=1FR
""")
    #  ==> (1997 9:00 AM EDT) September 5;October 3
    #      (1997 9:00 AM EST) November 7;December 5
    #      (1998 9:00 AM EST) January 2;February 6;March 6;April 3
    #      (1998 9:00 AM EDT) May 1;June 5
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970905T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19971003T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19971107T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971205T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19980102T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19980206T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19980306T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19980403T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19980501T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19980605T090000", "America/New_York")

block test_rrules_13:
    echo ">> Testing: Monthly on the first Friday until December 24, 1997"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970905T090000
DTEND;TZID=America/New_York:19970905T093000
RRULE:FREQ=MONTHLY;UNTIL=19971224T000000Z;BYDAY=1FR
""")
    #  ==> (1997 9:00 AM EDT) September 5; October 3
    #      (1997 9:00 AM EST) November 7; December 5
    doAssert len(events) == 4
    doAssert events[0][0] == parseICalDateTime("19970905T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19971003T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19971107T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971205T090000", "America/New_York")

block test_rrules_14:
    echo ">> Testing: Every other month on the first and last Sunday of the month for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970907T090000
DTEND;TZID=America/New_York:19970907T093000
RRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU
""")
    #  ==> (1997 9:00 AM EDT) September 7,28
    #      (1997 9:00 AM EST) November 2,30
    #      (1998 9:00 AM EST) January 4,25;March 1,29
    #      (1998 9:00 AM EDT) May 3,31
    doAssert len(events) == 10
    echo events
    doAssert events[0][0] == parseICalDateTime("19970907T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970928T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19971102T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971130T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19980104T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19980125T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19980301T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19980329T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19980503T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19980531T090000", "America/New_York")


block test_rrules_15:
    echo ">> Testing: Every other month on the first and last Sunday of the month for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970907T090000
DTEND;TZID=America/New_York:19970907T093000
RRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU
""")
    #  ==> (1997 9:00 AM EDT) September 7,28
    #      (1997 9:00 AM EST) November 2,30
    #      (1998 9:00 AM EST) January 4,25;March 1,29
    #      (1998 9:00 AM EDT) May 3,31
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970907T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970928T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19971102T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971130T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19980104T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19980125T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19980301T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19980329T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19980503T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19980531T090000", "America/New_York")

block test_rrules_16:
    echo ">> Testing: Monthly on the second-to-last Monday of the month for 6 months"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970922T090000
DTEND;TZID=America/New_York:19970922T093000
RRULE:FREQ=MONTHLY;COUNT=6;BYDAY=-2MO
""")
    #  ==> (1997 9:00 AM EDT) September 22;October 20
    #      (1997 9:00 AM EST) November 17;December 22
    #      (1998 9:00 AM EST) January 19;February 16
    doAssert len(events) == 6
    doAssert events[0][0] == parseICalDateTime("19970922T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19971020T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19971117T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971222T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19980119T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19980216T090000", "America/New_York")

block test_rrules_17:
    echo ">> Testing: Monthly on the third-to-the-last day of the month, forever"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970928T090000
DTEND;TZID=America/New_York:19970928T093000
RRULE:FREQ=MONTHLY;BYMONTHDAY=-3
""")
    #  ==> (1997 9:00 AM EDT) September 28
    #      (1997 9:00 AM EST) October 29;November 28;December 29
    #      (1998 9:00 AM EST) January 29;February 26
    doAssert len(events) == 400 # 2030 limit
    doAssert events[0][0] == parseICalDateTime("19970928T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19971029T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19971128T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971229T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19980129T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19980226T090000", "America/New_York")
    doAssert events[399][0] == parseICalDateTime("20301229T090000", "America/New_York") # test limit


block test_rrules_18:
    echo ">> Testing: Monthly on the 2nd and 15th of the month for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15
""")
    #  ==> (1997 9:00 AM EDT) September 2,15;October 2,15
    #      (1997 9:00 AM EST) November 2,15;December 2,15
    #      (1998 9:00 AM EST) January 2,15
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970915T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19971002T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971015T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19971102T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19971115T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19971202T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19971215T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19980102T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19980115T090000", "America/New_York")

block test_rrules_19:
    echo ">> Testing: Monthly on the first and last day of the month for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970930T090000
DTEND;TZID=America/New_York:19970930T093000
RRULE:FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1
""")
    #  ==> (1997 9:00 AM EDT) September 30;October 1
    #      (1997 9:00 AM EST) October 31;November 1,30;December 1,31
    #      (1998 9:00 AM EST) January 1,31;February 1
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970930T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19971001T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19971031T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19971101T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19971130T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19971201T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19971231T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19980101T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19980131T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19980201T090000", "America/New_York")

block test_rrules_20:
    echo ">> Testing: Every 18 months on the 10th thru 15th of the month for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970910T090000
DTEND;TZID=America/New_York:19970910T093000
RRULE:FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15
""")
    #  ==> (1997 9:00 AM EDT) September 10,11,12,13,14,15
    #      (1999 9:00 AM EST) March 10,11,12,13
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970910T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970911T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970912T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19970913T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19970914T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19970915T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19990310T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19990311T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19990312T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19990313T090000", "America/New_York")

block test_rrules_21:
    echo ">> Testing: Every Tuesday, every other month"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=TU
""")
    #  ==> (1997 9:00 AM EDT) September 2,9,16,23,30
    #      (1997 9:00 AM EST) November 4,11,18,25
    #      (1998 9:00 AM EST) January 6,13,20,27;March 3,10,17,24,31
    doAssert len(events) == 875 # 2030 test limit
    doAssert events[0][0] == parseICalDateTime("19970902T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970909T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970916T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19970923T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19970930T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19971104T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("19971111T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("19971118T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("19971125T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("19980106T090000", "America/New_York")
    doAssert events[874][0] == parseICalDateTime("20301126T090000", "America/New_York") # test limit

block test_rrules_22:
    echo ">> Testing: Yearly in June and July for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970610T090000
DTEND;TZID=America/New_York:19970610T093000
RRULE:FREQ=YEARLY;COUNT=10;BYMONTH=6,7
""")
    #  ==> (1997 9:00 AM EDT) June 10;July 10
    #      (1998 9:00 AM EDT) June 10;July 10
    #      (1999 9:00 AM EDT) June 10;July 10
    #      (2000 9:00 AM EDT) June 10;July 10
    #      (2001 9:00 AM EDT) June 10;July 10
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970610T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970710T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19980610T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19980710T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("19990610T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("19990710T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("20000610T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("20000710T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("20010610T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("20010710T090000", "America/New_York")

block test_rrules_23:
    echo ">> Testing: Every other year on January, February, and March for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970310T090000
DTEND;TZID=America/New_York:19970310T093000
RRULE:FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3
""")
    #  ==> (1997 9:00 AM EST) March 10
    #      (1999 9:00 AM EST) January 10;February 10;March 10
    #      (2001 9:00 AM EST) January 10;February 10;March 10
    #      (2003 9:00 AM EST) January 10;February 10;March 10
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970310T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19990110T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19990210T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("19990310T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("20010110T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("20010210T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("20010310T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("20030110T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("20030210T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("20030310T090000", "America/New_York")


block test_rrules_24:
    echo ">> Testing: Every third year on the 1st, 100th, and 200th day for 10 occurrences"
    let events = toFullCal("""
DTSTART;TZID=America/New_York:19970101T090000
DTEND;TZID=America/New_York:19970101T093000
RRULE:FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200
""")
    #  ==> (1997 9:00 AM EST) January 1
    #      (1997 9:00 AM EDT) April 10;July 19
    #      (2000 9:00 AM EST) January 1
    #      (2000 9:00 AM EDT) April 9;July 18
    #      (2003 9:00 AM EST) January 1
    #      (2003 9:00 AM EDT) April 10;July 19
    #      (2006 9:00 AM EST) January 1
    doAssert len(events) == 10
    doAssert events[0][0] == parseICalDateTime("19970101T090000", "America/New_York")
    doAssert events[1][0] == parseICalDateTime("19970410T090000", "America/New_York")
    doAssert events[2][0] == parseICalDateTime("19970719T090000", "America/New_York")
    doAssert events[3][0] == parseICalDateTime("20000101T090000", "America/New_York")
    doAssert events[4][0] == parseICalDateTime("20000409T090000", "America/New_York")
    doAssert events[5][0] == parseICalDateTime("20000718T090000", "America/New_York")
    doAssert events[6][0] == parseICalDateTime("20030101T090000", "America/New_York")
    doAssert events[7][0] == parseICalDateTime("20030410T090000", "America/New_York")
    doAssert events[8][0] == parseICalDateTime("20030719T090000", "America/New_York")
    doAssert events[9][0] == parseICalDateTime("20060101T090000", "America/New_York")


# Every 20th Monday of the year, forever:
#  DTSTART;TZID=America/New_York:19970519T090000
#  RRULE:FREQ=YEARLY;BYDAY=20MO
#  ==> (1997 9:00 AM EDT) May 19
#      (1998 9:00 AM EDT) May 18
#      (1999 9:00 AM EDT) May 17
#      ...

# block test_rrules_25:
#     echo ">> Testing: Every 20th Monday of the year, forever"
#     let events = toFullCal("""
# DTSTART;TZID=America/New_York:19970519T090000
# DTEND;TZID=America/New_York:19970519T093000
# RRULE:FREQ=YEARLY;BYDAY=20MO
# """)
#     #  ==> (1997 9:00 AM EDT) May 19
#     #      (1998 9:00 AM EDT) May 18
#     #      (1999 9:00 AM EDT) May 17
#     #      ...
#     # doAssert len(events) == 403
#     echo events[0]
#     echo len(events)
#     doAssert events[0][0] == parseICalDateTime("19970519T090000", "America/New_York")
#     doAssert events[1][0] == parseICalDateTime("19980518T090000", "America/New_York")
#     doAssert events[2][0] == parseICalDateTime("19990517T090000", "America/New_York")
#     doAssert events[3][0] == parseICalDateTime("20000522T090000", "America/New_York")
#     doAssert events[4][0] == parseICalDateTime("20010521T090000", "America/New_York")
#     doAssert events[5][0] == parseICalDateTime("20020520T090000", "America/New_York")
#     doAssert events[6][0] == parseICalDateTime("20030519T090000", "America/New_York")
#     doAssert events[7][0] == parseICalDateTime("20040517T090000", "America/New_York")
#     doAssert events[8][0] == parseICalDateTime("20050516T090000", "America/New_York")
#     doAssert events[9][0] == parseICalDateTime("20060522T090000", "America/New_York")
#     doAssert events[10][0] == parseICalDateTime("20070521T090000", "America/New_York")
#     doAssert events[11][0] == parseICalDateTime("20080519T090000", "America/New_York")
#     doAssert events[12][0] == parseICalDateTime("20090518T090000", "America/New_York")
#     doAssert events[13][0] == parseICalDateTime("20100517T090000", "America/New_York")
#     doAssert events[14][0] == parseICalDateTime("20110516T090000", "America/New_York")


# Monday of week number 20 (where the default start of the week is
# Monday), forever:
#  DTSTART;TZID=America/New_York:19970512T090000
#  RRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO
#  ==> (1997 9:00 AM EDT) May 12
#      (1998 9:00 AM EDT) May 11
#      (1999 9:00 AM EDT) May 17
#      ...

# Every Thursday in March, forever:
#  DTSTART;TZID=America/New_York:19970313T090000
#  RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=TH
#  ==> (1997 9:00 AM EST) March 13,20,27
#      (1998 9:00 AM EST) March 5,12,19,26
#      (1999 9:00 AM EST) March 4,11,18,25
#      ...

# Every Thursday, but only during June, July, and August, forever:
#  DTSTART;TZID=America/New_York:19970605T090000
#  RRULE:FREQ=YEARLY;BYDAY=TH;BYMONTH=6,7,8
#  ==> (1997 9:00 AM EDT) June 5,12,19,26;July 3,10,17,24,31;
#                         August 7,14,21,28
#      (1998 9:00 AM EDT) June 4,11,18,25;July 2,9,16,23,30;
#                         August 6,13,20,27
#      (1999 9:00 AM EDT) June 3,10,17,24;July 1,8,15,22,29;
#                         August 5,12,19,26
#      ...

# Every Friday the 13th, forever:
#  DTSTART;TZID=America/New_York:19970902T090000
#  EXDATE;TZID=America/New_York:19970902T090000
#  RRULE:FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13
#  ==> (1998 9:00 AM EST) February 13;March 13;November 13
#      (1999 9:00 AM EDT) August 13
#      (2000 9:00 AM EDT) October 13
#      ...

# The first Saturday that follows the first Sunday of the month, forever:
#  DTSTART;TZID=America/New_York:19970913T090000
#  RRULE:FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13
#  ==> (1997 9:00 AM EDT) September 13;October 11
#      (1997 9:00 AM EST) November 8;December 13
#      (1998 9:00 AM EST) January 10;February 7;March 7
#      (1998 9:00 AM EDT) April 11;May 9;June 13...
#      ...

# Every 4 years, the first Tuesday after a Monday in November, forever (U.S. Presidential Election day):
#  DTSTART;TZID=America/New_York:19961105T090000
#  RRULE:FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;
#   BYMONTHDAY=2,3,4,5,6,7,8
#   ==> (1996 9:00 AM EST) November 5
#       (2000 9:00 AM EST) November 7
#       (2004 9:00 AM EST) November 2
#       ...

# The third instance into the month of one of Tuesday, Wednesday, or Thursday, for the next 3 months:
#  DTSTART;TZID=America/New_York:19970904T090000
#  RRULE:FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3
#  ==> (1997 9:00 AM EDT) September 4;October 7
#      (1997 9:00 AM EST) November 6

# The second-to-last weekday of the month:
#  DTSTART;TZID=America/New_York:19970929T090000
#  RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2
#  ==> (1997 9:00 AM EDT) September 29
#      (1997 9:00 AM EST) October 30;November 27;December 30
#      (1998 9:00 AM EST) January 29;February 26;March 30
#      ...

# Every 3 hours from 9:00 AM to 5:00 PM on a specific day:
#  DTSTART;TZID=America/New_York:19970902T090000
#  RRULE:FREQ=HOURLY;INTERVAL=3;UNTIL=19970902T170000Z
#  ==> (September 2, 1997 EDT) 09:00,12:00,15:00

# Every 15 minutes for 6 occurrences:
#  DTSTART;TZID=America/New_York:19970902T090000
#  RRULE:FREQ=MINUTELY;INTERVAL=15;COUNT=6
#  ==> (September 2, 1997 EDT) 09:00,09:15,09:30,09:45,10:00,10:15

# Every hour and a half for 4 occurrences:
#  DTSTART;TZID=America/New_York:19970902T090000
#  RRULE:FREQ=MINUTELY;INTERVAL=90;COUNT=4
#  ==> (September 2, 1997 EDT) 09:00,10:30;12:00;13:30

# Every 20 minutes from 9:00 AM to 4:40 PM every day:
#  DTSTART;TZID=America/New_York:19970902T090000
#  RRULE:FREQ=DAILY;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,20,40
#  or
#  RRULE:FREQ=MINUTELY;INTERVAL=20;BYHOUR=9,10,11,12,13,14,15,16
#  ==> (September 2, 1997 EDT) 9:00,9:20,9:40,10:00,10:20,
#                              ... 16:00,16:20,16:40
#      (September 3, 1997 EDT) 9:00,9:20,9:40,10:00,10:20,
#                              ...16:00,16:20,16:40
#      ...

# An example where the days generated makes a difference because of WKST:
#  DTSTART;TZID=America/New_York:19970805T090000
#  RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO
#  ==> (1997 EDT) August 5,10,19,24

# changing only WKST from MO to SU, yields different results...
#  DTSTART;TZID=America/New_York:19970805T090000
#  RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU
#  ==> (1997 EDT) August 5,17,19,31

# An example where an invalid date (i.e., February 30) is ignored.
#  DTSTART;TZID=America/New_York:20070115T090000
#  RRULE:FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5
#  ==> (2007 EST) January 15,30
#      (2007 EST) February 15
#      (2007 EDT) March 15,30
