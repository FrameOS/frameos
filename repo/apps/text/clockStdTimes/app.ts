// Clock (std/times format): the frame's time as text, its format written as
// the built-in data/clock of FrameOS 2026.11.10 and earlier wrote it
// ("HH:mm:ss", "dddd d MMMM yyyy", 'quoted' text). A scene made with that
// clock runs this app (docs/retired-apps.json); a new scene uses Clock
// (repo/apps/text/clock), whose format is chrono's.
//
// A port of std/times' `format`: its tokens, its literals and its errors. A
// JavaScript app's Date is in the frame's zone, as the Nim clock's was.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December']
// Written as they are between tokens; any other character is part of one.
const LITERALS = ' -/:()[],.'

const pad = (value: number, width: number) => String(value).padStart(width, '0')

// The ISO 8601 week and the year it belongs to (V, VV, GG, GGGG).
function isoWeek(date: Date): { week: number; year: number } {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const weekday = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - weekday)
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1)
  return { week: Math.ceil(((day.getTime() - yearStart) / 86400000 + 1) / 7), year: day.getUTCFullYear() }
}

function offset(date: Date, token: string): string {
  const east = -date.getTimezoneOffset() * 60
  const abs = Math.abs(east)
  const sign = east >= 0 ? '+' : '-'
  const hours = Math.floor(abs / 3600)
  const minutes = pad(Math.floor(abs / 60) % 60, 2)
  const seconds = pad(abs % 60, 2)
  switch (token) {
    case 'z': return sign + hours
    case 'zz': return sign + pad(hours, 2)
    case 'zzz': return `${sign}${pad(hours, 2)}:${minutes}`
    case 'ZZZ': return `${sign}${pad(hours, 2)}${minutes}`
    case 'zzzz': return `${sign}${pad(hours, 2)}:${minutes}:${seconds}`
    default: return `${sign}${pad(hours, 2)}${minutes}${seconds}`
  }
}

function pattern(date: Date, token: string): string {
  const year = date.getFullYear()
  const hour = date.getHours()
  const millis = date.getMilliseconds()
  switch (token) {
    case 'd': return String(date.getDate())
    case 'dd': return pad(date.getDate(), 2)
    case 'ddd': return WEEKDAYS[date.getDay()].slice(0, 3)
    case 'dddd': return WEEKDAYS[date.getDay()]
    case 'h': return String(hour % 12 || 12)
    case 'hh': return pad(hour % 12 || 12, 2)
    case 'H': return String(hour)
    case 'HH': return pad(hour, 2)
    case 'm': return String(date.getMinutes())
    case 'mm': return pad(date.getMinutes(), 2)
    case 'M': return String(date.getMonth() + 1)
    case 'MM': return pad(date.getMonth() + 1, 2)
    case 'MMM': return MONTHS[date.getMonth()].slice(0, 3)
    case 'MMMM': return MONTHS[date.getMonth()]
    case 's': return String(date.getSeconds())
    case 'ss': return pad(date.getSeconds(), 2)
    case 'fff': return pad(millis, 3)
    case 'ffffff': return pad(millis * 1000, 6)
    case 'fffffffff': return pad(millis * 1000000, 9)
    case 't': return hour >= 12 ? 'P' : 'A'
    case 'tt': return hour >= 12 ? 'PM' : 'AM'
    case 'yy': return pad(year % 100, 2)
    case 'yyyy':
    case 'uuuu': return year < 10000 ? pad(year, 4) : `+${year}`
    case 'YYYY':
    case 'UUUU': return String(year)
    case 'V': return String(isoWeek(date).week)
    case 'VV': return pad(isoWeek(date).week, 2)
    case 'GG': return pad(isoWeek(date).year % 100, 2)
    case 'GGGG': return String(isoWeek(date).year)
    case 'z': case 'zz': case 'zzz': case 'zzzz': case 'ZZZ': case 'ZZZZ': return offset(date, token)
    case 'g': return year < 1 ? 'BC' : 'AD'
    default: throw new Error(`'${token}' is not a valid pattern`)
  }
}

/** `date` in a std/times pattern. */
export function formatStdTimes(date: Date, format: string): string {
  let out = ''
  let run = ''
  const flush = () => {
    if (run) out += pattern(date, run)
    run = ''
  }
  for (let i = 0; i < format.length; i++) {
    const c = format[i]
    if (c === "'") {
      flush()
      if (format[i + 1] === "'") {
        out += "'"
        i++
        continue
      }
      const close = format.indexOf("'", i + 1)
      if (close < 0) throw new Error("Unclosed ' in time format string. For a literal ', use ''.")
      out += format.slice(i + 1, close)
      i = close
    } else if (LITERALS.includes(c)) {
      flush()
      out += c
    } else {
      if (run && run[0] !== c) flush()
      run += c
    }
  }
  flush()
  return out
}

export function get(app) {
  const c = app.config
  const format = c.format === 'custom' ? c.formatCustom : c.format
  return formatStdTimes(new Date(Date.now()), typeof format === 'string' ? format : 'HH:mm:ss')
}
