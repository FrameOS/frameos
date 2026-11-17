## The code editor's host in the browser preview (docs/code-editor.md,
## frameos/scene_code_hooks.nim): it reads, and saves or asks nothing. A scene's
## source is what the page loaded (`frameos_wasm_load_scenes`); the facts say
## `previewOnly`, and the app says saving and asking happen on a frame.
##
## Only the browser's preview worker turns it on (wasm/wasm_main.nim, with the
## scene store's preview): a plane rendering a board or a virtual frame runs a
## fresh runtime per render, which has nobody to read code to.

import std/json
import frameos/scene_code_hooks

var
  loaded = "" ## the payload the page loaded last, as text

proc codePreviewLoaded*(payload: string) =
  ## The page's scenes, kept as the text it sent: the page may turn the host
  ## on after it loaded them.
  loaded = payload

proc previewRead(asker: string): string {.nimcall, gcsafe, raises: [].} =
  """{"busy":"","error":"","done":"","draft":null,"ask":false,"save":false,"previewOnly":true}"""

proc previewSource(what: string): string {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if what == DraftSource or loaded.len == 0:
      return ""
    try:
      for scene in parseJson(loaded).getElems():
        if scene.kind == JObject and scene{"id"}.getStr() == what:
          return $scene
    except Exception:
      discard

proc previewAction(asker, action, args: string) {.nimcall, gcsafe, raises: [].} =
  discard

proc enableCodePreview*() =
  sceneCodeRead = previewRead
  sceneCodeSource = previewSource
  sceneCodeAction = previewAction
