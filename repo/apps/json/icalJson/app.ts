// An iCal feed into the events inside a window. A port of the built-in
// data/icalJson (retired 2026.11.6): the same fields, the same results.
//
// A feed can be many MB on a frame with a few MB to spare, so nothing here
// holds it. openLines hands over the lines this app asks for and reads past
// the rest natively (a calendar's attendees and folded descriptions never
// become strings), and an event that cannot reach the window is dropped the
// moment it ends. What stays is the window's events and the recurring series
// that can still land in it.

const DAY = 86400
const MARGIN = 2 * DAY // more than any UTC offset: the cheap wall-clock test before the exact one
const MAX_RESULTS = 100000
const CANCELLED = 3

// Windows zone names as Outlook and Exchange write them, lower-cased.
const WINDOWS_ZONES =
  "|dateline standard time=Etc/GMT+12|utc-11=Etc/GMT+11|aleutian standard time=America/Adak|hawaiian st" +
  "andard time=Pacific/Honolulu|marquesas standard time=Pacific/Marquesas|alaskan standard time=America" +
  "/Anchorage|utc-09=Etc/GMT+9|pacific standard time (mexico)=America/Tijuana|pacific standard time=Ame" +
  "rica/Los_Angeles|us mountain standard time=America/Phoenix|mountain standard time (mexico)=America/C" +
  "hihuahua|mountain standard time=America/Denver|yukon standard time=America/Whitehorse|central americ" +
  "a standard time=America/Guatemala|central standard time=America/Chicago|central standard time (mexic" +
  "o)=America/Mexico_City|canada central standard time=America/Regina|sa pacific standard time=America/" +
  "Bogota|eastern standard time (mexico)=America/Cancun|eastern standard time=America/New_York|us easte" +
  "rn standard time=America/Indiana/Indianapolis|haiti standard time=America/Port-au-Prince|cuba standa" +
  "rd time=America/Havana|turks and caicos standard time=America/Grand_Turk|venezuela standard time=Ame" +
  "rica/Caracas|paraguay standard time=America/Asuncion|atlantic standard time=America/Halifax|central " +
  "brazilian standard time=America/Cuiaba|sa western standard time=America/La_Paz|pacific sa standard t" +
  "ime=America/Santiago|newfoundland standard time=America/St_Johns|tocantins standard time=America/Ara" +
  "guaina|e. south america standard time=America/Sao_Paulo|sa eastern standard time=America/Cayenne|arg" +
  "entina standard time=America/Buenos_Aires|greenland standard time=America/Nuuk|montevideo standard t" +
  "ime=America/Montevideo|magallanes standard time=America/Punta_Arenas|saint pierre standard time=Amer" +
  "ica/Miquelon|bahia standard time=America/Bahia|utc-02=Etc/GMT+2|azores standard time=Atlantic/Azores" +
  "|cape verde standard time=Atlantic/Cape_Verde|gmt standard time=Europe/London|greenwich standard tim" +
  "e=Atlantic/Reykjavik|morocco standard time=Africa/Casablanca|gmt daylight time=Europe/London|w. euro" +
  "pe standard time=Europe/Berlin|central europe standard time=Europe/Warsaw|romance standard time=Euro" +
  "pe/Paris|central european standard time=Europe/Warsaw|w. central africa standard time=Africa/Lagos|n" +
  "amibia standard time=Africa/Windhoek|gtb standard time=Europe/Bucharest|middle east standard time=As" +
  "ia/Beirut|egypt standard time=Africa/Cairo|e. europe standard time=Europe/Chisinau|syria standard ti" +
  "me=Asia/Damascus|west bank standard time=Asia/Hebron|south africa standard time=Africa/Johannesburg|" +
  "fle standard time=Europe/Kyiv|israel standard time=Asia/Jerusalem|kaliningrad standard time=Europe/K" +
  "aliningrad|sudan standard time=Africa/Khartoum|libya standard time=Africa/Tripoli|turkey standard ti" +
  "me=Europe/Istanbul|arabic standard time=Asia/Baghdad|arabian standard time=Asia/Dubai|belarus standa" +
  "rd time=Europe/Minsk|russian standard time=Europe/Moscow|volgograd standard time=Europe/Volgograd|sa" +
  "ratov standard time=Europe/Saratov|georgian standard time=Asia/Tbilisi|azerbaijan standard time=Asia" +
  "/Baku|mauritius standard time=Indian/Mauritius|caucasus standard time=Asia/Yerevan|afghanistan stand" +
  "ard time=Asia/Kabul|west asia standard time=Asia/Tashkent|ekaterinburg standard time=Asia/Yekaterinb" +
  "urg|pakistan standard time=Asia/Karachi|india standard time=Asia/Kolkata|sri lanka standard time=Asi" +
  "a/Colombo|nepal standard time=Asia/Kathmandu|central asia standard time=Asia/Almaty|bangladesh stand" +
  "ard time=Asia/Dhaka|myanmar standard time=Asia/Yangon|se asia standard time=Asia/Bangkok|north asia " +
  "standard time=Asia/Novosibirsk|china standard time=Asia/Shanghai|north asia east standard time=Asia/" +
  "Irkutsk|singapore standard time=Asia/Singapore|taipei standard time=Asia/Taipei|w. australia standar" +
  "d time=Australia/Perth|korea standard time=Asia/Seoul|tokyo standard time=Asia/Tokyo|yakutsk standar" +
  "d time=Asia/Yakutsk|cen. australia standard time=Australia/Adelaide|aus central standard time=Austra" +
  "lia/Darwin|aus eastern standard time=Australia/Sydney|w. pacific standard time=Pacific/Port_Moresby|" +
  "tonga standard time=Pacific/Tongatapu|lord howe standard time=Australia/Lord_Howe|tokelau standard t" +
  "ime=Pacific/Fakaofo|fiji standard time=Pacific/Fiji|new zealand standard time=Pacific/Auckland|utc+1" +
  "2=Etc/GMT-12|utc+13=Etc/GMT-13|samoa standard time=Pacific/Apia|line islands standard time=Pacific/K" +
  "iritimati|chatham islands standard time=Pacific/Chatham|argentina daylight time=America/Buenos_Aires" +
  "|greenwich daylight time=Atlantic/Reykjavik|w. europe daylight time=Europe/Berlin|central europe day" +
  "light time=Europe/Warsaw|romance daylight time=Europe/Paris|central european daylight time=Europe/Wa" +
  "rsaw|fle daylight time=Europe/Kyiv|turkey daylight time=Europe/Istanbul|russian daylight time=Europe" +
  "/Moscow|caucasus daylight time=Asia/Yerevan|aus eastern daylight time=Australia/Sydney|cen. australi" +
  "a daylight time=Australia/Adelaide|aus central daylight time=Australia/Darwin|tasmania standard time" +
  "=Australia/Hobart|e. australia standard time=Australia/Brisbane|central pacific standard time=Pacifi" +
  "c/Guadalcanal|vladivostok standard time=Asia/Vladivostok|sakhalin standard time=Asia/Sakhalin|magada" +
  "n standard time=Asia/Magadan|kamchatka standard time=Asia/Kamchatka|utc+14=Etc/GMT-14|iran standard " +
  "time=Asia/Tehran|azerbaijan daylight time=Asia/Baku|bangladesh daylight time=Asia/Dhaka|central asia" +
  " daylight time=Asia/Almaty|china daylight time=Asia/Shanghai|korea daylight time=Asia/Seoul|tokyo da" +
  "ylight time=Asia/Tokyo|newfoundland daylight time=America/St_Johns|"

