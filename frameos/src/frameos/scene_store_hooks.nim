## The scene store's hooks (docs/scene-store.md): what a JS app reads with
## `frameos.store()` and asks with `frameos.storeAction(action, args)`. The
## Scene store sample scene is the app that uses them; any app may.
##
## The host has the facts and does the work, off the render task: the Pi's
## frameos/scene_store_linux.nim, the ESP32's main/fos_store.c through
## embedded/embedded_runtime.nim. A runtime without a host (the browser
## preview, a frame rendered on its control plane) leaves them nil, and the
## app reads null: it browses with `frameos.fetchJson` and installs nothing.

type
  SceneStoreRead* = proc (asker: string): string {.nimcall, gcsafe, raises: [].}
    ## JSON text, handed to the app as it is (the ESP32's comes from C, and
    ## parsing it here only to print it again would cost flash). "": no store on this frame (the owner turned the settings on the
    ## frame's screen off, `frame_settings_on_screen`). Else what the host
    ## knows now: {url: the store it browses, version: this FrameOS, busy:
    ## the action running or "", error: the last action's refusal code,
    ## done: the last action that worked ("uptodate": an update with nothing
    ## newer), params: what the listing below answers, listing: the store's
    ## answer as it came or null, installed: [{id, store, v}] (every scene on
    ## the frame that came from the store: its runtime id, store scene id and
    ## version), preview: {store, id, name} or null, removeAny: a scene not
    ## from the store may be removed too (a frame with no control plane),
    ## previewOnly: the browser preview's host, which installs nothing}.
    ## `asker` is the scene reading: news redraws it while it shows.
  SceneStoreAction* = proc (asker, action, args: string) {.nimcall, gcsafe, raises: [].}
    ## `args` is a JSON object's text. browse {params: the listing's query string}, preview {store, name},
    ## install {store, name, show}, update {store or id}, remove {store or
    ## id}, discard. One at a time: an action while one runs is dropped. The
    ## host asks for a render of `asker` when what it knows changed.

var
  sceneStoreRead*: SceneStoreRead
  sceneStoreAction*: SceneStoreAction

proc validStoreParams*(params: string): bool =
  ## A listing's query string as an app may hand it over: what a URL's query
  ## holds, nothing that could leave it (no `#`, no spaces, no `/`).
  if params.len > 400:
    return false
  for ch in params:
    if ch notin {'a'..'z', 'A'..'Z', '0'..'9', '-', '_', '.', '~', '%', '&', '=', '+', ','}:
      return false
  true
