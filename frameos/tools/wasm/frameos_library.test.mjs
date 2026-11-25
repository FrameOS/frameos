// Unit tests for the wasm runtime's Emscripten JS library. The file is not a
// module: Emscripten reads it and splices each function into frameos.js. So
// it is evaluated here with a stub addToLibrary, and the request hook is run
// against stubbed Emscripten globals and a recording XMLHttpRequest.
//
//   node --test tools/wasm/frameos_library.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('./frameos_library.js', import.meta.url), 'utf8')

function loadLibrary() {
  let library = null
  vm.runInNewContext(source, { addToLibrary: (object) => (library = object) })
  assert.ok(library, 'frameos_library.js must call addToLibrary')
  return library
}

const isPrivateHost = loadLibrary().$frameosIsPrivateHost
const logUrl = loadLibrary().$frameosLogUrl

test('the request hook pulls in the private-host and log-URL helpers', () => {
  assert.ok(loadLibrary().fos_nim_http_request__deps.includes('$frameosIsPrivateHost'))
  assert.ok(loadLibrary().fos_nim_http_request__deps.includes('$frameosLogUrl'))
})

test('a log line shows a URL as scheme://host[:port] only', () => {
  const cases = [
    ['https://cloud.frameos.net/api/photos/shared/pk_abc/file?path=beach%2Fa.jpg', 'https://cloud.frameos.net'],
    ['HTTP://Example.COM:8080/x?key=secret#frag', 'http://example.com:8080'],
    ['http://user:pa@ss@192.168.1.1:8123/api', 'http://192.168.1.1:8123'],
    ['http://[fe80::1]:8080/x', 'http://[fe80::1]:8080'],
    ['https://example.com?token=1', 'https://example.com'],
    ['http://example.com:/x', 'http://example.com'],
    ['', '(invalid URL)'],
    ['example.com/path?key=1', '(invalid URL)'],
    ['https:///pk_abc', '(invalid URL)'],
    ['https://user:secret@/x', '(invalid URL)'],
    ['https://host:80x/', '(invalid URL)'],
    ['https://sec ret/', '(invalid URL)'],
    ['/api/photos/shared/pk_abc/photo', '(invalid URL)'],
  ]
  for (const [url, want] of cases) assert.equal(logUrl(url), want, url)
})

test('private IPv4 literals, matching the device policy', () => {
  for (const host of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.251',
    '255.255.255.255',
  ]) {
    assert.equal(isPrivateHost(host), true, host)
  }
})

test('public IPv4 literals', () => {
  for (const host of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '192.0.2.1', '198.20.0.1', '223.255.255.255']) {
    assert.equal(isPrivateHost(host), false, host)
  }
})

test('IPv6 literals as URL() spells them', () => {
  const hostOf = (url) => new URL(url).hostname
  for (const url of [
    'http://[::1]/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:192.168.1.1]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::10.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fc12:3456::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
  ]) {
    assert.equal(isPrivateHost(hostOf(url)), true, url)
  }
  for (const url of ['http://[2001:4860:4860::8888]/', 'http://[2606:4700::1111]/', 'http://[::ffff:8.8.8.8]/', 'http://[64:ff9b::808:808]/']) {
    assert.equal(isPrivateHost(hostOf(url)), false, url)
  }
})

test('URL() normalizes odd IPv4 spellings before the check sees them', () => {
  for (const url of ['http://0x7f.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://127.1/', 'http://192.168.1.1./']) {
    assert.equal(isPrivateHost(new URL(url).hostname), true, url)
  }
})

test('names that can only mean a local host', () => {
  for (const host of ['localhost', 'app.localhost', 'LOCALHOST', 'homeassistant.local', 'nas.home.arpa', 'db.internal', 'router.lan', 'nas', 'printer.', '']) {
    assert.equal(isPrivateHost(host), true, JSON.stringify(host))
  }
  for (const host of ['api.open-meteo.com', 'example.com', 'localhost.example.com', 'local.example', 'internal.example.com']) {
    assert.equal(isPrivateHost(host), false, host)
  }
})

test('malformed IPv6 fails closed', () => {
  for (const host of ['[1::2::3]', '[zz::1]', '[1:2:3:4:5:6:7:8:9]', '[1:2:3]']) {
    assert.equal(isPrivateHost(host), true, host)
  }
})

