// Weather panel for Open-Meteo data, all vector: pixie's SVG has no <text>, so text is a single-stroke font.
const G = {}
for (const [, k, w, d] of `0 9 M4.5 0 Q9 0 9 7 Q9 14 4.5 14 Q0 14 0 7 Q0 0 4.5 0
1 9 M2.5 2.6 Q5 1.6 6 0 L6 14
2 9 M0.5 3 Q0.5 0 4.5 0 Q8.5 0 8.5 3 Q8.5 5.5 6 8 L0 14 L9 14
3 9 M0.8 2.2 Q1.6 0 4.5 0 Q8.2 0 8.2 3.1 Q8.2 6.1 4.4 6.4 Q8.7 6.7 8.7 10.3 Q8.7 14 4.5 14 Q1.2 14 0.4 11.6
4 9 M6.5 14 L6.5 0 L0 9.5 L9 9.5
5 9 M8 0 L1.4 0 L0.9 6.1 Q2.2 5.2 4.2 5.2 Q8.7 5.2 8.7 9.5 Q8.7 14 4.4 14 Q1.2 14 0.4 11.8
6 9 M8 1.6 Q7 0 4.8 0 Q0.4 0 0.4 7.3 Q0.4 14 4.6 14 Q8.7 14 8.7 9.9 Q8.7 6 4.9 6 Q1.3 6 0.4 8.8
7 9 M0.3 0 L9 0 L3.6 14
8 9 M4.5 6.4 Q1 6.1 1 3.2 Q1 0 4.5 0 Q8 0 8 3.2 Q8 6.1 4.5 6.4 Q0.4 6.8 0.4 10.4 Q0.4 14 4.5 14 Q8.6 14 8.6 10.4 Q8.6 6.8 4.5 6.4
9 9 M1 12.4 Q2 14 4.2 14 Q8.6 14 8.6 6.7 Q8.6 0 4.4 0 Q0.3 0 0.3 4.1 Q0.3 8 4.1 8 Q7.7 8 8.6 5.2
A 10 M0 14 L5 0 L10 14 M1.8 9.2 L8.2 9.2
B 9.4 M1 0 L1 14 M1 0 L5 0 Q8.4 0 8.4 3.2 Q8.4 6.3 5 6.4 L1 6.4 M5 6.4 Q9 6.5 9 10.2 Q9 14 5 14 L1 14
C 9.6 M9.2 2.6 Q8 0 5 0 Q0.5 0 0.5 7 Q0.5 14 5 14 Q8 14 9.2 11.4
D 9.7 M1 0 L1 14 M1 0 L4.4 0 Q9.2 0 9.2 7 Q9.2 14 4.4 14 L1 14
E 8.7 M8.3 0 L1 0 L1 14 L8.3 14 M1 6.4 L7 6.4
F 8.5 M8.3 0 L1 0 L1 14 M1 6.4 L7 6.4
G 9.7 M9.2 2.6 Q8 0 5 0 Q0.5 0 0.5 7 Q0.5 14 5 14 Q9.2 14 9.2 10.4 L9.2 8 L5.4 8
H 9.5 M1 0 L1 14 M8.5 0 L8.5 14 M1 6.4 L8.5 6.4
I 2.6 M1.3 0 L1.3 14
J 7 M6 0 L6 10.6 Q6 14 3.2 14 Q0.7 14 0.4 11
K 9.6 M1 0 L1 14 M9 0 L1 7.8 M3.8 5.6 L9.5 14
L 8 M1 0 L1 14 L7.8 14
M 11.5 M1 14 L1 0 L5.75 9.6 L10.5 0 L10.5 14
N 9.5 M1 14 L1 0 L8.5 14 L8.5 0
O 10.5 M5.25 0 Q10 0 10 7 Q10 14 5.25 14 Q0.5 14 0.5 7 Q0.5 0 5.25 0
P 9.2 M1 14 L1 0 L5.2 0 Q8.8 0 8.8 3.6 Q8.8 7.2 5.2 7.2 L1 7.2
Q 10.5 M5.25 0 Q10 0 10 7 Q10 14 5.25 14 Q0.5 14 0.5 7 Q0.5 0 5.25 0 M6.4 10.6 L10.3 14.8
R 9.5 M1 14 L1 0 L5.2 0 Q8.8 0 8.8 3.5 Q8.8 6.9 5.2 6.9 L1 6.9 M5.4 6.9 L9.2 14
S 9.2 M8.4 2.1 Q7.6 0 4.6 0 Q1 0 1 3.1 Q1 5.6 4.6 6.4 Q8.7 7.3 8.7 10.3 Q8.7 14 4.6 14 Q1.1 14 0.3 11.7
T 9 M4.5 14 L4.5 0 M0 0 L9 0
U 9.5 M1 0 L1 9.4 Q1 14 4.75 14 Q8.5 14 8.5 9.4 L8.5 0
V 10 M0 0 L5 14 L10 0
W 13 M0.5 0 L3.4 14 L6.5 3.4 L9.6 14 L12.5 0
X 9.5 M0.4 0 L9.1 14 M9.1 0 L0.4 14
Y 10 M0 0 L5 7.6 L10 0 M5 7.6 L5 14
Z 9 M0.5 0 L8.5 0 L0.5 14 L8.5 14
  5.5
- 7 M1 7.5 L6 7.5
+ 8 M4 3.8 L4 11.2 M0.3 7.5 L7.7 7.5
. 3.5 M1.05 13.3 Q1.05 12.6 1.75 12.6 Q2.45 12.6 2.45 13.3 Q2.45 14 1.75 14 Q1.05 14 1.05 13.3
, 3.5 M2.4 12.4 Q2.6 14.6 1.1 16
: 3.5 M1.05 4.7 Q1.05 4 1.75 4 Q2.45 4 2.45 4.7 Q2.45 5.4 1.75 5.4 Q1.05 5.4 1.05 4.7 M1.05 13.3 Q1.05 12.6 1.75 12.6 Q2.45 12.6 2.45 13.3 Q2.45 14 1.75 14 Q1.05 14 1.05 13.3
· 3.8 M1.2 7.5 Q1.2 6.8 1.9 6.8 Q2.6 6.8 2.6 7.5 Q2.6 8.2 1.9 8.2 Q1.2 8.2 1.2 7.5
° 6.6 M3.25 0 Q5.55 0 5.55 2.3 Q5.55 4.6 3.25 4.6 Q0.95 4.6 0.95 2.3 Q0.95 0 3.25 0
% 11 M2.6 0.6 Q4.6 0.6 4.6 2.7 Q4.6 4.8 2.6 4.8 Q0.6 4.8 0.6 2.7 Q0.6 0.6 2.6 0.6 M10.4 0.5 L0.6 13.5 M8.4 9.2 Q10.4 9.2 10.4 11.3 Q10.4 13.4 8.4 13.4 Q6.4 13.4 6.4 11.3 Q6.4 9.2 8.4 9.2
/ 7 M6.5 0 L0.5 14
' 2.6 M1.3 0 L1.1 3.6
( 4.6 M4 -0.5 Q1 3 1 7 Q1 11 4 14.5
) 4.6 M0.6 -0.5 Q3.6 3 3.6 7 Q3.6 11 0.6 14.5`.matchAll(/^(.) (\S+) ?(.*)$/gm))
  G[k] = [+w, d]
