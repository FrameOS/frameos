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

addToLibrary({
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

  fos_nim_http_request__deps: ['malloc'],
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

      // Synchronous XHR: the Nim/pixie pipeline is fully synchronous and this
      // module runs in a Web Worker, where sync XHR is permitted.
      var directRequest = function () {
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