const zones = new Map()

function zoneInfo(name) {
  let info = zones.get(name)
  if (!info) {
    info = { name: normalizeZoneName(name), changes: null, last: 0 }
    zones.set(name, info)
  }
  return info
}

function normalizeZoneName(raw) {
  const trimmed = String(raw).trim()
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  const at = WINDOWS_ZONES.indexOf('|' + lower + '=')
  if (at >= 0) {
    const from = at + lower.length + 2
    return WINDOWS_ZONES.slice(from, WINDOWS_ZONES.indexOf('|', from))
  }
  const upper = trimmed.toUpperCase()
  if (upper === 'UTC' || upper === 'GMT') return 'Etc/UTC'
  if (trimmed.startsWith('UTC') && trimmed.length > 3 && (trimmed[3] === '+' || trimmed[3] === '-')) {
    const [h, m = '0'] = trimmed.slice(4).split(':')
    const hour = strictInt(h, true)
    const minute = strictInt(m, true)
    if (hour === null || minute === null) return trimmed
    if (minute === 0) {
      const offset = trimmed[3] === '+' ? -hour : hour
      return 'Etc/GMT' + (offset >= 0 ? '+' + offset : offset)
    }
  }
  return frameos.timeZone(trimmed).name
}

export function normalizeTimeZone(raw) {
  return zoneInfo(raw).name
}

// Seconds east of UTC at `t`: the transition table, fetched once per zone.
function offsetAt(info, t) {
  if (info.changes === null) info.changes = info.name ? frameos.timeZone(info.name).changes : []
  const c = info.changes
  const n = c.length / 2
  if (n === 0) return 0
  let i = info.last
  if (!(c[2 * i] <= t && (i === n - 1 || c[2 * i + 2] > t))) {
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (c[2 * mid] <= t) lo = mid
      else hi = mid - 1
    }
    i = lo
    info.last = i
  }
  return c[2 * i + 1]
}

function wallToTs(wall, info) {
  return info.name ? wall - offsetAt(info, wall) : wall
}

function daysFromCivil(y, m, d) {
  y += Math.floor((m - 1) / 12)
  m = (((m - 1) % 12) + 12) % 12 + 1
  if (m <= 2) y -= 1
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * ((m + 9) % 12) + 2) / 5) + d - 1
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468
}

function civilFromDays(days) {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const m = mp < 10 ? mp + 3 : mp - 9
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, doy - Math.floor((153 * mp + 2) / 5) + 1]
}

const weekdayOf = (days) => (((days + 3) % 7) + 7) % 7 // Monday is 0

function leap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
}