// Runs the request hook as the preview worker would, returning which URLs
// were opened directly and whether the proxy was used.
function request(
  url,
  { page, proxyUrl = '/api/proxy', lanAccess, proxyFirst, module, sendError = null, proxyAnswer = null, responseHeaders = '', headersPtr = 0 } = {}
) {
  const library = loadLibrary()
  const opened = []
  const logs = []
  class FakeXHR {
    open(method, target) {
      this.target = target
      opened.push(target)
    }
    setRequestHeader() {}
    send() {
      if (this.target === proxyUrl && proxyAnswer) {
        this.status = proxyAnswer.status
        this.answerHeaders = proxyAnswer.headers ?? {}
        this.response = new TextEncoder().encode(proxyAnswer.body ?? '').buffer
        return
      }
      if (sendError && this.target !== proxyUrl) throw new Error(sendError)
      this.status = 200
      this.response = new TextEncoder().encode('ok').buffer
    }
    getResponseHeader(name) {
      for (const [key, value] of Object.entries(this.answerHeaders ?? {})) {
        if (key.toLowerCase() === name.toLowerCase()) return value
      }
      return null
    }
    getAllResponseHeaders() {
      return responseHeaders
    }
  }
  const heap = new Uint8Array(8192)
  const strings = new Map([
    [1, 'GET'],
    [2, url],
  ])
  const context = {
    UTF8ToString: (ptr) => strings.get(ptr) ?? '',
    HEAPU8: heap,
    _malloc: () => 512,
    makeSetValue: () => {},
    // One Module across calls is one runtime: what it learned (the origins
    // that failed directly) carries over.
    Module: Object.assign(module ?? {}, {
      frameosProxyUrl: proxyUrl,
      frameosLanAccess: lanAccess,
      frameosProxyFirst: proxyFirst,
      onFrameosLog: (message) => logs.push(message),
    }),
    XMLHttpRequest: FakeXHR,
    TextEncoder,
    URL,
    ArrayBuffer,
    Uint8Array,
    JSON,
    btoa,
    self: page ? { location: new URL(page) } : undefined,
    frameosIsPrivateHost: library.$frameosIsPrivateHost,
    frameosLogUrl: library.$frameosLogUrl,
    frameosProxyRefusal: library.$frameosProxyRefusal,
  }
  // The hook's `{{{ makeSetValue(...) }}}` lines are Emscripten macros; as
  // plain JS they are nested blocks calling the stub above. The route helper
  // reads `self`, so it runs in the same context.
  vm.createContext(context)
  context.frameosRoute = vm.runInContext(`(${library.$frameosRoute.toString()})`, context)
  const hook = vm.runInContext(`(${library.fos_nim_http_request.toString()})`, context)
  const ptr = hook(1, 2, 0, 0, 0, 0, 1000, 0, 0, 0, headersPtr)
  const end = headersPtr ? heap.indexOf(0, headersPtr) : 0
  const headers = new TextDecoder().decode(heap.subarray(headersPtr, end))
  // What the scene is handed: the body at the pointer (the stub malloc's 512).
  const said = ptr ? new TextDecoder().decode(heap.subarray(ptr, heap.indexOf(0, ptr))) : null
  return { opened, logs, headers, said, direct: opened.filter((u) => u !== proxyUrl), viaProxy: opened.includes(proxyUrl) }
}

test("the response's headers go into the caller's block as whole lines, 2047 bytes at most", () => {
  const lines = 'content-range: bytes 0-65535/8388608\r\netag: "abc"\r\n'
  assert.equal(request('https://files.example/big.bin', { responseHeaders: lines, headersPtr: 4096 }).headers, lines)
  const long = Array.from({ length: 100 }, (_, i) => `x-header-${i}: ${'v'.repeat(20)}\r\n`).join('')
  const kept = request('https://files.example/', { responseHeaders: long, headersPtr: 4096 }).headers
  assert.ok(kept.length <= 2047 && kept.length > 1900, String(kept.length))
  assert.ok(long.startsWith(kept) && kept.endsWith('\n'))
  // No block asked for: nothing written.
  assert.equal(request('https://files.example/', { responseHeaders: lines }).headers, '')
})

