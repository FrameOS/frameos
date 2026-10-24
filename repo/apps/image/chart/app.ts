const PALETTE = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const num = (v) => {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') return Number(v.trim())
  return NaN
}

const fmt = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(Number(v.toFixed(2))))

const r1 = (v) => Math.round(v * 10) / 10

function parse(data) {
  if (typeof data === 'string') {
    if (!data.trim()) return { series: [], labels: [] }
    try {
      data = JSON.parse(data)
    } catch (e) {
      return { series: [], labels: [] }
    }
  }
  if (Array.isArray(data)) {
    const labels = data.map((item) => (item && typeof item === 'object' ? String(item.label ?? item.name ?? '') : ''))
    const values = data.map((item) =>
      item && typeof item === 'object' ? num('value' in item ? item.value : item.y) : num(item)
    )
    return { series: [{ values }], labels: labels.some(Boolean) ? labels : [] }
  }
  if (!data || typeof data !== 'object') return { series: [], labels: [] }
  const entry = (s) =>
    Array.isArray(s)
      ? { values: s.map(num) }
      : s && typeof s === 'object'
      ? { name: s.name ?? s.label, color: s.color, values: (s.values ?? s.data ?? []).map(num) }
      : { values: [num(s)] }
  const series = Array.isArray(data.series) ? data.series.map(entry) : 'values' in data ? [entry(data)] : []
  const labels = Array.isArray(data.labels) ? data.labels.map((l) => (typeof l === 'number' ? fmt(l) : String(l ?? ''))) : []
  return { series: series.filter((s) => s.values.length), labels }
}