function monthLength(y, m) {
  return m === 2 ? (leap(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
}

// Digits at s[from..from+count), or NaN.
function digits(s, from, count) {
  let v = 0
  for (let i = from; i < from + count; i++) {
    const c = s.charCodeAt(i) - 48
    if (!(c >= 0 && c <= 9)) return NaN
    v = v * 10 + c
  }
  return v
}

function strictInt(text, quiet) {
  if (/^[+-]?[0-9]+$/.test(text)) return parseInt(text, 10)
  if (quiet) return null
  throw new Error('Invalid integer: ' + text)
}

// The wall-clock seconds of an iCal date or date-time: NaN when it is neither.
function wallOf(text) {
  if (text.length === 8) {
    return daysFromCivil(digits(text, 0, 4), digits(text, 4, 2), digits(text, 6, 2)) * DAY
  }
  if ((text.length !== 15 && text.length !== 16) || text[8] !== 'T' || (text.length === 16 && text[15] !== 'Z')) return NaN
  return daysFromCivil(digits(text, 0, 4), digits(text, 4, 2), digits(text, 6, 2)) * DAY +
    digits(text, 9, 2) * 3600 + digits(text, 11, 2) * 60 + digits(text, 13, 2)
}

// The date-time part of a property value, past any parameters.
function dateTimeText(value) {
  const semi = value.indexOf(';')
  if (semi >= 0) return value.split(';')[1]
  const colon = value.indexOf(':')
  return colon >= 0 ? value.split(':')[1] : value
}


export function parseICalDateTime(text, zone) {
  const part = dateTimeText(text)
  const wall = wallOf(part)
  if (wall !== wall) throw new Error('Failed to parse datetime string: ' + text)
  if (part.length === 16) return wall // Z: already UTC
  const info = zoneInfo(zone)
  return wallToTs(wall, info)
}

export function unescape(line) {
  if (line.indexOf('\\') < 0) return line
  let out = ''
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '\\') {
      out += line[i]
      continue
    }
    i++
    if (i >= line.length) return out + '\\'
    const c = line[i]
    out += c === 'n' || c === 'N' ? '\n' : c === 't' || c === 'T' ? '\t' : c === 'r' || c === 'R' ? '\r' : c
  }
  return out
}

export function parseICalDuration(value) {
  let s = value.trim()
  let sign = 1
  if (s[0] === '+') s = s.slice(1)
  else if (s[0] === '-') {
    sign = -1
    s = s.slice(1)
  }
  if (s[0] !== 'P') throw new Error('Invalid DURATION: ' + value)
  let total = 0
  let num = ''
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (c === 'T') continue
    if (c >= '0' && c <= '9') {
      num += c
      continue
    }
    if (!num) throw new Error('Invalid DURATION: ' + value)
    const unit = { W: 604800, D: DAY, H: 3600, M: 60, S: 1 }[c]
    if (!unit) throw new Error('Invalid DURATION unit in: ' + value)
    total += parseInt(num, 10) * unit
    num = ''
  }
  if (num) throw new Error('Trailing number in DURATION: ' + value)
  return sign * total
}

const WEEKDAYS = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 }
const FREQS = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }

const intList = (text, into) => {
  for (const part of text.split(',')) into.push(strictInt(part))
}

export function parseRRule(value, event, calendarZone) {
  const rule = { freq: 'daily', interval: 0, byDay: [], byMonth: [], byMonthDay: [], byYearDay: [], byWeekNo: [], until: 0, count: 0, weekStart: -1 }
  for (const part of value.split(';')) {
    const pair = part.split('=')
    if (pair.length !== 2) continue
    const v = pair[1]
    switch (pair[0]) {
      case 'FREQ':
        rule.freq = FREQS[v]
        if (!rule.freq) throw new Error('Unknown RRULE freq: ' + v)
        break
      case 'INTERVAL': rule.interval = strictInt(v); break
      case 'COUNT': rule.count = strictInt(v); break
      case 'UNTIL': rule.until = parseICalDateTime(v, calendarZone); break
      case 'BYSECOND': case 'BYMINUTE': case 'BYHOUR': case 'BYSETPOS':
        throw new Error(pair[0] + ' is not supported')
      case 'BYDAY':
        for (const day of v.split(',')) {
          if (day.length < 2) continue
          const name = day.slice(-2).toUpperCase()
          const num = day.length > 2 ? strictInt(day.slice(0, -2)) : 0
          if (name in WEEKDAYS) rule.byDay.push([WEEKDAYS[name], num])
        }
        break
      case 'BYMONTHDAY': intList(v, rule.byMonthDay); break
      case 'BYYEARDAY': intList(v, rule.byYearDay); break
      case 'BYWEEKNO': intList(v, rule.byWeekNo); break
      case 'BYMONTH': intList(v, rule.byMonth); break
      case 'WKST': if (v.toUpperCase() in WEEKDAYS) rule.weekStart = WEEKDAYS[v.toUpperCase()]; break
    }
  }
  if (rule.interval === 0) rule.interval = 1
  if ((rule.freq === 'monthly' || rule.freq === 'yearly') && rule.byMonth.length && !rule.byDay.length && !rule.byMonthDay.length && !rule.byYearDay.length) {
    // The day comes from DTSTART when no BYxxx names one.
    const zone = zoneInfo(event.timeZone)
    rule.byMonthDay.push(civilFromDays(Math.floor((event.startTs + offsetAt(zone, event.startTs)) / DAY))[2])
  }
  return rule
}

function zoneParam(value) {
  return normalizeTimeZone(value.split(':')[0].split('=')[1])
}

function parseDateValue(value, event, cal) {
  const zone = event.timeZone === '' ? cal.timeZone : event.timeZone
  return parseICalDateTime(value.indexOf('VALUE=DATE') >= 0 ? value.slice(value.lastIndexOf(':') + 1) : value, zone)
}

const LINES_ALWAYS = ['BEGIN:VEVENT', 'END:VEVENT', 'BEGIN:VALARM', 'END:VALARM', 'BEGIN:VCALENDAR', 'END:VCALENDAR', 'X-WR-TIMEZONE', 'UID', 'TZID', 'DTSTART', 'DTEND', 'DURATION', 'DTSTAMP', 'RECURRENCE-ID', 'RRULE', 'EXDATE', 'SUMMARY', 'STATUS', 'LAST-MODIFIED', 'SEQUENCE', 'http']