for (const g of 'AÀÁÂÃÄÅÆ CÇ EÈÉÊË IÌÍÎÏ NÑ OÒÓÔÕÖØ UÙÚÛÜ YÝ SŠ ZŽ'.split(' ')) for (const c of g) G[c] = G[g[0]]

const T = 1.8
const glyphs = (s) => [...s].map((c) => G[c.toUpperCase()]).filter(Boolean)
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const f2 = (v) => v.toFixed(2)
const xy = (x, y) => f2(x) + ' ' + f2(y)
const temp = (v) => Math.round(v) + '°'
const mm = (v) => Math.round(v * 10) / 10 + ''
const letter = (unit) => (unit.includes('F') ? 'F' : 'C')
const DAYS = 'SUN MON TUE WED THU FRI SAT'.split(' ')
const MONTHS = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ')
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()

function parseIso(iso) {
  const [date, time] = iso.split('T')
  const [y, m, d] = date.split('-').map((v) => parseInt(v, 10))
  return [y, m, d, parseInt((time || '00:00').split(':')[0], 10)]
}

function width(s, size) {
  let units = 0
  for (const g of glyphs(s)) units += g[0] + T
  return ((units > 0 ? units - T : 0) * size) / 14
}

const fit = (s, size, max) => {
  const w = width(s, size)
  return w > max ? (size * max) / w : size
}

