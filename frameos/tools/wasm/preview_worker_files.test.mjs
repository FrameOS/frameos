// Upload and Download in the Files scene, the preview worker's half
// (preview-worker.js, frameos/src/frameos/file_transfer_preview.nim): the
// runtime's request goes to the page, the files the page sends back are
// written into the folder the runtime named (never one the page names), and
// the answer goes back into the runtime. The worker runs here against a fake
// emscripten module with an in-memory file system.
//
//   node --test tools/wasm/preview_worker_files.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const DIR = 1
const FILE = 2

// Just enough of emscripten's FS for the worker's asset folder.
function fakeFs() {
  const nodes = new Map([['/', { mode: DIR }]])
  const parent = (path) => path.slice(0, path.lastIndexOf('/')) || '/'
  const fail = (code) => {
    const error = new Error(code)
    error.code = code
    throw error
  }
  return {
    nodes,
    mkdir(path) {
      if (nodes.has(path)) fail('EEXIST')
      if (!nodes.has(parent(path))) fail('ENOENT')
      nodes.set(path, { mode: DIR, mtime: new Date(1) })
    },
    readdir(path) {
      if (nodes.get(path)?.mode !== DIR) fail('ENOTDIR')
      const names = ['.', '..']
      for (const key of nodes.keys()) {
        if (key !== path && parent(key) === path) names.push(key.slice(key.lastIndexOf('/') + 1))
      }
      return names
    },
    stat(path) {
      const node = nodes.get(path)
      if (!node) fail('ENOENT')
      return { mode: node.mode, size: node.data ? node.data.length : 0, mtime: node.mtime }
    },
    isDir: (mode) => mode === DIR,
    isFile: (mode) => mode === FILE,
    writeFile(path, bytes) {
      if (nodes.get(parent(path))?.mode !== DIR) fail('ENOENT')
      nodes.set(path, { mode: FILE, data: Uint8Array.from(bytes), mtime: new Date(2) })
    },
    readFile(path) {
      const node = nodes.get(path)
      if (node?.mode !== FILE) fail('ENOENT')
      return node.data
    },
    unlink: (path) => nodes.delete(path),
    rmdir: (path) => nodes.delete(path),
    mount() {},
    syncfs(_populate, done) {
      done(null)
    },
  }
}

// The worker, evaluated as a script with the fake runtime in place of
// `import('./frameos.js')`.
async function startWorker() {
  let source = readFileSync(new URL('./preview-worker.js', import.meta.url), 'utf8')
  const load = "(await import('./frameos.js')).default"
  assert.ok(source.includes(load), 'the worker loads frameos.js as it did')
  source = source.replace(load, '__createFrameOS').replaceAll('import.meta.url', "'http://test/'")

  const FS = fakeFs()
  FS.nodes.set('/srv', { mode: DIR })
  FS.nodes.set('/srv/assets', { mode: DIR })
  FS.nodes.set('/srv/assets/photos', { mode: DIR })
  FS.nodes.set('/srv/assets/photos/beach.jpg', { mode: FILE, data: new Uint8Array([1, 2, 3]) })
  const posted = []
  const answers = []
  let requests = 0
  const module = {
    FS,
    _frameos_wasm_set_file_transfer() {},
    _frameos_wasm_file_transfer_done() {},
    ccall(name, _ret, _types, args) {
      switch (name) {
        case 'frameos_wasm_init':
          return true
        case 'frameos_wasm_load_scenes':
          return 1
        case 'frameos_wasm_scene_info':
          return '{"currentSceneId":"asset-browser","scenes":[]}'
        case 'frameos_wasm_scene_state':
          return '{}'
        case 'frameos_wasm_set_file_transfer':
          module.fileTransfer = args[0]
          return null
        case 'frameos_wasm_event': {
          // The scene's tap: the Files app asks, as file_transfer_preview.nim does.
          const payload = JSON.parse(args[1])
          if (args[0] === 'ask') {
            requests += 1
            module.onFrameosFileRequest(JSON.stringify({ id: requests, op: payload.op, path: payload.path }))
          }
          return true
        }
        case 'frameos_wasm_file_transfer_done':
          answers.push([...args])
          return true
        default:
          return null
      }
    },
  }
  const context = {
    self: { postMessage: (message) => posted.push(message) },
    // A render's next one is minutes away: never scheduled here.
    setTimeout: (fn, ms) => (ms ? 0 : setTimeout(fn, 0)),
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    __createFrameOS: async (options) => Object.assign(module, options),
    URL,
    console,
  }
  vm.runInNewContext(source, context)
  const send = (data) => context.self.onmessage({ data })
  send({ type: 'init', width: 800, height: 480, scenesJson: '[]', fileTransfer: true, browserAssets: false })
  const until = async (check) => {
    for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(check(), 'the worker got there')
  }
  await until(() => posted.some((message) => message.type === 'ready'))
  return { FS, posted, answers, module, send, until }
}