const NEEDLE = { RRULE: '\nRRULE', DTSTART: '\nDTSTART', DTEND: '\nDTEND', DURATION: '\nDURATION', RID: '\nRECURRENCE-ID' }

// The value of a property in a block (its parameters included), undefined when
// the block has none. `needle` is the name after a newline, `name` the same
// without it for the block's first line.
function rawValue(block, name, needle) {
  let at = block.startsWith(name) ? 0 : block.indexOf(needle)
  if (at < 0) return undefined
  if (at > 0) at += 1
  const sep = at + name.length
  const c = block[sep]
  if (c !== ':' && c !== ';') return undefined
  const end = block.indexOf('\n', sep)
  return end < 0 ? block.slice(sep + 1) : block.slice(sep + 1, end)
}

const hasProperty = (block, name, needle) => block.startsWith(name) || block.indexOf(needle) >= 0

// A date value's YYYYMMDD: the strings compare as the dates do.
function dateKey(value) {
  const at = value.lastIndexOf(':') + 1
  return value.slice(at, at + 8)
}

function keyOfDays(days) {
  const [y, m, d] = civilFromDays(days)
  return String(y * 10000 + m * 100 + d)
}

// Is this event plainly outside the window? Read off two or three lines as
// text, no time zone and no parsing, because most of a feed that goes back
// years is exactly that, and it is the one thing the loop below must do cheaply.
function quickReject(block, o) {
  if (!o.keepFrom) return false
  const dtstart = rawValue(block, 'DTSTART', NEEDLE.DTSTART)
  if (dtstart === undefined) return false
  const start = dateKey(dtstart)
  const dtend = rawValue(block, 'DTEND', NEEDLE.DTEND)
  const end = dtend !== undefined ? dateKey(dtend) : hasProperty(block, 'DURATION', NEEDLE.DURATION) ? '' : start
  if (!((start.length === 8 && start > o.untilKey) || (end.length === 8 && end < o.fromKey))) return false
  if (hasProperty(block, 'RRULE', NEEDLE.RRULE)) return false
  const rid = rawValue(block, 'RECURRENCE-ID', NEEDLE.RID)
  if (rid === undefined) return true
  // An override only touches what happens inside the window: the instance it
  // replaces (at its RECURRENCE-ID) or where it moved to (checked just above).
  if (/THISANDFUTURE/i.test(rid)) return false
  const original = rid.slice(rid.indexOf(':') + 1, rid.indexOf(':') + 9)
  return original.length === 8 && (original < o.fromKey || original > o.untilKey)
}

function fieldsOf(block) {
  const fields = {}
  let inAlarm = false
  for (const line of block.split('\n')) {
    if (line.startsWith('BEGIN:VALARM')) inAlarm = true
    else if (line.startsWith('END:VALARM')) inAlarm = false
    else if (!inAlarm) {
      let at = line.indexOf(':')
      if (at < 0) continue
      const semi = line.indexOf(';')
      if (semi >= 0 && semi < at) at = semi
      const key = line.slice(0, at)
      if (key === 'EXDATE') (fields.EXDATE ?? (fields.EXDATE = [])).push(line.slice(at + 1))
      else if (fields[key] === undefined) fields[key] = line.slice(at + 1)
    }
  }
  return fields
}

// One event's lines, into an event. Throws on anything malformed, which
// skips that event and no other.
function finishEvent(f, cal, o) {
  const keeping = o.keepFrom > 0
  const rid = f['RECURRENCE-ID']
  const rrule = f.RRULE

  const event = {
    uid: f.UID ?? '', timeZone: cal.timeZone, startTs: 0, endTs: 0, fullDay: false, rrules: [], exDates: [],
    recurrenceId: rid ?? '', summary: '', description: '', location: '', url: '', status: 0, sequence: 0, dtStamp: 0, lastModified: 0,
  }
  if (f.TZID !== undefined) event.timeZone = normalizeTimeZone(f.TZID)
  if (f.DTSTART !== undefined) {
    const v = f.DTSTART
    if (v.startsWith('TZID=')) event.timeZone = zoneParam(v)
    event.startTs = parseDateValue(v, event, cal)
    event.fullDay = v.indexOf('VALUE=DATE') >= 0 || v.length === 8
  }
  if (f.DTEND !== undefined) {
    const v = f.DTEND
    if (v.startsWith('TZID=')) event.timeZone = zoneParam(v)
    event.endTs = parseDateValue(v, event, cal)
    event.fullDay = v.indexOf('VALUE=DATE') >= 0 || v.length === 8
  }
  if (f.DURATION !== undefined) event.endTs = event.startTs + parseICalDuration(f.DURATION)
  if (f.DTSTAMP !== undefined) event.dtStamp = parseICalDateTime(f.DTSTAMP, 'UTC')

  if (rrule !== undefined) {
    const rule = parseRRule(rrule, event, cal.timeZone)
    event.rrules.push(rule)
    if (keeping && !rid) {
      // A series over before the window, or not begun by its end. An expired
      // one cannot end another either: reconcile only pairs equal rules.
      if (rule.until && rule.until + Math.max(0, event.endTs - event.startTs) < o.keepFrom) return
      if (event.startTs > o.keepUntil) return
    }
  }
  if (f.EXDATE) {
    for (const raw of f.EXDATE) {
      let zone = ''
      let dates = raw
      const colon = raw.indexOf(':')
      if (colon !== -1) {
        for (const p of raw.slice(0, colon).split(';')) {
          if (p.startsWith('TZID=')) zone = normalizeTimeZone(p.slice(5))
        }
        dates = raw.slice(colon + 1)
      }
      const use = zone || cal.masterTz.get(event.uid) || event.timeZone || cal.timeZone
      for (const token of dates.split(',')) event.exDates.push(parseICalDateTime(token, use))
    }
  }
  if (f.SUMMARY !== undefined) event.summary = unescape(f.SUMMARY)
  if (f.DESCRIPTION !== undefined) event.description = unescape(f.DESCRIPTION)
  if (f.LOCATION !== undefined) event.location = unescape(f.LOCATION)
  if (f.URL !== undefined) event.url = unescape(f.URL)
  if (f.STATUS !== undefined) {
    const s = f.STATUS.toUpperCase()
    event.status = s === 'TENTATIVE' ? 1 : s === 'CONFIRMED' ? 2 : s === 'CANCELLED' ? CANCELLED : 0
  }
  if (f['LAST-MODIFIED'] !== undefined) event.lastModified = parseICalDateTime(f['LAST-MODIFIED'], 'UTC')
  if (f.SEQUENCE !== undefined) event.sequence = strictInt(f.SEQUENCE, true) ?? 0

  if (!rid && event.uid) cal.masterTz.set(event.uid, event.timeZone)
  if (keeping) {
    if (event.rrules.length === 0 && !rid) {
      const eventEnd = event.endTs > 0 ? event.endTs : event.startTs
      if (eventEnd < o.keepFrom || event.startTs > o.keepUntil) return
    }
    if (o.search && event.summary.indexOf(o.search) < 0) return
    if (event.status === CANCELLED && !rid) return
  }
  cal.events.push(event)
}