function text(s, x, y, size, color, weight, anchor) {
  const k = size / 14
  const x0 = anchor === 'middle' ? x - width(s, size) / 2 : anchor === 'end' ? x - width(s, size) : x
  let d = ''
  let cx = 0
  for (const [advance, path] of glyphs(s)) {
    if (path) d += `<path d="${path}" transform="translate(${f2(cx)} 0)"/>`
    cx += advance + T
  }
  return (
    `<g transform="translate(${xy(x0, y - size)}) scale(${k.toFixed(4)})" fill="none" stroke="${color}"` +
    ` stroke-width="${(weight / k).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round">${d}</g>`
  )
}

const line = (x1, y1, x2, y2, stroke, w = 1, cap = '') =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${w}"` +
  (cap && ` stroke-linecap="${cap}"`) +
  '/>'
const hr = (p, y) => line(p.pad, f2(y), p.W - p.pad, f2(y), p.grid)
const vr = (p, x, y1, y2) => line(f2(x), f2(y1), f2(x), f2(y2), p.grid)

const STOP_T = [-15, 0, 10, 18, 27, 38]
const STOP_C = ['7FA9F0', '7CC4E8', '8FD0A8', 'F2C94C', 'F2994A', 'EB5757']
function tempColor(v, unit) {
  const c = unit.includes('F') ? ((v - 32) * 5) / 9 : v
  const i = STOP_T.findIndex((t) => c <= t)
  if (i <= 0) return '#' + STOP_C[i < 0 ? 5 : 0]
  const t = (c - STOP_T[i - 1]) / (STOP_T[i] - STOP_T[i - 1])
  let hex = '#'
  for (let j = 0; j < 6; j += 2) {
    const [a, b] = [STOP_C[i - 1], STOP_C[i]].map((s) => parseInt(s.slice(j, j + 2), 16))
    hex += Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0')
  }
  return hex
}

function icon(set, code, day, x, y, size) {
  const icons = set && set.icons
  if (!icons) return ''
  let key = (set.map || {})['' + code] || 'cloudy'
  if (!day && icons[key + '-night']) key += '-night'
  if (!icons[key]) {
    if (!icons.cloudy) return ''
    key = 'cloudy'
  }
  return `<g transform="translate(${xy(x, y)}) scale(${(size / (set.viewBox || 64)).toFixed(4)})">${icons[key]}</g>`
}

function sky(c, day) {
  if (c >= 95) return ['#252A40', '#4A5578']
  if (c >= 71 && c <= 86 && ![80, 81, 82].includes(c)) return day ? ['#5D7A9C', '#A9BFD6'] : ['#1F2A3F', '#44546F']
  if (c >= 51) return day ? ['#3E5C7A', '#7395B0'] : ['#141E2C', '#31445C']
  if (c >= 45) return day ? ['#6E7B8A', '#A3AEBA'] : ['#242B34', '#4A545F']
  if (c >= 2) return day ? ['#3E6FB0', '#84AED6'] : ['#161E38', '#35426A']
  return day ? ['#2E6FD0', '#7FB8EE'] : ['#111834', '#2C3B6E']
}

