## The scene store's host in the browser preview (docs/scene-store.md,
## frameos/scene_store_hooks.nim): previews only. The Scene store app browses
## through it and can Preview a store scene in the preview itself, Show it
## again and Discard it; Install, Update and Delete are a frame's
## (`previewOnly` in the facts, and `preview_only` if asked anyway).
##
## Only the browser's preview worker turns it on (wasm/wasm_main.nim,
## `frameos_wasm_set_store_preview`): a plane rendering a board or a virtual
## frame runs a fresh runtime per render, where a preview would be gone at
## the next one. The preview runs in a Web Worker whose requests are
## synchronous, so an action is done by the time it returns. Loading the
## scenes and switching to them waits for the runtime's next pass
## (`takeStorePreviewChange`): the action comes from inside the store app's
## own tap.

import std/[json, strutils]
import frameos/types
import frameos/interpreter
import frameos/scene_store_hooks

type
  StorePreviewFetch* = proc (url: string): tuple[code: int, body: string] {.nimcall, gcsafe, raises: [].}
    ## A GET of `url`: the status (0 when it did not answer) and the body.

  StorePreviewChangeKind* = enum
    spcNone, spcShow, spcDiscard

  StorePreviewChange* = object
    ## What the runtime does on its next pass: load `scenes` beside the ones it
    ## has and show the first (spcShow), or drop `dropIds` and go back to
    ## `back` (spcDiscard; a new preview also drops the old one first).
    kind*: StorePreviewChangeKind
    scenes*: seq[FrameSceneInput]
    dropIds*: seq[string]
    back*: string

var
  storeBase = ""
  storeVersion = ""
  storeFetch: StorePreviewFetch
  listing: JsonNode
  listingParams = ""
  lastError = ""
  lastDone = ""
  previewStore = ""
  previewName = ""
  previewBack = ""
  previewIds: seq[string]
  pending: StorePreviewChange

proc isStoreId(id: string): bool =
  ## What a store scene's id is (and so all that may go into its path): a UUID.
  if id.len != 36:
    return false
  for ch in id:
    if ch notin {'0'..'9', 'a'..'f', 'A'..'F', '-'}:
      return false
  true

proc storePreviewRead*(asker: string): string {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if storeBase.len == 0:
      return ""
    try:
      let facts = %*{
        "url": storeBase, "version": storeVersion, "busy": "", "error": lastError, "done": lastDone,
        "params": listingParams, "installed": newJArray(), "removeAny": false, "previewOnly": true,
      }
      facts["listing"] = if listing.isNil: newJNull() else: listing
      facts["preview"] =
        if previewIds.len == 0: newJNull()
        else: %*{"store": previewStore, "id": previewIds[0], "name": previewName}
      result = $facts
    except CatchableError:
      result = ""

proc browse(params: string) =
  if not validStoreParams(params):
    return
  let (code, body) = storeFetch(storeBase & "/api/store/device/scenes?version=" & storeVersion &
    (if params.len > 0: "&" & params else: ""))
  if code != 200:
    lastError = if code == 429: "rate_limited" else: "store_unavailable"
    return
  let answer = parseJson(body)
  if answer.kind != JObject or answer{"scenes"}.isNil or answer{"scenes"}.kind != JArray:
    lastError = "store_unavailable"
    return
  listing = answer
  listingParams = params

proc preview(asker, store, name: string) =
  if not isStoreId(store):
    lastError = "invalid_scene"
    return
  let (code, body) = storeFetch(storeBase & "/api/store/scenes/" & store & "/scenes.json")
  if code == 404:
    lastError = "invalid_scene"
    return
  if code != 200:
    lastError = if code == 429: "rate_limited" else: "store_unavailable"
    return
  let scenes = parseInterpretedSceneInputs(body)
  if scenes.len == 0:
    lastError = "invalid_scene"
    return
  # Going back from a preview of a preview is going back to the store.
  let back = if previewIds.len > 0 and previewBack.len > 0: previewBack else: asker
  pending = StorePreviewChange(kind: spcShow, scenes: scenes, dropIds: previewIds, back: back)
  previewIds = @[]
  for scene in scenes:
    previewIds.add(scene.id.string)
  previewStore = store
  previewName = name
  previewBack = back
  lastDone = "preview"

proc discardPreview() =
  if previewIds.len == 0:
    return
  pending = StorePreviewChange(kind: spcDiscard, dropIds: previewIds, back: previewBack)
  previewIds = @[]
  previewStore = ""
  previewName = ""
  lastDone = "discard"

proc storePreviewAction*(asker, action, args: string) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if storeBase.len == 0:
      return
    lastError = ""
    lastDone = ""
    try:
      let given = parseJson(if args.len > 0: args else: "{}")
      case action
      of "browse": browse(given{"params"}.getStr())
      of "preview": preview(asker, given{"store"}.getStr(), given{"name"}.getStr())
      of "discard": discardPreview()
      of "install", "update", "remove": lastError = "preview_only"
      else: discard
    except Exception:
      lastError = "store_unavailable"

proc enableStorePreview*(base, version: string, fetch: StorePreviewFetch) =
  ## The hooks answer from now on, for the store at `base` (no trailing `/`).
  storeBase = base.strip(leading = false, chars = {'/'})
  storeVersion = version
  storeFetch = fetch
  sceneStoreRead = storePreviewRead
  sceneStoreAction = storePreviewAction

proc takeStorePreviewChange*(): StorePreviewChange =
  ## The change the last action asked for, once: the runtime applies it at the
  ## start of a pass.
  result = move pending
  pending = StorePreviewChange()

proc resetStorePreviewForTests*() =
  storeBase = ""
  listing = nil
  listingParams = ""
  lastError = ""
  lastDone = ""
  previewStore = ""
  previewName = ""
  previewBack = ""
  previewIds = @[]
  pending = StorePreviewChange()
  sceneStoreRead = nil
  sceneStoreAction = nil
