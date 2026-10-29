// Events to Agenda: calendar events (as the iCal JSON app gives them) as an
// agenda in basic-caret text, a day title over each day's events.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December']

const str = (value) => (typeof value === 'string' ? value : '')

// A font size as caret text writes it: 24, 24.5, never 24.000000.
const size = (value) => String(Number((Number(value) || 0).toFixed(6)))

// "Tuesday, December 24" for "2024-12-24": the date as written, in no zone.
function dayTitle(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day)
  if (!match) throw new Error(`Invalid date: ${day}`)
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay()
  return `${WEEKDAYS[weekday]}, ${MONTHS[month - 1]} ${date}`
}

// Today as YYYY-MM-DD in `zone`. JavaScript's clock is in the frame's zone,
// as the Nim runtime's is, and knows no other, so a calendar in a third zone
// gets the frame's day: the two differ only between their midnights.
function today(zone) {
  const now = new Date(Date.now())
  const utc = zone === 'UTC' || zone === 'Etc/UTC' || zone === 'GMT'
  const parts = utc
    ? [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()]
    : [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  return parts.map((part, i) => String(part).padStart(i === 0 ? 4 : 2, '0')).join('-')
}

export function get(app) {
  const c = app.config
  const title = `^(${size(c.titleFontSize)},${c.titleColor})`
  const normal = `^(${size(c.baseFontSize)},${c.textColor})`
  const time = `^(${size(c.baseFontSize)},${c.timeColor})`
  const events = c.events
  const noEvents = !Array.isArray(events) || events.length === 0
  // The first event that names its zone, else the frame's.
  const zone = (noEvents ? '' : str(events.find((event) => str(event?.timezone))?.timezone)) ||
    app.frame.timeZone || 'UTC'
  const h1 = (text) => `${title}${text}\n${normal}\n`

  let result = ''
  let currentDay = ''
  if (c.startWithToday || noEvents) {
    currentDay = today(zone)
    result += h1(dayTitle(currentDay))
  }
  if (noEvents) return result + 'No events found\n'

  const sorted = [...events].sort((a, b) => {
    const x = str(a?.startTime)
    const y = str(b?.startTime)
    return x < y ? -1 : x > y ? 1 : 0
  })
  let hasAny = false
  for (const event of sorted) {
    const summary = str(event?.summary)
    const startDay = str(event?.startTime)
    const endDay = str(event?.endTime)
    const withTime = startDay.includes('T')
    const startDate = startDay.split('T')[0]
    const endDate = endDay.split('T')[0]
    let displayDay = startDate
    // A day that is on now shows under today.
    if (c.startWithToday && currentDay && startDate <= currentDay && currentDay <= endDate) displayDay = currentDay

    if (displayDay !== currentDay) {
      if (!hasAny && c.startWithToday) result += 'No events today\n'
      result += '\n' + h1(dayTitle(displayDay))
      currentDay = displayDay
    }
    hasAny = true

    if (withTime) {
      const startTime = startDay.split('T')[1].slice(0, 5)
      const endTime = endDay.includes('T') ? endDay.split('T')[1].slice(0, 5) : ''
      result += `${time}${startTime} - ${endTime}  ${normal}${summary}\n`
    } else if (startDay === currentDay && endDay === currentDay) {
      result += `${time}All day  ${normal}${summary}\n`
    } else {
      result += `${time}Until ${dayTitle(endDay)}  ${normal}${summary}\n`
    }
  }
  return result
}