// parseICalendar(source, timeZone, { keepFrom, keepUntil, search, want }):
// `source` is a stream a byteIter field arrived as, or a string. Without
// `keepFrom` nothing is dropped early (the tests read every event).
export function parseICalendar(source, timeZone, options) {
  const o = { keepFrom: 0, keepUntil: 0, search: '', want: [], ...options }
  if (o.keepFrom) {
    o.fromKey = keyOfDays(Math.floor((o.keepFrom - MARGIN) / DAY))
    o.untilKey = keyOfDays(Math.floor((o.keepUntil + MARGIN) / DAY))
  }
  const cal = { events: [], timeZone: normalizeTimeZone(timeZone || ''), masterTz: new Map(), staleCutoff: new Map(), problem: '', skipped: 0 }
  const lines = frameos.openLines(source, { unfold: true, trim: true, only: [...LINES_ALWAYS, ...o.want, ...(o.keepFrom ? [] : ['LOCATION', 'URL', 'DESCRIPTION'])] })
  if (!lines) {
    cal.problem = 'No iCal data provided.'
    return cal
  }
  let first = true
  let inCalendar = false
  let line
  while ((line = frameos.nextLine(lines)) !== null) {
    if (first) {
      first = false
      if (line.startsWith('http')) {
        cal.problem = 'Pass in iCal data as a string, not a URL.'
        return cal
      }
    }
    if (line.startsWith('BEGIN:VEVENT')) {
      const block = frameos.nextBlock(lines, 'END:VEVENT')
      if (block === null) break
      if (quickReject(block, o)) continue
      try {
        finishEvent(fieldsOf(block), cal, o)
      } catch (e) {
        cal.skipped++
      }
    } else if (line.startsWith('BEGIN:VCALENDAR')) inCalendar = true
    else if (line.startsWith('END:VCALENDAR')) inCalendar = false
    else if (inCalendar && line.startsWith('X-WR-TIMEZONE')) {
      const colon = line.indexOf(':')
      const semi = line.indexOf(';')
      if (colon >= 0) cal.timeZone = normalizeTimeZone(unescape(line.slice((semi >= 0 && semi < colon ? semi : colon) + 1)))
    }
  }
  frameos.streamClose(lines)
  if (first) cal.problem = 'No iCal data provided.'
  cal.events.sort((a, b) => a.startTs - b.startTs)
  reconcileRecurringSeries(cal)
  return cal
}

const freshness = (e) => [e.sequence, e.lastModified, e.dtStamp, e.startTs]

function compareFreshness(a, b) {
  const x = freshness(a)
  const y = freshness(b)
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

const ruleKey = (r) => [r.freq, r.interval, r.byDay.join('/'), r.byMonth, r.byMonthDay, r.byYearDay, r.byWeekNo, r.until, r.count, r.weekStart].join('|')

// Two masters that are the same series under different UIDs: the older one
// ends where the newer one begins.
function reconcileRecurringSeries(cal) {
  const groups = new Map()
  for (const e of cal.events) {
    if (e.status === CANCELLED || e.rrules.length === 0 || e.recurrenceId) continue
    const key = e.summary + '|' + e.fullDay + '|' + (e.endTs - e.startTs) + '|' + ruleKey(e.rrules[0])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const older of group) {
      for (const newer of group) {
        if (older === newer || older.uid === newer.uid) continue
        const fresher = compareFreshness(newer, older)
        if ((older.startTs < newer.startTs && fresher >= 0) || (older.startTs === newer.startTs && fresher > 0)) {
          const cut = cal.staleCutoff.get(older.uid)
          if (cut === undefined || newer.startTs < cut) cal.staleCutoff.set(older.uid, newer.startTs)
        }
      }
    }
  }
}