test('a public page never requests a private host directly; the proxy decides', () => {
  for (const url of ['http://192.168.1.1/admin', 'http://localhost:8123/api/states', 'http://homeassistant.local/', 'http://[fd00::1]/', 'http://nas/']) {
    const result = request(url, { page: 'https://cloud.frameos.net/frames/1' })
    assert.deepEqual(result.direct, [], url)
    assert.equal(result.viaProxy, true, url)
  }
})

test('without a proxy the private request fails instead of going direct', () => {
  const result = request('http://10.0.0.5/', { page: 'https://cloud.frameos.net/', proxyUrl: null })
  assert.deepEqual(result.opened, [])
  assert.match(result.logs.join('\n'), /private-network request refused/)
})

test('a public page still reaches public hosts directly', () => {
  const result = request('https://api.open-meteo.com/v1/forecast?x=1', { page: 'https://cloud.frameos.net/frames/1' })
  assert.deepEqual(result.direct, ['https://api.open-meteo.com/v1/forecast?x=1'])
  assert.equal(result.viaProxy, false)
})

test('a self-hosted app on the LAN keeps direct access to LAN hosts', () => {
  for (const page of ['http://192.168.1.5:8989/frames/1', 'http://localhost:8989/', 'http://frameos.local:8989/']) {
    const result = request('http://192.168.1.20/api', { page })
    assert.deepEqual(result.direct, ['http://192.168.1.20/api'], page)
  }
})

test('same-origin targets still only go through the proxy', () => {
  const result = request('/api/frames', { page: 'http://192.168.1.5:8989/frames/1' })
  assert.deepEqual(result.direct, [])
  assert.equal(result.viaProxy, true)
})

test('headless renderers (no browser origin) are not guarded', () => {
  const result = request('http://192.168.1.1/', { page: undefined })
  assert.deepEqual(result.direct, ['http://192.168.1.1/'])
})

const LAN_OFF = /Local network access is off for this frame, so (\S+) cannot be reached\. Turn on local network access in the frame settings\./

test('a frame with local network access off: private hosts refused, direct and proxied, in its words', () => {
  for (const page of ['https://cloud.frameos.net/frames/1', 'http://192.168.1.5:8989/frames/1', undefined]) {
    for (const url of ['http://192.168.1.1/admin', 'http://homeassistant.local:8123/api/states', 'http://[fd00::1]/']) {
      const result = request(url, { page, lanAccess: false })
      assert.deepEqual(result.opened, [], `${url} from ${page}`)
      const line = result.logs.join('\n')
      assert.match(line, LAN_OFF, `${url} from ${page}`)
      assert.equal(line.match(LAN_OFF)[1], new URL(url).hostname)
      // The scene gets the same words as the request's error.
      assert.match(result.said, LAN_OFF, `${url} from ${page}`)
    }
  }
})

test('a frame with local network access off still reaches the internet', () => {
  const result = request('https://api.open-meteo.com/v1/forecast?x=1', {
    page: 'https://cloud.frameos.net/frames/1',
    lanAccess: false,
  })
  assert.deepEqual(result.direct, ['https://api.open-meteo.com/v1/forecast?x=1'])
  assert.deepEqual(result.logs, [])
})

test('Local network access off leaves the same-origin path alone', () => {
  const result = request('/api/frames', { page: 'http://192.168.1.5:8989/frames/1', lanAccess: false })
  assert.deepEqual(result.direct, [])
  assert.equal(result.viaProxy, true)
})

test('Local network access on, or not said, changes nothing', () => {
  for (const lanAccess of [true, undefined]) {
    const lan = request('http://192.168.1.20/api', { page: 'http://192.168.1.5:8989/frames/1', lanAccess })
    assert.deepEqual(lan.direct, ['http://192.168.1.20/api'])
    const publicPage = request('http://192.168.1.1/admin', { page: 'https://cloud.frameos.net/frames/1', lanAccess })
    assert.deepEqual(publicPage.direct, [])
    assert.equal(publicPage.viaProxy, true)
    assert.doesNotMatch(publicPage.logs.join('\n'), /Local network access is off/)
  }
})