test('the page that answers file requests turns them on, and ready says so', async () => {
  const { posted, module } = await startWorker()
  assert.equal(module.fileTransfer, true)
  assert.equal(posted.find((message) => message.type === 'ready').fileTransfer, true)
})

test('an upload asks the page, and writes what comes back into the folder the runtime named', async () => {
  const { FS, posted, answers, send, until } = await startWorker()
  send({ type: 'event', name: 'ask', payload: { op: 'upload', path: '/srv/assets/photos' } })
  await until(() => posted.some((message) => message.type === 'fileRequest'))
  const request = posted.find((message) => message.type === 'fileRequest')
  assert.deepEqual({ ...request }, { type: 'fileRequest', id: 1, op: 'upload', name: 'photos' })
  const bytes = (values) => new Uint8Array(values).buffer
  send({
    type: 'fileUpload',
    id: 1,
    files: [
      { name: 'beach.jpg', data: bytes([9, 9]) },
      { name: '../../etc/notes.txt', data: bytes([7]) },
      { name: '.hidden.png', data: bytes([5]) },
    ],
  })
  await until(() => answers.length === 1)
  assert.deepEqual(answers[0], [1, true, 3, ''])
  // The one there is kept; the new one takes the next name. Folders and a dot
  // first are no part of a name.
  assert.deepEqual([...FS.readFile('/srv/assets/photos/beach.jpg')], [1, 2, 3])
  assert.deepEqual([...FS.readFile('/srv/assets/photos/beach (2).jpg')], [9, 9])
  assert.deepEqual([...FS.readFile('/srv/assets/photos/notes.txt')], [7])
  assert.deepEqual([...FS.readFile('/srv/assets/photos/hidden.png')], [5])
  assert.ok(posted.some((message) => message.type === 'assetsChanged'))
  // Answered once: the same id again writes nothing.
  send({ type: 'fileUpload', id: 1, files: [{ name: 'again.txt', data: bytes([1]) }] })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(FS.nodes.has('/srv/assets/photos/again.txt'), false)
  assert.equal(answers.length, 1)
})

test('a picker closed with nothing is cancelled, and a page never names the folder', async () => {
  const { FS, posted, answers, send, until } = await startWorker()
  send({ type: 'event', name: 'ask', payload: { op: 'upload', path: '/srv/assets' } })
  await until(() => posted.some((message) => message.type === 'fileRequest'))
  send({ type: 'fileUpload', id: 1, path: '/srv/elsewhere', files: [] })
  await until(() => answers.length === 1)
  assert.deepEqual(answers[0], [1, false, 0, 'cancelled'])
  assert.equal(FS.nodes.has('/srv/elsewhere'), false)
})

test('a download hands the page the file, and the page says it is saved', async () => {
  const { posted, answers, send, until } = await startWorker()
  send({ type: 'event', name: 'ask', payload: { op: 'download', path: '/srv/assets/photos/beach.jpg' } })
  await until(() => posted.some((message) => message.type === 'fileRequest'))
  const request = posted.find((message) => message.type === 'fileRequest')
  assert.equal(request.op, 'download')
  assert.equal(request.name, 'beach.jpg')
  assert.deepEqual([...new Uint8Array(request.data)], [1, 2, 3])
  send({ type: 'fileTransferDone', id: 1, ok: true })
  await until(() => answers.length === 1)
  assert.deepEqual(answers[0], [1, true, 1, ''])
})

test('a path outside the assets folder is refused without asking the page', async () => {
  const { posted, answers, send, until } = await startWorker()
  send({ type: 'event', name: 'ask', payload: { op: 'download', path: '/etc/passwd' } })
  await until(() => answers.length === 1)
  assert.deepEqual(answers[0], [1, false, 0, 'failed'])
  assert.equal(posted.some((message) => message.type === 'fileRequest'), false)
})