function header(p, title) {
  const y = p.pad + p.base
  return p.showLocation && p.name
    ? text(p.name, p.pad, y, p.base, p.ink, p.base * 0.14) +
        text(title, p.W - p.pad, y, p.base * 0.82, p.sub, p.base * 0.1, 'end')
    : text(title, p.pad, y, p.base * 0.9, p.sub, p.base * 0.12)
}

const message = (p, s) => text(s, p.W / 2, p.H / 2, clamp(p.W * 0.05, 10, 24), p.sub, 2, 'middle')

function current(p) {
  const { W, H, pad, base, fc } = p
  const cur = fc.current_weather || {}
  const code = cur.weathercode || 0
  const daily = fc.daily || {}
  const compact = H < 240 || (H < 300 && !p.showDetails)
  let svg = ''
  let top = pad
  if (p.showLocation) {
    const iso = (cur.time || p.date || '').substring(0, 10)
    let title = ''
    if (iso) {
      const [y, m, d] = parseIso(iso)
      title = DAYS[dow(y, m, d)] + ' ' + d + ' ' + MONTHS[m - 1]
    }
    svg += header(p, title)
    top = p.hb
  }
  const detailsH = p.showDetails && !compact ? clamp(H * 0.2, 54, 92) : 0
  const feelsH = compact ? base * 1.4 : base * 1.9
  const condH = compact ? base * 1.7 : base * 2.2

  const heroBottom = H - pad - detailsH - condH - feelsH
  const heroH = Math.max(40, heroBottom - top)
  const iconSize = clamp(Math.min(heroH * 0.94, W * 0.4), 34, 300)
  const tempSize = clamp(Math.min(heroH * 0.62, W * 0.26), 26, 240)
  const tempStr = temp(cur.temperature || 0)
  const unitSize = tempSize * 0.3
  const gap = iconSize * 0.12
  const tempW = width(tempStr, tempSize)
  const heroX = (W - (iconSize + gap + tempW + unitSize * 0.75)) / 2
  const midY = top + heroH / 2
  const tx = heroX + iconSize + gap
  const tempY = midY + tempSize * 0.42
  const unit = letter((fc.current_weather_units || {}).temperature || '°C')
  svg += icon(p.icons, code, cur.is_day === 1, heroX, midY - iconSize / 2, iconSize)
  svg += text(tempStr, tx, tempY, tempSize, p.ink, tempSize * 0.15)
  svg += text(unit, tx + tempW + unitSize * 0.3, tempY - tempSize + unitSize, unitSize, p.sub, unitSize * 0.13)

  const condY = heroBottom + condH * 0.72
  const label = p.icons?.labels?.['' + code] || 'CODE ' + code
  svg += text(label, W / 2, condY, condH * 0.5, p.ink, condH * 0.07, 'middle')
  const bits = []
  const hourly = fc.hourly || {}
  const apparent = hourly.apparent_temperature || []
  const i = cur.time && apparent.length ? (hourly.time || []).indexOf(cur.time.substring(0, 14) + '00') : -1
  if (i >= 0 && apparent[i] !== null) bits.push('FEELS ' + temp(apparent[i]))
  if ((daily.temperature_2m_max || []).length) {
    bits.push('H ' + temp(daily.temperature_2m_max[0]) + ' L ' + temp(daily.temperature_2m_min[0]))
  }
  if (bits.length) {
    svg += text(bits.join(' · '), W / 2, condY + feelsH * 0.7, feelsH * 0.42, p.sub, feelsH * 0.055, 'middle')
  }
  return detailsH > 0 ? svg + details(p, cur, daily, H - pad - detailsH, detailsH) : svg
}