function hasThisAndFuture(value) {
  const i = value.indexOf(':')
  if (i === -1) return false
  return value.slice(0, i).split(';').some((p) => {
    const up = p.toUpperCase()
    return up.startsWith('RANGE=') && up.slice(6).split('=')[0] === 'THISANDFUTURE'
  })
}

function ridParts(value) {
  let zone = ''
  let date = value
  const colon = value.indexOf(':')
  if (colon !== -1) {
    date = value.slice(colon + 1)
    for (const p of value.slice(0, colon).split(';')) {
      if (p.startsWith('TZID=')) zone = normalizeTimeZone(p.slice(5))
    }
  }
  return [zone, date]
}

function ridTimestamp(cal, event) {
  const [zoneParam, date] = ridParts(event.recurrenceId)
  const zone = zoneParam || cal.masterTz.get(event.uid) || event.timeZone || cal.timeZone
  return parseICalDateTime(date, zone)
}

function weekStartOf(rule) {
  return rule.weekStart === -1 ? 0 : rule.weekStart
}

function simpleNext(wall, rule) {
  const tod = ((wall % DAY) + DAY) % DAY
  switch (rule.freq) {
    case 'daily': return wall + rule.interval * DAY
    case 'weekly': return wall + 7 * rule.interval * DAY
    case 'monthly': {
      const [y, m, d] = civilFromDays(Math.floor(wall / DAY))
      return daysFromCivil(y, m + rule.interval, d) * DAY + tod
    }
    default: {
      const [y, m, d] = civilFromDays(Math.floor(wall / DAY))
      return daysFromCivil(y + rule.interval, m, d) * DAY + tod
    }
  }
}

function intervalEnd(wall, rule, zone) {
  const days = Math.floor(wall / DAY)
  let next
  if (rule.freq === 'daily') next = days + 1
  else if (rule.freq === 'weekly') {
    const start = weekStartOf(rule)
    const wd = weekdayOf(days)
    next = days + (start > wd ? start - wd : 7 - wd + start)
  } else {
    const [y, m] = civilFromDays(days)
    next = rule.freq === 'monthly' ? daysFromCivil(y, m + 1, 1) : daysFromCivil(y + 1, 1, 1)
  }
  return wallToTs(next * DAY, zone)
}

function nextIntervalStart(wall, rule) {
  const days = Math.floor(wall / DAY)
  const tod = wall - days * DAY
  if (rule.freq === 'daily') return (days + rule.interval) * DAY + tod
  if (rule.freq === 'weekly') {
    const start = weekStartOf(rule)
    const wd = weekdayOf(days)
    return (days + 7 * (rule.interval - 1) + (start > wd ? start - wd : 7 - wd + start)) * DAY + tod
  }
  const [y, m] = civilFromDays(days)
  return (rule.freq === 'monthly' ? daysFromCivil(y, m + rule.interval, 1) : daysFromCivil(y + rule.interval, 1, 1)) * DAY + tod
}

function nthWeekdayMatches(days, y, m, d, wd, num, rule) {
  if (rule.freq !== 'monthly' && rule.freq !== 'yearly') {
    // Weekly and daily rules never walk the period: the walk starts and stays on the 1st.
    return d === 1
  }
  if (weekdayOf(days) !== wd) return false
  let day
  let count = 0
  if (num > 0) {
    day = rule.freq === 'yearly' ? daysFromCivil(y, 1, 1) : days - d + 1
    const stop = rule.freq === 'yearly' ? daysFromCivil(y + 1, 1, 1) : days - d + 1 + monthLength(y, m)
    while (day < stop) {
      if (weekdayOf(day) === wd && ++count === num) break
      day++
    }
  } else {
    day = rule.freq === 'yearly' ? daysFromCivil(y, 12, 31) : days - d + monthLength(y, m)
    const stop = rule.freq === 'yearly' ? daysFromCivil(y, 1, 1) : days - d + 1
    while (day >= stop) {
      if (weekdayOf(day) === wd && ++count === -num) break
      day--
    }
  }
  return day === days
}

