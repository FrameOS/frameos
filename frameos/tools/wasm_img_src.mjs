#!/usr/bin/env node
// `<img src="https://…">` in the wasm runtime, where nothing pumps, so the
// render fetches the pictures. A plane's render (a board's picture, a render
// check) gets every one in that render; the browser preview, which shows each
// frame as it comes (frameos_wasm_set_pictures_one_a_render), one a render
// with the next render soon, and no more renders once they are in. Until
// 2026-11-16 the runtime fetched in the render only on e-paper, so an LCD's
// preview never drew a picture (the playground's Scene store showed no
// covers), and the preview took a new render's context for the last one and
// stopped after a few pictures, asking for a render every 50 ms.
//
//   frameos/tools/build_wasm.sh --out DIR
//   node frameos/tools/wasm_img_src.mjs DIR
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const wasmDir = resolve(process.argv[2] ?? join(root, 'frontend', 'public', 'frameos-wasm'))

const CELL = 20
const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]
const WIDTH = CELL * COLORS.length
const HEIGHT = CELL

const fail = (message) => {
  console.error(`FAILED: ${message}`)
  process.exit(1)
}

// A solid 8x8 PNG of one color.
function png([r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(8, 0)
  header.writeUInt32BE(8, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.from([0, ...Array(8).fill([r, g, b]).flat()])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(8).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// The network the runtime's HTTP hook (tools/wasm/frameos_library.js) sees:
// https://img.test/<n>.png is picture n.
let asked = []
globalThis.XMLHttpRequest = class {
  open(method, url) {
    this.url = url
  }
  setRequestHeader() {}
  send() {
    asked.push(this.url)
    const match = /^https:\/\/img\.test\/(\d+)\.png$/.exec(this.url)
    const bytes = match && COLORS[Number(match[1])] ? png(COLORS[Number(match[1])]) : null
    this.status = bytes ? 200 : 404
    this.response = bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) : new ArrayBuffer(0)
  }
}

const source = `export function get() {
  return (
    <div className="flex w-[${WIDTH}px] h-[${HEIGHT}px] bg-black">
${COLORS.map((_, i) => `      <img src="https://img.test/${i}.png" className="w-[${CELL}px] h-[${CELL}px]" />`).join('\n')}
    </div>
  )
}
`
const config = { name: 'Pictures', category: 'data', version: '1.0.0', fields: [], output: [{ name: 'image', type: 'image' }] }
const scene = {
  id: 'img-src',
  name: 'img src',
  settings: { execution: 'interpreted', backgroundColor: '#000000' },
  fields: [],
  apps: { pictures: { ...config, sources: { 'config.json': JSON.stringify(config), 'app.tsx': source } } },
  nodes: [
    { id: 'render', type: 'event', position: { x: 0, y: 0 }, data: { keyword: 'render' } },
    { id: 'app', type: 'app', position: { x: 300, y: -190 }, data: { keyword: 'pictures', config: {} } },
    { id: 'draw', type: 'app', position: { x: 300, y: 0 }, data: { keyword: 'render/image', config: { placement: 'stretch' } } },
  ],
  edges: [
    { id: 'render-draw', type: 'appNodeEdge', source: 'render', target: 'draw', sourceHandle: 'next', targetHandle: 'prev' },
    { id: 'app-draw', type: 'codeNodeEdge', source: 'app', target: 'draw', sourceHandle: 'fieldOutput', targetHandle: 'fieldInput/image' },
  ],
}

const { default: createFrameOS } = await import(pathToFileURL(join(wasmDir, 'frameos.js')).href)
const wasmBinary = await readFile(join(wasmDir, 'frameos.wasm'))
const wanted = COLORS.map((_, i) => `https://img.test/${i}.png`)

// Rendered as the preview worker renders: again as soon as the scene asks.
// Answers how many renders it took.
async function play(label, oneARender) {
  asked = []
  const problems = []
  const Module = await createFrameOS({
    wasmBinary,
    print: () => {},
    printErr: (line) => console.error(`[frameos] ${line}`),
    onFrameosLog: (line) => {
      if (/<img>|jsApp:error|scene:error|failed/.test(line)) problems.push(line)
    },
  })
  const call = (name, ret, types, args) => Module.ccall(name, ret, types, args)
  const lastError = () => call('frameos_wasm_last_error', 'string', [], [])
  if (!call('frameos_wasm_init', 'boolean', ['number', 'number', 'string', 'string', 'string'],
    [WIDTH, HEIGHT, 'img src check', 'UTC', '{}'])) {
    fail(`${label}: init: ${lastError()}`)
  }
  call('frameos_wasm_set_pictures_one_a_render', null, ['boolean'], [oneARender])
  if (call('frameos_wasm_load_scenes', 'number', ['string'], [JSON.stringify([scene])]) < 1) {
    fail(`${label}: load scenes: ${lastError()}`)
  }
  if (!call('frameos_wasm_select_scene', 'boolean', ['string'], [scene.id])) fail(`${label}: select scene`)

  let renders = 0
  let soon = true
  while (soon && renders < 20) {
    const rc = call('frameos_wasm_render', 'number', [], [])
    renders += 1
    if (rc !== 0) fail(`${label}: render ${renders} returned ${rc}: ${lastError()}`)
    const nextSleep = call('frameos_wasm_next_sleep', 'number', [], [])
    soon = (nextSleep >= 0 && nextSleep < 1) || call('frameos_wasm_render_requested', 'boolean', [], [])
  }
  if (soon) fail(`${label}: still asking for renders after ${renders} (asked for ${asked.length} pictures)`)
  if (problems.length > 0) fail(`${label}: the scene reported:\n${problems.slice(0, 5).join('\n')}`)

  const missing = wanted.filter((url) => !asked.includes(url))
  if (missing.length > 0) fail(`${label}: never asked for ${missing.join(', ')} (asked: ${asked.join(', ') || 'nothing'})`)
  if (asked.length !== wanted.length) fail(`${label}: asked ${asked.length} times for ${wanted.length} pictures`)

  const start = call('frameos_wasm_buffer', 'number', [], [])
  const pixels = Module.HEAPU8.slice(start, start + WIDTH * HEIGHT * 4)
  COLORS.forEach(([r, g, b], i) => {
    const at = ((CELL >> 1) * WIDTH + i * CELL + (CELL >> 1)) * 4
    const got = [pixels[at], pixels[at + 1], pixels[at + 2]]
    if (got.some((value, c) => Math.abs(value - [r, g, b][c]) > 8)) {
      fail(`${label}: picture ${i} is not drawn: rgb(${got.join(', ')}) where rgb(${r}, ${g}, ${b}) belongs`)
    }
  })
  console.log(`ok: ${label}: ${wanted.length} pictures fetched and drawn in ${renders} render(s)`)
  return renders
}

if ((await play("a plane's render", false)) !== 1) fail("a plane's render took more than one render")
if ((await play('the browser preview', true)) !== wanted.length) fail('the preview did not take one picture a render')
