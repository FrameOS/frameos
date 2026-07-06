// High fidelity weather panel for Open-Meteo data.
//
// Everything is drawn as vector SVG that FrameOS rasterizes with pixie.
// Pixie's SVG subset has no <text> element, so the panel ships a small
// single-stroke vector font (digits, A-Z and a few symbols) and draws all
// text as stroked paths. Icons come in through the `icons` field, produced
// by the "Weather icon set (JS)" app.

// ---------------------------------------------------------------------------
// Vector font: single stroke glyphs in a 14-unit tall box, baseline at y=14.
// Each entry is [advanceWidth, pathData].
// ---------------------------------------------------------------------------

const GLYPHS = {
  '0': [9, 'M4.5 0 Q9 0 9 7 Q9 14 4.5 14 Q0 14 0 7 Q0 0 4.5 0'],
  '1': [9, 'M2.5 2.6 Q5 1.6 6 0 L6 14'],
  '2': [9, 'M0.5 3 Q0.5 0 4.5 0 Q8.5 0 8.5 3 Q8.5 5.5 6 8 L0 14 L9 14'],
  '3': [9, 'M0.8 2.2 Q1.6 0 4.5 0 Q8.2 0 8.2 3.1 Q8.2 6.1 4.4 6.4 Q8.7 6.7 8.7 10.3 Q8.7 14 4.5 14 Q1.2 14 0.4 11.6'],
  '4': [9, 'M6.5 14 L6.5 0 L0 9.5 L9 9.5'],
  '5': [9, 'M8 0 L1.4 0 L0.9 6.1 Q2.2 5.2 4.2 5.2 Q8.7 5.2 8.7 9.5 Q8.7 14 4.4 14 Q1.2 14 0.4 11.8'],
  '6': [9, 'M8 1.6 Q7 0 4.8 0 Q0.4 0 0.4 7.3 Q0.4 14 4.6 14 Q8.7 14 8.7 9.9 Q8.7 6 4.9 6 Q1.3 6 0.4 8.8'],
  '7': [9, 'M0.3 0 L9 0 L3.6 14'],
  '8': [9, 'M4.5 6.4 Q1 6.1 1 3.2 Q1 0 4.5 0 Q8 0 8 3.2 Q8 6.1 4.5 6.4 Q0.4 6.8 0.4 10.4 Q0.4 14 4.5 14 Q8.6 14 8.6 10.4 Q8.6 6.8 4.5 6.4'],
  '9': [9, 'M1 12.4 Q2 14 4.2 14 Q8.6 14 8.6 6.7 Q8.6 0 4.4 0 Q0.3 0 0.3 4.1 Q0.3 8 4.1 8 Q7.7 8 8.6 5.2'],
  'A': [10, 'M0 14 L5 0 L10 14 M1.8 9.2 L8.2 9.2'],
  'B': [9.4, 'M1 0 L1 14 M1 0 L5 0 Q8.4 0 8.4 3.2 Q8.4 6.3 5 6.4 L1 6.4 M5 6.4 Q9 6.5 9 10.2 Q9 14 5 14 L1 14'],
  'C': [9.6, 'M9.2 2.6 Q8 0 5 0 Q0.5 0 0.5 7 Q0.5 14 5 14 Q8 14 9.2 11.4'],
  'D': [9.7, 'M1 0 L1 14 M1 0 L4.4 0 Q9.2 0 9.2 7 Q9.2 14 4.4 14 L1 14'],
  'E': [8.7, 'M8.3 0 L1 0 L1 14 L8.3 14 M1 6.4 L7 6.4'],
  'F': [8.5, 'M8.3 0 L1 0 L1 14 M1 6.4 L7 6.4'],
  'G': [9.7, 'M9.2 2.6 Q8 0 5 0 Q0.5 0 0.5 7 Q0.5 14 5 14 Q9.2 14 9.2 10.4 L9.2 8 L5.4 8'],
  'H': [9.5, 'M1 0 L1 14 M8.5 0 L8.5 14 M1 6.4 L8.5 6.4'],
  'I': [2.6, 'M1.3 0 L1.3 14'],
  'J': [7, 'M6 0 L6 10.6 Q6 14 3.2 14 Q0.7 14 0.4 11'],
  'K': [9.6, 'M1 0 L1 14 M9 0 L1 7.8 M3.8 5.6 L9.5 14'],
  'L': [8, 'M1 0 L1 14 L7.8 14'],
  'M': [11.5, 'M1 14 L1 0 L5.75 9.6 L10.5 0 L10.5 14'],
  'N': [9.5, 'M1 14 L1 0 L8.5 14 L8.5 0'],
  'O': [10.5, 'M5.25 0 Q10 0 10 7 Q10 14 5.25 14 Q0.5 14 0.5 7 Q0.5 0 5.25 0'],
  'P': [9.2, 'M1 14 L1 0 L5.2 0 Q8.8 0 8.8 3.6 Q8.8 7.2 5.2 7.2 L1 7.2'],
  'Q': [10.5, 'M5.25 0 Q10 0 10 7 Q10 14 5.25 14 Q0.5 14 0.5 7 Q0.5 0 5.25 0 M6.4 10.6 L10.3 14.8'],
  'R': [9.5, 'M1 14 L1 0 L5.2 0 Q8.8 0 8.8 3.5 Q8.8 6.9 5.2 6.9 L1 6.9 M5.4 6.9 L9.2 14'],
  'S': [9.2, 'M8.4 2.1 Q7.6 0 4.6 0 Q1 0 1 3.1 Q1 5.6 4.6 6.4 Q8.7 7.3 8.7 10.3 Q8.7 14 4.6 14 Q1.1 14 0.3 11.7'],
  'T': [9, 'M4.5 14 L4.5 0 M0 0 L9 0'],
  'U': [9.5, 'M1 0 L1 9.4 Q1 14 4.75 14 Q8.5 14 8.5 9.4 L8.5 0'],
  'V': [10, 'M0 0 L5 14 L10 0'],
  'W': [13, 'M0.5 0 L3.4 14 L6.5 3.4 L9.6 14 L12.5 0'],
  'X': [9.5, 'M0.4 0 L9.1 14 M9.1 0 L0.4 14'],
  'Y': [10, 'M0 0 L5 7.6 L10 0 M5 7.6 L5 14'],
  'Z': [9, 'M0.5 0 L8.5 0 L0.5 14 L8.5 14'],
  ' ': [5.5, ''],
  '-': [7, 'M1 7.5 L6 7.5'],
  '+': [8, 'M4 3.8 L4 11.2 M0.3 7.5 L7.7 7.5'],
  '.': [3.5, 'M1.05 13.3 Q1.05 12.6 1.75 12.6 Q2.45 12.6 2.45 13.3 Q2.45 14 1.75 14 Q1.05 14 1.05 13.3'],
  ',': [3.5, 'M2.4 12.4 Q2.6 14.6 1.1 16'],
  ':': [3.5, 'M1.05 4.7 Q1.05 4 1.75 4 Q2.45 4 2.45 4.7 Q2.45 5.4 1.75 5.4 Q1.05 5.4 1.05 4.7 M1.05 13.3 Q1.05 12.6 1.75 12.6 Q2.45 12.6 2.45 13.3 Q2.45 14 1.75 14 Q1.05 14 1.05 13.3'],
  '·': [3.8, 'M1.2 7.5 Q1.2 6.8 1.9 6.8 Q2.6 6.8 2.6 7.5 Q2.6 8.2 1.9 8.2 Q1.2 8.2 1.2 7.5'],
  '°': [6.6, 'M3.25 0 Q5.55 0 5.55 2.3 Q5.55 4.6 3.25 4.6 Q0.95 4.6 0.95 2.3 Q0.95 0 3.25 0'],
  '%': [11, 'M2.6 0.6 Q4.6 0.6 4.6 2.7 Q4.6 4.8 2.6 4.8 Q0.6 4.8 0.6 2.7 Q0.6 0.6 2.6 0.6 M10.4 0.5 L0.6 13.5 M8.4 9.2 Q10.4 9.2 10.4 11.3 Q10.4 13.4 8.4 13.4 Q6.4 13.4 6.4 11.3 Q6.4 9.2 8.4 9.2'],
  '/': [7, 'M6.5 0 L0.5 14'],
  "'": [2.6, 'M1.3 0 L1.1 3.6'],
  '(': [4.6, 'M4 -0.5 Q1 3 1 7 Q1 11 4 14.5'],
  ')': [4.6, 'M0.6 -0.5 Q3.6 3 3.6 7 Q3.6 11 0.6 14.5'],
}

