// Frame bench: raster (workload 1). One fixed SVG drawn over the whole panel:
// 160 translucent circles, 60 stroked curves, 40 rotated rectangles and four
// gradients, the same shapes every render from a fixed seed. The whole picture
// moves by a pixel each render (`n % 4`), so neither the LCD's damage repaint
// nor an e-paper panel's skipped refresh can turn a render into no work.
const W = 1
let n = 0

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const COLORS = ['#000000', '#ffffff', '#e11d48', '#2563eb', '#16a34a', '#facc15', '#f97316', '#7c3aed']

function shapes() {
  const r = rng(20261119)
  const out = []
  for (let i = 0; i < 160; i++) {
    out.push(<circle cx={Math.round(r() * 800)} cy={Math.round(r() * 480)} r={4 + Math.round(r() * 46)}
      fill={COLORS[i % COLORS.length]} fill-opacity="0.6" />)
  }
  for (let i = 0; i < 60; i++) {
    const x = r() * 800, y = r() * 480
    const d = `M${x.toFixed(1)} ${y.toFixed(1)} C${(r() * 800).toFixed(1)} ${(r() * 480).toFixed(1)} ${(r() * 800).toFixed(1)} ${(r() * 480).toFixed(1)} ${(r() * 800).toFixed(1)} ${(r() * 480).toFixed(1)}`
    out.push(<path d={d} fill="none" stroke={COLORS[(i + 3) % COLORS.length]} stroke-width="3" />)
  }
  for (let i = 0; i < 40; i++) {
    const x = Math.round(r() * 760), y = Math.round(r() * 440), a = Math.round(r() * 90)
    out.push(<rect x={x} y={y} width="40" height="24" fill={COLORS[(i + 5) % COLORS.length]} fill-opacity="0.8"
      transform={`rotate(${a} ${x + 20} ${y + 12})`} />)
  }
  return out
}

export function get(app) {
  n++
  frameos.log({ bench: 'raster', w: W, n })
  return (
    <svg viewBox="0 0 800 480" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sky" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="480">
          <stop offset="0" stop-color="#1e3a8a" />
          <stop offset="1" stop-color="#f0abfc" />
        </linearGradient>
        <linearGradient id="band" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="800" y2="0">
          <stop offset="0" stop-color="#facc15" />
          <stop offset="1" stop-color="#16a34a" />
        </linearGradient>
        <radialGradient id="sun" gradientUnits="userSpaceOnUse" cx="620" cy="120" r="80">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="1" stop-color="#f97316" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="800" height="480" fill="url(#sky)" />
      <g transform={`translate(${n % 4} 0)`}>
        <rect x="0" y="330" width="800" height="60" fill="url(#band)" />
        <circle cx="620" cy="120" r="80" fill="url(#sun)" />
        {shapes()}
      </g>
    </svg>
  )
}
