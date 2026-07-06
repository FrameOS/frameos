// Render one weather icon (or the whole set as a contact sheet) as an image.
// Wire `icons` from the "Weather icon set (JS)" app, which provides the SVG
// fragments plus the WMO code-to-icon map.

function resolveIconKey(iconSet, weathercode, isDay) {
  const map = iconSet && iconSet.map ? iconSet.map : {}
  const icons = iconSet && iconSet.icons ? iconSet.icons : {}
  let key = map['' + weathercode] || 'cloudy'
  if (!isDay && icons[key + '-night']) {
    key = key + '-night'
  }
  if (!icons[key]) {
    key = 'cloudy'
  }
  return key
}

function hasBackground(color) {
  if (!color) {
    return false
  }
  const c = ('' + color).toLowerCase()
  return c !== 'none' && c !== '#00000000' && c !== 'transparent'
}

export function get(app: FrameOSApp, context: FrameOSContext) {
  const iconSet = app.config.icons
  if (!iconSet || !iconSet.icons) {
    app.logError('weatherIcon: missing icon set, wire it from the Weather icon set app')
    return null
  }
  const viewBox = iconSet.viewBox || 64
  const background = app.config.background

  let width = Number(app.config.size) || 0
  let height = width
  if (width <= 0) {
    width = context.imageWidth || app.frame.width
    height = context.imageHeight || app.frame.height
  }

  const parts = []
  if (hasBackground(background)) {
    parts.push('<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="' + background + '"/>')
  }

  if (app.config.sheet === true) {
    const keys = Object.keys(iconSet.icons).sort()
    const columns = Math.max(1, Number(app.config.columns) || 4)
    const rows = Math.ceil(keys.length / columns)
    const cellW = width / columns
    const cellH = height / rows
    const scale = (Math.min(cellW, cellH) / viewBox) * 0.92
    for (let i = 0; i < keys.length; i++) {
      const col = i % columns
      const row = Math.floor(i / columns)
      const x = col * cellW + (cellW - viewBox * scale) / 2
      const y = row * cellH + (cellH - viewBox * scale) / 2
      parts.push(
        '<g transform="translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') scale(' + scale.toFixed(4) + ')">' +
        iconSet.icons[keys[i]] + '</g>'
      )
    }
  } else {
    const key = resolveIconKey(iconSet, Number(app.config.weathercode) || 0, app.config.isDay !== false)
    const scale = (Math.min(width, height) / viewBox) * 0.96
    const x = (width - viewBox * scale) / 2
    const y = (height - viewBox * scale) / 2
    parts.push(
      '<g transform="translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') scale(' + scale.toFixed(4) + ')">' +
      iconSet.icons[key] + '</g>'
    )
  }

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '">' +
    parts.join('') + '</svg>'
  return frameos.svg(svg, { width: width, height: height })
}
