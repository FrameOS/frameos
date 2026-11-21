#!/usr/bin/env node
// Upload and Download in the Files scene, end to end in the browser preview's
// runtime: the real preview worker (tools/wasm/preview-worker.js) running the
// real bundle, the page played by this script. A tap on Upload sends the page
// a `fileRequest`; the file the page sends back lands in the preview's assets
// folder and the scene lists it and opens it; a tap on Download in the
// picture's bar sends the page that file's bytes (docs/scene-store.md "The
// Files app", frameos/src/frameos/file_transfer_preview.nim).
//
//   frameos/tools/build_wasm.sh --out DIR
//   node frameos/tools/wasm_files_transfer.mjs DIR
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { crc32, deflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const wasmDir = resolve(process.argv[2] ?? join(root, 'frontend', 'public', 'frameos-wasm'))
const WIDTH = 800
const HEIGHT = 480
const WIRE_MAX = 32767

const fail = (message) => {
  console.error(`FAILED: ${message}`)
  process.exit(1)
}

// A solid PNG of one color.
function png([r, g, b], size = 64) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.from([0, ...Array(size).fill([r, g, b]).flat()])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(size).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const { default: createFrameOS } = await import(pathToFileURL(join(wasmDir, 'frameos.js')).href)
const wasmBinary = await readFile(join(wasmDir, 'frameos.wasm'))
const scenes = JSON.parse(await readFile(join(root, 'repo', 'scenes', 'samples', 'Files', 'scenes.json'), 'utf8'))

// The worker, as a script, with the bundle loaded from disk.
let source = await readFile(join(wasmDir, 'preview-worker.js'), 'utf8')
const load = "(await import('./frameos.js')).default"
if (!source.includes(load)) fail('the worker no longer loads frameos.js as this script expects')
source = source.replace(load, '__createFrameOS').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(wasmDir + '/').href))

const posted = []
const problems = []
const context = {
  self: {
    postMessage: (message) => {
      posted.push(message)
      if (message.type === 'error' || (message.type === 'log' && /jsApp:error|scene:error/.test(message.message))) {
        problems.push(message.message)
      }
    },
  },
  // The worker's own clock: a render it schedules minutes away never comes.
  setTimeout: (fn, ms) => (ms ? 0 : setTimeout(fn, 0)),
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  __createFrameOS: (options) => createFrameOS({ ...options, wasmBinary, print: () => {}, printErr: () => {} }),
  URL,
  console,
  TextDecoder,
  TextEncoder,
  XMLHttpRequest: class {},
}
vm.runInNewContext(source, context)
const send = (data) => context.self.onmessage({ data })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(what, check) {
  for (let i = 0; i < 200 && !check(); i++) await tick()
  if (!check()) fail(`${what}: never happened (last messages: ${posted.slice(-4).map((m) => m.type).join(', ')})`)
}
const last = (type) => posted.filter((message) => message.type === type).at(-1)
const frames = () => posted.filter((message) => message.type === 'frame').length
async function tap(x, y) {
  const at = { x: Math.round((x * WIRE_MAX) / (WIDTH - 1)), y: Math.round((y * WIRE_MAX) / (HEIGHT - 1)) }
  const before = frames()
  send({ type: 'event', name: 'pointerDown', payload: { ...at, pointerId: 1, pointerType: 'touch', button: 0, buttons: 1 } })
  send({ type: 'event', name: 'pointerUp', payload: { ...at, pointerId: 1, pointerType: 'touch', button: 0, buttons: 0 } })
  await tick()
  return before
}
let assetRequest = 0
async function assets(op, extra = {}) {
  const requestId = ++assetRequest
  send({ type: 'assets', requestId, op, ...extra })
  await until(`assets ${op}`, () => posted.some((m) => m.type === 'assetsResult' && m.requestId === requestId))
  const answer = posted.find((m) => m.type === 'assetsResult' && m.requestId === requestId)
  if (!answer.ok) fail(`assets ${op}: ${answer.error}`)
  return answer
}
function pixel(x, y) {
  const frame = last('frame')
  const at = (y * frame.width + x) * 4
  return [...new Uint8Array(frame.buffer, at, 3)]
}

send({
  type: 'init',
  width: WIDTH,
  height: HEIGHT,
  scenesJson: JSON.stringify(scenes),
  sceneId: 'asset-browser',
  browserAssets: false,
  fileTransfer: true,
  fastMode: true,
})
await until('ready', () => last('ready'))
if (last('ready').fileTransfer !== true) fail('the bundle did not take fileTransfer')
await until('the first frame', () => frames() > 0)
await assets('write', { path: 'note.txt', data: new TextEncoder().encode('hello').buffer })
send({ type: 'render' })

// Upload, the header's last button.
await tap(750, 30)
await until('the upload request', () => last('fileRequest'))
const upload = last('fileRequest')
if (upload.op !== 'upload' || upload.name !== '') fail(`asked ${JSON.stringify(upload)}`)
console.log('ok: a tap on Upload asks the page for files')

const red = png([220, 30, 30])
const sent = frames()
send({ type: 'fileUpload', id: upload.id, files: [{ name: 'red.png', data: red.buffer.slice(red.byteOffset, red.byteOffset + red.length) }] })
await until('the scene drawn again', () => frames() > sent)
const listing = (await assets('list')).entries.map((entry) => entry.path)
if (!listing.includes('red.png')) fail(`red.png is not in the folder: ${listing.join(', ')}`)
console.log('ok: the file picked is in the folder, and the scene is drawn again')

// The list, then its row for red.png (folders first, then pictures, then the rest).
await tap(527, 30)
await until('the list', () => frames() > sent + 1)
let before = frames()
await tap(200, 60 + 48 * 0 + 24)
await until('the picture open', () => frames() > before)
const [r, g, b] = pixel(WIDTH >> 1, HEIGHT >> 1)
if (!(r > 180 && g < 80 && b < 80)) fail(`the picture open is not the one uploaded: rgb(${r}, ${g}, ${b})`)
console.log('ok: the scene lists the file uploaded and opens it')

// Download, left of the slideshow's button (one picture: right at the edge).
const asked = posted.filter((m) => m.type === 'fileRequest').length
for (let x = 776; x > 600 && posted.filter((m) => m.type === 'fileRequest').length === asked; x -= 12) {
  await tap(x, 28)
}
await until('the download request', () => posted.filter((m) => m.type === 'fileRequest').length > asked)
const download = last('fileRequest')
if (download.op !== 'download' || download.name !== 'red.png') fail(`asked ${JSON.stringify({ ...download, data: undefined })}`)
if (Buffer.compare(Buffer.from(download.data), red) !== 0) fail('the download is not the file')
before = frames()
send({ type: 'fileTransferDone', id: download.id, ok: true })
await until('the scene drawn again', () => frames() > before)
console.log('ok: a tap on Download hands the page the file')

if (problems.length > 0) fail(`the preview reported:\n${problems.slice(0, 5).join('\n')}`)
process.exit(0)