test('a failed request is logged by its origin, the error text included', () => {
  const url = 'https://cloud.frameos.net/api/photos/shared/pk_secret/photo?index=3'
  const result = request(url, { proxyUrl: null, sendError: `Failed to load '${url}'` })
  const logged = result.logs.join('\n')
  assert.match(logged, /GET https:\/\/cloud\.frameos\.net failed: Error: Failed to load 'https:\/\/cloud\.frameos\.net'/)
  assert.doesNotMatch(logged, /pk_secret|index=3/)
})

test('proxy first: no request leaves the browser directly while a proxy is set', () => {
  for (const url of ['http://192.168.1.20:2283/api/albums', 'https://api.open-meteo.com/v1/forecast']) {
    const result = request(url, { page: 'http://192.168.1.5:8989/frames/1', proxyFirst: true })
    assert.deepEqual(result.direct, [], url)
    assert.equal(result.viaProxy, true, url)
  }
  // Without a proxy there is nothing to go first: the browser it is.
  const alone = request('https://api.open-meteo.com/v1/forecast', { page: 'http://192.168.1.5:8989/', proxyUrl: null, proxyFirst: true })
  assert.deepEqual(alone.direct, ['https://api.open-meteo.com/v1/forecast'])
})

test('an origin that failed directly goes to the proxy alone from then on', () => {
  const module = {}
  const page = 'http://192.168.1.5:8989/frames/1'
  const first = request('http://192.168.1.20:2283/api/albums', { page, module, sendError: 'NetworkError (CORS)' })
  assert.deepEqual(first.direct, ['http://192.168.1.20:2283/api/albums'])
  assert.equal(first.viaProxy, true)
  const second = request('http://192.168.1.20:2283/api/assets/1/thumbnail', { page, module, sendError: 'NetworkError (CORS)' })
  assert.deepEqual(second.direct, [])
  assert.equal(second.viaProxy, true)
  // Another origin still tries the browser first.
  const other = request('https://api.open-meteo.com/v1/forecast', { page, module })
  assert.deepEqual(other.direct, ['https://api.open-meteo.com/v1/forecast'])
  // A runtime of its own learned nothing.
  const fresh = request('http://192.168.1.20:2283/api/albums', { page })
  assert.deepEqual(fresh.direct, ['http://192.168.1.20:2283/api/albums'])
})

test("the proxy's refusal reaches the scene in words, not as a bare 403", () => {
  const page = 'http://192.168.1.5:8989/frames/1'
  const refused = (reason) =>
    request('http://192.168.1.20:2283/api/albums?key=secret', {
      page,
      proxyFirst: true,
      proxyAnswer: { status: 403, headers: { 'X-FrameOS-Proxy-Refused': reason }, body: '{"detail":"Proxy target host is not allowed"}' },
    })
  const lan = refused('local-network')
  assert.match(lan.said, LAN_OFF)
  assert.equal(lan.said.match(LAN_OFF)[1], '192.168.1.20')
  assert.match(lan.logs.join('\n'), LAN_OFF)
  assert.match(refused('public-only').said, /^The preview cannot reach 192\.168\.1\.20: its server reaches public internet addresses only\./)
  assert.match(refused('host').said, /^The preview cannot reach 192\.168\.1\.20: its server does not connect to that address\./)
  for (const reason of ['local-network', 'public-only', 'host']) {
    const result = refused(reason)
    assert.doesNotMatch(result.said + result.logs.join('\n'), /secret|\/api\/albums/, reason)
  }
  // A 403 from the upstream itself (through the proxy, no header) is the
  // upstream's answer, handed over as it is.
  const upstream403 = request('http://192.168.1.20:2283/api/albums', {
    page,
    proxyFirst: true,
    proxyAnswer: { status: 403, body: '{"message":"Invalid API key"}' },
  })
  assert.equal(upstream403.said, '{"message":"Invalid API key"}')
  assert.deepEqual(upstream403.logs, [])
})

test('a plain failure still hands the scene nothing to show', () => {
  const result = request('https://example.com/x', { proxyUrl: null, sendError: 'NetworkError' })
  assert.equal(result.said, null)
})

