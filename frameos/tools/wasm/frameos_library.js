// Emscripten JS library for the FrameOS wasm scene runtime
// (src/wasm/wasm_main.nim, built by tools/build_wasm.sh).
//
// Provides the host hooks the Nim side imports:
//  - frameos_wasm_js_log / frameos_wasm_js_event / frameos_wasm_js_open_link /
//    frameos_wasm_js_file_request: forwarded to the embedding script through
//    Module.onFrameosLog / Module.onFrameosEvent / Module.onFrameosOpenLink /
//    Module.onFrameosFileRequest.
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

  // What of a scene's request URL a log line may show: scheme://host[:port],
  // the way redactedUrl (src/frameos/utils/redacted_url.nim) and the ESP32's
  // fos_netguard_url_origin cut it. A share link carries its token in the
  // path, API keys ride in query strings, and these lines reach the preview's
  // log panel and the headless renderers' output.
  $frameosLogUrl: function (url) {
    var m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^\/?#\\]*@)?(\[[0-9a-f:.]+\]|[\w.~%\u0080-\uffff-]+)(:\d{0,5})?(?=[\/?#\\]|$)/i.exec(String(url || '').trim())
    if (!m) return '(invalid URL)'
    return (m[1] + m[2]).toLowerCase() + (m[3] && m[3].length > 1 ? m[3] : '')
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

  // A tapped link (`<a href>`, docs/jsx-ui.md "Links"): 1 when the embedding
  // page takes it (the browser preview opens a tab), 0 when nothing does,
  // and the runtime shows its QR code as a frame would (a plane rendering
  // a board, which defines no Module.onFrameosOpenLink).
  frameos_wasm_js_open_link: function (urlPtr) {
    if (Module['onFrameosOpenLink']) {
      Module['onFrameosOpenLink'](UTF8ToString(urlPtr))
      return 1
    }
    return 0
  },

  // An Upload or a Download the Files scene asked for (frameos/file_transfer_preview.nim):
  // {id, op, path} as JSON, to the worker, which hands it to the page.
  frameos_wasm_js_file_request: function (requestPtr) {
    if (Module['onFrameosFileRequest']) {
      Module['onFrameosFileRequest'](UTF8ToString(requestPtr))
    }
  },

  // Why the preview's proxy would not fetch `host`, in words a scene can
  // show: the proxy says which rule refused it (`X-FrameOS-Proxy-Refused`,
  // set by the backend's scene_preview_proxy and the cloud's
  // store/preview-proxy). `local-network` is the frame's own switch, in the
  // words the frame uses (the SPA's logs panel matches their start).
  $frameosProxyRefusal: function (reason, host) {
    if (reason === 'local-network') {
      return 'Local network access is off for this frame, so ' + host +
        ' cannot be reached. Turn on local network access in the frame settings.'
    }
    if (reason === 'public-only') {
      return 'The preview cannot reach ' + host + ': its server reaches public internet addresses only. ' +
        'The frame itself can, with local network access on.'
    }
    return 'The preview cannot reach ' + host + ': its server does not connect to that address.'
  },

  // Where a scene's request to `url` may go from here. Scene code is
  // untrusted (it may come from the public store). This worker shares the
  // app's origin, so a direct request to the app's own API would carry the
  // user's session cookie and read the answer — a same-origin target must
  // only ever go through the server-side proxy, which fetches without cookies
  // and applies the SSRF guard. The same goes for the viewer's own network
  // when the app itself is on the public internet: a request from the
  // viewer's browser to http://192.168.1.1/ cannot read the reply without
  // CORS, but it still reaches the router (timing, and side effects of a
  // GET). Chrome's Private Network Access blocks that; Firefox and Safari do
  // not. A self-hosted app on the LAN (or localhost) keeps direct access to
  // private hosts, as a frame on that LAN would have. (Under Node — the
  // headless renderers — there is no origin to protect; the guard only
  // applies inside a browser context.) `refusedDirect` says why it may not go
  // straight from the browser, null when it may.
  $frameosRoute__deps: ['$frameosIsPrivateHost'],
  $frameosRoute: function (url) {
    var inBrowser = typeof self !== 'undefined' && self && self.location && typeof self.location.href === 'string'
    var target = null
    try {
      target = inBrowser ? new URL(url, self.location.href) : new URL(url)
    } catch (e) {}
    var refusedDirect = null
    if (inBrowser) {
      if (!target) {
        refusedDirect = 'unparseable'
      } else if (target.origin === self.location.origin || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
        refusedDirect = 'same-origin'
      } else if (frameosIsPrivateHost(target.hostname) && !frameosIsPrivateHost(self.location.hostname)) {
        refusedDirect = 'private-network'
      }
    }
    return { inBrowser: inBrowser, target: target, refusedDirect: refusedDirect }
  },

  // Pictures fetched ahead, several at once (the browser preview's
  // `<img src>`, js_async.nim `urlImage`). The runtime's requests are
  // synchronous, one at a time, so a page of pictures came one a render. The
  // runtime names each picture it wants (fos_wasm_picture), this worker
  // fetches them `atOnce` at a time and keeps what came (`keepBytes` of
  // them, the least recently used let go first), says so as
  // each comes (Module.onFrameosPictures: the preview worker renders again),
  // and the runtime's request for one is answered from here, at once. Kept
  // for this runtime's life: a page seen again draws without the network.
  // Only where a request may go straight from the browser (frameosRoute);
  // through the proxy when the page says it goes first, or when the browser
  // could not reach the origin (CORS), as the request itself would go.
  $frameosPictures: function () {
    if (!Module['frameosPictures']) {
      // `atOnce` fetches in flight, `keepBytes` kept, none over `largest`.
      Module['frameosPictures'] = {
        entries: new Map(),
        bytes: 0,
        flying: 0,
        queue: [],
        atOnce: 6,
        keepBytes: 64 * 1024 * 1024,
        largest: 16 * 1024 * 1024,
      }
    }
    return Module['frameosPictures']
  },

  $frameosPictureFetch__deps: ['$frameosPictures', '$frameosRoute', '$frameosProxyRefusal'],
  $frameosPictureFetch: function (url, entry) {
    var TIMEOUT_MS = 15000
    var pictures = frameosPictures()
    pictures.flying++
    entry.state = 'coming'
    var proxyUrl = Module['frameosProxyUrl']
    var route = frameosRoute(url)
    var origin = route.target ? route.target.origin : null
    var directBlocked = Module['frameosDirectBlocked'] || (Module['frameosDirectBlocked'] = {})
    var get = function (proxied) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = controller ? setTimeout(function () { controller.abort() }, TIMEOUT_MS) : null
      var options = proxied
        ? {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method: 'GET', url: url, headers: {}, bodyBase64: '', timeoutMs: TIMEOUT_MS }),
          }
        : { credentials: 'omit' }
      if (controller) options.signal = controller.signal
      return fetch(proxied ? proxyUrl : url, options)
        .then(function (response) {
          var refusedBy = proxied && response.status === 403 ? response.headers.get('X-FrameOS-Proxy-Refused') : null
          if (refusedBy) {
            var refused = new Error(frameosProxyRefusal(refusedBy, route.target ? route.target.hostname : ''))
            refused.frameosRefusal = true
            throw refused
          }
          return response.arrayBuffer().then(function (body) {
            return { response: response, body: body }
          })
        })
        .then(
          function (got) {
            if (timer) clearTimeout(timer)
            return got
          },
          function (error) {
            if (timer) clearTimeout(timer)
            throw error
          }
        )
    }
    var viaProxy = !!proxyUrl && (Module['frameosProxyFirst'] === true || (origin !== null && directBlocked[origin] === true))
    var attempt = viaProxy
      ? get(true)
      : get(false).catch(function (error) {
          // The browser could not reach it (CORS, mostly): the proxy, from
          // now on for that origin, as fos_nim_http_request goes.
          if (!proxyUrl || origin === null) throw error
          directBlocked[origin] = true
          return get(true)
        })
    var settle = function () {
      pictures.flying--
      while (pictures.flying < pictures.atOnce && pictures.queue.length > 0) {
        var nextUrl = pictures.queue.shift()
        var next = pictures.entries.get(nextUrl)
        if (next && next.state === 'queued') frameosPictureFetch(nextUrl, next)
      }
      if (Module['onFrameosPictures']) Module['onFrameosPictures']()
    }
    attempt.then(
      function (got) {
        if (pictures.entries.get(url) !== entry) return settle()
        var bytes = new Uint8Array(got.body)
        if (bytes.length > pictures.largest) {
          // Too big to keep: the runtime's own request fetches it (`skip`),
          // and says so if it is too big for the runtime too.
          entry.state = 'skip'
          return settle()
        }
        var head = ''
        got.response.headers.forEach(function (value, name) {
          head += name + ': ' + value + '\r\n'
        })
        entry.state = 'here'
        entry.status = got.response.status
        entry.bytes = bytes
        entry.head = head
        pictures.bytes += bytes.length
        // The least recently used go first, never this one.
        var keys = pictures.entries.keys()
        while (pictures.bytes > pictures.keepBytes) {
          var step = keys.next()
          if (step.done) break
          var old = pictures.entries.get(step.value)
          if (old === entry || old.state !== 'here') continue
          pictures.bytes -= old.bytes.length
          pictures.entries.delete(step.value)
        }
        settle()
      },
      function (error) {
        if (pictures.entries.get(url) === entry) {
          entry.state = 'failed'
          entry.refusal = error && error.frameosRefusal ? error.message : ''
          entry.error = String(error)
        }
        settle()
      }
    )
  },

  // The picture at `url`, fetched ahead (frameosPictureFetch): 0 when it is
  // not one this worker fetches ahead (outside a browser, the page's own
  // origin, a private host, one too big to keep: the runtime's request goes
  // as always), 1 while it
  // is coming (asked for now if it was not), 2 when it is here and the
  // runtime's request for it is answered at once.
  fos_wasm_picture__deps: ['$frameosPictures', '$frameosPictureFetch', '$frameosRoute', '$frameosIsPrivateHost'],
  fos_wasm_picture: function (urlPtr) {
    var url = UTF8ToString(urlPtr)
    if (typeof fetch !== 'function') return 0
    var route = frameosRoute(url)
    if (!route.inBrowser || !route.target || route.refusedDirect) return 0
    if (Module['frameosLanAccess'] === false && frameosIsPrivateHost(route.target.hostname)) return 0
    var pictures = frameosPictures()
    var entry = pictures.entries.get(url)
    if (entry) {
      if (entry.state === 'skip') return 0
      return entry.state === 'here' || entry.state === 'failed' ? 2 : 1
    }
    entry = { state: 'queued' }
    pictures.entries.set(url, entry)
    if (pictures.flying < pictures.atOnce) {
      frameosPictureFetch(url, entry)
    } else {
      pictures.queue.push(url)
    }
    return 1
  },

  // Pictures are here that the render left for the next one
  // (js_async.nim `urlImage`): the preview worker renders again soon.
  fos_wasm_pictures_waiting: function () {
    if (Module['onFrameosPictures']) Module['onFrameosPictures']()
  },

  fos_nim_http_request__deps: ['malloc', '$frameosIsPrivateHost', '$frameosLogUrl', '$frameosProxyRefusal', '$frameosRoute'],
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
    outLenPtr,
    outHeadersPtr
  ) {
    {{{ makeSetValue('outStatusPtr', 0, 0, 'i32') }}}
    {{{ makeSetValue('outLenPtr', 0, 0, 'i32') }}}
    var method = UTF8ToString(methodPtr)
    var url = UTF8ToString(urlPtr)
    // When a same-origin proxy is configured, which goes first is the host
    // page's call (`frameosProxyFirst`): a self-hosted backend's proxy is the
    // frame's own (it reaches what the frame reaches, on the owner's machine),
    // so its pages go through it first and the browser never logs a CORS
    // error. The cloud's is a shared escape hatch: requests go straight from
    // the browser first, and only CORS/network failures are retried through
    // it — once per origin (`frameosDirectBlocked`): an origin that failed
    // directly goes to the proxy alone for the rest of this runtime.
    var proxyUrl = Module['frameosProxyUrl']
    // A refusal a scene should see in words (status 0 with the reason as the
    // body, as the ESP32's glue answers a failed connect), not as "failed".
    var refusal = function (message) {
      var error = new Error(message)
      error.frameosRefusal = true
      return error
    }
    // The bytes into the runtime's heap, with the status and the response's
    // header lines, as one answer.
    var answer = function (status, bytes, head) {
      if (maxBytes > 0 && bytes.length > maxBytes) {
        if (Module['onFrameosLog']) {
          Module['onFrameosLog']('http: response for ' + frameosLogUrl(url) + ' exceeded ' + maxBytes + ' bytes')
        }
        return 0
      }
      var ptr = _malloc(bytes.length > 0 ? bytes.length : 1)
      if (!ptr) return 0
      HEAPU8.set(bytes, ptr)
      if (outHeadersPtr) {
        // frameos.httpRequest's `headers`: "name: value" lines into the
        // caller's 2048-byte block (FOS_NIM_HTTP_HEADERS_BYTES, as the ESP32
        // glue writes it), whole lines only. Through the proxy they are the
        // proxy's answer's.
        var lines = new TextEncoder().encode(head || '')
        var fit = lines.length
        if (fit > 2047) fit = lines.lastIndexOf(10, 2046) + 1
        HEAPU8.set(lines.subarray(0, fit), outHeadersPtr)
        HEAPU8[outHeadersPtr + fit] = 0
      }
      {{{ makeSetValue('outStatusPtr', 0, 'status', 'i32') }}}
      {{{ makeSetValue('outLenPtr', 0, 'bytes.length', 'i32') }}}
      return ptr
    }
    // A refusal's words as the request's error (status 0): they name a host,
    // never a path or a query.
    var refusalAnswer = function (message) {
      var said = new TextEncoder().encode(message)
      var saidPtr = _malloc(said.length > 0 ? said.length : 1)
      if (saidPtr) {
        HEAPU8.set(said, saidPtr)
        {{{ makeSetValue('outLenPtr', 0, 'said.length', 'i32') }}}
      }
      return saidPtr
    }
    // A picture fetched ahead (frameosPictureFetch): answered from what came,
    // and a failure said once, then asked again next time.
    var pictures = method === 'GET' && bodyLen === 0 ? Module['frameosPictures'] : null
    var kept = pictures ? pictures.entries.get(url) : null
    if (kept && kept.state === 'here') {
      pictures.entries.delete(url)
      pictures.entries.set(url, kept)
      return answer(kept.status, kept.bytes, kept.head)
    }
    if (kept && kept.state === 'failed') {
      pictures.entries.delete(url)
      if (Module['onFrameosLog']) {
        var failedAt = frameosLogUrl(url)
        Module['onFrameosLog']('http: GET ' + failedAt + ' failed: ' + (url ? String(kept.error).split(url).join(failedAt) : kept.error))
      }
      return kept.refusal ? refusalAnswer(kept.refusal) : 0
    }
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

      // Where it may go from here (frameosRoute: never the app's own origin
      // straight, nor the viewer's network from a public page).
      var route = frameosRoute(url)
      var refusedDirect = route.refusedDirect
      var inBrowser = route.inBrowser
      var target = route.target

      // A cloud frame's local network access (docs/lan-access.md), when the
      // host page says what it is (`frameosLanAccess: false`): a preview of a
      // cloud frame with it off refuses a private host the way the frame
      // would, neither direct nor through the proxy, and in the frame's words —
      // the SPA's logs panel matches the start of them to link to the setting.
      // A same-origin target keeps its own path (the proxy only, above).
      if (Module['frameosLanAccess'] === false && refusedDirect !== 'same-origin') {
        if (target && (target.protocol === 'http:' || target.protocol === 'https:') &&
            frameosIsPrivateHost(target.hostname)) {
          throw refusal(frameosProxyRefusal('local-network', target.hostname))
        }
      }

      // Which origins already failed directly (CORS, mostly), for this
      // runtime's life: the next request to one goes to the proxy alone.
      var directBlocked = Module['frameosDirectBlocked'] || (Module['frameosDirectBlocked'] = {})
      var directKey = inBrowser && !refusedDirect ? target.origin : null
      var skipDirect = !!proxyUrl && (Module['frameosProxyFirst'] === true || (directKey !== null && directBlocked[directKey] === true))

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
      if (!skipDirect) {
        try {
          xhr = directRequest()
        } catch (e) {
          // A cross-origin host without CORS headers throws on sync send.
          directError = e
        }
        if ((xhr === null || xhr.status === 0) && directKey !== null) {
          directBlocked[directKey] = true
        }
      }
      if ((xhr === null || xhr.status === 0) && proxyUrl) {
        xhr = proxyRequest()
        var refusedBy = xhr.status === 403 && xhr.getResponseHeader ? xhr.getResponseHeader('X-FrameOS-Proxy-Refused') : null
        if (refusedBy) {
          throw refusal(frameosProxyRefusal(refusedBy, target ? target.hostname : frameosLogUrl(url)))
        }
      } else if (xhr === null) {
        throw directError
      }

      var bytes
      if (xhr.response instanceof ArrayBuffer) {
        bytes = new Uint8Array(xhr.response)
      } else {
        bytes = new TextEncoder().encode(xhr.responseText || '')
      }
      // A Node renderer's XHR shim may have no getAllResponseHeaders.
      return answer(xhr.status, bytes, (xhr.getAllResponseHeaders && xhr.getAllResponseHeaders()) || '')
    } catch (e) {
      if (Module['onFrameosLog']) {
        // A browser's network error can quote the URL it failed on, too.
        var origin = frameosLogUrl(url)
        var reason = url ? String(e).split(url).join(origin) : String(e)
        Module['onFrameosLog']('http: ' + method + ' ' + origin + ' failed: ' + reason)
      }
      if (e && e.frameosRefusal) {
        // Its words go to the scene as the request's error.
        return refusalAnswer(e.message)
      }
      return 0
    }
  },

  fos_nim_http_free__deps: ['free'],
  fos_nim_http_free: function (ptr) {
    if (ptr) _free(ptr)
  },
})