function matchesRule(days, rule) {
  if (rule.byDay.length === 1 && rule.byDay[0][1] === 0 && !rule.byMonth.length && !rule.byMonthDay.length && !rule.byYearDay.length) {
    return weekdayOf(days) === rule.byDay[0][0]
  }
  const [y, m, d] = civilFromDays(days)
  if (rule.byDay.length) {
    let found = false
    for (const [wd, num] of rule.byDay) {
      if (num === 0 ? weekdayOf(days) === wd : nthWeekdayMatches(days, y, m, d, wd, num, rule)) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  if (rule.byMonth.length && !rule.byMonth.includes(m)) return false
  if (rule.byMonthDay.length && !rule.byMonthDay.some((n) => (n > 0 ? n === d : d === monthLength(y, m) + n + 1))) return false
  if (rule.byYearDay.length && !rule.byYearDay.includes(days - daysFromCivil(y, 1, 1) + 1)) return false
  return true
}

// Whole intervals ahead, so a series from 2019 does not walk to today. Only
// without COUNT, which has to be spent from DTSTART.
function skipAhead(wall, rule, startTs, duration, simple) {
  const target = startTs - Math.max(0, duration) - 3 * DAY
  if (wall >= target) return wall
  if (rule.freq === 'daily' || rule.freq === 'weekly') {
    const period = rule.interval * (rule.freq === 'weekly' ? 7 : 1) * DAY
    return wall + Math.floor((target - wall) / period) * period
  }
  const months = rule.interval * (rule.freq === 'yearly' ? 12 : 1)
  const days = Math.floor(wall / DAY)
  const [y, m, d] = civilFromDays(days)
  if (simple && d > 28) return wall // a month with no such day rolls over, and the walk has to see that
  const [ty, tm] = civilFromDays(Math.floor(target / DAY))
  const steps = Math.floor(((ty - y) * 12 + tm - m - 1) / months)
  return steps > 0 ? daysFromCivil(y, m + steps * months, d) * DAY + (wall - days * DAY) : wall
}

function applyRule(state, cal, startTs, endTs, event, rule) {
  const zone = zoneInfo(event.timeZone === '' ? cal.timeZone : event.timeZone)
  const duration = event.endTs - event.startTs
  let ts = event.startTs
  let wall = ts + (zone.name ? offsetAt(zone, ts) : 0)
  let newEnd = event.endTs
  let counter = 0
  let first = true
  const until = rule.until
  const count = rule.count
  const ex = event.exDates
  const simple = !rule.byDay.length && !rule.byMonth.length && !rule.byMonthDay.length && !rule.byYearDay.length && !rule.byWeekNo.length
  while ((until === 0 || ts <= until) && (count === 0 || counter < count) && ts <= endTs) {
    let next
    if (simple) {
      next = simpleNext(wall, rule)
      if (!ex.includes(ts)) {
        counter++
        if (newEnd >= startTs) addMatched(state, cal, ts, event)
      }
    } else {
      next = nextIntervalStart(wall, rule)
      const end = intervalEnd(wall, rule, zone)
      while ((until === 0 || ts <= until) && (count === 0 || counter < count) && ts < end && ts < endTs) {
        if (matchesRule(Math.floor(wall / DAY), rule) && !ex.includes(ts)) {
          counter++
          if (newEnd >= startTs) addMatched(state, cal, ts, event)
        }
        wall += DAY
        ts = wallToTs(wall, zone)
        newEnd = ts + duration
      }
    }
    wall = next
    if (first) {
      first = false
      if (count === 0) wall = skipAhead(wall, rule, startTs, duration, simple)
    }
    ts = wallToTs(wall, zone)
    newEnd = ts + duration
  }
}

const KEY_SPAN = 4e10

function keyFor(state, uid, ts) {
  let id = state.uids.get(uid)
  if (id === undefined) {
    id = state.uids.size + 1
    state.uids.set(uid, id)
  }
  return id * KEY_SPAN + Math.trunc(ts)
}

function addMatched(state, cal, ts, event) {
  if (state.result.length > MAX_RESULTS) throw new Error('Too many events in calendar.')
  if (!event.recurrenceId && event.rrules.length) {
    const cut = cal.staleCutoff.get(event.uid)
    if (cut !== undefined && ts >= cut) return
  }
  if (event.recurrenceId) {
    const ridTs = ridTimestamp(cal, event)
    if (event.rrules.length || hasThisAndFuture(event.recurrenceId)) {
      const cut = state.split.get(event.uid)
      if (cut === undefined || ridTs < cut) state.split.set(event.uid, ridTs)
      state.provided.set(keyFor(state, event.uid, ts), [ts, event])
    } else {
      state.provided.set(keyFor(state, event.uid, ridTs), [ts, event])
    }
  } else if (event.rrules.length) {
    if (event.status !== CANCELLED) state.generated.set(keyFor(state, event.uid, ts), [ts, event])
  } else if (event.status !== CANCELLED) {
    state.result.push([ts, event])
  }
}

function resolveCollisions(state) {
  const winners = new Map()
  for (const pair of state.result) {
    const [ts, event] = pair
    const key = event.summary + '|' + Math.trunc(ts) + '|' + Math.trunc(event.endTs - event.startTs)
    const current = winners.get(key)
    const preferred = !current || compareFreshness(event, current[1]) > 0 ? event : current[1]
    if (preferred.uid === event.uid && preferred.startTs === event.startTs && preferred.endTs === event.endTs) winners.set(key, pair)
  }
  state.result = [...winners.values()]
}

export function getEvents(cal, startTs, endTs, search = '', maxCount = 1000) {
  const state = { result: [], provided: new Map(), generated: new Map(), split: new Map(), uids: new Map() }
  for (const event of cal.events) {
    if (search && event.summary.indexOf(search) < 0) continue
    if (event.status === CANCELLED && !event.recurrenceId) continue
    for (const rule of event.rrules) applyRule(state, cal, startTs, endTs, event, rule)
    if (event.rrules.length === 0 && event.startTs <= endTs && event.endTs >= startTs) addMatched(state, cal, event.startTs, event)
    if (event.recurrenceId) {
      const ridTs = ridTimestamp(cal, event)
      if (ridTs <= endTs && ridTs >= startTs) addMatched(state, cal, event.startTs === 0 ? ridTs : event.startTs, event)
    }
  }

  // A THISANDFUTURE split ends the parent at the split, and keeps as many of
  // the child's instances as it took from the parent.
  const removed = new Map()
  for (const [uid, cutoff] of state.split) {
    for (const [key, [ts, ev]] of state.generated) {
      if (ev.uid === uid && !ev.recurrenceId && ts >= cutoff) {
        state.generated.delete(key)
        removed.set(uid, (removed.get(uid) ?? 0) + 1)
      }
    }
  }
  for (const [uid, count] of removed) {
    const cutoff = state.split.get(uid)
    const children = []
    for (const [key, [ts, ev]] of state.provided) {
      if (ev.uid === uid && ts >= cutoff && (ev.rrules.length || hasThisAndFuture(ev.recurrenceId))) children.push([ts, key])
    }
    children.sort((a, b) => a[0] - b[0])
    for (let i = count; i < children.length; i++) state.provided.delete(children[i][1])
  }

  for (const [key, pair] of state.provided) {
    state.generated.delete(key)
    if (pair[1].status !== CANCELLED) state.result.push(pair)
  }
  for (const pair of state.generated.values()) state.result.push(pair)

  resolveCollisions(state)
  state.result.sort((a, b) => a[0] - b[0] || (a[1].summary < b[1].summary ? -1 : a[1].summary > b[1].summary ? 1 : 0))
  return maxCount > 0 && state.result.length > maxCount ? state.result.slice(0, maxCount) : state.result
}

const pad = (n, width) => String(n).padStart(width, '0')

function formatTs(ts, zone, dateOnly) {
  const wall = Math.floor(ts + (zone.name ? offsetAt(zone, ts) : 0))
  const days = Math.floor(wall / DAY)
  const [y, m, d] = civilFromDays(days)
  const date = pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2)
  if (dateOnly) return date
  const s = wall - days * DAY
  return date + 'T' + pad(Math.floor(s / 3600), 2) + ':' + pad(Math.floor(s / 60) % 60, 2) + ':' + pad(s % 60, 2)
}

// "this week", "next month", or a plain date (which reads as UTC midnight).
export function parsePeriodBoundary(value, zoneName, isStart, now) {
  const s = value.trim().toLowerCase()
  const parts = s.split(/\s+/)
  if (parts.length === 2 && ['this', 'last', 'next'].includes(parts[0]) && ['day', 'week', 'month', 'year'].includes(parts[1])) {
    const zone = zoneInfo(zoneName)
    const offset = zone.name ? offsetAt(zone, now) : 0
    let days = Math.floor((now + offset) / DAY)
    const step = parts[0] === 'last' ? -1 : parts[0] === 'next' ? 1 : 0
    let [y, m, d] = civilFromDays(days)
    if (parts[1] === 'day') days += step
    else if (parts[1] === 'week') days += 7 * step
    else if (parts[1] === 'month') days = daysFromCivil(y, m + step, d)
    else days = daysFromCivil(y + step, m, d)
    ;[y, m, d] = civilFromDays(days)
    const extra = isStart ? 0 : 1
    let result
    if (parts[1] === 'day') result = days + extra
    else if (parts[1] === 'week') result = days - weekdayOf(days) + 7 * extra
    else if (parts[1] === 'month') result = daysFromCivil(y, m + extra, 1)
    else result = daysFromCivil(y + extra, 1, 1)
    return result * DAY - offset
  }
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value)
  if (!match) throw new Error('Could not read the date "' + value + '": use YYYY-MM-DD, or this/last/next day, week, month or year')
  return daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3])) * DAY
}