function details(p, cur, daily, top, height) {
  const { W, pad, fc } = p
  const precip = (daily.precipitation_sum || [])[0]
  const wind =
    Math.round(cur.windspeed || 0) + ' ' + ((fc.current_weather_units || {}).windspeed || 'km/h').toUpperCase()
  const rain =
    (precip === undefined ? '0' : mm(precip)) + ' ' + ((fc.daily_units || {}).precipitation_sum || 'mm').toUpperCase()
  const cells = [
    ['WIND', wind, cur.winddirection],
    ['PRECIP', rain],
  ]
  const [rise, set] = [(daily.sunrise || [])[0], (daily.sunset || [])[0]]
  if (rise) cells.push(['SUNRISE', rise.split('T')[1] ?? rise])
  if (set) cells.push(['SUNSET', set.split('T')[1] ?? set])

  let svg = hr(p, top)
  const cellW = (W - pad * 2) / cells.length
  const innerW = cellW * 0.86
  const labelBase = clamp(height * 0.16, 7, 12)
  const valueBase = clamp(height * 0.26, 9, 19)
  const midY = top + height * 0.68
  cells.forEach(([label, value, arrow], i) => {
    const cx = pad + cellW * (i + 0.5)
    const ls = fit(label, labelBase, innerW)
    svg += text(label, cx, top + height * 0.34, ls, p.faint, ls * 0.13, 'middle')
    const hasArrow = arrow !== undefined
    const vs = fit(value, valueBase, hasArrow ? innerW - valueBase * 0.9 : innerW)
    const arrowW = hasArrow ? vs * 0.85 : 0
    const x = cx - (width(value, vs) + arrowW) / 2
    if (hasArrow) {
      const r = vs * 0.34
      const d = `M0 ${f2(-r)} L${xy(r * 0.62, r * 0.85)} L0 ${f2(r * 0.35)} L${xy(-r * 0.62, r * 0.85)} Z`
      svg +=
        `<g transform="translate(${xy(x + arrowW * 0.36, midY)}) rotate(${(((arrow || 0) + 180) % 360).toFixed(1)})">` +
        `<path d="${d}" fill="${p.sub}" stroke="${p.sub}" stroke-width="1" stroke-linejoin="round"/></g>`
    }
    svg += text(value, x + arrowW, midY + vs * 0.36, vs, p.ink, vs * 0.12)
    if (i) svg += vr(p, pad + cellW * i, top + height * 0.22, top + height * 0.82)
  })
  return svg
}

function hours(fc, count) {
  const h = fc.hourly || {}
  const times = h.time || []
  const now = (fc.current_weather || {}).time || (times.length ? times[0] : '')
  let start = times.findIndex((t) => t >= now.substring(0, 14) + '00')
  if (start < 0) start = Math.max(0, times.length - 1)
  const daily = fc.daily || {}
  const [rise, set] = [(daily.sunrise || [])[0], (daily.sunset || [])[0]]
  const out = []
  for (let i = start; i < times.length && out.length < count; i++) {
    const [y, m, d, hour] = parseIso(times[i])
    out.push({
      hour,
      dow: dow(y, m, d),
      temp: (h.temperature_2m || [])[i],
      precip: (h.precipitation || [])[i] || 0,
      code: (h.weathercode || [])[i] || 0,
      isDay: rise && set ? hour >= parseIso(rise)[3] && hour <= parseIso(set)[3] : hour >= 7 && hour < 20,
    })
  }
  return out
}

function hourly(p) {
  const wanted = clamp(p.hours, 2, 24)
  const fits = Math.floor((p.W - p.pad * 2) / 32)
  return fits < Math.min(wanted, 5) ? hourlyList(p, wanted) : hourlyChart(p, Math.min(wanted, fits))
}

