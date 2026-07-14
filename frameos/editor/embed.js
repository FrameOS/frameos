// Parent-side helper for embedding the FrameOS scene editor. Creates an
// iframe pointing at the editor bundle (this package's dist/index.html,
// served from your own host) and speaks its postMessage protocol:
//   in:  {type: 'frameos-editor:init', scenes, sceneId?, mode?, width?, height?, interval?, theme?, previewProxyUrl?, description?}
//        {type: 'frameos-editor:get-scenes'} · {type: 'frameos-editor:select-scene', sceneId}
//   out: {type: 'frameos-editor:ready'} · {type: 'frameos-editor:scenes', scenes}
//        {type: 'frameos-editor:save-screenshot', dataUrl, sceneId} (ack with 'frameos-editor:screenshot-saved')
//
// The editor bundle is AGPL-licensed FrameOS code running at arm's length in
// its own frame; this helper is part of the same package.

export function createFrameOSEditor({
  container,
  url,
  scenes,
  sceneId,
  mode = 'rpios',
  width = 800,
  height = 480,
  interval = 300,
  theme,
  previewProxyUrl,
  description,
  onScenesChanged,
  onReady,
}) {
  const iframe = document.createElement('iframe')
  iframe.src = url
  iframe.style.width = '100%'
  iframe.style.height = '100%'
  iframe.style.border = '0'
  container.appendChild(iframe)

  const editorOrigin = new URL(url, location.href).origin
  let latestScenes = scenes
  let latestSceneId = sceneId
  let ready = false
  const sceneWaiters = []

  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow || event.origin !== editorOrigin) {
      return
    }
    const message = event.data
    if (!message || typeof message !== 'object') {
      return
    }
    if (message.type === 'frameos-editor:ready') {
      ready = true
      post({
        type: 'frameos-editor:init',
        scenes: latestScenes,
        sceneId: latestSceneId,
        mode,
        width,
        height,
        interval,
        theme,
        previewProxyUrl,
        description,
      })
      onReady?.()
    } else if (message.type === 'frameos-editor:scenes' && Array.isArray(message.scenes)) {
      latestScenes = message.scenes
      while (sceneWaiters.length > 0) {
        sceneWaiters.shift()(message.scenes)
      }
      onScenesChanged?.(message.scenes)
    }
  }

  function post(message) {
    iframe.contentWindow?.postMessage(message, editorOrigin)
  }

  window.addEventListener('message', onMessage)

  return {
    iframe,
    /** Latest scenes as reported by the editor (kept current on every edit). */
    getScenesSync: () => latestScenes,
    /** Ask the editor for its current scenes. */
    getScenes: () =>
      new Promise((resolve) => {
        if (!ready) {
          resolve(latestScenes)
          return
        }
        sceneWaiters.push(resolve)
        post({ type: 'frameos-editor:get-scenes' })
      }),
    /** Replace the loaded scenes (re-initializes the editor). */
    setScenes: (nextScenes, nextSceneId) => {
      latestScenes = nextScenes
      latestSceneId = nextSceneId
      post({
        type: 'frameos-editor:init',
        scenes: nextScenes,
        sceneId: nextSceneId,
        mode,
        width,
        height,
        interval,
        theme,
        previewProxyUrl,
        description,
      })
    },
    selectScene: (nextSceneId) => {
      latestSceneId = nextSceneId
      post({ type: 'frameos-editor:select-scene', sceneId: nextSceneId })
    },
    destroy: () => {
      window.removeEventListener('message', onMessage)
      iframe.remove()
    },
  }
}
