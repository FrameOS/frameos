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

test('the request hook pulls in the private-host helper', () => {
  assert.ok(loadLibrary().fos_nim_http_request__deps.includes('$frameosIsPrivateHost'))
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
function request(url, { page, proxyUrl = '/api/proxy' } = {}) {
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
      this.status = 200
      this.response = new TextEncoder().encode('ok').buffer
    }
  }
  const heap = new Uint8Array(1024)
  const strings = new Map([
    [1, 'GET'],
    [2, url],
  ])
  const context = {
    UTF8ToString: (ptr) => strings.get(ptr) ?? '',
    HEAPU8: heap,
    _malloc: () => 512,
    makeSetValue: () => {},
    Module: { frameosProxyUrl: proxyUrl, onFrameosLog: (message) => logs.push(message) },
    XMLHttpRequest: FakeXHR,
    TextEncoder,
    URL,
    ArrayBuffer,
    Uint8Array,
    JSON,
    btoa,
    self: page ? { location: new URL(page) } : undefined,
    frameosIsPrivateHost: library.$frameosIsPrivateHost,
  }
  // The hook's `{{{ makeSetValue(...) }}}` lines are Emscripten macros; as
  // plain JS they are nested blocks calling the stub above.
  const hook = vm.runInNewContext(`(${library.fos_nim_http_request.toString()})`, context)
  hook(1, 2, 0, 0, 0, 0, 1000, 0, 0, 0)
  return { opened, logs, direct: opened.filter((u) => u !== proxyUrl), viaProxy: opened.includes(proxyUrl) }
}

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