function hourlyChart(p, count) {
  const { W, H, pad, base, fc } = p
  const series = hours(fc, count)
  if (!series.length) return message(p, 'NO HOURLY DATA')
  let svg = header(p, 'NEXT ' + series.length + ' HOURS')
  const colW = (W - pad - pad) / series.length
  const graph = p.showGraph
  const values = p.showValues || !graph

  const timeH = clamp(base * 1.5, 14, 26)
  const iconSize = values ? clamp(colW * (graph ? 0.78 : 0.95), 15, graph ? 46 : 64) : 0
  const tempSize = values ? clamp(colW * (graph ? 0.34 : 0.4), 9, graph ? 20 : 24) : 0
  const precipH = graph ? clamp(H * 0.07, 8, 34) : 0
  const band = H - pad - timeH - (p.hb + base * 0.4)
  const valuesH = values ? iconSize + tempSize * 1.25 + tempSize * 0.8 : 0
  const fixedH = valuesH + (graph ? precipH + 6 : 0)
  const chartH = graph ? clamp(band - fixedH, 40, H * (values ? 0.4 : 0.62)) : 0
  const iconTop = p.hb + base * 0.4 + Math.max(0, (band - fixedH - chartH) / 2)
  const chartTop = iconTop + valuesH
  const chartBottom = chartTop + chartH
  const bottom = chartBottom + precipH + (graph ? 6 : 0)

  const temps = series.map((s) => s.temp)
  let tMin = Math.min(...temps)
  let tMax = Math.max(...temps)
  const pMax = Math.max(0.4, ...series.map((s) => s.precip))
  if (tMax - tMin < 2) {
    tMax += 1
    tMin -= 1
  }
  const xs = series.map((_, i) => pad + colW * (i + 0.5))
  const ys = temps.map((t) => chartBottom - ((t - tMin) / (tMax - tMin)) * (chartBottom - chartTop))

  const units = fc.hourly_units || {}
  const unit = units.temperature_2m || '°C'
  const precipUnit = (units.precipitation || 'mm').toUpperCase()
  const labels = temps.map((t, i) => temp(t) + (i ? '' : letter(unit)))
  const ts = Math.min(tempSize, ...labels.map((l) => fit(l, tempSize, colW * 0.96)))
  const dividerTop = values ? iconTop + iconSize * 0.2 : chartTop
  const bw = Math.max(3, colW * 0.24)
  const precipSize = clamp(colW * 0.24, 7, 10)
  const labelSize = clamp(colW * 0.3, 8, 13)
  const timeY = bottom + timeH * 0.75
  let labeled = false
  series.forEach((s, i) => {
    const cx = xs[i]
    if (values) {
      svg += icon(p.icons, s.code, s.isDay, cx - iconSize / 2, iconTop, iconSize)
      svg += text(labels[i], cx, iconTop + iconSize + tempSize * 1.25, ts, p.ink, ts * 0.13, 'middle')
    }
    if (graph && s.precip > 0.05) {
      const bh = Math.max(2.5, (s.precip / pMax) * precipH)
      const barTop = bottom - 4 - bh
      svg += `<rect x="${f2(cx - bw / 2)}" y="${f2(barTop)}" width="${f2(bw)}" height="${f2(bh)}" fill="${p.rain}"/>`
      let label = mm(s.precip)
      if (!labeled && width(label + ' ' + precipUnit, precipSize) <= colW * 1.5) {
        label += ' ' + precipUnit
        labeled = true
      }
      svg += text(label, cx, barTop - precipSize * 0.4, precipSize, p.rain, precipSize * 0.13, 'middle')
    }
    const midnight = s.hour === 0
    const time = midnight ? DAYS[s.dow] : '' + s.hour
    svg += text(time, cx, timeY, labelSize, midnight ? p.ink : p.sub, labelSize * 0.12, 'middle')
    if (midnight && i) svg += vr(p, pad + colW * i, dividerTop, bottom)
  })
  if (!graph) return svg

  let d = 'M ' + xy(xs[0], ys[0])
  for (let i = 0; i < xs.length - 1; i++) {
    const [x0, x1, x2, x3] = [xs[i - 1] ?? xs[i], xs[i], xs[i + 1], xs[i + 2] ?? xs[i + 1]]
    const [y0, y1, y2, y3] = [ys[i - 1] ?? ys[i], ys[i], ys[i + 1], ys[i + 2] ?? ys[i + 1]]
    d += ` C ${xy(x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6)} ${xy(x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6)} ${xy(x2, y2)}`
  }
  if (!p.flat) {
    const area = `${d} L ${xy(xs[xs.length - 1], chartBottom)} L ${xy(xs[0], chartBottom)} Z`
    svg += `<path d="${area}" fill="rgba(255,255,255,0.16)"/>`
  }
  const curve = p.flat ? p.ink : tempColor((tMin + tMax) / 2, unit)
  const lw = clamp(colW * 0.06, 1.5, 3)
  svg += `<path d="${d}" fill="none" stroke="${curve}" stroke-width="${lw}" stroke-linecap="round"/>`
  const r = clamp(colW * 0.07, 1.8, 3.4)
  const fill = p.flat ? p.top : curve
  xs.forEach((x, i) => {
    svg += `<circle cx="${f2(x)}" cy="${f2(ys[i])}" r="${r}" fill="${fill}" stroke="${p.ink}" stroke-width="1.4"/>`
  })
  return svg
}

