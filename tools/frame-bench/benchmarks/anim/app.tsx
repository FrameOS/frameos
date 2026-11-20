// Frame bench: animation (workload 1), fast panels only. Twelve balls on a
// gradient, moved by the clock at 30 frames a second (`refreshInterval`
// 0.033); the board's `render:animation` summary gives the frame rate.
const W = 1

export function get(app) {
  const t = Date.now() / 1000
  const balls = []
  for (let i = 0; i < 12; i++) {
    const a = t * (0.6 + i * 0.07) + i
    balls.push(<circle cx={400 + Math.cos(a) * (120 + i * 18)} cy={240 + Math.sin(a * 1.3) * (80 + i * 9)} r={18 + (i % 4) * 6}
      fill={['#e11d48', '#2563eb', '#16a34a', '#facc15'][i % 4]} />)
  }
  return (
    <svg viewBox="0 0 800 480" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="800" y2="480">
          <stop offset="0" stop-color="#0f172a" />
          <stop offset="1" stop-color="#334155" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="800" height="480" fill="url(#bg)" />
      {balls}
    </svg>
  )
}
