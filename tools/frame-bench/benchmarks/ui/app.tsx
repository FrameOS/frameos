// Frame bench: UI (workload 1). A JSX layout of 48 cards (flex and grid,
// Tailwind classes, text, borders, rounded corners) of the kind a dashboard
// or a desktop draws. One card is picked each render (`n % 48`), so the layout
// and raster run every time; a tap on a card picks it (the tap test).
const W = 1
let n = 0
let picked = -1

export function get(app) {
  n++
  const on = picked >= 0 ? picked : n % 48
  frameos.log({ bench: 'ui', w: W, n })
  const cards = []
  for (let i = 0; i < 48; i++) {
    const sel = i === on
    cards.push(
      <div className={`flex flex-col justify-between rounded-lg border-2 p-1 ${sel ? 'bg-black text-white border-black' : 'bg-white text-black border-gray-400'}`}
        onClick={() => { picked = i }}>
        <span className="text-xs font-bold">{`Card ${i + 1}`}</span>
        <div className="flex flex-row items-center gap-1">
          <div className={`w-3 h-3 rounded-full ${i % 3 === 0 ? 'bg-red-600' : i % 3 === 1 ? 'bg-blue-600' : 'bg-green-600'}`} />
          <span className="text-xs">{`${(i * 37) % 100}%`}</span>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col w-full h-full bg-gray-100 p-2 gap-2">
      <div className="flex flex-row justify-between items-center">
        <span className="text-lg font-bold">Frame bench</span>
        <span className="text-sm">{`render ${n}`}</span>
      </div>
      <div className="grid grid-cols-8 gap-1 flex-1">{cards}</div>
    </div>
  )
}