test('a tapped link goes to the page when it takes links, else 0 (the QR code)', () => {
  const opened = []
  const context = { Module: {}, UTF8ToString: (ptr) => ptr }
  let library = null
  vm.runInNewContext(source, { ...context, addToLibrary: (object) => (library = object) })
  assert.equal(library.frameos_wasm_js_open_link('https://frameos.net'), 0)
  const withPage = { Module: { onFrameosOpenLink: (url) => opened.push(url) }, UTF8ToString: (ptr) => ptr }
  vm.runInNewContext(source, { ...withPage, addToLibrary: (object) => (library = object) })
  assert.equal(library.frameos_wasm_js_open_link('https://frameos.net'), 1)
  assert.deepEqual(opened, ['https://frameos.net'])
})

// The preview's pictures fetched ahead (fos_wasm_picture, frameosPictureFetch):
// a runtime whose fetch() the test answers by hand, with the request hook
// beside it to see what the runtime's own request for a picture is handed.
function pictureRuntime({ page = 'https://scenes.frameos.net/s/scene-store', proxyUrl = '/api/proxy', proxyFirst, lanAccess, browser = true } = {}) {
  const library = loadLibrary()
  const fetches = []
  const opened = []
  const logs = []
  let told = 0
  const fetch = (url, options) =>
    new Promise((resolve, reject) => {
      fetches.push({
        url,
        options,
        answer(status = 200, body = 'picture', headers = { 'content-type': 'image/jpeg' }) {
          const bytes = new TextEncoder().encode(body)
          resolve({
            status,
            headers: {
              get: (name) => headers[name] ?? null,
              forEach: (fn) => Object.entries(headers).forEach(([name, value]) => fn(value, name)),
            },
            arrayBuffer: () => Promise.resolve(bytes.buffer),
          })
        },
        fail(error = new TypeError('Failed to fetch')) {
          reject(error)
        },
      })
    })
  class FakeXHR {
    open(method, target) {
      opened.push(target)
    }
    setRequestHeader() {}
    send() {
      this.status = 200
      this.response = new TextEncoder().encode('from the network').buffer
    }
    getAllResponseHeaders() {
      return ''
    }
  }
  const heap = new Uint8Array(1 << 20)
  let free = 1024
  const strings = new Map()
  let nextString = 1
  const string = (text) => {
    strings.set(nextString, text)
    return nextString++
  }
  const module = {
    frameosProxyUrl: proxyUrl,
    frameosProxyFirst: proxyFirst,
    frameosLanAccess: lanAccess,
    onFrameosLog: (message) => logs.push(message),
    onFrameosPictures: () => told++,
  }
  const context = vm.createContext({
    UTF8ToString: (ptr) => strings.get(ptr) ?? '',
    HEAPU8: heap,
    // Fresh, zeroed memory each time, so a body reads to its own end.
    _malloc: (bytes) => {
      const ptr = free
      free += bytes + 1
      heap.fill(0, ptr, free)
      return ptr
    },
    makeSetValue: () => {},
    Module: module,
    XMLHttpRequest: FakeXHR,
    fetch: browser ? fetch : undefined,
    TextEncoder,
    URL,
    ArrayBuffer,
    Uint8Array,
    JSON,
    btoa,
    Map,
    Promise,
    AbortController,
    clearTimeout,
    // A fetch nobody answers must not hold the test run open.
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return timer
    },
    self: browser ? { location: new URL(page) } : undefined,
  })
  for (const name of ['$frameosIsPrivateHost', '$frameosLogUrl', '$frameosProxyRefusal', '$frameosRoute', '$frameosPictures', '$frameosPictureFetch']) {
    context[name.slice(1)] = vm.runInContext(`(${library[name].toString()})`, context)
  }
  const picture = vm.runInContext(`(${library.fos_wasm_picture.toString()})`, context)
  const hook = vm.runInContext(`(${library.fos_nim_http_request.toString()})`, context)
  return {
    module,
    fetches,
    opened,
    logs,
    told: () => told,
    picture: (url) => picture(string(url)),
    request(url) {
      const headersAt = 512
      heap.fill(0, headersAt, 1024)
      const ptr = hook(string('GET'), string(url), 0, 0, 0, 0, 1000, 0, 0, 0, headersAt)
      return {
        said: ptr ? new TextDecoder().decode(heap.subarray(ptr, heap.indexOf(0, ptr))) : null,
        headers: new TextDecoder().decode(heap.subarray(headersAt, heap.indexOf(0, headersAt))),
      }
    },
  }
}

