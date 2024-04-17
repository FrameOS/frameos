import ../app
import frameos/types

block test_ical_1:
    let iCalFile = readFile("./src/apps/ical/tests/data/test1.ics")
    echo iCalFile
    let events = parseICalendar(iCalFile)
    echo events
    doAssert len(events) == 1
    # doAssert events[0].startDate == "20080212"
    # doAssert events[0].endDate == "20080213"
    doAssert events[0].location == "Hodgenville\\, Kentucky"
    echo events[0].description
    doAssert events[0].description == "Born February 12\\, 1809\\nSixteenth President (1861-1865)\\n\\n\\n\\nhttp://AmericanHistoryCalendar.com"
    doAssert events[0].title == "Abraham Lincoln"

block test_ical_2:
    let iCalFile = readFile("./src/apps/ical/tests/data/test2.ics")
    echo iCalFile
    let events = parseICalendar(iCalFile)
    echo events
    doAssert len(events) == 5
    # doAssert events[0].startDate == "20080212"
    # doAssert events[0].endDate == "20080213"
    # doAssert events[0].location == "Hodgenville\\, Kentucky"
    # doAssert events[0].description == "Born February 12\\, 1809\\nSixteenth President (1861-1865)\\n\\n\\n"
    # doAssert events[0].title == "Abraham Lincoln"