const flag = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : typeof v === 'string' ? v.trim().toLowerCase() === 'true' : Boolean(v))

export function get(app) {
  const config = app.config
  if (config.ical === undefined || config.ical === null || config.ical === '') {
    app.logError('No iCal data provided.')
    return []
  }
  const timeZone = app.frame.timeZone || 'UTC'
  const now = Date.now() / 1000
  const startTs = config.exportFrom ? parsePeriodBoundary(config.exportFrom, timeZone, true, now) : now
  const endTs = config.exportUntil ? parsePeriodBoundary(config.exportUntil, timeZone, false, now) : now + 366 * DAY
  const addLocation = flag(config.addLocation, true)
  const addUrl = flag(config.addUrl, true)
  const addDescription = flag(config.addDescription, false)
  const addTimezone = flag(config.addTimezone, false)
  const count = Number(config.exportCount ?? 50) || 0
  const search = config.search || ''
  let cal
  try {
    cal = parseICalendar(config.ical, timeZone, {
      keepFrom: startTs,
      keepUntil: endTs,
      search,
      want: [...(addLocation ? ['LOCATION'] : []), ...(addUrl ? ['URL'] : []), ...(addDescription ? ['DESCRIPTION'] : [])],
    })
  } catch (e) {
    app.logError('Error parsing iCal: ' + (e && e.message ? e.message : e))
    return []
  }
  if (cal.problem) {
    app.logError(cal.problem)
    return []
  }
  const zone = zoneInfo(cal.timeZone)
  const reply = []
  for (const [time, event] of getEvents(cal, startTs, endTs, search, count)) {
    const span = event.endTs - event.startTs
    const end = time + span - (event.fullDay ? 0.001 : 0) + (event.fullDay && event.startTs === event.endTs ? DAY : 0)
    const out = { summary: event.summary, startTime: formatTs(time, zone, event.fullDay), endTime: formatTs(end, zone, event.fullDay) }
    if (event.location && addLocation) out.location = event.location
    if (event.url && addUrl) out.url = event.url
    if (event.description && addDescription) out.description = event.description
    if (addTimezone) out.timezone = event.timeZone || cal.timeZone
    reply.push(out)
  }
  app.log({ event: 'reply', eventsInRange: reply.length, ...(cal.skipped ? { skipped: cal.skipped } : {}) })
  return reply
}