// Every promise the answers set going has run.
const settled = () => new Promise((resolve) => setImmediate(resolve))

const cover = (i) => `https://cloud-cdn.frameos.net/store/scene-images/${i}.jpg`

test('pictures are fetched ahead six at a time, and the rest as those come in', async () => {
  const runtime = pictureRuntime()
  const urls = Array.from({ length: 8 }, (_, i) => cover(i))
  for (const url of urls) assert.equal(runtime.picture(url), 1, url)
  assert.deepEqual(runtime.fetches.map((f) => f.url), urls.slice(0, 6))
  // Asked again while it comes: no second fetch.
  assert.equal(runtime.picture(urls[0]), 1)
  assert.equal(runtime.fetches.length, 6)
  // Straight from the browser, no cookie.
  assert.equal(runtime.fetches[0].options.credentials, 'omit')
  runtime.fetches[0].answer(200, 'first')
  await settled()
  assert.equal(runtime.told(), 1)
  assert.deepEqual(runtime.fetches.map((f) => f.url), urls.slice(0, 7))
  for (const f of runtime.fetches.slice(1)) f.answer()
  await settled()
  assert.equal(runtime.fetches.length, 8)
  runtime.fetches[7].answer()
  await settled()
  assert.equal(runtime.told(), 8)
})

test("a picture that came is the runtime's request's answer, at once and again later", async () => {
  const runtime = pictureRuntime()
  const url = cover(1)
  runtime.picture(url)
  runtime.fetches[0].answer(200, 'jpeg bytes', { 'content-type': 'image/jpeg', etag: '"abc"' })
  await settled()
  assert.equal(runtime.picture(url), 2)
  const got = runtime.request(url)
  assert.equal(got.said, 'jpeg bytes')
  assert.match(got.headers, /content-type: image\/jpeg\r\n/)
  assert.match(got.headers, /etag: "abc"\r\n/)
  assert.deepEqual(runtime.opened, [], 'no request left the worker')
  // Kept: a page seen again draws without the network.
  assert.equal(runtime.picture(url), 2)
  assert.equal(runtime.request(url).said, 'jpeg bytes')
  assert.equal(runtime.fetches.length, 1)
  // Anything else still goes out.
  assert.equal(runtime.request(cover(2)).said, 'from the network')
  assert.deepEqual(runtime.opened, [cover(2)])
})

test('nothing the browser may not fetch itself is fetched ahead', () => {
  const runtime = pictureRuntime({ page: 'https://scenes.frameos.net/s/scene-store' })
  for (const url of ['/api/store/scenes/1/image', 'https://scenes.frameos.net/x.jpg', 'http://192.168.1.20/a.jpg', 'http://nas/a.jpg']) {
    assert.equal(runtime.picture(url), 0, url)
  }
  const lanOff = pictureRuntime({ page: 'http://192.168.1.5:8989/frames/1', lanAccess: false })
  assert.equal(lanOff.picture('http://192.168.1.20/a.jpg'), 0)
  // A plane's renderer in Node: its requests go as always.
  const headless = pictureRuntime({ browser: false })
  assert.equal(headless.picture(cover(1)), 0)
  assert.deepEqual([...runtime.fetches, ...lanOff.fetches, ...headless.fetches], [])
})

