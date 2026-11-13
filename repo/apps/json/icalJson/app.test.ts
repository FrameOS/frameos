// The built-in data/icalJson's tests, ported: the app's parser and expansion
// through its exports, get() through a made-up app.

import { get, getEvents, normalizeTimeZone, parseICalDateTime, parseICalDuration, parseICalendar, parsePeriodBoundary, parseRRule, unescape } from './app'

const NY = 'America/New_York'
const BRU = 'Europe/Brussels'

const at = (text: string, zone: string) => parseICalDateTime(text, zone)

function toFullCal(event: string, timeZone = 'UTC') {
  const calendar = parseICalendar(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1234567890\n${event}END:VEVENT\nEND:VCALENDAR\n`, timeZone)
  return getEvents(calendar, at('19900101', 'UTC'), at('20301231', 'UTC'), '', 1000)
}

function expectStarts(events: any[], zone: string, wall: string[]) {
  expect(events.slice(0, wall.length).map((e) => e[0])).toEqual(wall.map((text) => at(text, zone)))
}

const MEETINGS = String.raw`BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:one@example.com
X-WR-TIMEZONE:Europe/Brussels
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
X-LIC-LOCATION:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
TZNAME:PDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
TZNAME:PST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE

BEGIN:VEVENT
DTSTART;TZID=Europe/Brussels:20210414T170000
DTEND;TZID=Europe/Brussels:20210414T173000
RRULE:FREQ=WEEKLY;UNTIL=20260428T145959Z;INTERVAL=1;BYDAY=WE
DTSTAMP:20240417T194934Z
ORGANIZER;CN=one@example.com:mailto:one@example.com
UID:2DB1277C-CA5F-4C2D-90D0-140B66BA84E4
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=two@ex
 ample.com;X-NUM-GUESTS=0:mailto:two@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=th
 ree@example.com;X-NUM-GUESTS=0:mailto:three@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=one@ex
 ample.com;X-NUM-GUESTS=0:mailto:one@example.com
CREATED:20210419T095723Z
LAST-MODIFIED:20210419T100401Z
LOCATION:https://example.com/location-url/
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Team Standup
TRANSP:OPAQUE
X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC
END:VEVENT

BEGIN:VEVENT
DTSTART:20210624T100000Z
DTEND:20210624T110000Z
DTSTAMP:20240417T194934Z
UID:F9EAE5F5-03DF-4816-8F25-AA626A2389A9
CREATED:20210610T113315Z
LAST-MODIFIED:20210610T113315Z
SEQUENCE:1
STATUS:CONFIRMED
SUMMARY:Hacklunch for Project
TRANSP:OPAQUE
X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC
END:VEVENT

BEGIN:VEVENT
DTSTART:20210820T083000Z
DTEND:20210820T093000Z
DTSTAMP:20240417T194934Z
ORGANIZER;CN=one@example.com:mailto:one@example.com
UID:65sk7pn47gg2toh3r4j2uf6i7q@googi.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=two@ex
 ample.com;X-NUM-GUESTS=0:mailto:two@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=one@ex
 ample.com;X-NUM-GUESTS=0:mailto:one@example.com
CREATED:20210816T094622Z
DESCRIPTION:Hey Team! The sugarly overlord commands me to set up a meeting.
  This is the meeting
LAST-MODIFIED:20210818T080429Z
LOCATION:https://example.com/zoom-is-back
SEQUENCE:2
STATUS:CONFIRMED
SUMMARY:One / Two - Meeting
TRANSP:OPAQUE
END:VEVENT

BEGIN:VEVENT
DTSTART:20210818T180000Z
DTEND:20210818T190000Z
DTSTAMP:20240417T194934Z
ORGANIZER;CN=one@example.com:mailto:one@example.com
UID:6dgjcd9mcgqj0bb5cks6cb9k64pmabb1@googi.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=two@ex
 ample.com;X-NUM-GUESTS=0:mailto:two@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=th
 ree@example.com;X-NUM-GUESTS=0:mailto:three@example.com
CREATED:20210818T072649Z
DESCRIPTION:Hey\, let's try pairing for an hour and see where we end up :).
LAST-MODIFIED:20210818T151321Z
LOCATION:https://example.com/another-meeting-link
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Pairing Two / Three
TRANSP:OPAQUE
END:VEVENT

BEGIN:VEVENT
DTSTART:20210818T190000Z
DTEND:20210818T200000Z
DTSTAMP:20240417T194934Z
ORGANIZER;CN=one@example.com:mailto:one@example.com
UID:69hm6c9k6so36bb26lj64b9kcoojc@googi.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=th
 ree@example.com;X-NUM-GUESTS=0:mailto:three@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=one@ex
 ample.com;X-NUM-GUESTS=0:mailto:one@example.com
CREATED:20210818T072749Z
DESCRIPTION:Hey\, let's do a bit of pair coding :)
LAST-MODIFIED:20210818T151329Z
LOCATION:https://example.com/link-again
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Pairing Three / One
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR
`

const LINCOLN = String.raw`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ZContent.net//Zap Calendar 1.0//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
SUMMARY:Abraham Lincoln
UID:c7614cff-3549-4a00-9152-d25cc1fe077d
SEQUENCE:0
STATUS:CONFIRMED
TRANSP:TRANSPARENT
RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=12
DTSTART:20080212
DTEND:20080213
DTSTAMP:20150421T141403
CATEGORIES:U.S. Presidents,Civil War People
LOCATION:Hodgenville\, Kentucky
GEO:37.5739497;-85.7399606
DESCRIPTION:Born February 12\, 1809\nSixteenth President (1861-1865)\n\n\n
 \nhttp://AmericanHistoryCalendar.com
URL:http://americanhistorycalendar.com/peoplecalendar/1,328-abraham-lincol
 n
END:VEVENT
END:VCALENDAR`

// The first three of the fixture's 49 events: enough for its zone, its sort
// order and the non-ASCII summary.
const HOLIDAYS = String.raw`BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:Estonian holidays. Eesti pühapäevad.
X-WR-TIMEZONE:Europe/Tallinn
BEGIN:VEVENT
DTSTART;VALUE=DATE:20060514
DTEND;VALUE=DATE:20060515
DTSTAMP:20240418T212219Z
UID:8arpg1qkf1203unbd2eikon5gk@google.com
CREATED:20060504T152612Z
LAST-MODIFIED:20230117T030724Z
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Emadepäev
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20060623
DTEND;VALUE=DATE:20060624
RRULE:FREQ=YEARLY
DTSTAMP:20240418T212219Z
UID:f20c3qmc15g3lbinc9rav5jck4@google.com
CREATED:20060517T083301Z
LAST-MODIFIED:20230117T030729Z
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Võidupüha
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20060624
DTEND;VALUE=DATE:20060625
RRULE:FREQ=YEARLY
DTSTAMP:20240418T212219Z
UID:l3be62hr7mu77atugmq3lpu3c8@google.com
CREATED:20060517T083308Z
LAST-MODIFIED:20230117T030730Z
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Jaanipäev
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR
`

describe('parsing', () => {
  it('a UTC stamp ignores the zone; a floating one follows it', () => {
    expect(at('20240101T000000Z', 'UTC')).toBe(at('20240101T000000Z', BRU))
    expect(at('20240101', 'UTC')).not.toBe(at('20240101', BRU))
    expect(at('20240101T000000', 'UTC')).not.toBe(at('20240101T000000', BRU))
  })

  it('reads Windows zone names', () => {
    const content = `BEGIN:VCALENDAR
METHOD:PUBLISH
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
X-WR-TIMEZONE:GMT Standard Time
BEGIN:VTIMEZONE
TZID:GMT Standard Time
BEGIN:STANDARD
DTSTART:16010101T020000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T010000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:windows-ical-test
DTSTART;TZID=GMT Standard Time:20240331T100000
DTEND;TZID=GMT Standard Time:20240331T110000
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR`
    const calendar = parseICalendar(content)
    expect(calendar.timeZone).toBe('Europe/London')
    expect(calendar.events).toHaveLength(1)
    expect(calendar.events[0].startTs).toBe(at('20240331T100000', 'Europe/London'))
    expect(calendar.events[0].endTs).toBe(at('20240331T110000', 'Europe/London'))
    expect(calendar.events[0].summary).toBe('Test Event')
  })

  it('normalizes zone names', () => {
    expect(normalizeTimeZone('Romance Standard Time')).toBe('Europe/Paris')
    expect(normalizeTimeZone('utc')).toBe('Etc/UTC')
    expect(normalizeTimeZone('UTC+2')).toBe('Etc/GMT-2')
    expect(normalizeTimeZone('UTC-05:00')).toBe('Etc/GMT+5')
    expect(normalizeTimeZone('Europe/Brussels')).toBe(BRU)
  })

  it('unescapes text', () => {
    expect(unescape('a\\nb\\,c\;d\\\\e')).toBe('a\nb,c;d\\e')
    expect(unescape('trailing\\')).toBe('trailing\\')
  })

  it('reads durations', () => {
    expect(parseICalDuration('PT1H30M')).toBe(5400)
    expect(parseICalDuration('P1D')).toBe(86400)
    expect(parseICalDuration('-PT15M')).toBe(-900)
    expect(parseICalDuration('P2W')).toBe(1209600)
    expect(() => parseICalDuration('bogus')).toThrow()
    expect(() => parseICalDuration('P1X')).toThrow()
    expect(() => parseICalDuration('PT1')).toThrow()
  })

  it('reads a rule', () => {
    const event = { startTs: at('20240115T090000Z', 'UTC'), timeZone: 'UTC' }
    expect(parseRRule('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,-1SU;WKST=SU', event, 'UTC')).toEqual({
      freq: 'weekly', interval: 2, byDay: [[1, 0], [6, -1]], byMonth: [], byMonthDay: [], byYearDay: [], byWeekNo: [], until: 0, count: 4, weekStart: 6,
    })
    // BYMONTH alone takes its day from DTSTART.
    expect(parseRRule('FREQ=YEARLY;BYMONTH=3', event, 'UTC').byMonthDay).toEqual([15])
    expect(() => parseRRule('FREQ=HOURLY', event, 'UTC')).toThrow()
    expect(() => parseRRule('FREQ=DAILY;BYSETPOS=1', event, 'UTC')).toThrow()
    expect(() => parseRRule('FREQ=DAILY;COUNT=x', event, 'UTC')).toThrow()
  })

  it('reads period boundaries', () => {
    const now = at('20240515T120000Z', 'UTC') // a Wednesday
    expect(parsePeriodBoundary('2024-03-01', BRU, true, now)).toBe(at('20240301T000000Z', 'UTC'))
    expect(parsePeriodBoundary('this month', 'UTC', true, now)).toBe(at('20240501T000000Z', 'UTC'))
    expect(parsePeriodBoundary('this month', 'UTC', false, now)).toBe(at('20240601T000000Z', 'UTC'))
    expect(parsePeriodBoundary('this week', 'UTC', true, now)).toBe(at('20240513T000000Z', 'UTC'))
    expect(parsePeriodBoundary('next year', 'UTC', true, now)).toBe(at('20250101T000000Z', 'UTC'))
    expect(parsePeriodBoundary('last day', 'UTC', false, now)).toBe(at('20240515T000000Z', 'UTC'))
    expect(() => parsePeriodBoundary('soon', 'UTC', true, now)).toThrow()
  })

  it('steps one interval at the same wall-clock time', () => {
    const next = (dtstart: string, rule: string) =>
      toFullCal(`DTSTART;TZID=${BRU}:${dtstart}\nDTEND;TZID=${BRU}:${dtstart}\nRRULE:${rule};COUNT=2\n`)[1][0]
    expect(next('20240701T203000', 'FREQ=WEEKLY')).toBe(at('20240708T183000Z', 'UTC'))
    expect(next('20240703T203000', 'FREQ=MONTHLY')).toBe(at('20240803T183000Z', 'UTC'))
    expect(next('20240703T203000', 'FREQ=DAILY')).toBe(at('20240704T183000Z', 'UTC'))
  })

  it('lincoln', () => {
    const events = parseICalendar(LINCOLN).events
    expect(events).toHaveLength(1)
    expect(events[0].startTs).toBe(1202774400)
    expect(events[0].endTs).toBe(1202860800)
    expect(events[0].location).toBe('Hodgenville, Kentucky')
    expect(events[0].description).toBe('Born February 12, 1809\nSixteenth President (1861-1865)\n\n\n\nhttp://AmericanHistoryCalendar.com')
    expect(events[0].summary).toBe('Abraham Lincoln')
  })

  it('meetings', () => {
    const events = parseICalendar(MEETINGS).events
    expect(events).toHaveLength(5)
    expect(events[0].startTs).toBe(1618412400)
    expect(events[0].endTs).toBe(1618414200)
    expect(events[0].location).toBe('https://example.com/location-url/')
    expect(events[0].description).toBe('')
    expect(events[0].summary).toBe('Team Standup')
    expect(events[0].rrules[0]).toEqual({
      freq: 'weekly', interval: 1, byDay: [[2, 0]], byMonth: [], byMonthDay: [], byYearDay: [], byWeekNo: [], until: 1777388399, count: 0, weekStart: -1,
    })
    expect(events[1].startTs).toBe(1624528800)
    expect(events[1].endTs).toBe(1624532400)
    expect(events[1].location).toBe('')
    expect(events[1].description).toBe('')
    expect(events[1].summary).toBe('Hacklunch for Project')
    expect(events[2].startTs).toBe(1629309600)
    expect(events[2].endTs).toBe(1629313200)
    expect(events[2].location).toBe('https://example.com/another-meeting-link')
    expect(events[2].description).toBe("Hey, let's try pairing for an hour and see where we end up :).")
    expect(events[2].summary).toBe('Pairing Two / Three')
    expect(events[3].startTs).toBe(1629313200)
    expect(events[3].endTs).toBe(1629316800)
    expect(events[3].location).toBe('https://example.com/link-again')
    expect(events[3].description).toBe("Hey, let's do a bit of pair coding :)")
    expect(events[3].summary).toBe('Pairing Three / One')
    expect(events[4].startTs).toBe(1629448200)
    expect(events[4].endTs).toBe(1629451800)
    expect(events[4].location).toBe('https://example.com/zoom-is-back')
    expect(events[4].description).toBe('Hey Team! The sugarly overlord commands me to set up a meeting. This is the meeting')
    expect(events[4].summary).toBe('One / Two - Meeting')
  })

  it('meetings, expanded', () => {
    let calendar = parseICalendar(MEETINGS)
    expect(calendar.timeZone).toBe(BRU)
    const all = getEvents(calendar, at('20240101', 'UTC'), at('20250101', 'UTC'), '', 100)
    expect(all).toHaveLength(52)
    expect(all[0][0]).toBe(1704297600)
    expect(all[51][0]).toBe(1735142400)
    expect(all[0][1].summary).toBe('Team Standup')

    calendar = parseICalendar(MEETINGS)
    const old = getEvents(calendar, at('20210101', 'UTC'), at('20220101', 'UTC'), '', 100)
    expect(old).toHaveLength(42)
    expect(old[0][0]).toBe(1618412400)
    expect(old[41][0]).toBe(1640793600)
    expect(old[0][1].summary).toBe('Team Standup')
    expect(old[11][1].summary).toBe('Hacklunch for Project')

    calendar = parseICalendar(MEETINGS)
    expect(getEvents(calendar, at('20210101', 'UTC'), at('20220101', 'UTC'), 'Team Standup', 1000)).toHaveLength(38)
  })

  it('holidays', () => {
    const calendar = parseICalendar(HOLIDAYS)
    expect(calendar.timeZone).toBe('Europe/Tallinn')
    expect(calendar.events).toHaveLength(3)
    expect(calendar.events[0].startTs).toBe(1147554000)
    expect(calendar.events[0].summary).toBe('Emadepäev')
  })
})

// Examples from https://icalendar.org/iCalendar-RFC-5545/3-8-5-3-recurrence-rule.html
// (the BYWEEKNO, BYSETPOS and sub-daily ones were never supported).
describe('recurrence', () => {
  it('Daily for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=DAILY;COUNT=10
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970902T090000', '19970903T090000', '19970904T090000', '19970905T090000'])
    expect(events[9][0]).toBe(at('19970911T090000', NY))
  })

  it('Daily until December 24, 1997', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=DAILY;UNTIL=19971224T000000Z
`)
    expect(events).toHaveLength(113)
    expect(events[0][0]).toBe(at('19970902T090000', NY))
    expect(events[112][0]).toBe(at('19971223T090000', NY))
  })

  it('Every other day - forever', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=DAILY;INTERVAL=2
`)
    expect(events).toHaveLength(1000)
    expect(events[0][0]).toBe(at('19970902T090000', NY))
    expect(events[56][0]).toBe(at('19971223T090000', NY))
    expect(events[999][0]).toBe(at('20030221T090000', NY))
  })

  it('Every 10 days, 5 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=DAILY;INTERVAL=10;COUNT=5
`)
    expect(events).toHaveLength(5)
    expectStarts(events, NY, ['19970902T090000', '19970912T090000', '19970922T090000', '19971002T090000', '19971012T090000'])
  })

  it('Every day in January, for 3 years', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19980101T090000
DTEND;TZID=America/New_York:19980101T093000
RRULE:FREQ=YEARLY;UNTIL=20000131T140000Z;
 BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA
`)
    expect(events).toHaveLength(93)
    expect(events[0][0]).toBe(at('19980101T090000', NY))
    expect(events[92][0]).toBe(at('20000131T090000', NY))
  })

  it('Every day in January, for 3 years', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19980101T090000
DTEND;TZID=America/New_York:19980101T093000
RRULE:FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1
`)
    expect(events).toHaveLength(93)
    expect(events[0][0]).toBe(at('19980101T090000', NY))
    expect(events[92][0]).toBe(at('20000131T090000', NY))
  })

  it('Weekly for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;COUNT=10
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970902T090000', '19970909T090000', '19970916T090000', '19970923T090000', '19970930T090000', '19971007T090000', '19971014T090000', '19971021T090000', '19971028T090000', '19971104T090000'])
  })

  it('Weekly until December 24, 1997', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;UNTIL=19971224T000000Z
`)
    expect(events).toHaveLength(17)
    expectStarts(events, NY, ['19970902T090000', '19970909T090000', '19970916T090000', '19970923T090000', '19970930T090000', '19971007T090000', '19971014T090000', '19971021T090000', '19971028T090000', '19971104T090000', '19971111T090000', '19971118T090000', '19971125T090000', '19971202T090000', '19971209T090000', '19971216T090000', '19971223T090000'])
  })

  it('Every other week - forever', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU
`)
    expect(events).toHaveLength(870)
    expectStarts(events, NY, ['19970902T090000', '19970916T090000', '19970930T090000', '19971014T090000', '19971028T090000', '19971111T090000', '19971125T090000', '19971209T090000', '19971223T090000', '19980106T090000'])
    expect(events[869][0]).toBe(at('20301224T090000', NY))
  })

  it('Weekly on Tuesday and Thursday for five weeks', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;UNTIL=19971007T000000Z;WKST=SU;BYDAY=TU,TH
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970902T090000', '19970904T090000', '19970909T090000', '19970911T090000', '19970916T090000', '19970918T090000', '19970923T090000', '19970925T090000', '19970930T090000', '19971002T090000'])
  })

  it('Weekly on Tuesday and Thursday for five weeks', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970902T090000', '19970904T090000', '19970909T090000', '19970911T090000', '19970916T090000', '19970918T090000', '19970923T090000', '19970925T090000', '19970930T090000', '19971002T090000'])
  })

  it('Every other week on Monday, Wednesday, and Friday until December 24, 1997, starting on Monday, September 1, 1997', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970901T090000
DTEND;TZID=America/New_York:19970901T093000
RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR
`)
    expect(events).toHaveLength(25)
    expectStarts(events, NY, ['19970901T090000', '19970903T090000', '19970905T090000', '19970915T090000', '19970917T090000', '19970919T090000', '19970929T090000'])
    expect(events[24][0]).toBe(at('19971222T090000', NY))
  })

  it('Every other week on Tuesday and Thursday, for 8 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH
`)
    expect(events).toHaveLength(8)
    expectStarts(events, NY, ['19970902T090000', '19970904T090000', '19970916T090000', '19970918T090000', '19970930T090000', '19971002T090000', '19971014T090000', '19971016T090000'])
  })

  it('Monthly on the first Friday for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970905T090000
DTEND;TZID=America/New_York:19970905T093000
RRULE:FREQ=MONTHLY;COUNT=10;BYDAY=1FR
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970905T090000', '19971003T090000', '19971107T090000', '19971205T090000', '19980102T090000', '19980206T090000', '19980306T090000', '19980403T090000', '19980501T090000', '19980605T090000'])
  })

  it('Monthly on the first Friday until December 24, 1997', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970905T090000
DTEND;TZID=America/New_York:19970905T093000
RRULE:FREQ=MONTHLY;UNTIL=19971224T000000Z;BYDAY=1FR
`)
    expect(events).toHaveLength(4)
    expectStarts(events, NY, ['19970905T090000', '19971003T090000', '19971107T090000', '19971205T090000'])
  })

  it('Every other month on the first and last Sunday of the month for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970907T090000
DTEND;TZID=America/New_York:19970907T093000
RRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970907T090000', '19970928T090000', '19971102T090000', '19971130T090000', '19980104T090000', '19980125T090000', '19980301T090000', '19980329T090000', '19980503T090000', '19980531T090000'])
  })

  it('Monthly on the second-to-last Monday of the month for 6 months', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970922T090000
DTEND;TZID=America/New_York:19970922T093000
RRULE:FREQ=MONTHLY;COUNT=6;BYDAY=-2MO
`)
    expect(events).toHaveLength(6)
    expectStarts(events, NY, ['19970922T090000', '19971020T090000', '19971117T090000', '19971222T090000', '19980119T090000', '19980216T090000'])
  })

  it('Monthly on the third-to-the-last day of the month, forever', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970928T090000
DTEND;TZID=America/New_York:19970928T093000
RRULE:FREQ=MONTHLY;BYMONTHDAY=-3
`)
    expect(events).toHaveLength(400)
    expectStarts(events, NY, ['19970928T090000', '19971029T090000', '19971128T090000', '19971229T090000', '19980129T090000', '19980226T090000'])
    expect(events[399][0]).toBe(at('20301229T090000', NY))
  })

  it('Monthly on the 2nd and 15th of the month for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970902T090000', '19970915T090000', '19971002T090000', '19971015T090000', '19971102T090000', '19971115T090000', '19971202T090000', '19971215T090000', '19980102T090000', '19980115T090000'])
  })

  it('Monthly on the first and last day of the month for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970930T090000
DTEND;TZID=America/New_York:19970930T093000
RRULE:FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970930T090000', '19971001T090000', '19971031T090000', '19971101T090000', '19971130T090000', '19971201T090000', '19971231T090000', '19980101T090000', '19980131T090000', '19980201T090000'])
  })

  it('Every 18 months on the 10th thru 15th of the month for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970910T090000
DTEND;TZID=America/New_York:19970910T093000
RRULE:FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970910T090000', '19970911T090000', '19970912T090000', '19970913T090000', '19970914T090000', '19970915T090000', '19990310T090000', '19990311T090000', '19990312T090000', '19990313T090000'])
  })

  it('Every Tuesday, every other month', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=TU
`)
    expect(events).toHaveLength(875)
    expectStarts(events, NY, ['19970902T090000', '19970909T090000', '19970916T090000', '19970923T090000', '19970930T090000', '19971104T090000', '19971111T090000', '19971118T090000', '19971125T090000', '19980106T090000'])
    expect(events[874][0]).toBe(at('20301126T090000', NY))
  })

  it('Yearly in June and July for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970610T090000
DTEND;TZID=America/New_York:19970610T093000
RRULE:FREQ=YEARLY;COUNT=10;BYMONTH=6,7
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970610T090000', '19970710T090000', '19980610T090000', '19980710T090000', '19990610T090000', '19990710T090000', '20000610T090000', '20000710T090000', '20010610T090000', '20010710T090000'])
  })

  it('Every other year on January, February, and March for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970310T090000
DTEND;TZID=America/New_York:19970310T093000
RRULE:FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970310T090000', '19990110T090000', '19990210T090000', '19990310T090000', '20010110T090000', '20010210T090000', '20010310T090000', '20030110T090000', '20030210T090000', '20030310T090000'])
  })

  it('Every third year on the 1st, 100th, and 200th day for 10 occurrences', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970101T090000
DTEND;TZID=America/New_York:19970101T093000
RRULE:FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200
`)
    expect(events).toHaveLength(10)
    expectStarts(events, NY, ['19970101T090000', '19970410T090000', '19970719T090000', '20000101T090000', '20000409T090000', '20000718T090000', '20030101T090000', '20030410T090000', '20030719T090000', '20060101T090000'])
  })

  it('Every 20th Monday of the year, forever', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970519T090000
DTEND;TZID=America/New_York:19970519T093000
RRULE:FREQ=YEARLY;BYDAY=20MO
`)
    expect(events).toHaveLength(34)
    expectStarts(events, NY, ['19970519T090000', '19980518T090000', '19990517T090000', '20000515T090000', '20010514T090000', '20020520T090000', '20030519T090000', '20040517T090000', '20050516T090000', '20060515T090000'])
  })

  it('Every Thursday in March, forever', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970313T090000
DTEND;TZID=America/New_York:19970313T093000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=TH
`)
    expect(events).toHaveLength(149)
    expectStarts(events, NY, ['19970313T090000', '19970320T090000', '19970327T090000', '19980305T090000', '19980312T090000', '19980319T090000', '19980326T090000', '19990304T090000', '19990311T090000', '19990318T090000', '19990325T090000', '20000302T090000', '20000309T090000', '20000316T090000'])
  })

  it('Every Thursday, but only during June, July, and August, forever', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970605T090000
DTEND;TZID=America/New_York:19970605T093000
RRULE:FREQ=YEARLY;BYDAY=TH;BYMONTH=6,7,8
`)
    expect(events).toHaveLength(447)
    expectStarts(events, NY, ['19970605T090000', '19970612T090000', '19970619T090000', '19970626T090000', '19970703T090000', '19970710T090000', '19970717T090000', '19970724T090000', '19970731T090000', '19970807T090000', '19970814T090000'])
  })

  it('Every Friday the 13th, forever', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970902T090000
DTEND;TZID=America/New_York:19970902T093000
RRULE:FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13
`)
    expect(events).toHaveLength(57)
    expectStarts(events, NY, ['19980213T090000', '19980313T090000', '19981113T090000', '19990813T090000', '20001013T090000'])
  })

  it('The first Saturday that follows the first Sunday of the month, forever', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970913T090000
DTEND;TZID=America/New_York:19970913T093000
RRULE:FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13
`)
    expect(events).toHaveLength(400)
    expectStarts(events, NY, ['19970913T090000', '19971011T090000', '19971108T090000', '19971213T090000', '19980110T090000', '19980207T090000', '19980307T090000', '19980411T090000', '19980509T090000', '19980613T090000'])
  })

  it('Every 4 years, the first Tuesday after a Monday in November, forever (U.S. Presidential Election day)', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19961105T090000
DTEND;TZID=America/New_York:19961105T093000
RRULE:FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8
`)
    expect(events).toHaveLength(9)
    expectStarts(events, NY, ['19961105T090000', '20001107T090000', '20041102T090000', '20081104T090000', '20121106T090000', '20161108T090000', '20201103T090000'])
  })

  it('An example where the days generated makes a difference because of WKST', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970805T090000
DTEND;TZID=America/New_York:19970805T093000
RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO
`)
    expect(events).toHaveLength(4)
    expectStarts(events, NY, ['19970805T090000', '19970810T090000', '19970819T090000', '19970824T090000'])
  })

  it('changing only WKST from MO to SU, yields different results', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:19970805T090000
DTEND;TZID=America/New_York:19970805T093000
RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU
`)
    expect(events).toHaveLength(4)
    expectStarts(events, NY, ['19970805T090000', '19970817T090000', '19970819T090000', '19970831T090000'])
  })

  it('An example where an invalid date (i.e., February 30) is ignored', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:20070115T090000
DTEND;TZID=America/New_York:20070115T093000
RRULE:FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5
`)
    expect(events).toHaveLength(5)
    expectStarts(events, NY, ['20070115T090000', '20070130T090000', '20070215T090000', '20070315T090000', '20070330T090000'])
  })

  it('EXDATE', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:20070115T090000
DTEND;TZID=America/New_York:20070115T093000
RRULE:FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5
EXDATE;TZID=America/New_York:20070315T090000
EXDATE;TZID=America/New_York:20070415T090000
`)
    expect(events).toHaveLength(5)
    expectStarts(events, NY, ['20070115T090000', '20070130T090000', '20070215T090000', '20070330T090000', '20070430T090000'])
  })

  it('RECURRENCE-ID override', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:20070115T090000
DTEND;TZID=America/New_York:20070115T093000
RRULE:FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5
SUMMARY:Test Event
END:VEVENT
BEGIN:VEVENT
UID:1234567890
DTSTART;TZID=America/New_York:20070215T090000
DTEND;TZID=America/New_York:20070215T093000
RECURRENCE-ID;TZID=America/New_York:20070215T090000
SUMMARY:Overridden
`)
    expect(events).toHaveLength(5)
    expectStarts(events, NY, ['20070115T090000', '20070130T090000', '20070215T090000', '20070315T090000', '20070330T090000'])
    expect(events[0][1].summary).toBe('Test Event')
    expect(events[2][1].summary).toBe('Overridden')
  })

  it('RECURRENCE-ID standalone', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:20070215T090000
DTEND;TZID=America/New_York:20070215T093000
RECURRENCE-ID;TZID=America/New_York:20070215T090000
SUMMARY:Overridden
`)
    expect(events).toHaveLength(1)
    expect(events[0][0]).toBe(at('20070215T090000', NY))
  })

  it('RECURRENCE-ID with STATUS:CANCELLED (should remove the instance)', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:20241001T180000
DTEND;TZID=America/New_York:20241001T200000
RRULE:FREQ=WEEKLY;COUNT=4
SUMMARY:Block / Family Time
END:VEVENT
BEGIN:VEVENT
UID:1234567890
DTSTART;TZID=America/New_York:20241008T180000
DTEND;TZID=America/New_York:20241008T200000
RECURRENCE-ID;TZID=America/New_York:20241008T180000
STATUS:CANCELLED
SUMMARY:Block / Family Time (cancelled)
`)
    const starts = events.map((e) => e[0])
    expect(events).toHaveLength(3)
    expect(starts.includes(at('20241001T180000', NY))).toBe(true)
    expect(starts.includes(at('20241008T180000', NY))).toBe(false)
    expect(starts.includes(at('20241015T180000', NY))).toBe(true)
    expect(starts.includes(at('20241022T180000', NY))).toBe(true)
  })

  it('RECURRENCE-ID;RANGE=THISANDFUTURE (split series)', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=America/New_York:20241001T180000
DTEND;TZID=America/New_York:20241001T200000
RRULE:FREQ=WEEKLY;COUNT=6
SUMMARY:Block / Family Time
END:VEVENT
BEGIN:VEVENT
UID:1234567890
DTSTART;TZID=America/New_York:20241015T190000
DTEND;TZID=America/New_York:20241015T210000
RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20241015T180000
RRULE:FREQ=WEEKLY
SUMMARY:Block / Family Time (moved later)
`)
    const starts = events.map((e) => e[0])
    expect(starts.includes(at('20241015T180000', NY))).toBe(false)
    expect(starts.includes(at('20241015T190000', NY))).toBe(true)
    expect(starts.includes(at('20241022T190000', NY))).toBe(true)
    expect(starts.includes(at('20241022T180000', NY))).toBe(false)
    expect(events).toHaveLength(6)
  })

  it('newer recurring master suppresses stale older series', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=Europe/Brussels:20220307T180000
DTEND;TZID=Europe/Brussels:20220307T200000
RRULE:FREQ=WEEKLY;BYDAY=FR,MO,TH,TU,WE
LAST-MODIFIED:20250320T174938Z
SEQUENCE:1
SUMMARY:Block / Family Time
END:VEVENT
BEGIN:VEVENT
UID:abcdef-newer-series@example.com
DTSTART;TZID=Europe/Brussels:20250113T180000
DTEND;TZID=Europe/Brussels:20250113T200000
RRULE:FREQ=WEEKLY;BYDAY=FR,MO,TH,TU,WE
LAST-MODIFIED:20250401T120000Z
SEQUENCE:2
SUMMARY:Block / Family Time
`, 'Europe/Brussels')
    const starts = events.map((e) => e[0])
    expect(starts.includes(at('20250110T180000', BRU))).toBe(true)
    expect(starts.includes(at('20250113T180000', BRU))).toBe(true)
    expect(starts.filter((t) => t === at('20250113T180000', BRU))).toHaveLength(1)
  })

  it('exact duplicate occurrences keep the freshest event', () => {
    const events = toFullCal(String.raw`DTSTART;TZID=Europe/Brussels:20250113T180000
DTEND;TZID=Europe/Brussels:20250113T200000
LAST-MODIFIED:20250101T100000Z
SEQUENCE:1
SUMMARY:Block / Family Time
END:VEVENT
BEGIN:VEVENT
UID:duplicate-fresher@example.com
DTSTART;TZID=Europe/Brussels:20250113T180000
DTEND;TZID=Europe/Brussels:20250113T200000
LAST-MODIFIED:20250102T100000Z
SEQUENCE:2
SUMMARY:Block / Family Time
`, 'Europe/Brussels')
    expect(events).toHaveLength(1)
    expect(events[0][1].uid).toBe('duplicate-fresher@example.com')
  })
})

