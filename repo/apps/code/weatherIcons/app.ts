// Weather icon set for Open-Meteo / WMO weather codes.
// Returns { viewBox, map, labels, icons } where every icon is an SVG <g>
// fragment drawn inside a 64x64 box. Consumers stamp the fragments with
// <g transform="translate(x,y) scale(s)">...</g>.

const WMO_ICON_MAP = {
  '0': 'clear',
  '1': 'mostly-clear',
  '2': 'partly',
  '3': 'overcast',
  '45': 'fog',
  '48': 'fog',
  '51': 'drizzle',
  '53': 'drizzle',
  '55': 'drizzle',
  '56': 'freezing-rain',
  '57': 'freezing-rain',
  '61': 'rain',
  '63': 'rain',
  '65': 'heavy-rain',
  '66': 'freezing-rain',
  '67': 'freezing-rain',
  '71': 'snow',
  '73': 'snow',
  '75': 'heavy-snow',
  '77': 'snow',
  '80': 'showers',
  '81': 'showers',
  '82': 'heavy-rain',
  '85': 'snow-showers',
  '86': 'snow-showers',
  '95': 'thunder',
  '96': 'thunder-hail',
  '99': 'thunder-hail',
}

const WMO_LABELS = {
  '0': 'Clear sky',
  '1': 'Mainly clear',
  '2': 'Partly cloudy',
  '3': 'Overcast',
  '45': 'Fog',
  '48': 'Icy fog',
  '51': 'Light drizzle',
  '53': 'Drizzle',
  '55': 'Dense drizzle',
  '56': 'Freezing drizzle',
  '57': 'Freezing drizzle',
  '61': 'Light rain',
  '63': 'Rain',
  '65': 'Heavy rain',
  '66': 'Freezing rain',
  '67': 'Freezing rain',
  '71': 'Light snow',
  '73': 'Snow',
  '75': 'Heavy snow',
  '77': 'Snow grains',
  '80': 'Rain showers',
  '81': 'Rain showers',
  '82': 'Violent showers',
  '85': 'Snow showers',
  '86': 'Snow showers',
  '95': 'Thunderstorm',
  '96': 'Storm with hail',
  '99': 'Storm with hail',
}

// Material-style cloud outline, drawn in a 24x24 box (spans roughly x 0..24, y 4..20).
const CLOUD_PATH =
  'M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z'

function group(children) {
  return '<g>' + children.join('') + '</g>'
}

function cloud(x, y, scale, fill, stroke, lw) {
  return (
    '<g transform="translate(' + x + ' ' + y + ') scale(' + scale + ')">' +
    '<path d="' + CLOUD_PATH + '" fill="' + fill + '" stroke="' + stroke +
    '" stroke-width="' + (lw / scale) + '" stroke-linejoin="round"/></g>'
  )
}

function sun(cx, cy, r, fill, stroke, lw, rays) {
  const parts = []
  parts.push(
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + fill +
    '" stroke="' + stroke + '" stroke-width="' + lw + '"/>'
  )
  const rayCount = 8
  for (let i = 0; i < rayCount; i++) {
    const a = (Math.PI * 2 * i) / rayCount + Math.PI / 8
    const r1 = r + rays * 0.55
    const r2 = r + rays * 1.45
    const x1 = cx + Math.cos(a) * r1
    const y1 = cy + Math.sin(a) * r1
    const x2 = cx + Math.cos(a) * r2
    const y2 = cy + Math.sin(a) * r2
    parts.push(
      '<line x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) + '" x2="' + x2.toFixed(2) +
      '" y2="' + y2.toFixed(2) + '" stroke="' + stroke + '" stroke-width="' + lw +
      '" stroke-linecap="round"/>'
    )
  }
  return parts.join('')
}

function moon(cx, cy, r, fill, stroke, lw) {
  // Crescent: large outer arc plus a shallower inner return arc.
  const top = (cy - r).toFixed(2)
  const bottom = (cy + r).toFixed(2)
  const x = (cx + r * 0.45).toFixed(2)
  const inner = (r * 0.78).toFixed(2)
  const d =
    'M ' + x + ' ' + top +
    ' A ' + r + ' ' + r + ' 0 1 0 ' + x + ' ' + bottom +
    ' A ' + inner + ' ' + inner + ' 0 0 1 ' + x + ' ' + top + ' Z'
  return (
    '<path d="' + d + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + lw +
    '" stroke-linejoin="round"/>'
  )
}

function star(x, y, s, color, lw) {
  return (
    '<path d="M ' + x + ' ' + (y - s) + ' L ' + x + ' ' + (y + s) +
    ' M ' + (x - s) + ' ' + y + ' L ' + (x + s) + ' ' + y +
    '" stroke="' + color + '" stroke-width="' + lw + '" stroke-linecap="round"/>'
  )
}

function rainLine(x, y, len, color, lw) {
  const x2 = (x - len * 0.3).toFixed(2)
  const y2 = (y + len).toFixed(2)
  return (
    '<line x1="' + x + '" y1="' + y + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color +
    '" stroke-width="' + lw + '" stroke-linecap="round"/>'
  )
}