function hourlyList(p, wanted) {
  const { W, H, pad, base, fc } = p
  const top = p.hb + base * 0.3
  const availH = H - pad - top
  const rowH = clamp(availH / wanted, 26, 54)
  const series = hours(fc, Math.max(1, Math.floor(availH / rowH)))
  if (!series.length) return message(p, 'NO HOURLY DATA')
  let svg = header(p, 'HOURLY')
  const size = clamp(rowH * 0.42, 9, 20)
  const units = fc.hourly_units || {}
  const unit = letter(units.temperature_2m || '°C')
  let precipUnit = ' ' + (units.precipitation || 'mm').toUpperCase()
  series.forEach((s, i) => {
    const midY = top + rowH * (i + 0.5)
    const y = midY + size * 0.36
    svg += text(s.hour === 0 ? DAYS[s.dow] : String(s.hour).padStart(2, '0') + ':00', pad, y, size, p.sub, size * 0.12)
    svg += icon(p.icons, s.code, s.isDay, W * 0.36, midY - rowH * 0.42, rowH * 0.84)
    svg += text(temp(s.temp) + (i ? '' : unit), W * 0.66, y, size * 1.15, p.ink, size * 0.15, 'middle')
    if (s.precip > 0.05) {
      svg += text(mm(s.precip) + precipUnit, W - pad, y, size * 0.92, p.rain, size * 0.11, 'end')
      precipUnit = ''
    }
    if (i) svg += hr(p, top + rowH * i)
  })
  return svg
}