const PAST = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nDTSTART:20000101\nDTEND:20000102\nSUMMARY:Past Event\nEND:VEVENT\nEND:VCALENDAR'

describe('get', () => {
  it('rejects a URL', () => {
    const error = mock.error()
    expect(get(makeApp({ config: { ical: 'http://example.com/calendar.ics' } }))).toEqual([])
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith('Pass in iCal data as a string, not a URL.')
  })

  it('rejects an empty feed', () => {
    const error = mock.error()
    expect(get(makeApp({ config: { ical: '' } }))).toEqual([])
    expect(error).toHaveBeenCalledWith('No iCal data provided.')
  })

  it('replies with nothing for a window with nothing in it', () => {
    const log = mock.log()
    const app = makeApp({ config: { ical: PAST, exportFrom: '2100-01-01', exportUntil: '2100-01-02' } })
    expect(get(app)).toEqual([])
    expect(log).toHaveBeenCalledWith({ event: 'reply', eventsInRange: 0 })
  })

  it('folds a description across read windows and keeps every event', () => {
    let body = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:UTC\r\n'
    for (let i = 0; i < 400; i++) {
      const day = String(1 + (i % 27)).padStart(2, '0')
      body += `BEGIN:VEVENT\r\nUID:event-${i}\r\nDTSTART:203001${day}T090000Z\r\nDTEND:203001${day}T100000Z\r\nSUMMARY:Event number ${i}\r\n`
      body += 'DESCRIPTION:A description long enough to fold over several\r\n continuation lines, repeated so the body is large: ' + 'padding '.repeat(12) + '\r\nEND:VEVENT\r\n'
    }
    body += 'END:VCALENDAR\r\n'
    expect(body.length).toBeGreaterThan(100000)
    const reply = get(makeApp({ config: { ical: body, exportFrom: '2029-01-01', exportUntil: '2031-01-01', exportCount: 10000, addDescription: true } }))
    expect(reply).toHaveLength(400)
    expect(reply[0].description).toContain('continuation lines')
  })

  it('drops one-offs outside the window while it reads, and keeps what can still recur into it', () => {
    const body = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'UID:ancient@t', 'DTSTART:20200101T100000Z', 'DTEND:20200101T110000Z', 'SUMMARY:ancient one-off', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:future@t', 'DTSTART:20990101T100000Z', 'DTEND:20990101T110000Z', 'SUMMARY:distant one-off', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:inside@t', 'DTSTART:20260815T100000Z', 'DTEND:20260815T110000Z', 'SUMMARY:in window', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:weekly@t', 'DTSTART:20200106T090000Z', 'DTEND:20200106T093000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:old recurring master', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const kept = parseICalendar(body, 'UTC', { keepFrom: 1785542400, keepUntil: 1788220800 }).events.map((e) => e.summary)
    expect(kept).toEqual(['old recurring master', 'in window'])
    expect(parseICalendar(body, 'UTC').events).toHaveLength(4)
  })
})
