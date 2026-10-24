// One weather icon, or the whole set as a sheet, from the Weather icon set app's `icons`.
export function get(app, context) {
  const { icons: set, weathercode, isDay, size, background, sheet, columns } = app.config
  if (!set || !set.icons) throw new Error('weatherIcon: missing icon set, wire it from the Weather icon set app')
  const vb = set.viewBox || 64
  // The size the icon is drawn at: its own field, else the box it feeds, else
  // the canvas. The last two are in scene pixels, already turned with the frame.
  const [w, h] =
    size > 0
      ? [size, size]
      : [context.targetWidth || context.imageWidth || 0, context.targetHeight || context.imageHeight || 0]
  if (!(w > 0 && h > 0)) throw new Error('No canvas to draw on: this app runs on render.')
  const stamp = (x, y, s, icon) =>
    `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})">${icon}</g>`
  let out =
    background && !['none', '#00000000', 'transparent'].includes(('' + background).toLowerCase())
      ? `<rect x="0" y="0" width="${w}" height="${h}" fill="${background}"/>`
      : ''
  if (sheet) {
    const keys = Object.keys(set.icons).sort()
    const cols = Math.max(1, columns || 4)
    const cw = w / cols
    const ch = h / Math.ceil(keys.length / cols)
    const s = (Math.min(cw, ch) / vb) * 0.92
    const [dx, dy] = [(cw - vb * s) / 2, (ch - vb * s) / 2]
    keys.forEach((key, i) => (out += stamp((i % cols) * cw + dx, Math.floor(i / cols) * ch + dy, s, set.icons[key])))
  } else {
    let key = (set.map || {})['' + weathercode] || 'cloudy'
    if (!isDay && set.icons[key + '-night']) key += '-night'
    if (!set.icons[key]) key = 'cloudy'
    const s = (Math.min(w, h) / vb) * 0.96
    out += stamp((w - vb * s) / 2, (h - vb * s) / 2, s, set.icons[key])
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${out}</svg>`
  return frameos.svg(svg, { width: w, height: h })
}
