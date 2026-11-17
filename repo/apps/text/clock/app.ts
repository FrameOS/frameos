// Clock: the frame's time as text, in chrono's format: "{hour/2}:{minute/2}",
// the tokens a code node's format helper takes. A JavaScript app's Date is
// in the frame's zone. A scene made with the built-in clock of FrameOS
// 2026.11.10 and earlier runs Clock (std/times format) instead
// (repo/apps/text/clockStdTimes).

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December']

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/** `date` in a chrono format; a token it does not know is left as written. */
export function formatTime(date: Date, format: string, timeZone = ''): string {
  return format.replace(/\{([^{}]+)\}/g, (written, token: string) => {
    const hour = date.getHours()
    switch (token) {
      case 'year': return String(date.getFullYear())
      case 'year/2': return pad(date.getFullYear() % 100)
      case 'year/4': return pad(date.getFullYear(), 4)
      case 'month': return String(date.getMonth() + 1)
      case 'month/2': return pad(date.getMonth() + 1)
      case 'month/n': return MONTHS[date.getMonth()]
      case 'month/n/3': return MONTHS[date.getMonth()].slice(0, 3)
      case 'day': return String(date.getDate())
      case 'day/2': return pad(date.getDate())
      case 'weekday': return WEEKDAYS[date.getDay()]
      case 'weekday/3': return WEEKDAYS[date.getDay()].slice(0, 3)
      case 'weekday/2': return WEEKDAYS[date.getDay()].slice(0, 2)
      case 'hour': return String(hour)
      case 'hour/2': return pad(hour)
      case 'hour/ap': return String(hour % 12 || 12)
      case 'hour/2/ap': return pad(hour % 12 || 12)
      case 'am/pm': return hour < 12 ? 'am' : 'pm'
      case 'minute': return String(date.getMinutes())
      case 'minute/2': return pad(date.getMinutes())
      case 'second': return String(date.getSeconds())
      case 'second/2': return pad(date.getSeconds())
      case 'tzName': return timeZone
      default: return written
    }
  })
}

export function get(app) {
  const c = app.config
  const format = c.format === 'custom' ? c.formatCustom : c.format
  return formatTime(new Date(Date.now()), typeof format === 'string' ? format : '', app.frame?.timeZone ?? '')
}