const ACCENTS = {
  'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A', 'Æ': 'A',
  'Ç': 'C',
  'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E',
  'Ì': 'I', 'Í': 'I', 'Î': 'I', 'Ï': 'I',
  'Ñ': 'N',
  'Ò': 'O', 'Ó': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O', 'Ø': 'O',
  'Ù': 'U', 'Ú': 'U', 'Û': 'U', 'Ü': 'U',
  'Ý': 'Y', 'Š': 'S', 'Ž': 'Z',
}

const TRACKING = 1.8

function glyphFor(ch) {
  let up = ch.toUpperCase()
  if (ACCENTS[up]) {
    up = ACCENTS[up]
  }
  return GLYPHS[up]
}

function textUnits(str) {
  let units = 0
  for (let i = 0; i < str.length; i++) {
    const g = glyphFor(str.charAt(i))
    if (g) {
      units += g[0] + TRACKING
    }
  }
  return units > 0 ? units - TRACKING : 0
}

function textWidth(str, size) {
  return (textUnits(str) * size) / 14
}

// Shrink `size` until `str` fits in maxWidth.
function fitSize(str, size, maxWidth) {
  const w = textWidth(str, size)
  return w > maxWidth ? (size * maxWidth) / w : size
}

// Draw `str` with the baseline at (x, y). anchor: start | middle | end.
function text(str, x, y, size, color, weight, anchor) {
  const s = size / 14
  let startX = x
  if (anchor === 'middle') {
    startX = x - textWidth(str, size) / 2
  } else if (anchor === 'end') {
    startX = x - textWidth(str, size)
  }
  const sw = (weight / s).toFixed(3)
  const parts = []
  let cx = 0
  for (let i = 0; i < str.length; i++) {
    const g = glyphFor(str.charAt(i))
    if (!g) {
      continue
    }
    if (g[1]) {
      parts.push('<path d="' + g[1] + '" transform="translate(' + cx.toFixed(2) + ' 0)"/>')
    }
    cx += g[0] + TRACKING
  }
  return (
    '<g transform="translate(' + startX.toFixed(2) + ' ' + (y - size).toFixed(2) + ') scale(' + s.toFixed(4) + ')"' +
    ' fill="none" stroke="' + color + '" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round">' +
    parts.join('') + '</g>'
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function hexToRgb(hex) {
  const h = hex.charAt(0) === '#' ? hex.substring(1) : hex
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ]
}

function rgbToHex(r, g, b) {
  const to2 = (v) => {
    const s = Math.round(clamp(v, 0, 255)).toString(16)
    return s.length < 2 ? '0' + s : s
  }
  return '#' + to2(r) + to2(g) + to2(b)
}

function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA)
  const b = hexToRgb(hexB)
  return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
}