function daily(p) {
  const { W, H, pad, base, fc } = p
  const top = p.hb + base * 0.3
  const availH = H - pad - top
  const wanted = clamp(p.days, 1, 16)
  const rowH = clamp(availH / wanted, 26, 72)
  const count = Math.max(1, Math.min(wanted, Math.floor(availH / rowH)))
  const dd = fc.daily || {}
  const times = dd.time || []
  const series = []
  for (let i = 0; i < times.length && series.length < count; i++) {
    const [y, m, d] = parseIso(times[i])
    series.push({
      dow: dow(y, m, d),
      min: (dd.temperature_2m_min || [])[i],
      max: (dd.temperature_2m_max || [])[i],
      precip: (dd.precipitation_sum || [])[i] || 0,
      code: (dd.weathercode || [])[i] || 0,
    })
  }
  if (!series.length) return message(p, 'NO DAILY DATA')
  let svg = header(p, 'DAILY')
  const tMin = Math.min(...series.map((s) => s.min))
  let tMax = Math.max(...series.map((s) => s.max))
  if (tMax - tMin < 1) tMax += 1

  const unit = (fc.daily_units || {}).temperature_2m_max || '°C'
  const size = clamp(rowH * 0.34, 9, 21)
  const labels = series.map((s, i) => (i || W < 380 ? DAYS[s.dow] : 'TODAY'))
  const dayW = Math.max(0, ...labels.map((l) => width(l, size))) + size * 0.8
  const iconS = clamp(rowH * 0.78, 16, 48)
  const tempW = width('-88°', size) + size * 0.6
  const barRight = W - pad - tempW
  let precipW = W >= 430 ? width('88.8', size * 0.88) + size : 0
  if (barRight - (pad + dayW + iconS + precipW + tempW) < W * 0.16) precipW = 0
  const barLeft = pad + dayW + iconS + precipW + tempW
  const scaleX = (t) => barLeft + ((t - tMin) / (tMax - tMin)) * (barRight - barLeft)
  const bw = clamp(rowH * 0.18, 4, 10)

  series.forEach((s, i) => {
    const midY = top + rowH * (i + 0.5)
    const baseY = midY + size * 0.36
    svg += text(labels[i], pad, baseY, size, p.ink, size * 0.13)
    svg += icon(p.icons, s.code, true, pad + dayW, midY - iconS / 2, iconS)
    if (precipW > 0 && s.precip > 0.05) {
      svg += text(mm(s.precip), pad + dayW + iconS + precipW * 0.85, baseY, size * 0.88, p.rain, size * 0.1, 'end')
    }
    svg += text(temp(s.min), barLeft - size * 0.7, baseY, size, p.sub, size * 0.12, 'end')
    svg += text(temp(s.max), barRight + size * 0.7, baseY, size, p.ink, size * 0.13)
    const x1 = scaleX(s.min)
    const x2 = Math.max(scaleX(s.max), x1 + 2)
    const y = f2(midY)
    if (p.flat) svg += line(f2(x1), y, f2(x2), y, p.ink, bw, 'round')
    else {
      svg += line(f2(barLeft), y, f2(barRight), y, p.grid, bw, 'round')
      for (let k = 0; k < 10; k++) {
        const [t0, t1] = [k / 10, (k + 1) / 10]
        const sx1 = x1 + (x2 - x1) * t0
        const color = tempColor(s.min + (s.max - s.min) * ((t0 + t1) / 2), unit)
        svg += line(f2(k ? sx1 - 0.4 : sx1), y, f2(x1 + (x2 - x1) * t1), y, color, bw, k && k < 9 ? 'butt' : 'round')
      }
    }
    if (i) svg += hr(p, top + rowH * i)
  })
  return svg
}

export function get(app, context) {
  const c = app.config
  const W = c.width > 0 ? c.width : context.imageWidth || app.frame.width
  const H = c.height > 0 ? c.height : context.imageHeight || app.frame.height
  const weather = c.weather
  if (!weather || weather.error || !weather.forecast) {
    throw new Error('Weather unavailable: ' + (weather ? weather.error || 'no forecast' : 'no data'))
  }
  const fc = weather.forecast
  const cur = fc.current_weather || {}
  const pad = clamp(Math.min(W, H) * 0.055, 8, 30)
  const base = clamp(Math.min(W, H) * 0.052, 9, 24)
  const flat = c.lowContrast
  const [ink, sub, faint, grid, rain] = (
    flat
      ? '#111111 #3D3D3D #8A8A8A #C8C8C8 #111111'
      : '#FFFFFF rgba(255,255,255,0.78) rgba(255,255,255,0.45) rgba(255,255,255,0.22) #9BDCFF'
  ).split(' ')
  const [top, bottom] = flat ? ['#FFFFFF'] : sky(cur.weathercode || 0, cur.is_day === 1)
  const p = {
    W,
    H,
    pad,
    base,
    hb: pad + base + base * 0.6,
    fc,
    icons: c.icons,
    date: weather.date,
    name: weather.location?.name || '',
    flat,
    top,
    ink,
    sub,
    faint,
    grid,
    rain,
    hours: c.hours || 10,
    days: c.days || 7,
    showLocation: c.showLocation,
    showDetails: c.showDetails,
    showValues: c.showValues,
    showGraph: c.showGraph,
  }
  const body = c.mode === 'hourly' ? hourly(p) : c.mode === 'daily' ? daily(p) : current(p)
  const bg = flat
    ? ''
    : `<linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}">` +
      `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`
  const rect = `<rect x="0" y="0" width="${W}" height="${H}" fill="${flat ? top : 'url(#bg)'}"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  return frameos.svg(svg + bg + rect + body + '</svg>', { width: W, height: H })
}