function yRange(series, minY, maxY, includeZero) {
  let lo = Infinity
  let hi = -Infinity
  for (const s of series) {
    for (const v of s.values) {
      if (Number.isFinite(v)) {
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
    }
  }
  if (lo > hi) {
    lo = 0
    hi = 1
  }
  if (includeZero) {
    lo = Math.min(lo, 0)
    hi = Math.max(hi, 0)
  }
  const fixedLo = String(minY ?? '').trim() !== '' && Number.isFinite(Number(minY))
  const fixedHi = String(maxY ?? '').trim() !== '' && Number.isFinite(Number(maxY))
  if (fixedLo) lo = Number(minY)
  if (fixedHi) hi = Number(maxY)
  if (lo > hi) [lo, hi] = [hi, lo]
  if (hi - lo < 1e-9) {
    const pad = Math.max(Math.abs(lo) * 0.1, 1)
    lo -= pad
    hi += pad
  }
  // Grid steps of 1, 2, 2.5 or 5 x 10^n; an automatic end moves out to one.
  const rough = (hi - lo) / 4
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((m) => m >= rough)
  if (!fixedLo) lo = Math.floor(lo / step + 1e-9) * step
  if (!fixedHi) hi = Math.ceil(hi / step - 1e-9) * step
  return [lo, hi, step]
}

export function get(app, context) {
  const c = app.config
  // The size the chart is drawn at: the box it feeds, else the canvas. Both
  // are in scene pixels, already turned with the frame.
  const W = Math.round(context.targetWidth || context.imageWidth || 0)
  const H = Math.round(context.targetHeight || context.imageHeight || 0)
  if (!(W > 0 && H > 0)) throw new Error('No canvas to draw on: this app runs on render.')
  const unit = Math.min(W, H)
  const size = (value, auto) => (Number(value) > 0 ? Number(value) : auto)
  const fontSize = size(c.fontSize, Math.max(10, Math.round(unit / 28)))
  const lineWidth = size(c.lineWidth, Math.max(2, r1(unit / 200)))
  const padding = Number(c.padding) >= 0 && String(c.padding ?? '').trim() !== '' ? Number(c.padding) : Math.round(unit / 30)
  const type = ['line', 'bar', 'area'].includes(c.chartType) ? c.chartType : 'line'
  const ink = c.axisColor || '#333333'
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`]
  if (String(c.transparentBackground) === 'false') {
    out.push(`<rect width="${W}" height="${H}" fill="${esc(c.backgroundColor || '#ffffff')}"/>`)
  }
  const text = (x, y, s, size, anchor, baseline = 'middle') =>
    out.push(
      `<text x="${r1(x)}" y="${r1(y)}" font-size="${r1(size)}" fill="${esc(ink)}" text-anchor="${anchor}" dominant-baseline="${baseline}">${esc(s)}</text>`
    )
  const done = () => frameos.svg(out.join('') + '</svg>', { width: W, height: H })

  const { series, labels } = parse(c.data)
  if (!series.some((s) => s.values.some(Number.isFinite))) {
    text(W / 2, H / 2, 'No chart data', Math.max(8, Math.min(32, unit / 8)), 'middle')
    return done()
  }
  const [lo, hi, step] = yRange(series, c.minY, c.maxY, type !== 'line')
  const levels = []
  for (let v = hi; v >= lo - step * 1e-6 && levels.length < 12; v -= step) levels.push(v)
  const points = series.reduce((most, s) => Math.max(most, s.values.length), 0)
  let plotX = padding
  let plotY = padding
  const plotRight = W - padding
  let plotBottom = H - padding
  if (c.title) {
    text(W / 2, plotY + fontSize * 0.875, c.title, fontSize * 1.25, 'middle')
    plotY += fontSize * 1.75
  }
  const showLabels = String(c.showLabels) !== 'false'
  const gutter = showLabels ? levels.reduce((most, v) => Math.max(most, fmt(v).length), 0) * fontSize * 0.6 + fontSize * 0.4 : 0
  plotX += gutter
  if (showLabels && labels.length) plotBottom -= fontSize * 1.5
  const plotW = plotRight - plotX
  const plotH = plotBottom - plotY
  if (plotW < 8 || plotH < 8) {
    text(W / 2, H / 2, 'Not enough space', Math.max(8, Math.min(32, unit / 8)), 'middle')
    return done()
  }
  const yOf = (v) => plotY + plotH - ((v - lo) / (hi - lo)) * plotH
  const xOf = (i) =>
    type === 'bar' ? plotX + ((i + 0.5) * plotW) / points : points === 1 ? plotX + plotW / 2 : plotX + (plotW * i) / (points - 1)
  const baseY = yOf(Math.min(Math.max(0, lo), hi))

  if (String(c.showGrid) !== 'false') {
    const d = levels.map((v) => `M${r1(plotX)} ${r1(yOf(v))}h${r1(plotW)}`).join('')
    out.push(`<path d="${d}" stroke="${esc(ink)}" stroke-opacity="0.25" stroke-width="1" fill="none"/>`)
  }

  series.forEach((s, si) => {
    const color = esc(s.color || (si === 0 ? c.color || PALETTE[0] : PALETTE[si % PALETTE.length]))
    if (type === 'bar') {
      const d = []
      if (points > plotW) {
        const cols = Math.max(Math.floor(plotW), 1)
        const top = new Array(cols).fill(Infinity)
        const bottom = new Array(cols).fill(-Infinity)
        s.values.forEach((v, i) => {
          if (!Number.isFinite(v)) return
          const col = Math.min(cols - 1, Math.floor((i * cols) / points))
          top[col] = Math.min(top[col], yOf(v), baseY)
          bottom[col] = Math.max(bottom[col], yOf(v), baseY)
        })
        for (let i = 0; i < cols; i++) {
          if (top[i] <= bottom[i]) d.push(`M${r1(plotX + i)} ${r1(top[i])}h1v${r1(Math.max(bottom[i] - top[i], 1))}h-1z`)
        }
      } else {
        const groupW = plotW / points
        const innerW = groupW * 0.8
        const gap = Math.min(2, innerW / (series.length * 4))
        const barW = Math.max(1, (innerW - gap * (series.length - 1)) / series.length)
        s.values.forEach((v, i) => {
          if (!Number.isFinite(v)) return
          const x = plotX + i * groupW + (groupW - innerW) / 2 + si * (barW + gap)
          const y = yOf(v)
          d.push(`M${r1(x)} ${r1(Math.min(y, baseY))}h${r1(barW)}v${r1(Math.max(Math.abs(baseY - y), 1))}h${r1(-barW)}z`)
        })
      }
      out.push(`<path d="${d.join('')}" fill="${color}"/>`)
      return
    }
    for (let i = 0; i < s.values.length; ) {
      if (!Number.isFinite(s.values[i])) {
        i++
        continue
      }
      let end = i
      while (end + 1 < s.values.length && Number.isFinite(s.values[end + 1])) end++
      if (end === i) {
        out.push(`<circle cx="${r1(xOf(i))}" cy="${r1(yOf(s.values[i]))}" r="${r1(Math.max(lineWidth, 2))}" fill="${color}"/>`)
      } else {
        const pts = []
        for (let j = i; j <= end; j++) pts.push(`${r1(xOf(j))} ${r1(yOf(s.values[j]))}`)
        if (type === 'area') {
          const area = `M${r1(xOf(i))} ${r1(baseY)}L${pts.join('L')}L${r1(xOf(end))} ${r1(baseY)}Z`
          out.push(`<path d="${area}" fill="${color}" fill-opacity="0.35"/>`)
        }
        const stroke = `stroke="${color}" stroke-width="${r1(lineWidth)}" stroke-linecap="round" stroke-linejoin="round"`
        out.push(`<path d="M${pts.join('L')}" ${stroke} fill="none"/>`)
      }
      i = end + 1
    }
  })

  out.push(`<path d="M${r1(plotX)} ${r1(plotY)}v${r1(plotH)}h${r1(plotW)}" stroke="${esc(ink)}" stroke-width="1" fill="none"/>`)
  if (showLabels) {
    levels.forEach((v) => text(plotX - fontSize * 0.3, yOf(v), fmt(v), fontSize, 'end'))
    if (labels.length) {
      const widest = labels.reduce((most, l) => Math.max(most, l.length), 0) * fontSize * 0.6 + fontSize * 0.5
      const step = Math.max(1, Math.ceil((points * widest) / plotW))
      for (let i = 0; i < points; i += step) {
        const x = Math.min(Math.max(xOf(i), widest / 2), W - widest / 2)
        if (labels[i]) text(x, plotBottom + fontSize * 0.3, labels[i], fontSize, 'middle', 'hanging')
      }
    }
  }
  return done()
}