function dot(x, y, r, color) {
  return '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + color + '"/>'
}

function flake(x, y, s, color, lw) {
  const parts = []
  for (let i = 0; i < 3; i++) {
    const a = (Math.PI * i) / 3 + Math.PI / 6
    const dx = Math.cos(a) * s
    const dy = Math.sin(a) * s
    parts.push(
      '<line x1="' + (x - dx).toFixed(2) + '" y1="' + (y - dy).toFixed(2) +
      '" x2="' + (x + dx).toFixed(2) + '" y2="' + (y + dy).toFixed(2) +
      '" stroke="' + color + '" stroke-width="' + lw + '" stroke-linecap="round"/>'
    )
  }
  return parts.join('')
}

function bolt(x, y, s, fill, stroke, lw) {
  const pts = [
    [x + 2.5 * s, y],
    [x - 2.2 * s, y + 7 * s],
    [x + 0.4 * s, y + 7 * s],
    [x - 1.6 * s, y + 12 * s],
    [x + 3.6 * s, y + 4.6 * s],
    [x + 1 * s, y + 4.6 * s],
  ]
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + ' ' + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ') + ' Z'
  return (
    '<path d="' + d + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + lw +
    '" stroke-linejoin="round"/>'
  )
}

function fogLines(color, lw) {
  const parts = []
  const rows = [
    [16, 48, 46],
    [20, 54, 44],
    [24, 60, 40],
  ]
  for (let i = 0; i < rows.length; i++) {
    const x1 = rows[i][0]
    const y = rows[i][1]
    const x2 = rows[i][0] + rows[i][2] - 16
    parts.push(
      '<line x1="' + x1 + '" y1="' + y + '" x2="' + x2 + '" y2="' + y + '" stroke="' + color +
      '" stroke-width="' + lw + '" stroke-linecap="round"/>'
    )
  }
  return parts.join('')
}

