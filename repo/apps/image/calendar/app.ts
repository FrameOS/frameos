// A month of days with the events on them, drawn as an SVG the size of the area
// it feeds. A port of the built-in render/calendar app (retired 2026.11.5): the
// same fields, the same layout arithmetic, the same themes, and text placed
// where pixie's typeset put it, so a converted scene looks as it did.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// The vertical metrics (hhea ascent, descent, line gap, per em) of the fonts a
// frame ships with. They turn a typeset box into the SVG baseline the built-in
// app's text sat on. An uploaded font is measured as Ubuntu, the default face.
const FONT_METRICS = {
  ubuntu: [0.932, -0.189, 0.028],
  ptsans: [1.018, -0.276, 0],
  firago: [0.935, -0.265, 0],
  cormorantgaramond: [0.924, -0.287, 0],
  liberationsans: [1854 / 2048, -434 / 2048, 67 / 2048],
  liberationserif: [1825 / 2048, -443 / 2048, 87 / 2048],
  liberationmono: [1705 / 2048, -615 / 2048, 0],
  cascadiamono: [1900 / 2048, -480 / 2048, 0],
  comicrelief: [2257 / 2048, -597 / 2048, 0],
  galindo: [2014 / 2048, -883 / 2048, 0],
  peralta: [2004 / 2048, -647 / 2048, 0],
}

function metrics(font) {
  const key = String(font || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  for (const family of Object.keys(FONT_METRICS)) {
    if (key.startsWith(family)) return FONT_METRICS[family]
  }
  return FONT_METRICS.ubuntu
}

const THEME_FONTS = {
  weekdayFont: 'Ubuntu-Medium.ttf',
  titleFont: 'Ubuntu-Bold.ttf',
  dateFont: 'Ubuntu-Medium.ttf',
  eventTimeFont: 'Ubuntu-Light.ttf',
  eventTitleFont: 'Ubuntu-Medium.ttf',
  weekdayFontSize: 16,
  titleFontSize: 28,
  dateFontSize: 18,
  eventFontSize: 14,
}

const THEMES = {
  light: {
    ...THEME_FONTS,
    backgroundColor: '#ffffff',
    // The built-in light theme's weekend colour had an alpha of 1/255: it never
    // showed, and light calendars have no weekend shading.
    weekendBackgroundColor: '',
    todayStrokeColor: '#ff0000',
    todayBackgroundColor: '#efbdbd',
    dateTextColor: '#000000',
    eventTimeColor: '#000000',
    eventTitleColor: '#000000',
    titleTextColor: '#000000',
    titleBackgroundColor: '#ffffff',
    weekdayTextColor: '#000000',
    weekdayBackgroundColor: '#f0f0f0',
    gridColor: '#dcdcdc',
    eventColorForeground: ['#000000', '#000000', '#000000', '#000000', '#000000', '#000000', '#000000'],
    eventColorBackground: ['#a6b5f9', '#87f1a2', '#edc48a', '#f8a8a4', '#e6b5ff', '#a0d3f1', '#fff5a0'],
  },
  dark: {
    ...THEME_FONTS,
    backgroundColor: '#222222',
    weekendBackgroundColor: '#2d2d2d',
    todayStrokeColor: '#ff0000',
    todayBackgroundColor: '#2f0101',
    dateTextColor: '#ffffff',
    eventTimeColor: '#ffffff',
    eventTitleColor: '#ffffff',
    titleTextColor: '#ffffff',
    titleBackgroundColor: '#222222',
    weekdayTextColor: '#ffffff',
    weekdayBackgroundColor: '#1e1e1e',
    gridColor: '#282828',
    eventColorForeground: ['#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    eventColorBackground: ['#2459af', '#0f6927', '#94650f', '#881c12', '#7f129e', '#0f6a95', '#748018'],
  },
}

const DEFAULTS = {
  backgroundColor: '#ffffff',
  weekendBackgroundColor: '#9eafd6',
  todayStrokeColor: '#ff0000',
  todayBackgroundColor: '#e5afaf',
  dateTextColor: '#000000',
  eventTimeColor: '#333333',
  eventTitleColor: '#333333',
  titleTextColor: '#000000',
  titleBackgroundColor: '#ffffff',
  weekdayTextColor: '#000000',
  weekdayBackgroundColor: '#ffffff',
  gridColor: '#999999',
  titleFont: '',
  weekdayFont: '',
  dateFont: '',
  eventTitleFont: 'Ubuntu-Medium.ttf',
  eventTimeFont: 'Ubuntu-Light.ttf',
  titleFontSize: 28,
  weekdayFontSize: 16,
  dateFontSize: 18,
  eventFontSize: 14,
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const n = (v) => String(Math.round(v * 1000) / 1000)

// Nim's round: halves away from zero.
const nimRound = (v) => (v < 0 ? -Math.round(-v) : Math.round(v))

const bool = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true'
  return Boolean(v)
}

const number = (v, fallback) => {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return fallback
  const x = Number(v)
  return Number.isFinite(x) ? x : fallback
}

const text = (v, fallback) => (typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v))

function daysInMonth(year, month) {
  switch (month) {
    case 1: case 3: case 5: case 7: case 8: case 10: case 12:
      return 31
    case 4: case 6: case 9: case 11:
      return 30
    case 2:
      return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0) ? 29 : 28
    default:
      return 30
  }
}