// Temperature to color, anchored on celsius; fahrenheit values are converted.
const TEMP_STOPS = [
  [-15, '#7FA9F0'],
  [0, '#7CC4E8'],
  [10, '#8FD0A8'],
  [18, '#F2C94C'],
  [27, '#F2994A'],
  [38, '#EB5757'],
]

function tempColor(value, unit) {
  let c = value
  if (unit && unit.indexOf('F') >= 0) {
    c = ((value - 32) * 5) / 9
  }
  if (c <= TEMP_STOPS[0][0]) {
    return TEMP_STOPS[0][1]
  }
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    if (c <= TEMP_STOPS[i][0]) {
      const t = (c - TEMP_STOPS[i - 1][0]) / (TEMP_STOPS[i][0] - TEMP_STOPS[i - 1][0])
      return mix(TEMP_STOPS[i - 1][1], TEMP_STOPS[i][1], t)
    }
  }
  return TEMP_STOPS[TEMP_STOPS.length - 1][1]
}

function parseIso(iso) {
  // "2026-01-18T22:15" -> parts; no Date object to stay deterministic.
  const datePart = iso.split('T')[0]
  const timePart = iso.split('T')[1] || '00:00'
  const d = datePart.split('-')
  const t = timePart.split(':')
  return {
    y: parseInt(d[0], 10),
    mo: parseInt(d[1], 10),
    d: parseInt(d[2], 10),
    h: parseInt(t[0], 10),
    mi: parseInt(t[1] || '0', 10),
  }
}

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function dayOfWeek(y, mo, d) {
  // Sakamoto's algorithm, 0 = Sunday.
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  let yy = y
  if (mo < 3) {
    yy -= 1
  }
  return (yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) + t[mo - 1] + d) % 7
}

function fmtTemp(v) {
  const r = Math.round(v)
  return (r === 0 ? 0 : r) + '°'
}

function unitLetter(unit) {
  return ('' + (unit || '°C')).indexOf('F') >= 0 ? 'F' : 'C'
}

function fmtPrecip(v) {
  return Math.round(v * 10) / 10 + ''
}

function fmtClock(iso) {
  const p = iso.split('T')
  return p.length > 1 ? p[1] : iso
}

function iconFragment(iconSet, code, isDay, x, y, size) {
  if (!iconSet || !iconSet.icons) {
    return ''
  }
  const map = iconSet.map || {}
  const icons = iconSet.icons
  let key = map['' + code] || 'cloudy'
  if (!isDay && icons[key + '-night']) {
    key = key + '-night'
  }
  if (!icons[key]) {
    key = icons['cloudy'] ? 'cloudy' : ''
  }
  if (!key) {
    return ''
  }
  const vb = iconSet.viewBox || 64
  const s = size / vb
  return '<g transform="translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') scale(' + s.toFixed(4) + ')">' + icons[key] + '</g>'
}