function buildIcons(colors, lw) {
  const c = colors
  const icons = {}

  const mainCloud = cloud(9, 14, 1.9, c.cloudFill, c.cloudStroke, lw)
  const highCloud = cloud(9, 6, 1.9, c.cloudFill, c.cloudStroke, lw)
  const backCloud = cloud(24, 6, 1.15, c.cloudBackFill, c.cloudBackStroke, lw)
  const smallCloud = cloud(22, 26, 1.55, c.cloudFill, c.cloudStroke, lw)
  const sunPeek = sun(20, 20, 8.5, c.sunFill, c.sunStroke, lw, 5)
  const moonPeek = moon(20, 19, 9.5, c.moonFill, c.moonStroke, lw)

  icons['clear'] = group([sun(32, 32, 11, c.sunFill, c.sunStroke, lw, 7)])
  icons['clear-night'] = group([
    moon(30, 32, 13, c.moonFill, c.moonStroke, lw),
    star(47, 16, 3, c.starColor, lw * 0.8),
    star(52, 30, 2, c.starColor, lw * 0.7),
  ])
  icons['mostly-clear'] = group([
    sun(28, 26, 10, c.sunFill, c.sunStroke, lw, 6),
    cloud(28, 32, 1.15, c.cloudFill, c.cloudStroke, lw),
  ])
  icons['mostly-clear-night'] = group([
    moon(27, 26, 11, c.moonFill, c.moonStroke, lw),
    star(50, 18, 2.5, c.starColor, lw * 0.7),
    cloud(28, 32, 1.15, c.cloudFill, c.cloudStroke, lw),
  ])
  icons['partly'] = group([sunPeek, smallCloud])
  icons['partly-night'] = group([moonPeek, smallCloud])
  icons['cloudy'] = group([backCloud, cloud(7, 16, 1.9, c.cloudFill, c.cloudStroke, lw)])
  icons['overcast'] = group([
    cloud(20, 6, 1.35, c.cloudBackFill, c.cloudBackStroke, lw),
    cloud(6, 18, 1.95, c.cloudDarkFill, c.cloudDarkStroke, lw),
  ])
  icons['fog'] = group([cloud(9, 2, 1.75, c.cloudFill, c.cloudStroke, lw), fogLines(c.fogColor, lw)])
  icons['drizzle'] = group([
    highCloud,
    dot(24, 50, 1.9, c.rainColor),
    dot(33, 56, 1.9, c.rainColor),
    dot(42, 50, 1.9, c.rainColor),
    dot(28, 59, 1.9, c.rainColor),
    dot(38, 61, 1.9, c.rainColor),
  ])
  icons['rain'] = group([
    highCloud,
    rainLine(25, 49, 9, c.rainColor, lw),
    rainLine(34, 52, 9, c.rainColor, lw),
    rainLine(43, 49, 9, c.rainColor, lw),
  ])
  icons['heavy-rain'] = group([
    highCloud,
    rainLine(22, 48, 8, c.rainColor, lw),
    rainLine(30, 53, 8, c.rainColor, lw),
    rainLine(38, 48, 8, c.rainColor, lw),
    rainLine(46, 53, 8, c.rainColor, lw),
    rainLine(28, 44, 6, c.rainColor, lw),
    rainLine(40, 58, 6, c.rainColor, lw),
  ])
  icons['freezing-rain'] = group([
    highCloud,
    rainLine(24, 49, 9, c.rainColor, lw),
    rainLine(33, 53, 9, c.rainColor, lw),
    flake(43, 54, 4.5, c.snowColor, lw * 0.85),
  ])
  icons['snow'] = group([
    highCloud,
    flake(24, 51, 5, c.snowColor, lw * 0.85),
    flake(34, 58, 5, c.snowColor, lw * 0.85),
    flake(44, 51, 5, c.snowColor, lw * 0.85),
  ])
  icons['heavy-snow'] = group([
    highCloud,
    flake(22, 49, 5, c.snowColor, lw * 0.85),
    flake(33, 54, 5, c.snowColor, lw * 0.85),
    flake(44, 49, 5, c.snowColor, lw * 0.85),
    flake(27, 59, 4, c.snowColor, lw * 0.85),
    flake(39, 61, 4, c.snowColor, lw * 0.85),
  ])
  icons['sleet'] = group([
    highCloud,
    rainLine(25, 49, 8, c.rainColor, lw),
    flake(35, 55, 4.5, c.snowColor, lw * 0.85),
    rainLine(45, 49, 8, c.rainColor, lw),
  ])
  icons['showers'] = group([
    sun(19, 17, 7.5, c.sunFill, c.sunStroke, lw, 4.5),
    cloud(15, 16, 1.65, c.cloudFill, c.cloudStroke, lw),
    rainLine(26, 52, 8, c.rainColor, lw),
    rainLine(35, 55, 8, c.rainColor, lw),
    rainLine(44, 52, 8, c.rainColor, lw),
  ])
  icons['showers-night'] = group([
    moon(19, 16, 8.5, c.moonFill, c.moonStroke, lw),
    cloud(15, 16, 1.65, c.cloudFill, c.cloudStroke, lw),
    rainLine(26, 52, 8, c.rainColor, lw),
    rainLine(35, 55, 8, c.rainColor, lw),
    rainLine(44, 52, 8, c.rainColor, lw),
  ])
  icons['snow-showers'] = group([
    sun(19, 17, 7.5, c.sunFill, c.sunStroke, lw, 4.5),
    cloud(15, 16, 1.65, c.cloudFill, c.cloudStroke, lw),
    flake(26, 54, 4.5, c.snowColor, lw * 0.85),
    flake(38, 57, 4.5, c.snowColor, lw * 0.85),
  ])
  icons['thunder'] = group([highCloud, bolt(32, 41, 1.5, c.boltFill, c.boltStroke, lw * 0.75)])
  icons['thunder-hail'] = group([
    highCloud,
    bolt(28, 41, 1.4, c.boltFill, c.boltStroke, lw * 0.75),
    dot(43, 49, 2.4, c.snowColor),
    dot(47, 56, 2.4, c.snowColor),
  ])
  return icons
}

export function get(app: FrameOSApp) {
  const lowContrast = app.config.lowContrast === true
  let palette = app.config.palette || 'auto'
  if (palette === 'auto') {
    palette = lowContrast ? 'mono' : 'vivid'
  }
  const lw = Number(app.config.lineWidth) > 0 ? Number(app.config.lineWidth) : 3
  const ink = app.config.ink || '#222222'
  const paper = app.config.paper || '#ffffff'

  let colors
  if (palette === 'mono') {
    colors = {
      sunFill: 'none',
      sunStroke: ink,
      moonFill: 'none',
      moonStroke: ink,
      starColor: ink,
      cloudFill: paper,
      cloudStroke: ink,
      cloudBackFill: paper,
      cloudBackStroke: ink,
      cloudDarkFill: paper,
      cloudDarkStroke: ink,
      rainColor: ink,
      snowColor: ink,
      boltFill: paper,
      boltStroke: ink,
      fogColor: ink,
    }
  } else {
    colors = {
      sunFill: '#FFD54F',
      sunStroke: '#F59E0B',
      moonFill: '#FDE9A8',
      moonStroke: '#E8B93C',
      starColor: '#FDE9A8',
      cloudFill: '#FDFEFF',
      cloudStroke: '#7C8DA6',
      cloudBackFill: '#DCE5F0',
      cloudBackStroke: '#93A5BD',
      cloudDarkFill: '#C7D2E1',
      cloudDarkStroke: '#6C7E98',
      rainColor: '#38BDF8',
      snowColor: '#A8D8F0',
      boltFill: '#FFD54F',
      boltStroke: '#F59E0B',
      fogColor: '#9FB0C4',
    }
  }

  return {
    viewBox: 64,
    palette: palette,
    map: WMO_ICON_MAP,
    labels: WMO_LABELS,
    icons: buildIcons(colors, lw),
  }
}
