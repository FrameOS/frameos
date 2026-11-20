// Frame bench: baseline (workload 1). The CPU scene's picture and nothing
// else: what every JS-app render costs on this board (the interpreter call,
// the node walk, a full-frame fill). The raster and UI scores subtract it.
export function get(app) {
  frameos.log({ bench: 'base', w: 1 })
  return (
    <svg viewBox="0 0 400 240" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="400" height="240" fill="#ffffff" />
      <rect x="40" y="40" width="120" height="160" fill="#000000" />
      <circle cx="280" cy="120" r="70" fill="#000000" />
    </svg>
  )
}
