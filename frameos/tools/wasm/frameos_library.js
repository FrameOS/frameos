// Emscripten JS library for the FrameOS wasm scene runtime
// (src/wasm/wasm_main.nim, built by tools/build_wasm.sh).
//
// Provides the host hooks the Nim side imports:
//  - frameos_wasm_js_log / frameos_wasm_js_event: forwarded to the embedding
//    script through Module.onFrameosLog / Module.onFrameosEvent.
//  - fos_nim_http_request / fos_nim_http_free: the same hook the ESP32
//    firmware implements in C (see src/frameos/utils/http_client.nim),
//    implemented here with synchronous XHR. Synchronous requests with a
//    binary response are only allowed inside workers, which is where the
//    live-preview frontend runs this module.
//
// tools/wasm/frameos_library.test.mjs loads this file with a stub
// addToLibrary and exercises the request guard.

addToLibrary({
  // True when `hostname` (as URL.hostname spells it: lowercase, IPv4 in
  // dotted decimal, IPv6 in brackets) names the viewer's own machine or
  // network. IP literals follow isPrivateNetworkAddress in
  // src/frameos/utils/http_client.nim. Names cannot be resolved from here,
  // so a name counts as private when it can only mean a local host:
  // localhost, the reserved private-use suffixes, or a single label that a
  // LAN search domain would complete.
  $frameosIsPrivateHost: function (hostname) {
    var host = String(hostname || '')
      .toLowerCase()
      .replace(/\.$/, '')
    if (host === '') return true

    var ipv4Private = function (b) {
      if (b[0] === 0) return true // 0.0.0.0/8
      if (b[0] === 10) return true // 10/8
      if (b[0] === 100 && (b[1] & 0xc0) === 64) return true // 100.64/10 CGNAT
      if (b[0] === 127) return true // loopback
      if (b[0] === 169 && b[1] === 254) return true // link-local
      if (b[0] === 172 && (b[1] & 0xf0) === 16) return true // 172.16/12
      if (b[0] === 192 && b[1] === 0 && b[2] === 0) return true // 192.0.0.0/24
      if (b[0] === 192 && b[1] === 168) return true // 192.168/16
      if (b[0] === 198 && (b[1] & 0xfe) === 18) return true // 198.18/15
      if ((b[0] & 0xf0) === 224) return true // 224/4 multicast
      if (b[0] >= 240) return true // 240/4 reserved, broadcast
      return false
    }

    if (host.charAt(0) === '[') {
      // IPv6 literal. URL() has already validated and compressed it; expand
      // it to 16 bytes. Anything unparseable fails closed.
      var inner = host.slice(1, host.indexOf(']') > 0 ? host.indexOf(']') : host.length)
      var halves = inner.split('::')
      if (halves.length > 2) return true
      var parseGroups = function (part) {
        if (part === '') return []
        var groups = part.split(':')
        var out = []
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i]
          if (g.indexOf('.') >= 0 && i === groups.length - 1) {
            var quad = g.split('.').map(Number)
            if (quad.length !== 4 || quad.some(function (n) { return !(n >= 0 && n <= 255) })) return null
            out.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3])
          } else {
            if (!/^[0-9a-f]{1,4}$/.test(g)) return null
            out.push(parseInt(g, 16))
          }
        }
        return out
      }
      var head = parseGroups(halves[0])
      var tail = halves.length === 2 ? parseGroups(halves[1]) : []
      if (head === null || tail === null) return true
      var missing = 8 - head.length - tail.length
      if (missing < 0 || (halves.length === 1 && missing !== 0)) return true
      var words = head.concat(new Array(missing).fill(0), tail)
      var b = []
      for (var w = 0; w < 8; w++) b.push(words[w] >> 8, words[w] & 0xff)
      var zeroPrefix = true
      for (var z = 0; z < 10; z++) if (b[z] !== 0) zeroPrefix = false
      var allZero = zeroPrefix && b[10] === 0 && b[11] === 0 && b[12] === 0 && b[13] === 0 && b[14] === 0
      if (allZero && b[15] <= 1) return true // :: and ::1
      if (zeroPrefix && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
        return ipv4Private(b.slice(12)) // ::ffff:a.b.c.d and ::a.b.c.d
      }
      var nat64 = b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b
      for (var n = 4; n < 12 && nat64; n++) if (b[n] !== 0) nat64 = false
      if (nat64) return ipv4Private(b.slice(12)) // 64:ff9b::/96
      if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 ULA
      if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10
      if (b[0] === 0xff) return true // multicast
      return false
    }

    var parts = host.split('.')
    if (parts.length === 4 && parts.every(function (p) { return /^[0-9]{1,3}$/.test(p) })) {
      var octets = parts.map(Number)
      if (octets.some(function (o) { return o > 255 })) return true
      return ipv4Private(octets)
    }

    if (parts.length === 1) return true // "nas", "router", "homeassistant"
    var last = parts[parts.length - 1]
    var lastTwo = parts.slice(-2).join('.')
    return last === 'localhost' || last === 'local' || last === 'internal' || last === 'lan' || lastTwo === 'home.arpa'
  },

  frameos_wasm_js_log: function (msgPtr) {
    var msg = UTF8ToString(msgPtr)
    if (Module['onFrameosLog']) {
      Module['onFrameosLog'](msg)
    } else {
      console.log('[frameos]', msg)
    }
  },

  frameos_wasm_js_event: function (eventPtr, payloadPtr) {
    if (Module['onFrameosEvent']) {
      Module['onFrameosEvent'](UTF8ToString(eventPtr), UTF8ToString(payloadPtr))
    }
  },

  fos_nim_http_request__deps: ['malloc', '$frameosIsPrivateHost'],
  fos_nim_http_request: function (
    methodPtr,
    urlPtr,
    bodyPtr,
    bodyLen,
    headersPtr,
    headersLen,
    timeoutMs,
    maxBytes,
    outStatusPtr,
    outLenPtr
  ) {
    {{{ makeSetValue('outStatusPtr', 0, 0, 'i32') }}}
    {{{ makeSetValue('outLenPtr', 0, 0, 'i32') }}}
    var method = UTF8ToString(methodPtr)
    var url = UTF8ToString(urlPtr)
    // When a same-origin backend proxy is configured, it is the FALLBACK:
    // requests go straight from the browser first (client-side, no server
    // load), and only CORS/network failures are retried through the proxy,
    // which fetches server-side like the device would.
    var proxyUrl = Module['frameosProxyUrl']
    try {
      var body = null
      if (bodyLen > 0) {
        body = new Uint8Array(HEAPU8.buffer, bodyPtr, bodyLen).slice()
      }
      var headers = {}
      if (headersLen > 0) {
        var headerBlock = UTF8ToString(headersPtr, headersLen)
        var lines = headerBlock.split('\n')
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i]
          var colon = line.indexOf(':')
          if (colon > 0) {
            headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
          }
        }
      }

      // Scene code is untrusted (it may come from the public store). This
      // worker shares the app's origin, so a direct request to the app's own
      // API would carry the user's session cookie and read the answer — a
      // same-origin target must only ever go through the server-side proxy,
      // which fetches without cookies and applies the SSRF guard.
      // The same goes for the viewer's own network when the app itself is
      // on the public internet: a request from the viewer's browser to
      // http://192.168.1.1/ cannot read the reply without CORS, but it still
      // reaches the router (timing, and side effects of a GET). Chrome's
      // Private Network Access blocks that; Firefox and Safari do not. A
      // self-hosted app on the LAN (or localhost) keeps direct access to
      // private hosts, as a frame on that LAN would have.
      // (Under Node — the headless renderers — there is no origin to protect;
      // the guard only applies inside a browser context.)
      var refusedDirect = null
      var inBrowser = typeof self !== 'undefined' && self && self.location && typeof self.location.href === 'string'
      if (inBrowser) {
        try {
          var resolved = new URL(url, self.location.href)
          if (resolved.origin === self.location.origin || (resolved.protocol !== 'http:' && resolved.protocol !== 'https:')) {
            refusedDirect = 'same-origin'
          } else if (frameosIsPrivateHost(resolved.hostname) && !frameosIsPrivateHost(self.location.hostname)) {
            refusedDirect = 'private-network'
          }
        } catch (e) {
          refusedDirect = 'unparseable'
        }
      }

      // Synchronous XHR: the Nim/pixie pipeline is fully synchronous and this
      // module runs in a Web Worker, where sync XHR is permitted.
      var directRequest = function () {
        if (refusedDirect) {
          throw new Error('frameos: ' + refusedDirect + ' request refused from scene code')
        }
        var xhr = new XMLHttpRequest()
        xhr.open(method, url, false)
        try {
          xhr.responseType = 'arraybuffer'
          if (timeoutMs > 0) xhr.timeout = timeoutMs
        } catch (e) {
          // Main-thread fallback: sync XHR only supports text responses there.
        }
        for (var name in headers) {
          try {
            xhr.setRequestHeader(name, headers[name])
          } catch (e) {
            // Forbidden header names (User-Agent & co) throw; skip them.
          }
        }
        xhr.send(body)
        return xhr
      }

      var proxyRequest = function () {
        var xhr = new XMLHttpRequest()
        xhr.open('POST', proxyUrl, false)
        xhr.withCredentials = true
        try {
          xhr.responseType = 'arraybuffer'
          if (timeoutMs > 0) xhr.timeout = timeoutMs
        } catch (e) {}
        var bodyBase64 = ''
        if (body && body.length > 0) {
          var bin = ''
          for (var j = 0; j < body.length; j++) bin += String.fromCharCode(body[j])
          bodyBase64 = btoa(bin)
        }
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.send(
          JSON.stringify({ method: method, url: url, headers: headers, bodyBase64: bodyBase64, timeoutMs: timeoutMs })
        )
        return xhr
      }

      var xhr = null
      var directError = null
      try {
        xhr = directRequest()
      } catch (e) {
        // A cross-origin host without CORS headers throws on sync send.
        directError = e
      }
      if ((xhr === null || xhr.status === 0) && proxyUrl) {
        xhr = proxyRequest()
      } else if (xhr === null) {
        throw directError
      }

      var bytes
      if (xhr.response instanceof ArrayBuffer) {
        bytes = new Uint8Array(xhr.response)
      } else {
        bytes = new TextEncoder().encode(xhr.responseText || '')
      }
      if (maxBytes > 0 && bytes.length > maxBytes) {
        if (Module['onFrameosLog']) {
          Module['onFrameosLog']('http: response for ' + url + ' exceeded ' + maxBytes + ' bytes')
        }
        return 0
      }
      var ptr = _malloc(bytes.length > 0 ? bytes.length : 1)
      if (!ptr) return 0
      HEAPU8.set(bytes, ptr)
      {{{ makeSetValue('outStatusPtr', 0, 'xhr.status', 'i32') }}}
      {{{ makeSetValue('outLenPtr', 0, 'bytes.length', 'i32') }}}
      return ptr
    } catch (e) {
      if (Module['onFrameosLog']) {
        Module['onFrameosLog']('http: ' + method + ' ' + url + ' failed: ' + e)
      }
      return 0
    }
  },

  fos_nim_http_free__deps: ['free'],
  fos_nim_http_free: function (ptr) {
    if (ptr) _free(ptr)
  },
})
