// Weather icons for WMO codes: { viewBox, palette, map, labels, icons }, each icon a <g> fragment in a 64x64 box.
const map = {}
const labels = {}
for (const line of `0 clear Clear sky
1 mostly-clear Mainly clear
2 partly Partly cloudy
3 overcast Overcast
45 fog Fog
48 fog Icy fog
51 drizzle Light drizzle
53 drizzle Drizzle
55 drizzle Dense drizzle
56 freezing-rain Freezing drizzle
57 freezing-rain Freezing drizzle
61 rain Light rain
63 rain Rain
65 heavy-rain Heavy rain
66 freezing-rain Freezing rain
67 freezing-rain Freezing rain
71 snow Light snow
73 snow Snow
75 heavy-snow Heavy snow
77 snow Snow grains
80 showers Rain showers
81 showers Rain showers
82 heavy-rain Violent showers
85 snow-showers Snow showers
86 snow-showers Snow showers
95 thunder Thunderstorm
96 thunder-hail Storm with hail
99 thunder-hail Storm with hail`.split('\n')) {
  const [code, icon, ...label] = line.split(' ')
  map[code] = icon
  labels[code] = label.join(' ')
}

const CLOUD =
  'M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z'
const VIVID =
  '#FFD54F #F59E0B #FDE9A8 #E8B93C #FDE9A8 #FDFEFF #7C8DA6 #DCE5F0 #93A5BD #C7D2E1 #6C7E98 #38BDF8 #A8D8F0 #FFD54F #F59E0B #9FB0C4'