function conditionLabel(iconSet, code) {
  if (iconSet && iconSet.labels && iconSet.labels['' + code]) {
    return iconSet.labels['' + code]
  }
  return 'CODE ' + code
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

function skyFor(code, isDay) {
  if (code >= 95) {
    return ['#252A40', '#4A5578']
  }
  if (code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82) {
    return isDay ? ['#5D7A9C', '#A9BFD6'] : ['#1F2A3F', '#44546F']
  }
  if (code >= 51) {
    return isDay ? ['#3E5C7A', '#7395B0'] : ['#141E2C', '#31445C']
  }
  if (code >= 45) {
    return isDay ? ['#6E7B8A', '#A3AEBA'] : ['#242B34', '#4A545F']
  }
  if (code >= 2) {
    return isDay ? ['#3E6FB0', '#84AED6'] : ['#161E38', '#35426A']
  }
  return isDay ? ['#2E6FD0', '#7FB8EE'] : ['#111834', '#2C3B6E']
}

function themeFor(code, isDay, lowContrast) {
  if (lowContrast) {
    return {
      flat: true,
      bgTop: '#FFFFFF',
      bgBottom: '#FFFFFF',
      text: '#111111',
      sub: '#3D3D3D',
      faint: '#8A8A8A',
      line: '#111111',
      grid: '#C8C8C8',
      rain: '#111111',
      areaFill: 'none',
      barSolid: '#111111',
    }
  }
  const sky = skyFor(code, isDay)
  return {
    flat: false,
    bgTop: sky[0],
    bgBottom: sky[1],
    text: '#FFFFFF',
    sub: 'rgba(255,255,255,0.78)',
    faint: 'rgba(255,255,255,0.45)',
    line: '#FFFFFF',
    grid: 'rgba(255,255,255,0.22)',
    rain: '#9BDCFF',
    areaFill: 'rgba(255,255,255,0.16)',
    barSolid: '',
  }
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

function hourlySeries(forecast, count) {
  const hourly = forecast.hourly || {}
  const times = hourly.time || []
  const cur = forecast.current_weather || {}
  const nowIso = cur.time || (times.length ? times[0] : '')
  let start = 0
  for (let i = 0; i < times.length; i++) {
    if (times[i] >= nowIso.substring(0, 14) + '00') {
      start = i
      break
    }
    if (i === times.length - 1) {
      start = i
    }
  }
  const out = []
  for (let i = start; i < times.length && out.length < count; i++) {
    const p = parseIso(times[i])
    out.push({
      iso: times[i],
      hour: p.h,
      dow: dayOfWeek(p.y, p.mo, p.d),
      temp: (hourly.temperature_2m || [])[i],
      precip: (hourly.precipitation || [])[i] || 0,
      code: (hourly.weathercode || [])[i] || 0,
      wind: (hourly.windspeed_10m || [])[i],
      isDay: hourIsDay(p.h, forecast),
    })
  }
  return out
}

function hourIsDay(hour, forecast) {
  // Approximate day/night per hour from the first day's sunrise/sunset.
  const daily = forecast.daily || {}
  const sunrise = (daily.sunrise || [])[0]
  const sunset = (daily.sunset || [])[0]
  if (!sunrise || !sunset) {
    return hour >= 7 && hour < 20
  }
  const riseH = parseIso(sunrise).h
  const setH = parseIso(sunset).h
  return hour >= riseH && hour <= setH
}

function dailySeries(forecast, count) {
  const daily = forecast.daily || {}
  const times = daily.time || []
  const out = []
  for (let i = 0; i < times.length && out.length < count; i++) {
    const p = parseIso(times[i])
    out.push({
      iso: times[i],
      dow: dayOfWeek(p.y, p.mo, p.d),
      dayNum: p.d,
      min: (daily.temperature_2m_min || [])[i],
      max: (daily.temperature_2m_max || [])[i],
      precip: (daily.precipitation_sum || [])[i] || 0,
      code: (daily.weathercode || [])[i] || 0,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function backgroundSvg(p) {
  if (p.theme.flat) {
    return '<rect x="0" y="0" width="' + p.W + '" height="' + p.H + '" fill="' + p.theme.bgTop + '"/>'
  }
  return (
    '<linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="' + p.H + '">' +
    '<stop offset="0" stop-color="' + p.theme.bgTop + '"/>' +
    '<stop offset="1" stop-color="' + p.theme.bgBottom + '"/>' +
    '</linearGradient>' +
    '<rect x="0" y="0" width="' + p.W + '" height="' + p.H + '" fill="url(#bg)"/>'
  )
}

function headerSvg(p, title) {
  const parts = []
  const size = p.base
  const y = p.pad + size
  if (p.showLocation && p.locationName) {
    parts.push(text(p.locationName, p.pad, y, size, p.theme.text, size * 0.14, 'start'))
    parts.push(text(title, p.W - p.pad, y, size * 0.82, p.theme.sub, size * 0.1, 'end'))
  } else {
    parts.push(text(title, p.pad, y, size * 0.9, p.theme.sub, size * 0.12, 'start'))
  }
  return { svg: parts.join(''), bottom: y + size * 0.6 }
}

function windArrow(x, y, r, deg, color, lw) {
  // Arrow points in the direction the wind blows toward.
  const d = 'M0 ' + (-r).toFixed(2) + ' L' + (r * 0.62).toFixed(2) + ' ' + (r * 0.85).toFixed(2) +
    ' L0 ' + (r * 0.35).toFixed(2) + ' L' + (-r * 0.62).toFixed(2) + ' ' + (r * 0.85).toFixed(2) + ' Z'
  return (
    '<g transform="translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') rotate(' + ((deg + 180) % 360).toFixed(1) + ')">' +
    '<path d="' + d + '" fill="' + color + '" stroke="' + color + '" stroke-width="' + lw +
    '" stroke-linejoin="round"/></g>'
  )
}

// ---------------------------------------------------------------------------
// Current conditions panel
// ---------------------------------------------------------------------------

function renderCurrent(p) {
  const parts = []
  const cur = p.forecast.current_weather || {}
  const units = p.forecast.current_weather_units || {}
  const daily = p.forecast.daily || {}
  const isDay = cur.is_day === 1
  const compact = p.H < 240 || (p.H < 300 && !p.showDetails)

  let top = p.pad
  if (p.showLocation) {
    const dateIso = (cur.time || p.weather.date || '').substring(0, 10)
    let title = ''
    if (dateIso) {
      const dp = parseIso(dateIso)
      title = DAY_NAMES[dayOfWeek(dp.y, dp.mo, dp.d)] + ' ' + dp.d + ' ' + MONTH_NAMES[dp.mo - 1]
    }
    const h = headerSvg(p, title)
    parts.push(h.svg)
    top = h.bottom
  }

  const detailsH = p.showDetails && !compact ? clamp(p.H * 0.2, 54, 92) : 0
  const feelsH = compact ? p.base * 1.4 : p.base * 1.9
  const condH = compact ? p.base * 1.7 : p.base * 2.2

  // Hero: icon + temperature side by side, centered.
  const heroTop = top
  const heroBottom = p.H - p.pad - detailsH - condH - feelsH
  const heroH = Math.max(40, heroBottom - heroTop)
  const iconSize = clamp(Math.min(heroH * 0.94, p.W * 0.4), 34, 300)
  const tempSize = clamp(Math.min(heroH * 0.62, p.W * 0.26), 26, 240)
  const tempStr = fmtTemp(cur.temperature || 0)
  const unitStr = (units.temperature || '°C').indexOf('F') >= 0 ? 'F' : 'C'
  const unitSize = tempSize * 0.3
  const gapHero = iconSize * 0.12
  const tempW = textWidth(tempStr, tempSize)
  const heroW = iconSize + gapHero + tempW + unitSize * 0.75
  const heroX = (p.W - heroW) / 2
  const heroMidY = heroTop + heroH / 2
  parts.push(iconFragment(p.icons, cur.weathercode || 0, isDay, heroX, heroMidY - iconSize / 2, iconSize))
  const tempBase = heroMidY + tempSize * 0.42
  parts.push(text(tempStr, heroX + iconSize + gapHero, tempBase, tempSize, p.theme.text, tempSize * 0.15, 'start'))
  parts.push(
    text(unitStr, heroX + iconSize + gapHero + tempW + unitSize * 0.3, tempBase - tempSize + unitSize, unitSize, p.theme.sub, unitSize * 0.13, 'start')
  )

  // Condition label + feels like / hi-lo line.
  const condY = heroBottom + condH * 0.72
  parts.push(text(conditionLabel(p.icons, cur.weathercode || 0), p.W / 2, condY, condH * 0.5, p.theme.text, condH * 0.07, 'middle'))

  const bits = []
  const apparent = currentApparent(p.forecast)
  if (apparent !== null) {
    bits.push('FEELS ' + fmtTemp(apparent))
  }
  if ((daily.temperature_2m_max || []).length) {
    bits.push('H ' + fmtTemp(daily.temperature_2m_max[0]) + ' L ' + fmtTemp(daily.temperature_2m_min[0]))
  }
  if (bits.length) {
    parts.push(text(bits.join(' · '), p.W / 2, condY + feelsH * 0.7, feelsH * 0.42, p.theme.sub, feelsH * 0.055, 'middle'))
  }

  if (detailsH > 0) {
    parts.push(renderDetailCells(p, cur, units, daily, p.H - p.pad - detailsH, detailsH))
  }
  return parts.join('')
}

function currentApparent(forecast) {
  const hourly = forecast.hourly || {}
  const cur = forecast.current_weather || {}
  const times = hourly.time || []
  const apparent = hourly.apparent_temperature || []
  if (!times.length || !apparent.length || !cur.time) {
    return null
  }
  const key = cur.time.substring(0, 14) + '00'
  for (let i = 0; i < times.length; i++) {
    if (times[i] === key) {
      return apparent[i]
    }
  }
  return null
}

function renderDetailCells(p, cur, units, daily, top, height) {
  const parts = []
  const cells = []
  const windUnit = (units.windspeed || 'km/h').toUpperCase()
  cells.push({
    label: 'WIND',
    value: Math.round(cur.windspeed || 0) + ' ' + windUnit,
    arrow: cur.winddirection,
  })
  const dailyUnits = p.forecast.daily_units || {}
  const precip = (daily.precipitation_sum || [])[0]
  cells.push({
    label: 'PRECIP',
    value: (precip === undefined ? '0' : Math.round(precip * 10) / 10) + ' ' + (dailyUnits.precipitation_sum || 'mm').toUpperCase(),
  })
  const sunrise = (daily.sunrise || [])[0]
  const sunset = (daily.sunset || [])[0]
  if (sunrise) {
    cells.push({ label: 'SUNRISE', value: fmtClock(sunrise) })
  }
  if (sunset) {
    cells.push({ label: 'SUNSET', value: fmtClock(sunset) })
  }

  parts.push(
    '<line x1="' + p.pad + '" y1="' + top.toFixed(2) + '" x2="' + (p.W - p.pad) + '" y2="' + top.toFixed(2) +
    '" stroke="' + p.theme.grid + '" stroke-width="1"/>'
  )

  const n = cells.length
  const cellW = (p.W - p.pad * 2) / n
  const innerW = cellW * 0.86
  const labelBase = clamp(height * 0.16, 7, 12)
  const valueBase = clamp(height * 0.26, 9, 19)
  for (let i = 0; i < n; i++) {
    const cx = p.pad + cellW * (i + 0.5)
    const cell = cells[i]
    const labelSize = fitSize(cell.label, labelBase, innerW)
    parts.push(text(cell.label, cx, top + height * 0.34, labelSize, p.theme.faint, labelSize * 0.13, 'middle'))
    const hasArrow = cell.arrow !== undefined
    const midY = top + height * 0.68
    let valueSize = fitSize(cell.value, valueBase, hasArrow ? innerW - valueBase * 0.9 : innerW)
    const valueW = textWidth(cell.value, valueSize)
    const arrowW = hasArrow ? valueSize * 0.85 : 0
    const groupX = cx - (valueW + arrowW) / 2
    if (hasArrow) {
      parts.push(windArrow(groupX + arrowW * 0.36, midY, valueSize * 0.34, cell.arrow || 0, p.theme.sub, 1))
    }
    parts.push(text(cell.value, groupX + arrowW, midY + valueSize * 0.36, valueSize, p.theme.text, valueSize * 0.12, 'start'))
    if (i > 0) {
      const lx = p.pad + cellW * i
      parts.push(
        '<line x1="' + lx.toFixed(2) + '" y1="' + (top + height * 0.22).toFixed(2) + '" x2="' + lx.toFixed(2) +
        '" y2="' + (top + height * 0.82).toFixed(2) + '" stroke="' + p.theme.grid + '" stroke-width="1"/>'
      )
    }
  }
  return parts.join('')
}

// ---------------------------------------------------------------------------
// Hourly forecast panel
// ---------------------------------------------------------------------------

function renderHourly(p) {
  const availW = p.W - p.pad * 2
  const wanted = clamp(p.hours, 2, 24)
  const horizontalFit = Math.floor(availW / 32)
  if (horizontalFit < Math.min(wanted, 5)) {
    return renderHourlyList(p, wanted)
  }
  return renderHourlyChart(p, Math.min(wanted, horizontalFit))
}

function renderHourlyChart(p, count) {
  const parts = []
  const series = hourlySeries(p.forecast, count)
  if (!series.length) {
    return renderMessage(p, 'NO HOURLY DATA')
  }
  const h = headerSvg(p, 'NEXT ' + series.length + ' HOURS')
  parts.push(h.svg)

  const left = p.pad
  const right = p.W - p.pad
  const availW = right - left
  const colW = availW / series.length

  // The panel has two optional parts: the values row (icons + temperatures)
  // and the graph (temperature curve + precipitation bars).
  const showGraph = p.showGraph
  const showValues = p.showValues || !showGraph

  const timeH = clamp(p.base * 1.5, 14, 26)
  const iconSize = showValues ? clamp(colW * (showGraph ? 0.78 : 0.95), 15, showGraph ? 46 : 64) : 0
  const tempSize = showValues ? clamp(colW * (showGraph ? 0.34 : 0.4), 9, showGraph ? 20 : 24) : 0
  const precipH = showGraph ? clamp(p.H * 0.07, 8, 34) : 0

  // Cap the curve height and center the whole block vertically.
  const availBand = p.H - p.pad - timeH - (h.bottom + p.base * 0.4)
  const valuesH = showValues ? iconSize + tempSize * 1.25 + tempSize * 0.8 : 0
  const fixedH = valuesH + (showGraph ? precipH + 6 : 0)
  const chartH = showGraph ? clamp(availBand - fixedH, 40, p.H * (showValues ? 0.4 : 0.62)) : 0
  const offset = Math.max(0, (availBand - fixedH - chartH) / 2)

  const iconTop = h.bottom + p.base * 0.4 + offset
  const tempY = iconTop + iconSize + tempSize * 1.25
  const chartTop = iconTop + valuesH
  const chartBottom = chartTop + chartH
  const bottom = chartBottom + precipH + (showGraph ? 6 : 0)

  // Temperature curve scale.
  let tMin = series[0].temp
  let tMax = series[0].temp
  let pMax = 0.4
  for (let i = 0; i < series.length; i++) {
    tMin = Math.min(tMin, series[i].temp)
    tMax = Math.max(tMax, series[i].temp)
    pMax = Math.max(pMax, series[i].precip)
  }
  if (tMax - tMin < 2) {
    tMax += 1
    tMin -= 1
  }
  const ys = []
  const xs = []
  for (let i = 0; i < series.length; i++) {
    xs.push(left + colW * (i + 0.5))
    ys.push(chartBottom - ((series[i].temp - tMin) / (tMax - tMin)) * (chartBottom - chartTop))
  }

  // Per-column icons, temps, precipitation bars and time labels. The first
  // temperature and the first precipitation value carry the units.
  const unit = (p.forecast.hourly_units || {}).temperature_2m || '°C'
  const precipUnit = ((p.forecast.hourly_units || {}).precipitation || 'mm').toUpperCase()
  const tempLabels = []
  let fittedTempSize = tempSize
  for (let i = 0; i < series.length; i++) {
    tempLabels.push(fmtTemp(series[i].temp) + (i === 0 ? unitLetter(unit) : ''))
    if (showValues) {
      fittedTempSize = Math.min(fittedTempSize, fitSize(tempLabels[i], tempSize, colW * 0.96))
    }
  }
  const dividerTop = showValues ? iconTop + iconSize * 0.2 : chartTop
  let precipLabeled = false
  for (let i = 0; i < series.length; i++) {
    const cx = xs[i]
    const item = series[i]
    if (showValues) {
      parts.push(iconFragment(p.icons, item.code, item.isDay, cx - iconSize / 2, iconTop, iconSize))
      parts.push(text(tempLabels[i], cx, tempY, fittedTempSize, p.theme.text, fittedTempSize * 0.13, 'middle'))
    }
    if (showGraph && item.precip > 0.05) {
      const bh = Math.max(2.5, (Math.min(item.precip, pMax) / pMax) * precipH)
      const bw = Math.max(3, colW * 0.24)
      const barTop = bottom - 4 - bh
      parts.push(
        '<rect x="' + (cx - bw / 2).toFixed(2) + '" y="' + barTop.toFixed(2) + '" width="' + bw.toFixed(2) +
        '" height="' + bh.toFixed(2) + '" fill="' + p.theme.rain + '"/>'
      )
      const precipSize = clamp(colW * 0.24, 7, 10)
      let precipLabel = fmtPrecip(item.precip)
      if (!precipLabeled && textWidth(precipLabel + ' ' + precipUnit, precipSize) <= colW * 1.5) {
        precipLabel = precipLabel + ' ' + precipUnit
        precipLabeled = true
      }
      parts.push(text(precipLabel, cx, barTop - precipSize * 0.4, precipSize, p.theme.rain, precipSize * 0.13, 'middle'))
    }
    const isMidnight = item.hour === 0
    const label = isMidnight ? DAY_NAMES[item.dow] : '' + item.hour
    const labelSize = clamp(colW * 0.3, 8, 13)
    parts.push(
      text(label, cx, bottom + timeH * 0.75, labelSize, isMidnight ? p.theme.text : p.theme.sub, labelSize * 0.12, 'middle')
    )
    if (isMidnight && i > 0) {
      const lx = left + colW * i
      parts.push(
        '<line x1="' + lx.toFixed(2) + '" y1="' + dividerTop.toFixed(2) + '" x2="' + lx.toFixed(2) +
        '" y2="' + bottom.toFixed(2) + '" stroke="' + p.theme.grid + '" stroke-width="1"/>'
      )
    }
  }

  if (!showGraph) {
    return parts.join('')
  }

  // Smooth temperature curve (Catmull-Rom converted to cubic beziers).
  let d = 'M ' + xs[0].toFixed(2) + ' ' + ys[0].toFixed(2)
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = i > 0 ? xs[i - 1] : xs[i]
    const y0 = i > 0 ? ys[i - 1] : ys[i]
    const x3 = i + 2 < xs.length ? xs[i + 2] : xs[i + 1]
    const y3 = i + 2 < ys.length ? ys[i + 2] : ys[i + 1]
    const c1x = xs[i] + (xs[i + 1] - x0) / 6
    const c1y = ys[i] + (ys[i + 1] - y0) / 6
    const c2x = xs[i + 1] - (x3 - xs[i]) / 6
    const c2y = ys[i + 1] - (y3 - ys[i]) / 6
    d += ' C ' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2) +
      ' ' + xs[i + 1].toFixed(2) + ' ' + ys[i + 1].toFixed(2)
  }
  if (p.theme.areaFill !== 'none') {
    const area = d + ' L ' + xs[xs.length - 1].toFixed(2) + ' ' + chartBottom.toFixed(2) +
      ' L ' + xs[0].toFixed(2) + ' ' + chartBottom.toFixed(2) + ' Z'
    parts.push('<path d="' + area + '" fill="' + p.theme.areaFill + '"/>')
  }
  const curveColor = p.theme.flat ? p.theme.line : tempColor((tMin + tMax) / 2, unit)
  parts.push(
    '<path d="' + d + '" fill="none" stroke="' + curveColor + '" stroke-width="' + clamp(colW * 0.06, 1.5, 3) +
    '" stroke-linecap="round"/>'
  )
  for (let i = 0; i < xs.length; i++) {
    parts.push('<circle cx="' + xs[i].toFixed(2) + '" cy="' + ys[i].toFixed(2) + '" r="' + clamp(colW * 0.07, 1.8, 3.4) + '" fill="' +
      (p.theme.flat ? p.theme.bgTop : curveColor) + '" stroke="' + (p.theme.flat ? p.theme.line : p.theme.text) + '" stroke-width="1.4"/>')
  }
  return parts.join('')
}

function renderHourlyList(p, wanted) {
  const parts = []
  const h = headerSvg(p, 'HOURLY')
  parts.push(h.svg)
  const top = h.bottom + p.base * 0.3
  const availH = p.H - p.pad - top
  const rowH = clamp(availH / wanted, 26, 54)
  const count = Math.max(1, Math.floor(availH / rowH))
  const series = hourlySeries(p.forecast, count)
  if (!series.length) {
    return renderMessage(p, 'NO HOURLY DATA')
  }
  const size = clamp(rowH * 0.42, 9, 20)
  const unit = (p.forecast.hourly_units || {}).temperature_2m || '°C'
  const precipUnit = ((p.forecast.hourly_units || {}).precipitation || 'mm').toUpperCase()
  let precipLabeled = false
  for (let i = 0; i < series.length; i++) {
    const item = series[i]
    const midY = top + rowH * (i + 0.5)
    const baseY = midY + size * 0.36
    const label = item.hour === 0 ? DAY_NAMES[item.dow] : (item.hour < 10 ? '0' : '') + item.hour + ':00'
    parts.push(text(label, p.pad, baseY, size, p.theme.sub, size * 0.12, 'start'))
    parts.push(iconFragment(p.icons, item.code, item.isDay, p.W * 0.36, midY - rowH * 0.42, rowH * 0.84))
    parts.push(
      text(fmtTemp(item.temp) + (i === 0 ? unitLetter(unit) : ''), p.W * 0.66, baseY, size * 1.15, p.theme.text, size * 0.15, 'middle')
    )
    if (item.precip > 0.05) {
      const precipLabel = fmtPrecip(item.precip) + (precipLabeled ? '' : ' ' + precipUnit)
      precipLabeled = true
      parts.push(text(precipLabel, p.W - p.pad, baseY, size * 0.92, p.theme.rain, size * 0.11, 'end'))
    }
    if (i > 0) {
      parts.push(
        '<line x1="' + p.pad + '" y1="' + (top + rowH * i).toFixed(2) + '" x2="' + (p.W - p.pad) +
        '" y2="' + (top + rowH * i).toFixed(2) + '" stroke="' + p.theme.grid + '" stroke-width="1"/>'
      )
    }
  }
  return parts.join('')
}

// ---------------------------------------------------------------------------
// Daily forecast panel
// ---------------------------------------------------------------------------

function renderDaily(p) {
  const parts = []
  const h = headerSvg(p, 'DAILY')
  parts.push(h.svg)
  const top = h.bottom + p.base * 0.3
  const availH = p.H - p.pad - top
  const wanted = clamp(p.days, 1, 16)
  const rowH = clamp(availH / wanted, 26, 72)
  const count = Math.max(1, Math.min(wanted, Math.floor(availH / rowH)))
  const series = dailySeries(p.forecast, count)
  if (!series.length) {
    return renderMessage(p, 'NO DAILY DATA')
  }

  let tMin = series[0].min
  let tMax = series[0].max
  for (let i = 0; i < series.length; i++) {
    tMin = Math.min(tMin, series[i].min)
    tMax = Math.max(tMax, series[i].max)
  }
  if (tMax - tMin < 1) {
    tMax += 1
  }

  const unit = (p.forecast.daily_units || {}).temperature_2m_max || '°C'
  const size = clamp(rowH * 0.34, 9, 21)

  // Measured column budget: day | icon | (precip) | min | bar | max.
  const todayLabel = p.W >= 380 ? 'TODAY' : DAY_NAMES[series[0].dow]
  const dayLabels = series.map((item, i) => (i === 0 ? todayLabel : DAY_NAMES[item.dow]))
  let dayW = 0
  for (let i = 0; i < dayLabels.length; i++) {
    dayW = Math.max(dayW, textWidth(dayLabels[i], size))
  }
  dayW += size * 0.8
  const iconS = clamp(rowH * 0.78, 16, 48)
  const tempW = textWidth('-88°', size) + size * 0.6
  let precipW = p.W >= 430 ? textWidth('88.8', size * 0.88) + size : 0
  let barLeft = p.pad + dayW + iconS + precipW + tempW
  let barRight = p.W - p.pad - tempW
  if (barRight - barLeft < p.W * 0.16) {
    precipW = 0
    barLeft = p.pad + dayW + iconS + tempW
  }
  const scaleX = (t) => barLeft + ((t - tMin) / (tMax - tMin)) * (barRight - barLeft)

  for (let i = 0; i < series.length; i++) {
    const item = series[i]
    const midY = top + rowH * (i + 0.5)
    const baseY = midY + size * 0.36
    parts.push(text(dayLabels[i], p.pad, baseY, size, p.theme.text, size * 0.13, 'start'))
    parts.push(iconFragment(p.icons, item.code, true, p.pad + dayW, midY - iconS / 2, iconS))
    if (precipW > 0 && item.precip > 0.05) {
      parts.push(
        text(Math.round(item.precip * 10) / 10 + '', p.pad + dayW + iconS + precipW * 0.85, baseY, size * 0.88, p.theme.rain, size * 0.1, 'end')
      )
    }
    parts.push(text(fmtTemp(item.min), barLeft - size * 0.7, baseY, size, p.theme.sub, size * 0.12, 'end'))
    parts.push(text(fmtTemp(item.max), barRight + size * 0.7, baseY, size, p.theme.text, size * 0.13, 'start'))

    // Temperature range bar on a shared scale.
    const x1 = scaleX(item.min)
    const x2 = Math.max(scaleX(item.max), x1 + 2)
    const bw = clamp(rowH * 0.18, 4, 10)
    if (p.theme.flat) {
      parts.push(
        '<line x1="' + x1.toFixed(2) + '" y1="' + midY.toFixed(2) + '" x2="' + x2.toFixed(2) + '" y2="' + midY.toFixed(2) +
        '" stroke="' + p.theme.barSolid + '" stroke-width="' + bw + '" stroke-linecap="round"/>'
      )
    } else {
      // Track + gradient bar built from butt-capped segments with round ends.
      parts.push(
        '<line x1="' + barLeft.toFixed(2) + '" y1="' + midY.toFixed(2) + '" x2="' + barRight.toFixed(2) + '" y2="' + midY.toFixed(2) +
        '" stroke="' + p.theme.grid + '" stroke-width="' + bw + '" stroke-linecap="round"/>'
      )
      const segments = 10
      for (let s = 0; s < segments; s++) {
        const t0 = s / segments
        const t1 = (s + 1) / segments
        const temp = item.min + (item.max - item.min) * ((t0 + t1) / 2)
        const sx1 = x1 + (x2 - x1) * t0
        const sx2 = x1 + (x2 - x1) * t1
        const isFirst = s === 0
        const isLast = s === segments - 1
        parts.push(
          '<line x1="' + (isFirst ? sx1 : sx1 - 0.4).toFixed(2) + '" y1="' + midY.toFixed(2) + '" x2="' + sx2.toFixed(2) +
          '" y2="' + midY.toFixed(2) + '" stroke="' + tempColor(temp, unit) + '" stroke-width="' + bw +
          '" stroke-linecap="' + (isFirst || isLast ? 'round' : 'butt') + '"/>'
        )
      }
    }
    if (i > 0) {
      parts.push(
        '<line x1="' + p.pad + '" y1="' + (top + rowH * i).toFixed(2) + '" x2="' + (p.W - p.pad) +
        '" y2="' + (top + rowH * i).toFixed(2) + '" stroke="' + p.theme.grid + '" stroke-width="1"/>'
      )
    }
  }
  return parts.join('')
}

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

function renderMessage(p, message) {
  return text(message, p.W / 2, p.H / 2, clamp(p.W * 0.05, 10, 24), p.theme.sub, 2, 'middle')
}

function renderErrorPanel(W, H, lowContrast, message) {
  const theme = themeFor(3, true, lowContrast)
  const p = { W: W, H: H, theme: theme }
  const parts = [backgroundSvg(p)]
  const size = clamp(Math.min(W, H) * 0.06, 10, 26)
  parts.push(text('WEATHER UNAVAILABLE', W / 2, H / 2 - size * 0.4, size, theme.text, size * 0.13, 'middle'))
  if (message) {
    const sub = ('' + message).substring(0, 60)
    parts.push(text(sub, W / 2, H / 2 + size * 1.4, size * 0.55, theme.sub, size * 0.07, 'middle'))
  }
  return parts.join('')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function get(app: FrameOSApp, context: FrameOSContext) {
  let W = Number(app.config.width) || 0
  let H = Number(app.config.height) || 0
  if (W <= 0) {
    W = context.imageWidth || app.frame.width
  }
  if (H <= 0) {
    H = context.imageHeight || app.frame.height
  }

  const weather = app.config.weather
  const lowContrast = app.config.lowContrast === true
  let body
  if (!weather || weather.error || !weather.forecast) {
    body = renderErrorPanel(W, H, lowContrast, weather ? weather.error : 'no data')
  } else {
    const forecast = weather.forecast
    const cur = forecast.current_weather || {}
    // Kept outside the object literal: the FrameOS TS transpiler misreads
    // `key: value !== x` inside object literals as a type annotation.
    const showLocation = app.config.showLocation !== false
    const showDetails = app.config.showDetails !== false
    const showValues = app.config.showValues !== false
    const showGraph = app.config.showGraph !== false
    const p = {
      W: W,
      H: H,
      pad: clamp(Math.min(W, H) * 0.055, 8, 30),
      base: clamp(Math.min(W, H) * 0.052, 9, 24),
      weather: weather,
      forecast: forecast,
      icons: app.config.icons,
      theme: themeFor(cur.weathercode || 0, cur.is_day === 1, lowContrast),
      hours: Number(app.config.hours) || 10,
      days: Number(app.config.days) || 7,
      showLocation: showLocation,
      showDetails: showDetails,
      showValues: showValues,
      showGraph: showGraph,
      locationName: weather.location && weather.location.name ? weather.location.name : '',
    }
    const mode = app.config.mode || 'current'
    if (mode === 'hourly') {
      body = backgroundSvg(p) + renderHourly(p)
    } else if (mode === 'daily') {
      body = backgroundSvg(p) + renderDaily(p)
    } else {
      body = backgroundSvg(p) + renderCurrent(p)
    }
  }

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + body + '</svg>'
  return frameos.svg(svg, { width: W, height: H })
}