// 0 = Sunday. Zeller's congruence, as the built-in app computed it.
function weekday(year, month, day) {
  let m = month
  let y = year
  if (m < 3) {
    m += 12
    y -= 1
  }
  const k = y % 100
  const j = Math.floor(y / 100)
  const h = (day + Math.floor((13 * (m + 1)) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) + 5 * j) % 7
  return (h + 6) % 7
}

// The colours and fonts in force: a theme's, or the node's own for "custom".
function style(c) {
  const theme = THEMES[text(c.theme, 'light')]
  if (theme) return theme
  const out = {}
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = key.endsWith('FontSize') ? number(c[key], DEFAULTS[key]) : text(c[key], DEFAULTS[key])
  }
  // One colour pair per `eventColorCount`, keyed `eventColorBackground[1]`, ….
  const count = Math.trunc(number(c.eventColorCount, 1))
  out.eventColorBackground = []
  out.eventColorForeground = []
  for (let i = 1; i <= count; i++) {
    out.eventColorBackground.push(text(c[`eventColorBackground[${i}]`], '#ffffff'))
    out.eventColorForeground.push(text(c[`eventColorForeground[${i}]`], '#000000'))
  }
  return out
}

function utf8Bytes(s) {
  const bytes = []
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (cp < 0x80) bytes.push(cp)
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63))
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
  }
  return bytes
}

// djb2 over the title's UTF-8 bytes picks its colour pair, so an event keeps
// its colour from render to render and from the built-in app to this one.
function pickColors(st, title) {
  const count = Math.min(st.eventColorBackground.length, st.eventColorForeground.length)
  if (count <= 0) return [st.backgroundColor, st.eventTitleColor]
  let h = 5381
  for (const b of utf8Bytes(title)) h = (Math.imul(h, 33) + b) >>> 0
  const i = h % count
  return [st.eventColorBackground[i], st.eventColorForeground[i]]
}

const looseBool = (v) => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['true', '1', 'yes', 'y'].includes(v.toLowerCase())
  if (typeof v === 'number') return v !== 0
  return false
}

// A date-only start, or one at midnight, is an all-day event.
const looksLikeAllDay = (start) => start.length === 10 || (start.length >= 16 && start.slice(11, 16) === '00:00')

const INT = /^[+-]?\d+$/

function parseYMD(s) {
  if (s.length < 10) return null
  const parts = [s.slice(0, 4), s.slice(5, 7), s.slice(8, 10)]
  if (!parts.every((p) => INT.test(p))) return null
  return parts.map((p) => parseInt(p, 10))
}

const cmpYMD = (a, b) => (a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] !== b[1] ? (a[1] < b[1] ? -1 : 1) : a[2] !== b[2] ? (a[2] < b[2] ? -1 : 1) : 0)