export function get(app) {
  const { palette: picked, lowContrast, lineWidth, ink, paper } = app.config
  const palette = picked === 'auto' ? (lowContrast ? 'mono' : 'vivid') : picked
  const lw = lineWidth > 0 ? lineWidth : 3
  const colors =
    palette === 'mono'
      ? ['none', ink, 'none', ink, ink, paper, ink, paper, ink, paper, ink, ink, ink, paper, ink, ink]
      : VIVID.split(' ')
  const [sunF, sunS, moonF, moonS, starC, cloudF, cloudS, backF] = colors
  const [backS, darkF, darkS, rainC, snowC, boltF, boltS, fogC] = colors.slice(8)

  const g = (...parts) => '<g>' + parts.join('') + '</g>'
  const each = (xy, draw) => {
    let out = ''
    for (let i = 0; i < xy.length; i += 2) out += draw(xy[i], xy[i + 1])
    return out
  }
  const ln = (x1, y1, x2, y2, color, w) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`
  const path = (d, fill, stroke, w) =>
    `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round"/>`
  const cloud = (x, y, s, fill = cloudF, stroke = cloudS) =>
    `<g transform="translate(${x} ${y}) scale(${s})">${path(CLOUD, fill, stroke, lw / s)}</g>`
  const sun = (cx, cy, r, rays) => {
    let out = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${sunF}" stroke="${sunS}" stroke-width="${lw}"/>`
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8 + Math.PI / 8
      const at = (rr) => [(cx + Math.cos(a) * rr).toFixed(2), (cy + Math.sin(a) * rr).toFixed(2)]
      out += ln(...at(r + rays * 0.55), ...at(r + rays * 1.45), sunS, lw)
    }
    return out
  }
  const moon = (cx, cy, r) => {
    const [t, b, x, i] = [cy - r, cy + r, cx + r * 0.45, r * 0.78].map((v) => v.toFixed(2))
    return path(`M ${x} ${t} A ${r} ${r} 0 1 0 ${x} ${b} A ${i} ${i} 0 0 1 ${x} ${t} Z`, moonF, moonS, lw)
  }
  const star = (x, y, s, w) =>
    `<path d="M ${x} ${y - s} L ${x} ${y + s} M ${x - s} ${y} L ${x + s} ${y}"` +
    ` stroke="${starC}" stroke-width="${w}" stroke-linecap="round"/>`
  const rain = (len, ...xy) => each(xy, (x, y) => ln(x, y, (x - len * 0.3).toFixed(2), (y + len).toFixed(2), rainC, lw))
  const dots = (r, color, ...xy) => each(xy, (x, y) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`)
  const flakes = (s, ...xy) =>
    each(xy, (x, y) => {
      let out = ''
      for (let i = 0; i < 3; i++) {
        const a = (Math.PI * i) / 3 + Math.PI / 6
        const [dx, dy] = [Math.cos(a) * s, Math.sin(a) * s]
        out += ln(...[x - dx, y - dy, x + dx, y + dy].map((v) => v.toFixed(2)), snowC, lw * 0.85)
      }
      return out
    })
  const bolt = (x, y, s) => {
    const pts = [2.5, 0, -2.2, 7, 0.4, 7, -1.6, 12, 3.6, 4.6, 1, 4.6]
    const d = each(pts, (dx, dy) => ` L ${(x + dx * s).toFixed(2)} ${(y + dy * s).toFixed(2)}`)
    return path(d.replace(' L', 'M') + ' Z', boltF, boltS, lw * 0.75)
  }
  const fog = (x1, y, x2) => ln(x1, y, x2, y, fogC, lw)

  const high = cloud(9, 6, 1.9)
  const small = cloud(22, 26, 1.55)
  const shower = cloud(15, 16, 1.65)
  const icons = {
    clear: g(sun(32, 32, 11, 7)),
    'clear-night': g(moon(30, 32, 13), star(47, 16, 3, lw * 0.8), star(52, 30, 2, lw * 0.7)),
    'mostly-clear': g(sun(28, 26, 10, 6), cloud(28, 32, 1.15)),
    'mostly-clear-night': g(moon(27, 26, 11), star(50, 18, 2.5, lw * 0.7), cloud(28, 32, 1.15)),
    partly: g(sun(20, 20, 8.5, 5), small),
    'partly-night': g(moon(20, 19, 9.5), small),
    cloudy: g(cloud(24, 6, 1.15, backF, backS), cloud(7, 16, 1.9)),
    overcast: g(cloud(20, 6, 1.35, backF, backS), cloud(6, 18, 1.95, darkF, darkS)),
    fog: g(cloud(9, 2, 1.75), fog(16, 48, 46), fog(20, 54, 48), fog(24, 60, 48)),
    drizzle: g(high, dots(1.9, rainC, 24, 50, 33, 56, 42, 50, 28, 59, 38, 61)),
    rain: g(high, rain(9, 25, 49, 34, 52, 43, 49)),
    'heavy-rain': g(high, rain(8, 22, 48, 30, 53, 38, 48, 46, 53), rain(6, 28, 44, 40, 58)),
    'freezing-rain': g(high, rain(9, 24, 49, 33, 53), flakes(4.5, 43, 54)),
    snow: g(high, flakes(5, 24, 51, 34, 58, 44, 51)),
    'heavy-snow': g(high, flakes(5, 22, 49, 33, 54, 44, 49), flakes(4, 27, 59, 39, 61)),
    sleet: g(high, rain(8, 25, 49), flakes(4.5, 35, 55), rain(8, 45, 49)),
    showers: g(sun(19, 17, 7.5, 4.5), shower, rain(8, 26, 52, 35, 55, 44, 52)),
    'showers-night': g(moon(19, 16, 8.5), shower, rain(8, 26, 52, 35, 55, 44, 52)),
    'snow-showers': g(sun(19, 17, 7.5, 4.5), shower, flakes(4.5, 26, 54, 38, 57)),
    thunder: g(high, bolt(32, 41, 1.5)),
    'thunder-hail': g(high, bolt(28, 41, 1.4), dots(2.4, snowC, 43, 49, 47, 56)),
  }
  return { viewBox: 64, palette, map, labels, icons }
}