test('an origin the browser cannot reach goes through the proxy, from then on', async () => {
  const runtime = pictureRuntime()
  const url = 'https://images.example.com/a.jpg?key=secret'
  runtime.picture(url)
  runtime.fetches[0].fail()
  await settled()
  assert.equal(runtime.fetches.length, 2)
  assert.equal(runtime.fetches[1].url, '/api/proxy')
  assert.equal(runtime.fetches[1].options.method, 'POST')
  assert.equal(runtime.fetches[1].options.credentials, 'include')
  assert.equal(JSON.parse(runtime.fetches[1].options.body).url, url)
  runtime.fetches[1].answer(200, 'proxied')
  await settled()
  assert.equal(runtime.request(url).said, 'proxied')
  assert.equal(runtime.module.frameosDirectBlocked['https://images.example.com'], true)
  runtime.picture('https://images.example.com/b.jpg')
  assert.equal(runtime.fetches[2].url, '/api/proxy')
  runtime.fetches[2].answer()
  await settled()
  // A page whose proxy goes first sends it there to begin with.
  const first = pictureRuntime({ page: 'http://192.168.1.5:8989/frames/1', proxyFirst: true })
  first.picture(cover(1))
  assert.equal(first.fetches[0].url, '/api/proxy')
  first.fetches[0].answer()
  await settled()
})

test('a picture that did not come is said once, by its origin, and fetched again when asked again', async () => {
  const runtime = pictureRuntime({ proxyUrl: null })
  const url = 'https://images.example.com/private/pk_secret.jpg'
  runtime.picture(url)
  runtime.fetches[0].fail(new TypeError(`Failed to fetch ${url}`))
  await settled()
  assert.equal(runtime.told(), 1)
  assert.equal(runtime.picture(url), 2)
  assert.equal(runtime.request(url).said, null)
  assert.deepEqual(runtime.opened, [])
  const logged = runtime.logs.join('\n')
  assert.match(logged, /GET https:\/\/images\.example\.com failed: TypeError: Failed to fetch https:\/\/images\.example\.com/)
  assert.doesNotMatch(logged, /pk_secret/)
  assert.equal(runtime.picture(url), 1)
  assert.equal(runtime.fetches.length, 2)
  runtime.fetches[1].answer()
  await settled()
})

test("the proxy's refusal is the picture's error, in words", async () => {
  const runtime = pictureRuntime({ page: 'http://192.168.1.5:8989/frames/1', proxyFirst: true })
  const url = 'https://images.example.com/a.jpg'
  runtime.picture(url)
  runtime.fetches[0].answer(403, '{"detail":"no"}', { 'X-FrameOS-Proxy-Refused': 'host' })
  await settled()
  assert.match(runtime.request(url).said, /^The preview cannot reach images\.example\.com: its server does not connect to that address\./)
})

test('the pictures used longest ago go when the kept ones are over their bytes', async () => {
  const runtime = pictureRuntime()
  const [a, b, c] = [cover('a'), cover('b'), cover('c')]
  runtime.picture(a)
  runtime.module.frameosPictures.keepBytes = 10
  runtime.picture(b)
  runtime.fetches[0].answer(200, 'aaaa')
  runtime.fetches[1].answer(200, 'bbbb')
  await settled()
  // `a` drawn again: `b` is the one used longest ago now.
  assert.equal(runtime.request(a).said, 'aaaa')
  runtime.picture(c)
  runtime.fetches[2].answer(200, 'cccc')
  await settled()
  assert.equal(runtime.picture(a), 2)
  assert.equal(runtime.picture(c), 2)
  assert.equal(runtime.picture(b), 1, 'gone, and fetched again')
  assert.equal(runtime.module.frameosPictures.bytes, 8)
  runtime.fetches[3].answer(200, 'bbbb')
  await settled()
})

test("a picture too big to keep is left to the runtime's own request, once", async () => {
  const runtime = pictureRuntime()
  const url = cover('big')
  runtime.picture(url)
  runtime.module.frameosPictures.largest = 3
  runtime.fetches[0].answer(200, 'too big')
  await settled()
  assert.equal(runtime.told(), 1)
  assert.equal(runtime.picture(url), 0)
  assert.equal(runtime.picture(url), 0)
  assert.equal(runtime.fetches.length, 1)
  assert.equal(runtime.request(url).said, 'from the network')
})

test('the runtime saying pictures wait tells the page', () => {
  let told = 0
  let library = null
  vm.runInNewContext(source, { Module: { onFrameosPictures: () => told++ }, addToLibrary: (object) => (library = object) })
  library.fos_wasm_pictures_waiting()
  assert.equal(told, 1)
  // A renderer that does not listen: nothing happens.
  vm.runInNewContext(source, { Module: {}, addToLibrary: (object) => (library = object) })
  library.fos_wasm_pictures_waiting()
})
