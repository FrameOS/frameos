// FrameOS live-preview worker.
//
// Loads the emscripten-built scene runtime (frameos.js/frameos.wasm, built by
// frameos/tools/build_wasm.sh) and drives it for the frontend's live-preview
// modal. Runs in a Web Worker so the runtime's synchronous HTTP hook (sync
// XHR) is allowed and long renders never block the page.
//
// Messages in:
//   {type: 'init', width, height, timeZone, scenesJson, sceneId, settingsJson, proxyUrl}
//   {type: 'render'}                       force a render now
//   {type: 'event', name, payload}         dispatch a scene event
//   {type: 'selectScene', sceneId}
// Messages out:
//   {type: 'ready', sceneInfo}
//   {type: 'frame', width, height, buffer, renderMs}   buffer: transferred ArrayBuffer (RGBA)
//   {type: 'state', state}
//   {type: 'log', message}
//   {type: 'sceneEvent', name, payload}
//   {type: 'error', message}

let Module = null
let renderTimer = null
let rendering = false

function post(msg, transfer) {
  self.postMessage(msg, transfer || [])
}

function call(name, ret, argTypes, args) {
  return Module.ccall(name, ret, argTypes, args)
}

function lastError() {
  try {
    return call('frameos_wasm_last_error', 'string', [], [])
  } catch (e) {
    return String(e)
  }
}

function postState() {
  try {
    const state = call('frameos_wasm_scene_state', 'string', [], [])
    post({ type: 'state', state: JSON.parse(state) })
  } catch (e) {
    // state is informational; ignore
  }
}

function renderNow() {
  if (!Module || rendering) {
    return
  }
  rendering = true
  try {
    const started = Date.now()
    const rc = call('frameos_wasm_render', 'number', [], [])
    const width = call('frameos_wasm_width', 'number', [], [])
    const height = call('frameos_wasm_height', 'number', [], [])
    const ptr = call('frameos_wasm_buffer', 'number', [], [])
    const len = call('frameos_wasm_buffer_len', 'number', [], [])
    if (rc === 2 || !ptr || !len) {
      post({ type: 'error', message: 'render failed: ' + lastError() })
      return
    }
    // Copy out of the wasm heap; the buffer is transferred to the page.
    const buffer = Module.HEAPU8.buffer.slice(ptr, ptr + len)
    post({ type: 'frame', width, height, buffer, renderMs: Date.now() - started }, [buffer])
    postState()
  } catch (e) {
    post({ type: 'error', message: 'render crashed: ' + e })
  } finally {
    rendering = false
    scheduleNextRender()
  }
}

function scheduleNextRender() {
  if (!Module) {
    return
  }
  if (renderTimer) {
    clearTimeout(renderTimer)
    renderTimer = null
  }
  let seconds = 0
  try {
    const interval = call('frameos_wasm_scene_interval', 'number', [], [])
    const nextSleep = call('frameos_wasm_next_sleep', 'number', [], [])
    seconds = interval > 0 ? interval : 300
    if (nextSleep >= 0 && nextSleep < seconds) {
      seconds = nextSleep
    }
  } catch (e) {
    seconds = 300
  }
  // Keep the preview responsive but sane: at least 1 fps worth of delay,
  // at most 15 minutes between refreshes.
  const delayMs = Math.min(Math.max(seconds * 1000, 1000), 15 * 60 * 1000)
  renderTimer = setTimeout(renderNow, delayMs)
}

function renderSoonIfRequested() {
  try {
    if (call('frameos_wasm_render_requested', 'boolean', [], [])) {
      renderNow()
    } else {
      postState()
    }
  } catch (e) {
    post({ type: 'error', message: String(e) })
  }
}

async function init(msg) {
  try {
    const createFrameOS = (await import('./frameos.js')).default
    Module = await createFrameOS({
      locateFile: (path) => new URL(path, import.meta.url).href,
      onFrameosLog: (message) => post({ type: 'log', message }),
      onFrameosEvent: (name, payload) => {
        let parsed = {}
        try {
          parsed = JSON.parse(payload)
        } catch (e) {}
        post({ type: 'sceneEvent', name, payload: parsed })
      },
    })
    // Route the runtime's HTTP requests through the backend proxy (same-origin,
    // no CORS) so data apps that fetch external URLs work like on the device.
    if (msg.proxyUrl) {
      Module['frameosProxyUrl'] = msg.proxyUrl
    }

    const ok = call(
      'frameos_wasm_init',
      'boolean',
      ['number', 'number', 'string', 'string', 'string'],
      [
        msg.width,
        msg.height,
        msg.name || 'live preview',
        msg.timeZone || 'UTC',
        msg.settingsJson || '{}',
      ]
    )
    if (!ok) {
      throw new Error('init failed: ' + lastError())
    }
    const loaded = call('frameos_wasm_load_scenes', 'number', ['string'], [msg.scenesJson])
    if (!loaded) {
      throw new Error('no scenes loaded: ' + lastError())
    }
    if (msg.sceneId) {
      call('frameos_wasm_select_scene', 'boolean', ['string'], [msg.sceneId])
    }
    const sceneInfo = JSON.parse(call('frameos_wasm_scene_info', 'string', [], []))
    post({ type: 'ready', sceneInfo })
    renderNow()
  } catch (e) {
    post({ type: 'error', message: String(e && e.message ? e.message : e) })
  }
}

self.onmessage = (ev) => {
  const msg = ev.data || {}
  switch (msg.type) {
    case 'init':
      init(msg)
      break
    case 'render':
      renderNow()
      break
    case 'event':
      if (Module) {
        try {
          call(
            'frameos_wasm_event',
            'boolean',
            ['string', 'string'],
            [msg.name, JSON.stringify(msg.payload || {})]
          )
        } catch (e) {
          post({ type: 'error', message: 'event failed: ' + e })
        }
        renderSoonIfRequested()
      }
      break
    case 'selectScene':
      if (Module) {
        call('frameos_wasm_select_scene', 'boolean', ['string'], [msg.sceneId])
        renderNow()
      }
      break
    default:
      break
  }
}