function nextDay([y, m, d]) {
  d += 1
  if (d > daysInMonth(y, m)) {
    d = 1
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return [y, m, d]
}

const pad = (v, width) => (v < 0 ? '-' + String(-v).padStart(width - 1, '0') : String(v).padStart(width, '0'))
const dayKey = ([y, m, d]) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`

// Timed events after the all-day ones, by start time; an unreadable time last.
const UNKNOWN_TIME = 2 ** 52

function minutesOf(start) {
  if (start.length >= 16) {
    const hh = start.slice(11, 13)
    const mm = start.slice(14, 16)
    if (INT.test(hh) && INT.test(mm)) {
      return Math.max(0, Math.min(23, parseInt(hh, 10))) * 60 + Math.max(0, Math.min(59, parseInt(mm, 10)))
    }
  }
  return UNKNOWN_TIME
}

function makeLine(st, showTimes, summary, start, allDay) {
  let display = summary
  if (showTimes && !allDay && start.length >= 16) display = start.slice(11, 16) + ' ' + summary
  const ymd = parseYMD(start)
  const sortKey = allDay ? (ymd ? ymd[0] * 10000 + ymd[1] * 100 + ymd[2] : 0) : 100000000 + minutesOf(start)
  return { display, allDay, colors: pickColors(st, summary), sortKey }
}

function parseEvents(events) {
  if (typeof events === 'string') {
    if (!events.trim()) return []
    try {
      events = JSON.parse(events)
    } catch (e) {
      return []
    }
  }
  return Array.isArray(events) ? events : []
}

const str = (v) => (typeof v === 'string' ? v : '')

// Each event's line under every day it covers ("YYYY-MM-DD" -> lines), sorted,
// with the colour pair an all-day chip is drawn in.
export function groupEvents(events, config = {}) {
  const st = style(config)
  const showTimes = bool(config.showEventTimes, true)
  const byDay = {}
  const add = (key, line) => (byDay[key] = byDay[key] || []).push(line)
  for (const ev of parseEvents(events)) {
    const e = ev && typeof ev === 'object' ? ev : {}
    const summary = str(e.summary)
    const start = str(e.startTime)
    const end = str(e.endTime)
    const allDay = looseBool(e.allDay) || looseBool(e.all_day) || looseBool(e.isAllDay) || looseBool(e.allday) || looksLikeAllDay(start)
    const from = parseYMD(start)
    const until = end.length >= 10 ? parseYMD(end) : null
    if (from && until && (allDay || start.length === 10)) {
      if (cmpYMD(from, until) > 0) {
        add(dayKey(from), makeLine(st, showTimes, summary, start, allDay))
      } else {
        let day = from
        for (let guard = 0; cmpYMD(day, until) <= 0 && guard < 1000; guard++) {
          add(dayKey(day), makeLine(st, showTimes, summary, start, allDay))
          day = nextDay(day)
        }
      }
    } else if (start.length >= 10) {
      add(start.slice(0, 10), makeLine(st, showTimes, summary, start, allDay))
    }
  }
  for (const key of Object.keys(byDay)) {
    byDay[key].sort((a, b) => a.sortKey - b.sortKey || (a.display < b.display ? -1 : a.display > b.display ? 1 : 0))
  }
  return byDay
}

// Cut a line to what fits, guessing a glyph at 55% of the font size.
function truncate(line, fontSize, maxWidth) {
  const chars = Array.from(line)
  const maxChars = Math.max(1, Math.trunc(maxWidth / Math.max(1, fontSize * 0.55)))
  if (chars.length <= maxChars) return line
  if (maxChars <= 1) return '…'
  return chars.slice(0, maxChars - 1).join('') + '…'
}

export function get(app, context) {
  const c = app.config
  const W = Math.round(context.targetWidth || context.imageWidth || 0)
  const H = Math.round(context.targetHeight || context.imageHeight || 0)
  if (!(W > 0 && H > 0)) throw new Error('No canvas to draw on: this app runs on render.')

  const st = style(c)
  const now = new Date(Date.now())
  const year = Math.trunc(number(c.year, 0)) || now.getFullYear()
  const month = Math.trunc(number(c.month, 0)) || now.getMonth() + 1
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1
  const todayDay = now.getDate()
  const s = Math.max(0.01, number(c.scale, 100) / 100)

  if (month < 1 || month > 12) throw new Error(`No month ${month}: use 1 to 12, or 0 for this month.`)
  const startMonday = bool(c.startWeekOnMonday, true)
  const days = daysInMonth(year, month)
  const firstWeekday = weekday(year, month, 1)
  const firstCol = startMonday ? (firstWeekday + 6) % 7 : firstWeekday
  const rows = Math.floor((firstCol + days + 6) / 7)

  const p = Math.max(Math.trunc(number(c.padding, 18)), 0) * s
  const gridStroke = nimRound(Math.max(number(c.gridWidth, 1), 1) * s)
  const contentX = p
  const contentY = p
  const contentW = W - 2 * p
  const contentH = H - 2 * p

  const weekdayHeaderHeight = st.weekdayFontSize * s * 1.5
  const position = text(c.monthYearPosition, 'top').toLowerCase()
  const titleShown = bool(c.showMonthYear, true) && (position === 'top' || position === 'bottom')
  const titleHeight = titleShown ? st.titleFontSize * s * 1.8 : 0
  const topTitle = titleShown && position === 'top' ? titleHeight : 0
  const bottomTitle = titleShown && position === 'bottom' ? titleHeight : 0
  const gridTop = contentY + topTitle + weekdayHeaderHeight
  const gridHeight = contentH - weekdayHeaderHeight - topTitle - bottomTitle
  const cellWidth = contentW / 7
  const cellHeight = gridHeight / rows

  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`]
  // The built-in app drew images of whole pixels at fractional positions.
  const rect = (x, y, w, h, fill) => {
    const ww = Math.trunc(w)
    const hh = Math.trunc(h)
    if (fill && ww > 0 && hh > 0) out.push(`<rect x="${n(x)}" y="${n(y)}" width="${ww}" height="${hh}" fill="${esc(fill)}"/>`)
  }
  const face = (font) => (font ? ` font-family="${esc(font)}"` : '')
  const span = (value, font, size, fill) => ({ value, font, size, fill })
  // One line typeset into a box, its baseline where pixie's typeset put it: the
  // tallest span's ascent below the top, or that line centred in the box.
  const line = (spans, x, top, boxHeight, middle, anchor) => {
    let ascent = 0
    let height = 0
    for (const { font, size } of spans) {
      const [asc, desc, gap] = metrics(font)
      ascent = Math.max(ascent, nimRound((asc + gap / 2) * size))
      height = Math.max(height, nimRound((asc - desc + gap) * size))
    }
    const baseline = top + ascent + (middle ? nimRound((boxHeight - height) / 2) : 0)
    const body = spans
      .map(({ value, font, size, fill }) => `<tspan${face(font)} font-size="${n(size)}" fill="${esc(fill)}">${esc(value)}</tspan>`)
      .join('')
    out.push(`<text x="${n(x)}" y="${n(baseline)}"${anchor ? ' text-anchor="middle"' : ''}>${body}</text>`)
  }

  if (!bool(c.transparentBackground, false)) out.push(`<rect width="${W}" height="${H}" fill="${esc(st.backgroundColor)}"/>`)

  if (titleShown) {
    const ty = topTitle > 0 ? contentY : contentY + contentH - bottomTitle
    rect(contentX, ty, contentW, titleHeight, st.titleBackgroundColor)
    const size = st.titleFontSize * s
    line([span(`${MONTHS[month - 1]} ${year}`, st.titleFont, size, st.titleTextColor)], contentX + contentW / 2, ty, titleHeight, true, true)
  }

  rect(contentX, contentY + topTitle, contentW, weekdayHeaderHeight, st.weekdayBackgroundColor)
  const names = startMonday ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const weekdaySize = st.weekdayFontSize * s
  names.forEach((name, i) => {
    line([span(name, st.weekdayFont, weekdaySize, st.weekdayTextColor)], contentX + i * cellWidth + cellWidth / 2, contentY + topTitle, weekdayHeaderHeight, true, true)
  })

  const cellAt = (day) => {
    const index = firstCol + day - 1
    return [contentX + (index % 7) * cellWidth, gridTop + Math.floor(index / 7) * cellHeight]
  }

  // Shading goes under the grid.
  for (let day = 1; day <= days; day++) {
    const wd = weekday(year, month, day)
    if (wd === 0 || wd === 6) rect(...cellAt(day), cellWidth, cellHeight, st.weekendBackgroundColor)
  }
  if (isCurrentMonth && todayDay <= days) rect(...cellAt(todayDay), cellWidth, cellHeight, st.todayBackgroundColor)

  if (bool(c.showGrid, true)) {
    const stroke = Math.max(1, Math.trunc(gridStroke))
    for (let i = 0; i <= 7; i++) rect(contentX + i * cellWidth, gridTop, stroke, gridHeight, st.gridColor)
    for (let i = 0; i <= rows; i++) rect(contentX, gridTop + i * cellHeight, contentW, stroke, st.gridColor)
  }

  const eventsByDay = groupEvents(c.events, c)
  const dateSize = st.dateFontSize * s
  const eventSize = st.eventFontSize * s
  const lineH = eventSize + 2 * s
  const lineGap = s

  for (let day = 1; day <= days; day++) {
    const [x, y] = cellAt(day)

    if (isCurrentMonth && day === todayDay) {
      const stroke = Math.trunc(Math.max(0, number(c.todayStrokeWidth, 2) * s))
      if (stroke > 0) {
        rect(x, y, cellWidth, stroke, st.todayStrokeColor)
        rect(x, y + cellHeight - stroke, cellWidth, stroke, st.todayStrokeColor)
        rect(x, y, stroke, cellHeight, st.todayStrokeColor)
        rect(x + cellWidth - stroke, y, stroke, cellHeight, st.todayStrokeColor)
      }
    }

    line([span(String(day), st.dateFont, dateSize, st.dateTextColor)], x + 4 * s, y + 3 * s, 0, false, false)

    const lines = eventsByDay[dayKey([year, month, day])]
    if (!lines) continue
    const availableH = cellHeight - dateSize - 9 * s
    const maxLines = Math.max(0, Math.trunc((availableH + lineGap) / (lineH + lineGap)))
    const needMore = lines.length > maxLines && maxLines > 0
    const visible = needMore ? Math.max(0, maxLines - 1) : Math.min(lines.length, maxLines)
    const shown = lines.slice(0, visible).map((ev) => ({
      ...ev,
      display: truncate(ev.display, eventSize, cellWidth - (ev.allDay ? 12 : 6) * s),
    }))
    if (needMore && lines.length - visible > 0) {
      shown.push({ display: `+${lines.length - visible} more`, allDay: false, colors: null })
    }

    const baseY = y + dateSize + 6 * s
    shown.forEach((ev, li) => {
      const yLine = baseY + li * (lineH + lineGap)
      const more = ev.display.startsWith('+')
      const chip = ev.allDay && !more
      if (chip) rect(x + 4 * s, yLine, cellWidth - 8 * s, lineH, ev.colors ? ev.colors[0] : st.backgroundColor)
      const d = ev.display
      let spans
      if (d.length >= 6 && d[2] === ':' && d[5] === ' ') {
        spans = [
          span(d.slice(0, 5) + ' ', st.eventTimeFont, eventSize, st.eventTimeColor),
          span(d.slice(6), st.eventTitleFont, eventSize, st.eventTitleColor),
        ]
      } else if (more) {
        spans = [span(d, st.eventTimeFont, eventSize, st.eventTimeColor)]
      } else {
        spans = [span(d, st.eventTitleFont, eventSize, ev.colors ? ev.colors[1] : st.eventTitleColor)]
      }
      line(spans, x + (chip ? 8 : 4) * s, yLine + (chip ? s : 0), chip ? lineH - 2 * s : lineH, chip, false)
    })
  }

  return frameos.svg(out.join('') + '</svg>', { width: W, height: H })
}
