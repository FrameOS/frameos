import frameos/types
import frameos/values
import frameos/spool
from frameos/apps as frameos_apps import spoolDir
from frameos/utils/image import renderError, renderErrorInto, spillImageToSpool, materializeImageSpool, scaleAndDrawImage
from frameos/utils/memory import renderMemoryInUse, availableRenderBytes,
  availableRenderHeadroomBytes, runsAsEmbedded
when defined(testing):
  from frameos/utils/memory import availableRenderBytesOverride
when defined(memProbe): import frameos/utils/memory
import frameos/js_runtime/app_runtime
import frameos/js_runtime/runtime
import frameos/retired_apps
import frameos/channels
import frameos/js_runtime/run_budget
import frameos/node_config
import frameos/event_log
import frameos/events
import frameos/planner
import frameos/refresh_interval
import frameos/render_scale
import frameos/runtime_diagnostics
import frameos/scene_rhythm
import frameos/layout_choice
import frameos/ui/events as ui_events
import frameos/utils/canvas_log
from frameos/utils/svg_frames import takePanelRegion, forgetPanelRegions
import frameos/events_gen
import std/hashes
from frameos/utils/app_images import paintPendingBackground
import tables, json, os, zippy, chroma, pixie, jsony, sequtils, options, strutils, times, math
import apps/apps

# What a scene's dispatch node may not reach is the contract's: every event
# whose `origins` (docs/events-contract.json) does not list "scene".

var eventListenersRun* {.threadvar.}: int
  ## Counts every event listener a run has started. Nothing in the runtime
  ## reads it any more (the render rule is the dispatcher's, and looks at scene
  ## state); the event fixtures do, to say how many listeners an event reached.

const TRACING = false
const EmbeddedMaxCachedImageBytes = 1024 * 1024

when defined(testing):
  var cachedImageMemoryLimitOverride* = 0
    ## Lets host tests exercise the embedded cache-image tiers (the disk spill
    ## and the live-canvas upgrade) without an embedded build.

proc cachedImageMemoryLimit(): int =
  ## Above this many bytes the node cache does not hold an image in memory: it
  ## goes to the disk tier instead, or is not stored at all when there is no
  ## disk to take it. 0 means no limit, which is the host behavior — a host
  ## can afford to keep what it cached.
  ##
  ## The editor's preview running as an ESP32 takes the device's limit too.
  ## It used to keep a host's, so a cached producer on a 1600x1200 frame was
  ## always handed a canvas-sized scratch: 7.68 MB the device never allocates
  ## (past this limit with no room for one it decodes into the live canvas),
  ## and the preview ran out of memory where the frame renders.
  when defined(testing):
    if cachedImageMemoryLimitOverride > 0:
      return cachedImageMemoryLimitOverride
  if runsAsEmbedded():
    EmbeddedMaxCachedImageBytes
  else:
    0

const FlowAppsSettlingBackground = ["render/svg", "render/split"]
  ## Flow apps that settle the scene background still owed themselves (paint
  ## it before their first paint, or waive it when that paint covers the
  ## canvas), so it is not painted ahead of them. render/svg: a full-canvas
  ## background rect is how most SVG scenes begin, and the canvas was filled
  ## twice per render; on an LCD it also repaints only what changed
  ## (utils/svg_frames.nim), which a fill ahead of it would have wiped.

proc affordsKeeping(image: Image, memoryLimit: int, context: ExecutionContext): bool =
  ## An image over the memory cache's limit is still kept while the frame
  ## affords it easily: with it held (it is allocated already), render
  ## headroom stays at or above that limit, room for as much again as the
  ## memory tier holds of its own accord. A slideshow's photo under an
  ## animation (render/zoomPan at 24 fps) is a cached producer's output every
  ## frame, and refused here every frame decoded it again: 6 s a frame on the
  ## SenseCAP Indicator (2026-10-25). The bar was 2 MB of headroom at first,
  ## and that board's 1 MB photo left 2.03 MB: for the first minute after a
  ## boot a few KB of TLS buffers put it under, and the slideshow decoded at
  ## 0.2 fps until they went (2026-10-26). The live canvas is never kept: a
  ## hit would redraw it onto itself.
  if context != nil and context.hasImage and not context.image.isNil and
      image.bufferPointer == context.image.bufferPointer:
    return false
  when defined(testing):
    # A host's headroom is its own RAM; a test says what the frame has.
    availableRenderBytesOverride >= memoryLimit
  else:
    availableRenderHeadroomBytes() >= memoryLimit

var imageSpillDisabled = false
  ## Latched on the first failed spill write, so a full or vanished card is
  ## probed once instead of on every render. Reset when scenes reload.

proc imageSpillRefusalReason(frameConfig: FrameConfig, scratchBytes: int): string =
  ## Whether an over-limit cached producer should still get an owned scratch,
  ## because the disk tier can store what the memory cache would refuse — and
  ## when not, *why* not, because "why is this scene re-downloading every
  ## render" must be a log line, not an archaeology project (the same rule
  ## the planner's refusals follow). Two conditions: somewhere to write, and
  ## room to live — the scratch is PSRAM held for the whole render next to
  ## the canvas and the producer's decode intermediates, so demand an equal
  ## share of headroom beyond the scratch itself. Returns "" when the disk
  ## tier can take the value.
  if imageSpillDisabled:
    return "spill disabled after an earlier storage failure"
  let contiguous = availableRenderBytes()
  if contiguous <= 0:
    return "available render memory unknown"
  if contiguous < scratchBytes:
    # The scratch is one allocation; it needs one block.
    return "largest free block " & $(contiguous div 1024) &
      "K cannot hold the " & $(scratchBytes div 1024) & "K scratch"
  let headroom = availableRenderHeadroomBytes()
  if headroom < 2 * scratchBytes:
    # The scratch lives next to the canvas and the producer's decode
    # intermediates for the whole render; those pieces need not be
    # contiguous, so this is a total-free question, not a block question —
    # the bench frame keeps ~1.7MB blocks inside 5MB free, and asking the
    # block answer here refused every spill the board could afford.
    return "headroom " & $(headroom div 1024) & "K is under 2x the " &
      $(scratchBytes div 1024) & "K scratch"
  if spoolScratchDir(spoolDir(frameConfig)).len == 0:
    return "no writable spill storage"
  ""

proc trySpillCachedImage(scene: InterpretedFrameScene, nodeId: NodeId,
    image: Image, context: ExecutionContext): ImageSpool =
  ## The store side of the cache's disk tier. Returns nil whenever spilling
  ## would be unsafe or storage will not take it — every nil means "store
  ## nothing", which is yesterday's behavior.
  ##
  ## The safety rule: only pixels the producer alone wrote may be snapshotted.
  ## An owned scratch or a self-allocated image is exactly the value a memory
  ## cache would have held, so the file is pixel-exact by construction. The
  ## live canvas is not: a contain fit leaves the margins holding whatever
  ## rendered before the producer this pass, and a compositing producer (JS,
  ## SVG) blends over the same — baking either into the cache would replay a
  ## stale background over later renders.
  ## "skipped", not an error: nothing failed, the cache simply holds nothing
  ## for this value. Logged only when the reason is worth a look; the canvas
  ## alias below is the by-design case for every scene that draws one image
  ## straight onto the canvas, so it fires on nearly every render and used to
  ## read like a failure in the logs ("imageSpill:refused", 2026-10-12).
  proc refuse(reason: string, debugOnly = false): ImageSpool =
    if not debugOnly or scene.frameConfig.debug:
      scene.logger.log(%*{
        "event": "interpreter:cache:imageSpill:skipped",
        "sceneId": scene.id.string,
        "nodeId": nodeId.int,
        "reason": reason
      })
    nil

  if imageSpillDisabled:
    return refuse("spill disabled after an earlier storage failure")
  if context != nil and context.hasImage and not context.image.isNil and
      image.bufferPointer == context.image.bufferPointer:
    return refuse("value aliases the live canvas", debugOnly = true)
  # The disk tier exists for canvas-shaped values. A native-resolution decode
  # that some unfused shape materialized (tens of MB) would cost a huge write
  # on every miss and could never be read back under the render budget anyway.
  let bytes = image.byteSize
  var cap = 4 * cachedImageMemoryLimit()
  if context != nil and context.hasImage and not context.image.isNil:
    # The disk tier stores RGBX rows whatever the canvas format, so the cap
    # is the canvas's pixel count at 4 bytes, not its own byte size.
    cap = max(cap, context.image.width * context.image.height * 4)
  if bytes > cap:
    return refuse($(bytes div 1024) & "K is over the " &
      $(cap div 1024) & "K spill cap")
  # Room on the storage, with its own reason: this is the everyday answer on
  # the ESP32's generic 8 MB layout (a 1 MB state partition, no SD card) and
  # it must neither disable the tier — free space comes and goes — nor read
  # as a storage failure.
  let dir = spoolScratchDir(spoolDir(scene.frameConfig))
  if dir.len == 0:
    return refuse("no writable spill storage")
  let shortfall = spoolHeadroomShortfall(dir, image.width * image.height * 4)
  if shortfall.len > 0:
    return refuse(shortfall)
  result = spillImageToSpool(image, "node" & $nodeId.int & "-cache.rgbx",
    spoolDir(scene.frameConfig))
  if result.isNil:
    imageSpillDisabled = true
    return refuse("storage write failed; disk tier disabled until scenes reload")
  scene.logger.log(%*{
    "event": "interpreter:cache:imageSpill",
    "sceneId": scene.id.string,
    "nodeId": nodeId.int,
    "bytes": bytes,
    "path": result.path()
  })

proc appSourcesFromSceneApps(scene: FrameScene, keyword: string): JsonNode =
  if scene of InterpretedFrameScene:
    let apps = InterpretedFrameScene(scene).apps
    if not apps.isNil and apps.kind == JObject and apps.hasKey(keyword):
      let app = apps[keyword]
      if not app.isNil and app.kind == JObject and app.hasKey("sources") and app["sources"].kind == JObject:
        return app["sources"]
  nil

proc initInterpretedApp(keyword: string, node: DiagramNode, scene: FrameScene): AppRoot =
  var sources = node.data{"sources"}
  if not hasJsAppSource(sources):
    sources = appSourcesFromSceneApps(scene, keyword)
  if not hasJsAppSource(sources):
    # A scene still on disk from before this runtime dropped a built-in app
    # (data/immich): run the JavaScript app that replaced it. Linux only —
    # see frameos/retired_apps.nim.
    sources = retiredAppSources(keyword)
  if hasJsAppSource(sources):
    return initDynamicJsApp(keyword, node, scene, sources)
  initApp(keyword, node, scene)

proc setInterpretedAppField(keyword: string, app: AppRoot, field: string, value: Value) =
  if app.isDynamicJsApp():
    app.setDynamicJsAppField(field, value)
  else:
    apps.setAppField(keyword, app, field, value)

proc getInterpretedApp(keyword: string, app: AppRoot, context: ExecutionContext): Value =
  if app.isDynamicJsApp():
    return app.getDynamicJsApp(context)
  apps.getApp(keyword, app, context)

proc runInterpretedApp(keyword: string, app: AppRoot, context: ExecutionContext) =
  if app.isDynamicJsApp():
    if isRetiredRenderApp(keyword) and context.hasImage and not context.image.isNil:
      # A render/chart or render/calendar node still on a Pi's disk runs its JavaScript port,
      # which returns its image instead of drawing it (frameos/retired_apps.nim).
      let value = app.getDynamicJsApp(context)
      if value.kind == fkImage and not value.asImage().isNil:
        scaleAndDrawImage(context.image, value.asImage(), "stretch")
      return
    app.runDynamicJsApp(context)
  else:
    apps.runApp(keyword, app, context)

proc evalInline(scene: InterpretedFrameScene,
                context: ExecutionContext,
                nodeId: NodeId,
                name: string,
                snippet: string,
                mapping: var Table[NodeId, Table[string, string]],
                ensureCompiled: InlineCompileProc,
                targetField: string): Value =
  let emptyArgs = initTable[string, Value]()
  let emptyArgTypes = initTable[string, string]()
  let emptyOutputs = initTable[string, string]()
  var fnName = ""
  if mapping.hasKey(nodeId) and mapping[nodeId].hasKey(name):
    fnName = mapping[nodeId][name]
  else:
    ensureCompiled(scene, nodeId, name, snippet)
    fnName = mapping[nodeId][name]
  callCompiledFn(scene, context, nodeId, fnName, emptyArgs, emptyArgTypes, emptyOutputs, targetField)

# -------------------------
# Cache utilities
# -------------------------

# Turn an interpreter Value into a stable JSON "key" snippet for cache-keying.
proc valueToKeyJson(v: Value): JsonNode =
  case v.kind
  of fkImage:
    # Images aren't JSON; key by dimensions (pointer identity would be fragile).
    let im = v.asImage()
    result = %* {"__image": {"w": im.width, "h": im.height}}
  of fkImageSpool:
    # Same identity as an in-memory image: the tier a value happens to sit in
    # must never change what it keys as.
    result = %* {"__image": {"w": v.imgSp.width, "h": v.imgSp.height}}
  of fkColor:
    result = %* v.asColor().toHtmlHex
  of fkJson:
    if v.asJson().isNil: result = %* {}
    else: result = v.asJson()
  of fkSpool:
    # Key by size + a content hash computed a window at a time. The whole point
    # of a file-backed spool is that the body is not resident; the cache key
    # must not be the thing that pulls a 4MB feed back into memory and parks it
    # in cacheKeys for the cache's lifetime. Byte-wise FNV-1a so the key
    # depends only on the bytes, not on how the tier happened to chunk them —
    # the same body can sit in memory one render and in a file the next.
    var h = 14695981039346656037'u64
    for window in v.sp.windows():
      for c in window:
        h = (h xor uint64(c)) * 1099511628211'u64
    result = %* {"__spool": {"len": v.sp.len, "hash": $h}}
  else:
    # string/text/float/int/bool/node/scene/none
    result = valueToJson(v)

proc withCache(scene: InterpretedFrameScene,
               nodeId: NodeId,
               context: ExecutionContext,
               cacheEnabled, cacheInputEnabled, cacheDurationEnabled: bool, cacheDurationSec: float,
               builtAnyInput: bool, builtInputKey: JsonNode,
               cacheExprActive: bool, cacheExprValue: JsonNode,
               allowStore: bool,
               extraLog: JsonNode,
               compute: proc (): Value): Value =
  ## Generic cache handler shared by app/code data nodes.
  ##
  ## `allowStore = false` still serves an existing cache entry, but refuses to
  ## write the freshly computed value back. Used when the computation ran on
  ## degraded inputs (a producer failed and was zero-filled): that result must
  ## never be pinned in the cache as though it were real data.
  ##
  ## `context` is only read by the image disk tier: to refuse snapshotting the
  ## live canvas on store, and to size the spill cap.
  if not cacheEnabled:
    return compute()

  var useCached = scene.cacheValues.hasKey(nodeId)

  if useCached and cacheDurationEnabled:
    if not scene.cacheTimes.hasKey(nodeId):
      useCached = false
    else:
      let last = scene.cacheTimes[nodeId]
      if epochTime() > last + cacheDurationSec:
        useCached = false

  if useCached and cacheExprActive:
    # Recompute when the cache expression's value changes, like compiled
    # scenes do
    if not scene.cacheExprs.hasKey(nodeId):
      useCached = false
    elif scene.cacheExprs[nodeId] != cacheExprValue:
      useCached = false

  if useCached and cacheInputEnabled and builtAnyInput:
    if not scene.cacheKeys.hasKey(nodeId):
      useCached = false
    else:
      if scene.cacheKeys[nodeId] != builtInputKey:
        useCached = false

  if useCached:
    var served = scene.cacheValues[nodeId]
    var tier = "memory"
    if served.kind == fkImageSpool:
      # The disk tier: read the pixels back, whole. Exact by construction —
      # the file is byte-for-byte the image a memory cache would have held.
      let img = materializeImageSpool(served.imgSp)
      if img.isNil:
        # File swept, card pulled, or no memory to read it back into. An entry
        # that cannot be served IS a miss; drop it (its file goes with it) and
        # recompute below, which is what an empty cache would have done.
        scene.cacheValues.del(nodeId)
        useCached = false
      else:
        served = VImage(img)
        tier = "storage"
    if useCached:
      var payload = %*{
        "event": "interpreter:cache:hit",
        "sceneId": scene.id.string,
        "nodeId": nodeId.int,
        "tier": tier
      }
      if extraLog.kind == JObject:
        for k in extraLog.keys: payload[k] = extraLog[k]
      if TRACING:
        scene.logger.log(payload)
      return served

  # Miss -> compute and write-back
  var payload = %*{
    "event": "interpreter:cache:miss",
    "sceneId": scene.id.string,
    "nodeId": nodeId.int
  }
  if extraLog.kind == JObject:
    for k in extraLog.keys: payload[k] = extraLog[k]
  if TRACING:
    scene.logger.log(payload)

  # A stale image goes before its replacement is made, not after: a
  # slideshow's last photo held on through the next one's decode, and on the
  # SenseCAP Indicator the 0.9 MB it pinned was the difference between a
  # photo and an error frame (2026-10-25). Not on degraded inputs, whose pass
  # must leave the stored entry for a healthy one to hit.
  if allowStore and scene.cacheValues.hasKey(nodeId) and
      scene.cacheValues[nodeId].kind == fkImage:
    scene.cacheValues.del(nodeId)

  let fresh = compute()
  if not allowStore:
    # Degraded inputs: return the value for this pass only. Leaving the stored
    # entry (and its key/time/expression) untouched means a later healthy pass
    # can still hit it, and a stale-but-real value is never replaced by one
    # computed from zero-filled data.
    return fresh
  var toStore = fresh
  let memoryLimit = cachedImageMemoryLimit()
  if memoryLimit > 0 and fresh.kind == fkImage and not fresh.img.isNil and
      fresh.img.byteSize > memoryLimit and not affordsKeeping(fresh.img, memoryLimit, context):
    # Never retain a frame-sized image in memory on embedded: pinning a
    # canvas-sized RGBA buffer (7.7MB at 1200x1600) across renders means the
    # next render needs a second canvas and OOMs the module — and when the
    # value aliases the live canvas, a hit would redraw the since-overwritten
    # canvas onto itself anyway. The disk tier takes what memory refuses:
    # spill the pixels to storage and cache a file-backed value instead.
    # When there is nothing to spill to (or the pixels are not the producer's
    # alone — see trySpillCachedImage), store nothing: re-running the producer
    # costs a re-download, which is what this cache did before the disk tier.
    let spool = trySpillCachedImage(scene, nodeId, fresh.img, context)
    if spool.isNil:
      return fresh
    toStore = VImageSpool(spool)
  scene.cacheValues[nodeId] = toStore
  if cacheDurationEnabled:
    scene.cacheTimes[nodeId] = epochTime()
  if cacheExprActive:
    scene.cacheExprs[nodeId] = cacheExprValue
  if cacheInputEnabled and builtAnyInput:
    scene.cacheKeys[nodeId] = builtInputKey
  fresh

# -------------------------
# Global registries/state
# -------------------------

var globalNodeCounter = 0
var nodeMappingTable = initTable[string, NodeId]()
var stateFieldTypesByScene = initTable[SceneId, Table[string, string]]()
var allScenesLoaded = false
var loadedScenes = initTable[SceneId, ExportedInterpretedScene]()
var uploadedScenes = initTable[SceneId, ExportedInterpretedScene]()
var lastInterpretedScenesLoadError = ""
# The deployed scenes' content, as last read off the disk: what an uploaded
# scene set records it was made over (scenes.nim, dropUploadsTheDeployReplaced).
# Linux only; the ESP32 and the preview hold one scene set, no uploads beside it.
when compileOption("threads"):
  import checksums/md5
var deployedScenesDigest = ""

proc deployedScenesFingerprint*(): string =
  deployedScenesDigest

when defined(testing):
  proc setDeployedScenesFingerprintForTest*(fingerprint: string) =
    deployedScenesDigest = fingerprint
var sceneLoader*: proc (sceneId: SceneId): bool {.nimcall.}
  ## Set on the ESP32, which keeps one scene resident (embedded_runtime.nim):
  ## a scene node naming one that is not resident yet (a split's panel) asks
  ## the firmware to read it off flash before the node's scene starts.

proc interpretedScenesLoadError*(): string =
  ## Why the last attempt to read scenes.json(.gz) off the disk failed, or ""
  ## when the scenes on hand came from a read that worked. `startFrameOS`
  ## consults this: the read itself happens too early to raise (see
  ## `loadInterpretedScenesForStartup`).
  lastInterpretedScenesLoadError

proc resetInterpretedScenes*() =
  allScenesLoaded = false
  # A card that was full or missing may have been swapped along with the
  # scenes; give the disk tier another chance.
  imageSpillDisabled = false
  lastInterpretedScenesLoadError = ""
  loadedScenes = initTable[SceneId, ExportedInterpretedScene]()
var compiledSceneExports = initTable[SceneId, ExportedScene]()

proc registerCompiledScene*(sceneId: SceneId, exported: ExportedScene) =
  compiledSceneExports[sceneId] = exported

proc setUploadedInterpretedScenes*(scenes: Table[SceneId, ExportedInterpretedScene]) =
  uploadedScenes = scenes

proc getUploadedInterpretedScenes*(): Table[SceneId, ExportedInterpretedScene] =
  uploadedScenes

# The scene list's ORDER, which the tables above lose: what `setCurrentScene
# {direction}` walks (docs/events.md, "Event map"). The deployed order is the
# scenes.json array as last read; the uploaded order the pushed payload's.
var deployedSceneOrder: seq[SceneId]
var uploadedSceneOrder: seq[SceneId]

proc setUploadedSceneOrder*(order: seq[SceneId]) =
  uploadedSceneOrder = order

when not defined(frameosEmbedded):
  # An ESP32 holds one scene at a time, and lists its layouts off flash.
  proc interpreterLayouts(): seq[LayoutEntry] {.nimcall, gcsafe.} =
    ## The layouts the frame holds as scenes.
    {.cast(gcsafe).}:
      for sceneId, scene in uploadedScenes.pairs:
        if scene.isLayout:
          result.add LayoutEntry(id: sceneId.string, name: scene.name)
      for sceneId, scene in loadedScenes.pairs:
        if scene.isLayout and not uploadedScenes.hasKey(sceneId):
          result.add LayoutEntry(id: sceneId.string, name: scene.name)

  layoutListing = interpreterLayouts

proc isLayoutOrNil(scene: ExportedInterpretedScene): bool =
  scene.isNil or scene.isLayout

proc sceneOrderSnapshot*(): seq[SceneId] =
  ## The frame's scene list in the control plane's order: a pushed set first,
  ## then the deployed scenes it does not name (the same two tables
  ## scenes.nim merges, in order).
  result = uploadedSceneOrder
  for sceneId in deployedSceneOrder:
    if sceneId notin result:
      result.add(sceneId)
  # A layout is no scene to page to (docs/scene-layouts.md).
  result.keepItIf(not (uploadedScenes.getOrDefault(it, nil).isLayoutOrNil and
    loadedScenes.getOrDefault(it, nil).isLayoutOrNil))

# -------------------------
# Forward decl
# -------------------------

proc runEvent*(self: FrameScene, context: ExecutionContext)

proc diagnosticKeyword(node: DiagramNode): string =
  if node.data.isNil or node.data.kind != JObject:
    return ""
  if node.data.hasKey("keyword") and node.data["keyword"].kind == JString:
    return node.data["keyword"].getStr()
  if node.data.hasKey("name") and node.data["name"].kind == JString:
    return node.data["name"].getStr()
  ""

# -------------------------
# Scene nodes on their own schedule
# -------------------------

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

var yieldScene {.threadvar.}: FrameScene
  ## The scene the layout on the way here wraps; nil outside a layout.

proc runSceneNodeRender(parent: FrameScene, child: FrameScene,
    runChild: proc (self: FrameScene, context: ExecutionContext), context: ExecutionContext,
    addSlot = true, hole = false) {.noinline.} =
  ## A scene node handling `render` (frameos/scene_rhythm.nim): the scene it
  ## draws runs only when it is due, and otherwise its last picture stays or
  ## goes back. Its `nextSleep` is its own: inside a split,
  ## `logic/nextSleepDuration` means "this panel next renders in N seconds"
  ## and never reaches the frame.
  ##
  ## No `finally`: a scene's runEvent catches every node's exception itself
  ## (runEventInner), so nothing raises past it.
  let given = context.image
  let stride = max(given.stride, 1)
  child.canvasX = int32(given.origin mod stride)
  child.canvasY = int32(given.origin div stride)
  if addSlot:
    let
      x = float32(child.canvasX - parent.canvasX)
      y = float32(child.canvasY - parent.canvasY)
    parent.slots.add(SceneSlot(child: child, x: x, y: y,
      visible: [x, y, x + given.width.float32, y + given.height.float32], hole: hole))
  let decision = rhythmVisit(child, given)
  if decision == rdKeep:
    return
  takePanelRegion(given) # a rectangle restored from elsewhere has no record to go by either
  if decision == rdRestore:
    rhythmRestore(child, given)
    return
  let parentSleep = context.nextSleep
  context.nextSleep = -1
  child.repainting = decision == rdRepaint
  let saved = rhythmEnterChild(child)
  runChild(child, context)
  rhythmLeaveChild(saved)
  child.repainting = false
  rhythmAfterRun(child, decision, given, context.image, context.nextSleep)
  context.nextSleep = parentSleep

proc logScene(scene: FrameScene, event, key, value: string) =
  scene.logger.log(%*{"event": event, "sceneId": scene.id.string, key: value})

proc renderContext(scene: FrameScene, image: Image, parent: ExecutionContext): ExecutionContext =
  ExecutionContext(scene: scene, image: image, hasImage: true, event: "render",
    payload: %*{}, parent: parent, loopIndex: 0, loopKey: ".", nextSleep: -1)

proc resolveSceneExport(sceneId: SceneId): ExportedScene =
  ## The scene with this id, resident or read in, nil when there is none. An
  ## uploaded one comes before a deployed one, as in scenes.nim.
  result = uploadedScenes.getOrDefault(sceneId, nil)
  if result.isNil:
    result = loadedScenes.getOrDefault(sceneId, nil)
  when not defined(frameosEmbedded):
    if result.isNil:
      result = compiledSceneExports.getOrDefault(sceneId, nil)
  if result.isNil and not sceneLoader.isNil and sceneLoader(sceneId):
    result = loadedScenes.getOrDefault(sceneId, nil)

proc dropLayout(layout: FrameScene) =
  ## A layout the frame stopped wearing: its interpreters go with it.
  if layout of InterpretedFrameScene:
    for child in InterpretedFrameScene(layout).sceneNodes.values:
      dropLayout(child)
    for app in InterpretedFrameScene(layout).appsByNodeId.values:
      releaseJsAppRuntime(app)

var takeParkedLayout*: proc(layoutId: string): FrameScene {.nimcall.}
  ## A host that drops one scene for the next (single_scene_host.nim) keeps the
  ## layout the dropped one wore and hands it back here: the next scene wearing
  ## it skips reading, parsing and starting it again, and keeps its warm caches
  ## (1.2 s of each scene switch on a reTerminal E1003, 2026-11-10).

proc startLayout(owner: FrameScene, layoutId: string, ownId: string, ownState: JsonNode): FrameScene =
  ## The layout `owner` wears, made: what the install set for it, under what
  ## was set on the frame. One that is not on the frame or cannot start leaves
  ## the scene as it is, and says so.
  var named = layoutId
  proc wornState(): JsonNode =
    result = if layoutId == ownId and not ownState.isNil: copy(ownState) else: newJObject()
    let kept = savedLayoutState(layoutId)
    if not kept.isNil and kept.kind == JObject:
      for key, value in kept.pairs:
        result[key] = value
  if layoutId != owner.id.string and not takeParkedLayout.isNil:
    let parked = takeParkedLayout(layoutId)
    if not parked.isNil:
      for key, value in wornState().pairs:
        parked.state[key] = value
      parked.shownName = owner.shownName
      parked.systemScene = false
      return parked
  let exported = if layoutId != owner.id.string: resolveSceneExport(layoutId.SceneId) else: nil
  if exported of ExportedInterpretedScene:
    try:
      let state = wornState()
      result = exported.init(layoutId.SceneId, owner.frameConfig, owner.logger, state)
      result.shownName = owner.shownName
      return
    except Exception as error:
      named.add ": "
      named.add error.msg
  owner.logScene("layout:missing", "layoutSceneId", named)

proc ensureLayoutScene(self: InterpretedFrameScene): FrameScene =
  ## The layout this scene is wrapped in, made on the first pass that shows
  ## the scene as the frame's (a scene in a panel has no layout of its own).
  let wanted = layoutFor(self.layoutSceneId.string)
  result = self.wornLayout
  if not result.isNil and result.id.string != wanted:
    dropLayout(result)
    self.wornLayout = nil
    result = nil
  if not result.isNil or wanted.len == 0 or self.layoutFailedFor == wanted:
    return
  result = startLayout(self, wanted, self.layoutSceneId.string, self.layoutState)
  if result.isNil:
    self.layoutFailedFor = wanted
  else:
    self.wornLayout = result

proc ensureBuiltInLayout(self: FrameScene): FrameScene =
  ## A built-in scene wears the layout of the scene it was opened from
  ## (event_loop.nim hands it over in `state.layout`), or the frame's choice.
  let own = self.state{"layout"}
  let ownId = own{"sceneId"}.getStr()
  # Safe mode's settings panel (event_loop.nim): no layout, whatever is chosen.
  let wanted = if self.state{"noLayout"}.getBool(): "" else: layoutFor(ownId)
  if not self.wornLayout.isNil and self.wornLayout.id.string != wanted:
    dropLayout(self.wornLayout)
    self.wornLayout = nil
  if self.wornLayout.isNil and wanted.len > 0 and self.wornLayoutFailedFor != wanted:
    self.wornLayout = startLayout(self, wanted, ownId, own{"state"})
    if self.wornLayout.isNil:
      self.wornLayoutFailedFor = wanted
    else:
      self.wornLayout.systemScene = true
  self.wornLayout

proc translatedPayload(payload: JsonNode, slot: SceneSlot): JsonNode =
  result = copy(payload)
  for i, key in ["x", "y", "startX", "startY"]:
    if result.hasKey(key):
      result[key] = %(result[key].getFloat() - (if (i and 1) == 0: slot.x else: slot.y))

proc routePointer(self: InterpretedFrameScene, context: ExecutionContext): bool =
  ## A pointer event over an embedded scene is that scene's, in its own
  ## coordinates; a press stays with the scene it began on until it lifts.
  if self.slots.len == 0 or context.payload.isNil or context.payload.kind != JObject:
    return false
  let
    payload = context.payload
    event = context.event
    pid = payload{"pointerId"}.getInt(0)
    # A gesture goes where it began. No position: -1 is on no slot.
    x = payload{"startX"}.getFloat(payload{"x"}.getFloat(-1))
    y = payload{"startY"}.getFloat(payload{"y"}.getFloat(-1))
    lifted = event == "pointerUp" or event == "pointerCancel"
    held = not self.capturedChild.isNil and self.capturedPointer == pid and (lifted or event == "pointerMove")
  var slot = -1
  for i in countdown(self.slots.high, 0):
    template s: untyped = self.slots[i]
    if held:
      if s.child == self.capturedChild:
        slot = i
        break
    elif x >= s.visible[0] and y >= s.visible[1] and x < s.visible[2] and y < s.visible[3]:
      slot = i
      break
  if event == "pointerDown" and slot >= 0:
    self.capturedChild = self.slots[slot].child
    self.capturedPointer = pid
  elif held and lifted:
    self.capturedChild = nil
  if slot < 0 or not (self.slots[slot].child of InterpretedFrameScene or not self.slots[slot].child.ownRun.isNil):
    return false
  let child = self.slots[slot].child
  let inner = ExecutionContext(scene: child, event: event,
    payload: translatedPayload(payload, self.slots[slot]), parent: context,
    loopIndex: context.loopIndex, loopKey: context.loopKey, nextSleep: -1)
  runEvent(child, inner)
  true

const PointerEvents = ["tap", "doubleTap", "longPress", "swipe", "pointerDown", "pointerUp",
  "pointerMove", "pointerCancel"]

proc drawIntoHole(host, child: FrameScene, canvas: Image, x, y, w, h: int, context: ExecutionContext, addSlot: bool) =
  ## `child`, on its own schedule, straight into a hole in `host`'s canvas.
  let view = canvas.view(x, y, w, h)
  let inner = renderContext(child, view, context)
  let saved = rhythmEnterHole()
  runSceneNodeRender(host, child, runEvent, inner, addSlot, hole = true)
  rhythmLeaveChild(saved)
  if inner.image != view:
    # It swapped its canvas for an image of its own: nothing wrote through, so
    # it is composited into place (as a split does for a cell).
    canvas.draw(inner.image, translate(vec2(x.float32, y.float32)))

proc dropEmbedImage(r: SceneRhythm) =
  noteEmbedImage(-r.embedImage.byteSize)
  unregisterCanvas(r.embedImage)
  r.embedImage = nil

proc parseEmbedProps(props: string): JsonNode =
  ## What the walker stringified, less the tag's own names. An exception here
  ## is the node's, like any failure of the UI that holds the tag.
  result = parseJson(if props.len > 0: props else: "{}")
  if result.kind != JObject:
    return newJObject()
  for key in ["id", "key", "ref", "children"]:
    if result.hasKey(key):
      result.delete(key)

proc renderEmbeddedScene(owner: FrameScene, nodeId: NodeId, index: int, sceneId, props: string,
    x, y: float32, visible: array[4, float32], width, height: int, asHole: bool, context: ExecutionContext): Image =
  ## A `<Scene id>` or `<yield />` in a UI. `asHole`: drawn straight into the
  ## canvas at (`x`, `y`), and non-nil when it was. Otherwise its picture at
  ## this size, what the walker draws as a raster image: it runs when it is due,
  ## like any embedded scene, and keeps its picture while the memory allows; a
  ## device that cannot afford to keep one renders it again each pass.
  if owner.isNil or not (owner of InterpretedFrameScene) or width <= 0 or height <= 0 or rhythmDepth() > 8:
    return nil
  let parent {.cursor.} = InterpretedFrameScene(owner)
  let yielded = sceneId == SceneYieldId
  var child: FrameScene
  if yielded:
    child = yieldScene
    if child.isNil or child == owner:
      return nil
  else:
    if sceneId == owner.id.string:
      return nil
    let key = NodeId(-((hash(sceneId) !& nodeId.int !& index) and 0x3fff_ffff) - 2)
    child = parent.sceneNodes.getOrDefault(key, nil)
    if child.isNil:
      let exported = resolveSceneExport(SceneId(sceneId))
      if exported.isNil:
        owner.logScene("scene:embed:unknown", "embedded", sceneId)
        return nil
      child = exported.init(SceneId(sceneId), owner.frameConfig, owner.logger, parseEmbedProps(props))
      parent.sceneNodes[key] = child
      parent.sceneExportByNodeId[key] = exported
  if child.rhythm.isNil:
    child.rhythm = SceneRhythm()
  let r {.cursor.} = child.rhythm
  if props != r.embedProps and not yielded:
    # Before the schedule decides: a change of state makes the scene due.
    r.embedProps = props
    if child.state.kind == JObject:
      for key, value in parseEmbedProps(props).pairs:
        child.state[key] = value
  if asHole:
    if not r.embedImage.isNil:
      dropEmbedImage(r)
    if owner.holesMoved:
      # The chrome has just painted where it was.
      rhythmMarkDue(child)
    drawIntoHole(owner, child, context.image, x.int, y.int, width, height, context, addSlot = true)
    return context.image
  owner.slots.add(SceneSlot(child: child, x: x, y: y, visible: visible))
  let due = rhythmEmbedDue(child)
  let like {.cursor.} = if context.hasImage: context.image else: nil
  let format = if like.isNil: pfRgbx else: like.format
  var image = r.embedImage
  let fits = not image.isNil and image.width == width and image.height == height and image.format == format
  if fits and not due:
    return image
  if not fits:
    if not image.isNil:
      dropEmbedImage(r)
    try:
      image = if like.isNil: newImage(width, height) else: newImageLike(like, width, height)
    except CatchableError:
      owner.logScene("scene:embed:noMemory", "embedded", sceneId)
      return nil
    if format == pfRgb565:
      image.ditherStores = true
  let inner = renderContext(child, image, context)
  child.canvasX = 0
  child.canvasY = 0
  child.repainting = not due
  let saved = rhythmEnterEmbed()
  runEvent(child, inner)
  rhythmLeaveChild(saved)
  child.repainting = false
  if due:
    rhythmAfterRun(child, rdRun, nil, nil, inner.nextSleep)
  if not r.embedImage.isNil or embedBytesAllowed(image.byteSize):
    if r.embedImage.isNil:
      r.embedImage = image
      noteEmbedImage(image.byteSize)
      discard registerCanvas(image)
    let log = canvasLogOf(image)
    if not log.isNil:
      log.drew(rect(0, 0, width.float32, height.float32))
  image

embeddedSceneRenderer = renderEmbeddedScene

proc yieldReady(owner: FrameScene): bool =
  not yieldScene.isNil and yieldScene != owner

embeddedYieldReady = yieldReady

{.pop.}

# -------------------------
# Core node runner
# -------------------------

proc evalCacheExpression(scene: InterpretedFrameScene, context: ExecutionContext,
    nodeId: NodeId, expression: string): tuple[active: bool, value: JsonNode] =
  ## Evaluates a cache expression (inline JS for interpreted scenes) so the
  ## node recomputes when the value changes, mirroring compiled scenes. On
  ## error the expression is ignored for this render.
  try:
    let v = evalInline(scene, context, nodeId, "__cacheExpression", expression,
                       scene.appInlineFuncNameByNodeArg, compileAppInlineFn,
                       "__cacheExpression")
    (true, valueToKeyJson(v))
  except Exception as e:
    scene.logger.log(%*{
      "event": "interpreter:cacheExpression:error",
      "sceneId": scene.id.string,
      "nodeId": nodeId.int,
      "code": expression,
      "error": $e.msg
    })
    (false, newJNull())

proc logInputError(self: FrameScene, event: string, nodeId: NodeId, input: string,
    producer: NodeId, code: string, e: ref Exception, zero: JsonNode = nil,
    sceneKey = "sceneId", inputKey = "input") {.noinline.} =
  ## The line runNode writes when one of a node's inputs fails: from a
  ## producer node, or from inline code when `producer` is NoNodeId, with the
  ## zero value the input got instead when there is one. One builder for the
  ## eight such lines: each `%*{…}` at its own site was ~300 B of flash.
  let line = newJObject()
  line["event"] = %event
  line[sceneKey] = %self.id.string
  line["nodeId"] = %nodeId.int
  line[inputKey] = %input
  if producer == NoNodeId:
    line["code"] = %code
  else:
    line["producer"] = %producer.int
  line["error"] = %e.msg
  line["stacktrace"] = %e.getStackTrace()
  if zero != nil:
    line["defaulted"] = %true
    line["defaultValue"] = zero
  self.logger.log(line)

proc logGraphStop(self: FrameScene, event: string, startNodeId, atNodeId: NodeId,
    limit = 0) {.noinline.} =
  ## runNode's flow stopped: a hop limit (`limit`) or a node visited twice.
  let line = newJObject()
  line["event"] = %event
  line["sceneId"] = %self.id.string
  line["startNodeId"] = %startNodeId.int
  line["atNodeId"] = %atNodeId.int
  if limit > 0:
    line["limit"] = %limit
  self.logger.log(line)

const MaxRunNodeDepth = 64
  ## Producer inputs are resolved by recursion (an app's field wired from a
  ## node wired from a node …), and the cycle check below only covers the
  ## flow edges of ONE runNode call. A node whose input is (transitively) its
  ## own output recursed until the stack blew — a scene error, not a crash.

proc runNode*(self: FrameScene, nodeId: NodeId, context: ExecutionContext, asDataNode = false): Value =
  let self = InterpretedFrameScene(self)
  var currentNodeId: NodeId = nodeId

  if asDataNode and nodeId in self.runNodeStack:
    raise newException(Exception,
      "Node " & $nodeId.int & " depends on itself: its input is produced by a node that is " &
      "still resolving it (cycle through " & $self.runNodeStack.len & " node(s))")
  if self.runNodeStack.len >= MaxRunNodeDepth:
    raise newException(Exception,
      "Node " & $nodeId.int & " is nested deeper than " & $MaxRunNodeDepth &
      " levels of producers; refusing to resolve it")
  self.runNodeStack.add(nodeId)
  defer: self.runNodeStack.setLen(self.runNodeStack.len - 1)

  # Safety: cycle detection + hop budget
  var visited = initTable[NodeId, bool]()
  var hops = 0
  const maxHops = 1000

  while currentNodeId != -1.NodeId:
    inc hops
    if hops > maxHops:
      logGraphStop(self, "interpreter:graph:hopLimit", nodeId, currentNodeId, maxHops)
      break
    if visited.hasKey(currentNodeId):
      logGraphStop(self, "interpreter:graph:cycle", nodeId, currentNodeId)
      break
    visited[currentNodeId] = true

    if not self.nodes.hasKey(currentNodeId):
      self.logger.log(%*{"event": "interpreter:nodeNotFound", "sceneId": self.id, "nodeId": currentNodeId.int})
      break

    let currentNode = self.nodes[currentNodeId]
    let nodeType = currentNode.nodeType
    when defined(memProbe):
      memProbe("node " & nodeType & "/" & diagnosticKeyword(currentNode) &
        " #" & $currentNodeId.int)
    let debugRuntime = self.frameConfig.debug
    var checkpointKeyword = ""
    var profileStartedAt = 0.0
    var profileMemoryBefore: tuple[known: bool, bytes: int] = (false, 0)
    # The fit actually handed to a producer this pass, for the profile log.
    var plannedFit = ""
    # The tier actually used, which can differ from the planned one.
    var plannedTier = iftLiveCanvas
    # The bounds actually offered this pass, for the profile log.
    var offeredBoundsWidth = 0
    var offeredBoundsHeight = 0
    if debugRuntime:
      checkpointKeyword = diagnosticKeyword(currentNode)
      markRuntimeCheckpoint("node:start", currentSceneId = self.id.string, contextEvent = context.event,
        nodeId = currentNodeId.int, nodeType = nodeType, keyword = checkpointKeyword)
      profileStartedAt = epochTime()
      profileMemoryBefore = renderMemoryInUse()
    if TRACING:
      self.logger.log(%*{"event": "interpreter:runNode", "sceneId": self.id, "nodeId": currentNodeId.int,
        "nodeType": nodeType})
    # A node in the flow may draw on the canvas: the background still owed
    # goes down first. A data node draws there only through a decode target,
    # which pays it on the way (takeDecodeTarget); the consumer of an image
    # fusion holds it until its producer has had the chance to waive it, and
    # pays it after its inputs (below).
    if not asDataNode and context.backgroundPending and
        not (nodeType == "app" and (self.imageFusionPlans.hasKey(currentNodeId) or
          currentNode.data{"keyword"}.getStr() in FlowAppsSettlingBackground)):
      paintPendingBackground(context)
    case nodeType:
    of "app":
      let keyword = currentNode.data{"keyword"}.getStr()
      if TRACING:
        self.logger.log(%*{
          "event": "interpreter:runApp",
          "sceneId": self.id, "nodeId": currentNodeId.int, "keyword": keyword
        })
      if not self.appsByNodeId.hasKey(currentNodeId):
        raise newException(Exception,
          "App not initialized for node id: " & $currentNode.id & ", keyword: " & keyword)

      let app = self.appsByNodeId[currentNodeId]

      # ---- Read per-node cache config ----
      let (cacheEnabled, cacheInputEnabled, cacheDurationEnabled, cacheDurationSec,
           cacheExpressionEnabled, cacheExpression) = readCacheConfig(currentNode.data)

      # ---- Negotiated decode target ----
      # Whether this node's image input can be produced straight into a target
      # instead of materialized whole was decided at scene load, from the
      # capabilities the apps involved declare in their config.json. The graph
      # shape is static between deploys; what is left here are the facts that
      # are not — is there a canvas, is one hint already in flight, and what
      # does a placement wired from a state field say right now.
      # See frameos/planner.nim and docs/value-pipeline.md.
      var setDecodeTargetHint = false
      if not asDataNode and self.imageFusionPlans.hasKey(currentNodeId) and
          context.hasImage and not context.image.isNil and
          context.decodeTargetImage.isNil and context.decodeTargetWidth == 0:
        let plan = self.imageFusionPlans[currentNodeId]
        var fit = plan.fit
        if plan.fitFromNodeId != NoNodeId:
          try:
            fit = runNode(self, plan.fitFromNodeId, context, asDataNode = true).asString()
          except CatchableError:
            fit = ""
          if fit.len == 0:
            # Scene JSON only stores explicitly-set values; an empty state
            # field means the app's config.json default.
            fit = plan.defaultFit
        if fit in plan.fits:
          var tier = plan.tier
          if tier == iftOwnedScratch and plan.ownedForCache:
            # The scratch exists so a cached producer never ends up owning the
            # live canvas. Past the in-memory limit the cache cannot hold the
            # value, so the scratch is only worth its PSRAM if the disk tier
            # will take the pixels instead (withCache spills the scratch, and
            # later renders serve it back from the file). When it will not —
            # no storage, no headroom — nothing gets stored, nothing aliases
            # the canvas across renders, and the scratch would be a whole
            # canvas of PSRAM bought to protect a cache entry that is never
            # written: decode into the live canvas instead. Every shipped
            # photo scene caches its producer, so this branch is the common
            # case, not the exception.
            let memoryLimit = cachedImageMemoryLimit()
            let scratchBytes = context.image.width * context.image.height * 4
            if memoryLimit > 0 and scratchBytes > memoryLimit:
              let refusal = imageSpillRefusalReason(self.frameConfig, scratchBytes)
              if refusal.len > 0:
                tier = iftLiveCanvas
                self.logger.log(%*{
                  "event": "interpreter:cache:imageTier",
                  "sceneId": self.id.string,
                  "nodeId": plan.producerNodeId.int,
                  "tier": "liveCanvas",
                  "reason": refusal
                })
          plannedTier = tier
          case tier
          of iftLiveCanvas:
            context.decodeTargetImage = context.image
            context.decodeTargetScalingMode = fit
            setDecodeTargetHint = true
          of iftOwnedScratch:
            if fit notin plan.excludedFits:
              # Canvas-sized, allocated by the producer. The consumer then
              # draws a same-size source, which is a plain draw — identical
              # output to fitting a native-size image here.
              context.decodeTargetWidth = context.image.width
              context.decodeTargetHeight = context.image.height
              context.decodeTargetScalingMode = fit
              context.decodeTargetOwned = true
              setDecodeTargetHint = true
        if setDecodeTargetHint:
          plannedFit = fit
          context.decodeTargetNodeId = plan.producerNodeId
          context.decodeTargetClaimedBy = 0.NodeId
          if plan.inPlaceNodeIds.len > 0:
            context.inPlaceImageNodes = plan.inPlaceNodeIds

      # ---- Requested bounds ----
      # The consumer's useful resolution for an edge that could not fuse: a
      # 90/270 rotation or a resize mid-chain, or a refused direct shape. The
      # terminal producer decodes bounded instead of at native resolution;
      # everything about the offer mirrors the decode target — addressed,
      # one-shot, and free if unclaimed.
      var setDecodeBoundsHint = false
      if not asDataNode and imageBoundsEnabled and
          self.imageBoundsPlans.hasKey(currentNodeId) and
          context.hasImage and not context.image.isNil and
          not setDecodeTargetHint and
          context.decodeBoundsNodeId == 0.NodeId:
        let boundsPlan = self.imageBoundsPlans[currentNodeId]
        var boundWidth =
          if boundsPlan.fromCanvas: context.image.width
          else: boundsPlan.fixedWidth
        var boundHeight =
          if boundsPlan.fromCanvas: context.image.height
          else: boundsPlan.fixedHeight
        if boundsPlan.swapped:
          swap(boundWidth, boundHeight)
        if boundsPlan.scale > 1.0:
          # A static zoom multiplier (zoomPan): the largest crop the consumer
          # will ever show needs scale times its own resolution, rounded up —
          # a bound must never come in under what the draw can use.
          boundWidth = int(ceil(boundWidth.float * boundsPlan.scale))
          boundHeight = int(ceil(boundHeight.float * boundsPlan.scale))
        if boundWidth > 0 and boundHeight > 0:
          context.decodeBoundsWidth = boundWidth
          context.decodeBoundsHeight = boundHeight
          context.decodeBoundsNodeId = boundsPlan.producerNodeId
          context.decodeBoundsClaimedBy = 0.NodeId
          setDecodeBoundsHint = true
          offeredBoundsWidth = boundWidth
          offeredBoundsHeight = boundHeight

      # ---- Wire inputs AND (if enabled) build an input-key JSON alongside ----
      var builtInputKey = %*{} # JObject; only meaningful when cacheInputEnabled = true and there are inputs
      var builtAnyInput = false

      if self.appInputsForNodeId.hasKey(currentNodeId):
        let connected = self.appInputsForNodeId[currentNodeId]
        for (inputName, producerNodeId) in connected.pairs:
          if self.nodes.hasKey(producerNodeId):
            try:
              let vIn = runNode(self, producerNodeId, context, asDataNode = true)
              setInterpretedAppField(keyword, app, inputName, vIn)
              if cacheEnabled and cacheInputEnabled:
                builtInputKey[inputName] = valueToKeyJson(vIn)
                builtAnyInput = true
            except Exception as e:
              logInputError(self, "interpreter:setField:error", currentNodeId, inputName,
                producerNodeId, "", e)
              # The producer may have consumed the decode target before it
              # failed, which is the exact state mayMutateImageInPlace reads as
              # "the chain fused". It did not — and the substitute image below
              # can be the LIVE CANVAS on embedded builds, which a forwarding
              # transformer must never mutate in place. Withdraw the clearance.
              context.inPlaceImageNodes = @[]
              # If this input takes an image, hand the consumer an image with
              # the producer's error on it ("response too large", HTTP errors,
              # …) — a nil image would only render as "No image provided".
              # Non-image fields reject the value and keep their defaults.
              try:
                if runsAsEmbedded():
                  # Reuse the live canvas for the error frame: allocating a
                  # second full-frame image next to it OOMs memory-tight
                  # devices (and the preview running as one). Paint only
                  # after the field accepted the image, so a non-image field
                  # mismatch leaves the canvas untouched.
                  if context.hasImage and not context.image.isNil:
                    setInterpretedAppField(keyword, app, inputName,
                      Value(kind: fkImage, img: context.image))
                    paintPendingBackground(context)
                    renderErrorInto(context.image, context.image.width,
                      context.image.height, $e.msg)
                  else:
                    setInterpretedAppField(keyword, app, inputName,
                      Value(kind: fkImage, img: renderError(self.frameConfig.width,
                        self.frameConfig.height, $e.msg)))
                else:
                  let errorWidth =
                    if context.hasImage and not context.image.isNil: context.image.width
                    else: self.frameConfig.width
                  let errorHeight =
                    if context.hasImage and not context.image.isNil: context.image.height
                    else: self.frameConfig.height
                  setInterpretedAppField(keyword, app, inputName,
                    Value(kind: fkImage, img: renderError(errorWidth, errorHeight, $e.msg)))
              except Exception:
                discard # Leave field at default; still proceed.

      if self.appInlineInputsForNodeId.hasKey(currentNodeId):
        let inlineConnected = self.appInlineInputsForNodeId[currentNodeId]
        for (inputName, codeSnippet) in inlineConnected.pairs:
          try:
            let vIn = evalInline(self, context, currentNodeId,
                                 inputName, codeSnippet,
                                 self.appInlineFuncNameByNodeArg, compileAppInlineFn,
                                 inputName)
            setInterpretedAppField(keyword, app, inputName, vIn)
            if cacheEnabled and cacheInputEnabled:
              builtInputKey[inputName] = valueToKeyJson(vIn)
              builtAnyInput = true
          except Exception as e:
            logInputError(self, "interpreter:setField:error:inlineCode", currentNodeId, inputName,
              NoNodeId, codeSnippet, e)

      if setDecodeTargetHint:
        context.decodeTargetImage = nil
        context.decodeTargetScalingMode = ""
        context.decodeTargetWidth = 0
        context.decodeTargetHeight = 0
        context.decodeTargetNodeId = 0.NodeId
        context.decodeTargetOwned = false
        context.inPlaceImageNodes = @[]
      # Whatever the producer did not settle, this node draws over, unless it
      # settles the background itself.
      if not asDataNode and keyword notin FlowAppsSettlingBackground:
        paintPendingBackground(context)
      if setDecodeBoundsHint:
        context.decodeBoundsWidth = 0
        context.decodeBoundsHeight = 0
        context.decodeBoundsNodeId = 0.NodeId

      if asDataNode and cacheEnabled:
        var cacheExprActive = false
        var cacheExprValue: JsonNode = newJNull()
        if cacheExpressionEnabled:
          (cacheExprActive, cacheExprValue) =
            evalCacheExpression(self, context, currentNodeId, cacheExpression)
        result = withCache(self, currentNodeId, context,
                           cacheEnabled, cacheInputEnabled, cacheDurationEnabled, cacheDurationSec,
                           builtAnyInput, builtInputKey,
                           cacheExprActive, cacheExprValue,
                           true,
                           %*{"keyword": keyword}):
          (proc (): Value =
            getInterpretedApp(keyword, app, context)
          )
      else:
        if asDataNode:
          result = getInterpretedApp(keyword, app, context)
        else:
          runInterpretedApp(keyword, app, context)

    of "source":
      raise newException(Exception, "Source nodes are not implemented for interpreted scenes")
    of "dispatch":
      let eventName = currentNode.data{"keyword"}.getStr()
      if TRACING:
        self.logger.log(%*{
          "event": "interpreter:dispatch:run",
          "sceneId": self.id,
          "nodeId": currentNodeId.int,
          "eventName": eventName
        })

      var payload =
        if currentNode.data.hasKey("config") and currentNode.data["config"].kind == JObject:
          copy(currentNode.data["config"])
        else:
          %*{}

      if payload.isNil or payload.kind != JObject:
        payload = %*{}

      if self.appInputsForNodeId.hasKey(currentNodeId):
        let connected = self.appInputsForNodeId[currentNodeId]
        for (inputName, producerNodeId) in connected.pairs:
          if self.nodes.hasKey(producerNodeId):
            try:
              let vIn = runNode(self, producerNodeId, context, asDataNode = true)
              payload[inputName] = valueToJson(vIn)
            except Exception as e:
              logInputError(self, "interpreter:dispatch:setField:error", currentNodeId, inputName,
                producerNodeId, "", e)

      if self.appInlineInputsForNodeId.hasKey(currentNodeId):
        let inlineConnected = self.appInlineInputsForNodeId[currentNodeId]
        for (inputName, codeSnippet) in inlineConnected.pairs:
          try:
            let vIn = evalInline(self, context, currentNodeId,
                                 inputName, codeSnippet,
                                 self.appInlineFuncNameByNodeArg, compileAppInlineFn,
                                 inputName)
            payload[inputName] = valueToJson(vIn)
          except Exception as e:
            logInputError(self, "interpreter:dispatch:setField:error:inlineCode", currentNodeId, inputName,
              NoNodeId, codeSnippet, e)

      var finalPayload = payload
      if eventName == "setSceneState":
        var statePayload = %*{}
        var rootPayload = %*{}
        var typeMap = initTable[string, string]()
        if stateFieldTypesByScene.hasKey(self.id):
          typeMap = stateFieldTypesByScene[self.id]
        for key in payload.keys:
          let valueNode = payload[key]
          if typeMap.hasKey(key):
            let typedValue = valueFromJsonByType(valueNode, typeMap[key])
            statePayload[key] = valueToJson(typedValue)
          else:
            if key == "render":
              let typedValue = valueFromJsonByType(valueNode, "boolean")
              rootPayload[key] = valueToJson(typedValue)
            else:
              statePayload[key] = copy(valueNode)
        if statePayload.len > 0:
          rootPayload["state"] = statePayload
        finalPayload = rootPayload

      if TRACING:
        self.logger.log(%*{
          "event": "interpreter:dispatch:send",
          "sceneId": self.id,
          "nodeId": currentNodeId.int,
          "eventName": eventName,
          "payload": finalPayload
        })
      dispatchFromScene(self, eventName, finalPayload, currentNodeId.int, context.event)
      if asDataNode:
        result = VJson(copy(finalPayload))
    of "code":
      # Parse outputs (types and default target)
      var outputTypes = initTable[string, string]()
      var defaultOutputName = ""
      if currentNode.data.hasKey("codeOutputs") and currentNode.data["codeOutputs"].kind == JArray:
        for outputDef in currentNode.data["codeOutputs"]:
          if outputDef.kind == JObject:
            let name = outputDef{"name"}.getStr()
            let typ = outputDef{"type"}.getStr()
            if name.len > 0:
              outputTypes[name] = typ
              if defaultOutputName.len == 0:
                defaultOutputName = name

      # Parse arg types
      var argTypes = initTable[string, string]()
      if currentNode.data.hasKey("codeArgs") and currentNode.data["codeArgs"].kind == JArray:
        for argDef in currentNode.data["codeArgs"]:
          if argDef.kind == JObject:
            let name = argDef{"name"}.getStr()
            let typ = argDef{"type"}.getStr()
            if name.len > 0:
              argTypes[name] = typ

      # Build args (connected + inline); also build cache input key if enabled
      var args = initTable[string, Value]()
      var builtInputKey = %*{}
      var builtAnyInput = false
      # Args whose producer raised and were replaced by a zero value. Tracked so
      # (a) the resulting JS error can name the real culprit and (b) the result
      # of this pass is kept out of the node cache.
      var defaultedArgs: seq[DefaultedArg] = @[]

      let (cacheEnabled, cacheInputEnabled, cacheDurationEnabled, cacheDurationSec,
           cacheExpressionEnabled, cacheExpression) = readCacheConfig(currentNode.data)

      if self.codeInputsForNodeId.hasKey(currentNodeId):
        let connectedArgs = self.codeInputsForNodeId[currentNodeId]
        for (argName, producerNodeId) in connectedArgs.pairs:
          if self.nodes.hasKey(producerNodeId):
            try:
              let vIn = runNode(self, producerNodeId, context, asDataNode = true)
              args[argName] = vIn
              if not argTypes.hasKey(argName):
                argTypes[argName] = ""
              if cacheEnabled and cacheInputEnabled:
                builtInputKey[argName] = valueToKeyJson(vIn)
                builtAnyInput = true
            except Exception as e:
              # One flaky producer must not take down the whole node. Hand the
              # code the zero value of the arg's declared type instead of
              # leaving the arg unset: an unset arg reaches JS as `undefined`,
              # and `[...undefined]` throws, killing every *other* data source
              # merged in the same expression.
              let zero = zeroValueForCodeArgType(argTypes.getOrDefault(argName, ""))
              logInputError(self, "interpreter:codeArg:error", currentNodeId, argName,
                producerNodeId, "", e, valueToJson(zero), inputKey = "arg")
              args[argName] = zero
              if not argTypes.hasKey(argName):
                argTypes[argName] = ""
              defaultedArgs.add((name: argName, error: $e.msg))
              # Deliberately NOT added to builtInputKey: a zero value is the
              # absence of data, not data. Keying on it would either poison a
              # good cache entry with a degraded result or make "no data" look
              # like a legitimate input change. The store guard below is what
              # actually keeps the degraded result out of the cache.

      if self.codeInlineInputsForNodeId.hasKey(currentNodeId):
        let inlineArgs = self.codeInlineInputsForNodeId[currentNodeId]
        for (argName, snippet) in inlineArgs.pairs:
          try:
            let vIn = evalInline(self, context, currentNodeId,
                                 argName, snippet,
                                 self.codeInlineFuncNameByNodeArg, compileCodeInlineFn,
                                 argName)
            args[argName] = vIn
            if not argTypes.hasKey(argName):
              argTypes[argName] = ""
            if cacheEnabled and cacheInputEnabled:
              builtInputKey[argName] = valueToKeyJson(vIn)
              builtAnyInput = true
          except Exception as e:
            # Same reasoning as the connected-producer path above: substitute
            # the zero value so downstream code sees "no data", not `undefined`.
            let zero = zeroValueForCodeArgType(argTypes.getOrDefault(argName, ""))
            logInputError(self, "interpreter:codeArg:error:inlineCode", currentNodeId, argName,
              NoNodeId, snippet, e, valueToJson(zero), inputKey = "arg")
            args[argName] = zero
            if not argTypes.hasKey(argName):
              argTypes[argName] = ""
            defaultedArgs.add((name: argName, error: $e.msg))
            # Not a cache-input contribution; see the connected-arg comment.

      let targetField = if defaultOutputName.len > 0: defaultOutputName else: ""

      # Compute (with optional caching)
      let computeFresh = proc (): Value =
        var fnName = getOrCompileCodeFn(self, currentNode)
        callCompiledFn(self, context, currentNodeId, fnName, args, argTypes, outputTypes, targetField,
                       defaultedArgs)

      if asDataNode and cacheEnabled:
        var cacheExprActive = false
        var cacheExprValue: JsonNode = newJNull()
        if cacheExpressionEnabled:
          (cacheExprActive, cacheExprValue) =
            evalCacheExpression(self, context, currentNodeId, cacheExpression)
        result = withCache(self, currentNodeId, context,
                           cacheEnabled, cacheInputEnabled, cacheDurationEnabled, cacheDurationSec,
                           builtAnyInput, builtInputKey,
                           cacheExprActive, cacheExprValue,
                           defaultedArgs.len == 0,
                           %*{"nodeType": "code"},
                           computeFresh)
      else:
        let fresh = computeFresh()
        if jBoolOr(currentNode.data, "logOutput", false):
          logCodeNodeOutput(FrameScene(self), currentNodeId, fresh)
        if asDataNode:
          result = fresh

    of "event":
      raise newException(Exception, "Event nodes not implemented in interpreted scenes yet")

    of "state":
      let key = currentNode.data{"keyword"}.getStr()
      var fieldType = "string"
      if stateFieldTypesByScene.hasKey(self.id):
        let m = stateFieldTypesByScene[self.id]
        if m.hasKey(key): fieldType = m[key]
      let j =
        if self.state.hasKey(key): self.state[key]
        else: %*"" # fallback if state missing
      result = valueFromJsonByType(j, fieldType)

    of "scene":
      let childSceneId = currentNode.data{"keyword"}.getStr().SceneId
      if TRACING:
        self.logger.log(%*{
          "event": "interpreter:runScene",
          "sceneId": self.id,
          "nodeId": currentNodeId.int,
          "childSceneId": childSceneId.string
        })

      var exportedChild: ExportedScene

      if self.sceneExportByNodeId.hasKey(currentNodeId):
        exportedChild = self.sceneExportByNodeId[currentNodeId]
      else:
        # An uploaded scene comes before a deployed one with its id, as in
        # the frame's scene registry (scenes.nim).
        if uploadedScenes.hasKey(childSceneId):
          let interpretedExport = uploadedScenes[childSceneId]
          exportedChild = ExportedScene(interpretedExport)
        elif loadedScenes.hasKey(childSceneId):
          let interpretedExport = loadedScenes[childSceneId]
          exportedChild = ExportedScene(interpretedExport)
        elif compiledSceneExports.hasKey(childSceneId):
          exportedChild = compiledSceneExports[childSceneId]
        else:
          raise newException(Exception,
            "Scene node references unknown scene id: " & childSceneId.string)
        self.sceneExportByNodeId[currentNodeId] = exportedChild

      if not self.sceneNodes.hasKey(currentNodeId):
        var persisted = %*{}
        if currentNode.data.hasKey("config") and currentNode.data["config"].kind == JObject:
          persisted = currentNode.data["config"]
        # The child's own init fires its "init" event, interpreted or compiled.
        let child = exportedChild.init(childSceneId, self.frameConfig, self.logger, persisted)
        self.sceneNodes[currentNodeId] = child

      let childScene = self.sceneNodes[currentNodeId]

      if not self.sceneExportByNodeId.hasKey(currentNodeId):
        self.sceneExportByNodeId[currentNodeId] = exportedChild

      # Apply dynamic inputs (fieldOutput -> fieldInput/<name>) into child's state before running
      if self.appInputsForNodeId.hasKey(currentNodeId):
        let connected = self.appInputsForNodeId[currentNodeId]
        for (inputName, producerNodeId) in connected.pairs:
          try:
            let v = runNode(self, producerNodeId, context, asDataNode = true)
            childScene.state[inputName] = valueToJson(v)
          except Exception as e:
            logInputError(self, "interpreter:setChildState:error", currentNodeId, inputName,
              producerNodeId, "", e, sceneKey = "parentSceneId")

      if self.appInlineInputsForNodeId.hasKey(currentNodeId):
        let inlineConnected = self.appInlineInputsForNodeId[currentNodeId]
        for (inputName, codeSnippet) in inlineConnected.pairs:
          try:
            let v = evalInline(self, context, currentNodeId,
                               inputName, codeSnippet,
                               self.appInlineFuncNameByNodeArg, compileAppInlineFn,
                               inputName)
            childScene.state[inputName] = valueToJson(v)
          except Exception as e:
            logInputError(self, "interpreter:setChildState:error:inlineCode", currentNodeId, inputName,
              NoNodeId, codeSnippet, e, sceneKey = "parentSceneId")

      # Delegate handling of the current event to the child scene.
      exportedChild = self.sceneExportByNodeId[currentNodeId]
      if debugRuntime:
        markRuntimeCheckpoint("scene:delegate", currentSceneId = self.id.string, contextEvent = context.event,
          nodeId = currentNodeId.int, nodeType = nodeType, keyword = checkpointKeyword,
          childSceneId = childScene.id.string)
      if context.event == "render" and context.hasImage and not context.image.isNil:
        runSceneNodeRender(self, childScene, exportedChild.runEvent, context)
      else:
        exportedChild.runEvent(childScene, context)
    else:
      raise newException(Exception, "Unknown node type: " & nodeType)

    if debugRuntime:
      markRuntimeCheckpoint("node:done", currentSceneId = self.id.string, contextEvent = context.event,
        nodeId = currentNodeId.int, nodeType = nodeType, keyword = checkpointKeyword)
      # How big the value on this edge is, and what running the node cost in
      # heap. Together these say where a render's peak memory actually goes,
      # per node and per edge — the measurement phase 1's fusion rules are
      # supposed to be aimed at (docs/value-pipeline.md, phase 0).
      var profile = %*{
        "event": "interpreter:node:profile",
        "sceneId": self.id.string,
        "nodeId": currentNodeId.int,
        "nodeType": nodeType,
        "keyword": checkpointKeyword,
        "dataNode": asDataNode,
        "durationMs": (epochTime() - profileStartedAt) * 1000.0
      }
      if asDataNode:
        profile["valueKind"] = %($result.kind)
        profile["valueBytes"] = %result.approxByteSize()
        if result.kind == fkImage and not result.img.isNil:
          profile["valueWidth"] = %result.img.width
          profile["valueHeight"] = %result.img.height
        if result.kind == fkSpool:
          # Which byte-side tier this edge is carrying, so a profile shows a
          # spooled body as the window it costs and says why.
          profile["valueTier"] = %(if result.sp.isFileBacked(): "storage" else: "memory")
          profile["valueTotalBytes"] = %result.sp.len
      let profileMemoryAfter = renderMemoryInUse()
      if profileMemoryBefore.known and profileMemoryAfter.known:
        profile["heapDeltaBytes"] = %(profileMemoryAfter.bytes - profileMemoryBefore.bytes)
      if self.imageFusionPlans.hasKey(currentNodeId):
        let plan = self.imageFusionPlans[currentNodeId]
        # Name the adapter the planner chose, so memory attribution can tell a
        # canvas that was written in place from one that was drawn onto.
        profile["fusion"] = %*{
          "input": plan.inputName,
          # False when the plan existed but nothing fused this pass — no canvas
          # on the context, another hint in flight, or a state-wired fit that
          # resolved outside the plan. `tier` is only meaningful when true.
          "applied": plannedFit.len > 0,
          # Applied means the offer was made; claimed means the planned
          # producer actually took it. A persistent applied-but-unclaimed edge
          # is a producer allocating its own value while the inventory says
          # "fused" — the wikicommons failure shape, now one log field.
          "claimed": plannedFit.len > 0 and
            context.decodeTargetClaimedBy == plan.producerNodeId,
          "tier": (if plannedTier == iftLiveCanvas: "liveCanvas" else: "ownedScratch"),
          "plannedTier": (if plan.tier == iftLiveCanvas: "liveCanvas" else: "ownedScratch"),
          "producerNodeId": plan.producerNodeId.int,
          "forwardedThrough": plan.inPlaceNodeIds.len,
          # The fit the producer was actually asked for. This is the field that
          # would have caught the XKCD regression on sight: the scene asks for
          # "contain" and a producer decoding with the frame's scaling mode
          # would say "cover" right here.
          "fit": plannedFit
        }
      if self.imageBoundsPlans.hasKey(currentNodeId):
        let boundsPlan = self.imageBoundsPlans[currentNodeId]
        profile["bounds"] = %*{
          "input": boundsPlan.inputName,
          "applied": offeredBoundsWidth > 0,
          # Same lesson as fusion's claimed-vs-applied: an offer nobody takes
          # is free, but a producer that quietly ignores it decodes native.
          "claimed": offeredBoundsWidth > 0 and
            context.decodeBoundsClaimedBy == boundsPlan.producerNodeId,
          "producerNodeId": boundsPlan.producerNodeId.int,
          "width": offeredBoundsWidth,
          "height": offeredBoundsHeight
        }
      self.logger.log(profile)

    if asDataNode:
      break

    if self.nextNodeIds.hasKey(currentNodeId):
      currentNodeId = self.nextNodeIds[currentNodeId]
    else:
      currentNodeId = -1.NodeId


# -------------------------
# Scene wiring helpers
# -------------------------

proc ensureConfig*(scene: InterpretedFrameScene, node: DiagramNode): JsonNode =
  ## Make sure node.data["config"] exists and is an object; return it.
  if node.data.isNil:
    node.data = %*{}
  if not node.data.hasKey("config") or node.data["config"].kind != JObject:
    node.data["config"] = %*{}
  node.data["config"]

proc setNodeFieldFromEdge*(scene: InterpretedFrameScene, edge: DiagramEdge) =
  ## Map edges of the form:
  ##   sourceHandle: "field/<fieldName>[idx][idx]..."
  ##   targetHandle: "prev"
  ## into node.config["<fieldName>[idx][idx]"] = target NodeId (int).
  if not edge.sourceHandle.startsWith("field/"): return
  if edge.targetHandle != "prev": return
  if not scene.nodes.hasKey(edge.source): return
  let fieldPath = edge.sourceHandle.substr("field/".len) # keep full path inc. [i][j]
  scene.ensureConfig(scene.nodes[edge.source])[fieldPath] = %(edge.target.int)

# -------------------------
# Scene lifecycle
# -------------------------

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger,
    persistedState: JsonNode): FrameScene =
  if TRACING:
    logger.log(%*{"event": "initInterpreted", "sceneId": sceneId.string})

  var exportedScene: ExportedInterpretedScene
  if uploadedScenes.hasKey(sceneId):
    exportedScene = uploadedScenes[sceneId]
  elif loadedScenes.hasKey(sceneId):
    exportedScene = loadedScenes[sceneId]
  else:
    raise newException(Exception, "Scene not found: " & sceneId.string)

  let scene = InterpretedFrameScene(
    id: sceneId,
    isRendering: false,
    frameConfig: frameConfig,
    logger: logger,
    refreshInterval: exportedScene.refreshInterval,
    refreshIntervalKey: exportedScene.refreshIntervalKey,
    refreshIntervalDefault: exportedScene.refreshIntervalDefault,
    renderScaleKey: exportedScene.renderScaleKey,
    renderScaleSetting: exportedScene.renderScaleSetting,
    backgroundColor: exportedScene.backgroundColor,
    state: %*{},
    nodes: initTable[NodeId, DiagramNode](),
    edges: @[],
    apps: exportedScene.apps,
    customEventOrigins: exportedScene.customEventOrigins,
    eventMap: exportedScene.eventMap,
    shownName: exportedScene.name,
    refreshFollowsChildren: exportedScene.refreshFollowsChildren,
    followInterval: -1,
    layoutSceneId: exportedScene.layoutSceneId,
    layoutState: exportedScene.layoutState,
    nextNodeIds: initTable[NodeId, NodeId](),
    appsByNodeId: initTable[NodeId, AppRoot](),
    eventListeners: initTable[string, seq[NodeId]](),
    appInputsForNodeId: initTable[NodeId, Table[string, NodeId]](),
    appInlineInputsForNodeId: initTable[NodeId, Table[string, string]](),
    codeInputsForNodeId: initTable[NodeId, Table[string, NodeId]](),
    codeInlineInputsForNodeId: initTable[NodeId, Table[string, string]](),
    sceneNodes: initTable[NodeId, FrameScene](),
    sceneExportByNodeId: initTable[NodeId, ExportedScene](),
    publicStateFields: exportedScene.publicStateFields,
    jsReady: false,
    jsFuncNameByNode: initTable[NodeId, string](),
    codeInlineFuncNameByNodeArg: initTable[NodeId, Table[string, string]](),
    appInlineFuncNameByNodeArg: initTable[NodeId, Table[string, string]](),
    cacheValues: initTable[NodeId, Value](),
    cacheTimes: initTable[NodeId, float](),
    cacheKeys: initTable[NodeId, JsonNode](),
    cacheExprs: initTable[NodeId, JsonNode](),
    imageFusionPlans: initTable[NodeId, ImageFusionPlan](),
  )
  scene.execNode = proc(nodeId: NodeId, context: ExecutionContext) =
    discard scene.runNode(nodeId, context)
  scene.getDataNode = proc(nodeId: NodeId, context: ExecutionContext): Value =
    scene.runNode(nodeId, context, asDataNode = true)
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      scene.state[key] = persistedState[key]

  # stateFields carries every field (including private ones); older callers
  # that only set publicStateFields still get their state seeded.
  let allStateFields =
    if exportedScene.stateFields.len > 0: exportedScene.stateFields
    else: exportedScene.publicStateFields
  var typeMap = initTable[string, string]()
  for field in allStateFields:
    typeMap[field.name] = field.fieldType
    if not scene.state.hasKey(field.name):
      let seed = stateFieldSeed(field)
      if not seed.isNil:
        scene.state[field.name] = seed
  stateFieldTypesByScene[sceneId] = typeMap
  scene.syncRefreshInterval()

  ## Pass 1: register nodes & event listeners (do not init apps yet)
  for node in exportedScene.nodes:
    scene.nodes[node.id] = node
    if TRACING:
      scene.logger.log(%*{"event": "initInterpretedNode", "sceneId": scene.id, "nodeType": node.nodeType,
          "nodeId": node.id.int})
    if node.nodeType == "event":
      let eventName = node.data{"keyword"}.getStr()
      if TRACING:
        scene.logger.log(%*{"event": "initInterpretedEvent", "sceneId": scene.id, "nodeEvent": eventName,
            "nodeId": node.id.int})
      if not scene.eventListeners.hasKey(eventName):
        scene.eventListeners[eventName] = @[]
      scene.eventListeners[eventName].add(node.id)

  ## Pass 2: process edges (next/prev, app inputs, and node-field wiring)
  for edge in exportedScene.edges:
    if TRACING:
      scene.logger.log(%*{"event": "initInterpretedEdge", "sceneId": scene.id, "edgeId": edge.id.int,
          "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
          "targetHandle": edge.targetHandle})
    scene.edges.add(edge)
    if edge.sourceHandle == "next" and edge.targetHandle == "prev":
      scene.nextNodeIds[edge.source] = edge.target
      continue
    ## value edges (app/code output -> app input)

    if edge.sourceHandle == "fieldOutput" and edge.targetHandle.startsWith("fieldInput/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if not scene.appInputsForNodeId.hasKey(edge.target):
        scene.appInputsForNodeId[edge.target] = initTable[string, NodeId]()
      scene.appInputsForNodeId[edge.target][fieldName] = edge.source
      if TRACING:
        scene.logger.log(%*{"event": "initInterpretedAppInput", "sceneId": scene.id, "appNodeId": edge.target.int,
            "inputField": fieldName, "connectedNodeId": edge.source.int})
      continue

    if edge.sourceHandle == "stateOutput" and edge.targetHandle.startsWith("fieldInput/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if not scene.appInputsForNodeId.hasKey(edge.target):
        scene.appInputsForNodeId[edge.target] = initTable[string, NodeId]()
      scene.appInputsForNodeId[edge.target][fieldName] = edge.source
      if TRACING:
        scene.logger.log(%*{"event": "initInterpretedStateInput", "sceneId": scene.id, "appNodeId": edge.target.int,
            "inputField": fieldName, "connectedNodeId": edge.source.int})
      continue

    # TODO: these should probably be deprecated
    if edge.sourceHandle.startsWith("code/") and edge.targetHandle.startsWith("fieldInput/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if not scene.appInlineInputsForNodeId.hasKey(edge.target):
        scene.appInlineInputsForNodeId[edge.target] = initTable[string, string]()
      scene.appInlineInputsForNodeId[edge.target][fieldName] = edge.sourceHandle.substr("code/".len)
      if TRACING:
        scene.logger.log(%*{
          "event": "initInterpretedInlineInput",
          "sceneId": scene.id,
          "appNodeId": edge.target.int,
          "inputField": fieldName,
          "code": edge.sourceHandle.substr("code/".len)
        })
      continue

    if edge.targetHandle.startsWith("codeField/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if edge.sourceHandle == "fieldOutput" or edge.sourceHandle == "stateOutput":
        if not scene.codeInputsForNodeId.hasKey(edge.target):
          scene.codeInputsForNodeId[edge.target] = initTable[string, NodeId]()
        scene.codeInputsForNodeId[edge.target][fieldName] = edge.source
        if TRACING:
          scene.logger.log(%*{
            "event": "initInterpretedCodeInput",
            "sceneId": scene.id,
            "codeNodeId": edge.target.int,
            "arg": fieldName,
            "connectedNodeId": edge.source.int
          })
        continue
      elif edge.sourceHandle.startsWith("code/"):
        if not scene.codeInlineInputsForNodeId.hasKey(edge.target):
          scene.codeInlineInputsForNodeId[edge.target] = initTable[string, string]()
        scene.codeInlineInputsForNodeId[edge.target][fieldName] = edge.sourceHandle.substr("code/".len)
        if TRACING:
          scene.logger.log(%*{
            "event": "initInterpretedCodeInlineInput",
            "sceneId": scene.id,
            "codeNodeId": edge.target.int,
            "arg": fieldName,
            "code": edge.sourceHandle.substr("code/".len)
          })
        continue

    ## node-field edges (app field -> prev of target node)
    if edge.sourceHandle.startsWith("field/") and edge.targetHandle == "prev":
      scene.setNodeFieldFromEdge(edge)
      if TRACING:
        scene.logger.log(%*{
          "event": "initInterpretedAppField",
          "sceneId": scene.id,
          "appNodeId": edge.source.int,
          "fieldPath": edge.sourceHandle.substr("field/".len),
          "targetNodeId": edge.target.int
        })
      continue

    if edge.edgeType == "codeNodeEdge":
      if TRACING:
        logger.log(%*{"event": "initInterpretedEdge:codeNodeEdge:ignored", "sceneId": scene.id, "edgeId": edge.id.int,
            "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
            "targetHandle": edge.targetHandle})
      continue

    logger.log(%*{"event": "initInterpretedEdge:ignored", "sceneId": scene.id, "edgeId": edge.id.int,
        "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
        "targetHandle": edge.targetHandle})

  ## Precompile functions. The JS context is built on demand, not here:
  ## compileAppInlineFn/compileCodeFn/evalOneShot each call ensureSceneJs
  ## themselves, so eagerly building one here only ever cost scenes that turn
  ## out to have no code nodes and no inline JS at all — a whole QuickJS
  ## runtime for nothing. That matters most for nested scenes, where the
  ## purely structural wrapper is the common case and every level used to pay.
  # Precompile functions for inline app/scene inputs (for all nodes that have them)
  for nodeId, inlineMap in scene.appInlineInputsForNodeId:
    for inputName, snippet in inlineMap.pairs:
      compileAppInlineFn(scene, nodeId, inputName, snippet)

  # Precompile functions for code nodes and their inline args
  for node in exportedScene.nodes:
    if node.nodeType == "code":
      compileCodeFn(scene, node)
      if scene.codeInlineInputsForNodeId.hasKey(node.id):
        for argName, snippet in scene.codeInlineInputsForNodeId[node.id].pairs:
          compileCodeInlineFn(scene, node.id, argName, snippet)

  ## Pass 3: initialize apps AFTER we've wired fields via edges
  for node in exportedScene.nodes:
    if node.nodeType == "app":
      let keyword = node.data{"keyword"}.getStr()
      if TRACING:
        scene.logger.log(%*{
          "event": "initInterpretedApp",
          "sceneId": scene.id,
          "nodeType": node.nodeType,
          "nodeId": node.id.int,
          "appKeyword": keyword,
          "configKeys": (if node.data.hasKey("config") and node.data["config"].kind == JObject:
          node.data["config"].keys.toSeq()
        else:
          @[])
        })
      let app = initInterpretedApp(keyword, node, scene)
      scene.appsByNodeId[node.id] = app
      if app.dynamicJsAppSubscribes():
        scene.eventApps.add(node.id)

    elif node.nodeType == "scene":
      let childSceneId = node.data{"keyword"}.getStr().SceneId
      var exportedChild: ExportedScene
      var isInterpretedChild = false

      if uploadedScenes.hasKey(childSceneId):
        let interpretedExport = uploadedScenes[childSceneId]
        exportedChild = ExportedScene(interpretedExport)
        isInterpretedChild = true
      elif loadedScenes.hasKey(childSceneId):
        let interpretedExport = loadedScenes[childSceneId]
        exportedChild = ExportedScene(interpretedExport)
        isInterpretedChild = true
      elif compiledSceneExports.hasKey(childSceneId):
        exportedChild = compiledSceneExports[childSceneId]
      elif not sceneLoader.isNil and sceneLoader(childSceneId) and loadedScenes.hasKey(childSceneId):
        exportedChild = ExportedScene(loadedScenes[childSceneId])
        isInterpretedChild = true
      else:
        raise newException(Exception,
          "Scene node references unknown scene id: " & childSceneId.string)

      # Use node.data.config as the initial state for the child scene (mirrors compiled behavior)
      var persisted = %*{}
      if node.data.hasKey("config") and node.data["config"].kind == JObject:
        persisted = node.data["config"]

      let child = exportedChild.init(childSceneId, frameConfig, logger, persisted)
      scene.sceneNodes[node.id] = child
      scene.sceneExportByNodeId[node.id] = exportedChild
      scene.logger.log(%*{
        "event": "initChildScene",
        "parentSceneId": scene.id,
        "nodeId": node.id.int,
        "childSceneId": childSceneId.string,
        "execution": if isInterpretedChild: "interpreted" else: "compiled"
      })


  ## Pass 4: negotiate what each image edge may skip materializing. Runs after
  ## the apps exist, because a node whose behaviour comes from scene JSON (a
  ## dynamic JS app) is opaque no matter what its keyword declares.
  let opaqueCheck: OpaqueCheck = proc (nodeId: NodeId): bool {.closure, gcsafe, raises: [].} =
    scene.appsByNodeId.getOrDefault(nodeId, nil).isDynamicJsApp()
  scene.planImageFusion(opaqueCheck)
  # Pass 5: the edges the fusion planner left materialized still get the
  # consumer's useful resolution passed upstream (requestedBounds).
  scene.planImageBounds(opaqueCheck)

  logger.log(%*{"event": "initInterpretedDone", "sceneId": sceneId.string, "nodes": scene.nodes.len,
      "edges": scene.edges.len, "eventListeners": scene.eventListeners.len, "apps": scene.appsByNodeId.len,
      "imageFusionPlans": scene.imageFusionPlans.len,
      "imageBoundsPlans": scene.imageBoundsPlans.len})

  # "init" fires here, once per scene instance and after its apps exist, the
  # way a compiled scene's generated init does it. It used to be the parent's
  # job and only child scenes had a parent, so a top-level interpreted scene —
  # the default execution mode, on every host — never heard it.
  if scene.eventListeners.hasKey("init"):
    var initContext = ExecutionContext(scene: scene, event: "init", payload: scene.state,
      hasImage: false, loopIndex: 0, loopKey: ".")
    runEvent(scene, initContext)

  return scene

# -------------------------
# Events / rendering
# -------------------------

proc applyPublicStateFromPayload(scene: InterpretedFrameScene, payload: JsonNode) =
  if payload.isNil or payload.kind != JObject: return
  for field in scene.publicStateFields:
    let key = field.name
    if payload.hasKey(key):
      var value = copy(payload[key])
      # Control forms deliver json fields as strings; parse them so state
      # nodes hand consumers real objects, like seeded defaults do
      if field.fieldType == "json" and value.kind == JString:
        try:
          value = parseJson(value.getStr())
        except CatchableError:
          discard
      if value != scene.state{key}:
        scene.state[key] = value

proc eventNodeMatchesPayload(node: DiagramNode, payload: JsonNode): bool =
  # Every filter the listener sets must match; a field it leaves empty matches
  # anything. A `button` listener with no `action` hears every press, double
  # press and long press: the line's own edges are `gpio` (docs/events.md).
  var hasLabelFilter = false
  if not node.data.isNil and node.data.kind == JObject:
    if node.data.hasKey("config") and node.data["config"].kind == JObject:
      let config = node.data["config"]
      for key, value in config.pairs:
        let expected = eventFilterValue(value)
        if expected.len > 0:
          if key == "label":
            hasLabelFilter = true
          if not eventPayloadValueMatches(payload, key, expected):
            return false

    if not hasLabelFilter and node.data.hasKey("label"):
      let expected = eventFilterValue(node.data["label"])
      if expected.len > 0 and not eventPayloadValueMatches(payload, "label", expected):
        return false

  true

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

proc logListenerError(scene: FrameScene, event: string, nodeId: NodeId, e: ref Exception) =
  ## `nodeId` is how the editor puts the error on its node (frameRuntimeErrors.ts).
  scene.logger.log(%*{"event": "runEventInterpreted:error", "sceneId": scene.id,
    "contextEvent": event, "nodeId": nodeId.int, "error": $e.msg, "stacktrace": e.getStackTrace()})

proc appsHear(scene: InterpretedFrameScene, event: string): bool =
  ## A JS app subscribed to `event` by name, or through "*".
  for nodeId in scene.eventApps:
    if scene.appsByNodeId[nodeId].dynamicJsAppHears(event):
      return true

proc listensThrough(scene: FrameScene, event: string, wearer: FrameScene): bool =
  ## `wearer`: the scene this one is the layout of, asked already. It is also
  ## this layout's content slot, and asking it again never ends.
  if scene.isNil or not (scene of InterpretedFrameScene):
    return true
  let interpreted = InterpretedFrameScene(scene)
  if interpreted.eventListeners.hasKey(event) or uiListens(scene.id.string, event) or interpreted.appsHear(event):
    return true
  # A pointer event is built for a scene that listens, and what it embeds
  # hears it through that scene: its layout, the panels, its `<Scene>`s.
  let layout = scene.wornLayout
  if not layout.isNil and listensThrough(layout, event, scene):
    return true
  for slot in scene.slots:
    if slot.child != scene and slot.child != wearer and listensThrough(slot.child, event, nil):
      return true

proc sceneListensTo*(scene: FrameScene, event: string): bool =
  ## Whether the scene has an event node for `event`. The dispatcher builds an
  ## input event's payload only when this is true; a scene that is not
  ## interpreted keeps every event, because nothing here can tell.
  listensThrough(scene, event, nil)

proc sceneKeyboardAt*(sceneId: SceneId, x, y: int): bool =
  ## Whether the scene's keyboard on the screen (a JSX field's) is under
  ## (x, y), scene pixels: the hosts' `EventHost.keyboardAt`.
  ui_events.keyboardAt(sceneId.string, x.float32, y.float32)

proc takesPresses(scene: InterpretedFrameScene): bool =
  ## A listener of its own for what a press becomes.
  for event in ["pointerDown", "pointerUp", "tap", "doubleTap", "longPress"]:
    if scene.eventListeners.hasKey(event) or scene.appsHear(event):
      return true

proc pressTakenIn(scene: FrameScene; x, y: float32; wearer: FrameScene; depth: int): bool =
  ## The way a pointer event goes (routePointer): into the scene's layout, to
  ## the panel under it in that panel's coordinates, else the scene's own UI.
  if scene.isNil or depth > 8:
    return false
  if scene != wearer and not scene.wornLayout.isNil:
    return pressTakenIn(scene.wornLayout, x, y, scene, depth + 1)
  if scene of InterpretedFrameScene and InterpretedFrameScene(scene).takesPresses():
    return true
  for i in countdown(scene.slots.high, 0):
    template s: untyped = scene.slots[i]
    if x >= s.visible[0] and y >= s.visible[1] and x < s.visible[2] and y < s.visible[3]:
      return pressTakenIn(s.child, x - s.x.float32, y - s.y.float32, wearer, depth + 1)
  uiTakesPressAt(scene.id.string, x, y)

proc pressTakenAt*(scene: FrameScene; x, y: int): bool =
  ## Whether something on the frame does something with a press at (x, y), the
  ## scene's pixels. Asked at the moment of the press, of what the last render
  ## drew: an element with only an onClick hears no pointerDown, and a press
  ## near the edge of a touch panel is not delivered until it is known not to
  ## be a swipe.
  pressTakenIn(scene, x.float32, y.float32, nil, 0)

type PressRect* = object
  ## One entry of a press map: x0, y0, x1, y1 in the scene's pixels, and
  ## whether a press there is taken. The first entry a press lands in answers.
  box*: array[4, float32]
  taken*: bool

proc clipped(box, clip: array[4, float32]): array[4, float32] =
  [max(box[0], clip[0]), max(box[1], clip[1]), min(box[2], clip[2]), min(box[3], clip[3])]

proc nonEmpty(box: array[4, float32]): bool = box[2] > box[0] and box[3] > box[1]

proc pressMapIn(scene: FrameScene; dx, dy: float32; clip: array[4, float32]; wearer: FrameScene;
                depth: int; into: var seq[PressRect]) =
  ## pressTakenIn as a list: the layout first, a slot answering alone for its
  ## part (its child's entries, then the slot itself as untaken), then the
  ## scene's own UI.
  if scene.isNil or depth > 8 or not clip.nonEmpty:
    return
  if scene != wearer and not scene.wornLayout.isNil:
    pressMapIn(scene.wornLayout, dx, dy, clip, scene, depth + 1, into)
    return
  if scene of InterpretedFrameScene and InterpretedFrameScene(scene).takesPresses():
    into.add PressRect(box: clip, taken: true)
    return
  for i in countdown(scene.slots.high, 0):
    template s: untyped = scene.slots[i]
    let zone = clipped([dx + s.visible[0], dy + s.visible[1], dx + s.visible[2], dy + s.visible[3]], clip)
    if zone.nonEmpty:
      pressMapIn(s.child, dx + s.x.float32, dy + s.y.float32, zone, wearer, depth + 1, into)
      into.add PressRect(box: zone, taken: false)
  var regions: seq[array[4, float32]]
  uiPressRects(scene.id.string, regions)
  for region in regions:
    let box = clipped([dx + region[0], dy + region[1], dx + region[2], dy + region[3]], clip)
    if box.nonEmpty:
      into.add PressRect(box: box, taken: true)

proc pressMap*(scene: FrameScene; width, height: int): seq[PressRect] =
  ## pressTakenAt for the whole canvas at once, of what the last render drew:
  ## where a press does something, as a control plane hands it to a board
  ## with the picture (docs/server-rendering.md "The click"). An entry inside
  ## a taken one before it, or after one that covers the canvas, says nothing
  ## and is left out.
  var all: seq[PressRect]
  pressMapIn(scene, 0, 0, [0'f32, 0, width.float32, height.float32], nil, 0, all)
  for entry in all:
    var said = true
    for earlier in result:
      if earlier.box[0] <= entry.box[0] and earlier.box[1] <= entry.box[1] and
          earlier.box[2] >= entry.box[2] and earlier.box[3] >= entry.box[3]:
        said = false
        break
    if said:
      result.add entry
  # A press that lands in nothing is not taken: untaken entries at the end say nothing.
  while result.len > 0 and not result[^1].taken:
    result.setLen(result.len - 1)

proc runEventApps(scene: InterpretedFrameScene, context: ExecutionContext) =
  ## The onEvent of the JS apps that subscribed to this event. One that returns
  ## true is drawn again, as a run of a JSX handler is.
  var wantsRender = false
  for nodeId in scene.eventApps:
    let app = scene.appsByNodeId[nodeId]
    if app.dynamicJsAppHears(context.event):
      try:
        inc eventListenersRun
        if onEventDynamicJsApp(app, context):
          wantsRender = true
      except Exception as e:
        scene.logListenerError(context.event, nodeId, e)
  if wantsRender:
    rhythmMarkDue(scene)
    sendEvent("render", %*{}, eoScene)

{.pop.}

proc runEventInner(self: FrameScene, context: ExecutionContext) =
  if not self.ownRun.isNil:
    # A built-in scene. What happens to it is what it draws next.
    if context.event != "render":
      rhythmMarkDue(self)
    self.ownRun(self, context)
    return
  var scene: InterpretedFrameScene = InterpretedFrameScene(self)
  markRuntimeCheckpoint("event:start", currentSceneId = self.id.string, contextEvent = context.event,
    clearNode = true)

  case context.event:
  of "setSceneState":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      applyPublicStateFromPayload(scene, context.payload["state"])
    if context.payload.hasKey("render"):
      sendEvent("render", %*{}, eoSystem)
  of "setCurrentScene":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      applyPublicStateFromPayload(scene, context.payload["state"])
  of "render":
    if not context.hasImage or context.image.isNil:
      # Same rotation contract as runner.renderSceneImage: scenes render at
      # the rotated dimensions; the output is rotated back to panel space
      # afterwards (Pi: rotateDegrees; embedded: rotation-aware packers).
      context.image = case self.frameConfig.rotate:
        of 90, 270: newImage(self.frameConfig.height, self.frameConfig.width)
        else: newImage(self.frameConfig.width, self.frameConfig.height)
      context.hasImage = true
    # Owed, not painted: whatever draws first pays it, and a first paint
    # that covers the canvas opaquely waives it (ExecutionContext's
    # backgroundPending). Paid below when nothing draws.
    context.backgroundColor = scene.backgroundColor
    context.backgroundPending = true
    scene.slots.setLen(0)
    # One render listener whose flow is one node: what that node draws is the
    # whole frame.
    context.wholeFrame = false
    if scene.eventListeners.hasKey("render") and scene.eventListeners["render"].len == 1:
      let first = scene.nextNodeIds.getOrDefault(scene.eventListeners["render"][0], -1.NodeId)
      if first != 0.NodeId and first != -1.NodeId:
        let after = scene.nextNodeIds.getOrDefault(first, -1.NodeId)
        context.wholeFrame = after == 0.NodeId or after == -1.NodeId
  of "tap", "doubleTap", "longPress", "swipe", "pointerDown", "pointerUp", "pointerMove", "pointerCancel", "uiTimer":
    # A JSX UI's handlers and hover:/active: classes, its fields and the
    # boxes that scroll (ui/events.nim). A run of a handler, a change in
    # what the pointer is over, a field's text or a scroll is a new picture.
    if not routePointer(scene, context) and dispatchUiEvent(self.id.string, context.event, context.payload):
      rhythmMarkDue(self)
      sendEvent("render", %*{}, eoScene)
  else:
    when defined(frameosEmbedded):
      uiSceneEvent(self.id.string)
    else:
      # Keys for a field and the wheel: not on an ESP32, which has neither.
      if context.event in ["keyDown", "textInput", "wheel"]:
        if dispatchUiEvent(self.id.string, context.event, context.payload):
          sendEvent("render", %*{}, eoScene)
      else:
        uiSceneEvent(self.id.string)

  if scene.eventListeners.hasKey(context.event):
    # Track filtered-out listeners so a press that matches nothing says so.
    # A scene whose event node filters on label "A" and a frame whose buttons
    # are labelled BOOT/KEY1 (board silkscreen, per the ESP32 preset) is a
    # dead button with no error anywhere: the GPIO fires, the event reaches
    # the scene, every listener rejects it, and runEvent returns quietly.
    var listenersFiltered = 0
    var matched = 0
    var expectedFilters: seq[string] = @[]
    for nodeId in scene.eventListeners[context.event]:
      let nextNode = if scene.nextNodeIds.hasKey(nodeId): scene.nextNodeIds[nodeId] else: -1.NodeId
      if nextNode != 0.NodeId and nextNode != -1.NodeId:
        if scene.nodes.hasKey(nodeId) and not eventNodeMatchesPayload(scene.nodes[nodeId], context.payload):
          listenersFiltered += 1
          let d = scene.nodes[nodeId].data
          if not d.isNil and d.kind == JObject:
            if d.hasKey("config") and d["config"].kind == JObject:
              for key, value in d["config"].pairs:
                let expected = eventFilterValue(value)
                if expected.len > 0: expectedFilters.add(key & "=" & expected)
            elif d.hasKey("label"):
              let expected = eventFilterValue(d["label"])
              if expected.len > 0: expectedFilters.add("label=" & expected)
          continue
        try:
          matched += 1
          inc eventListenersRun
          discard scene.runNode(nextNode, context)
        except Exception as e:
          self.logListenerError(context.event, nextNode, e)
      else:
        listenersFiltered += 1
    if listenersFiltered > 0 and matched == 0:
      # A key event's payload stays out of the log (event_log.nim): a listener
      # filtered on one key would otherwise log every other key pressed.
      self.logger.log(withEventPayload(%*{
        "event": "runEvent:noListenerMatched",
        "sceneId": self.id,
        "contextEvent": context.event,
        "expected": expectedFilters,
        "error": "\"" & context.event & "\" reached the scene but every listener filtered it out" &
          (if expectedFilters.len > 0: " (nodes want " & expectedFilters.join(", ") & ")" else: "")
      }, context.event, context.payload))
  scene.runEventApps(context)
  # A render in which nothing drew still shows the background.
  paintPendingBackground(context)

proc resolvedRenderDeadlineMs(frameConfig: FrameConfig): int =
  if frameConfig != nil and frameConfig.js != nil and frameConfig.js.renderDeadlineMs >= 0:
    return frameConfig.js.renderDeadlineMs
  DefaultRenderDeadlineMs

proc resolvedDispatchBudget(frameConfig: FrameConfig): int =
  if frameConfig != nil and frameConfig.js != nil and frameConfig.js.dispatchBudget >= 0:
    return frameConfig.js.dispatchBudget
  DefaultDispatchBudget

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

proc renderChrome(host: FrameScene, context: ExecutionContext) =
  ## A render of a scene whose UI may have holes (a layout around its
  ## `<yield />`, a UI with `<Scene>`s). A pass the UI has nothing to do in
  ## never enters it: its picture is on the canvas already, or comes out of
  ## another frame buffer around the holes, and what is in the holes gets its turn.
  let decision = rhythmVisitChrome(host)
  if decision == rdKeep or decision == rdRestore:
    if decision == rdRestore:
      rhythmRestoreChrome(host, context.image)
    for i in 0 ..< host.slots.len:
      template s: untyped = host.slots[i]
      drawIntoHole(host, s.child, context.image, s.x.int, s.y.int, int(s.visible[2] - s.x), int(s.visible[3] - s.y),
        context, addSlot = false)
    return
  runEventInner(host, context)
  if rhythmChromeCanStay(host):
    rhythmChromeRan(host, decision, context.nextSleep)

{.pop.}

proc runEvent*(self: FrameScene, context: ExecutionContext) =
  ## Every run of a scene — a render, an event, a child scene's init — enters
  ## here on every host (runner.nim, embedded_runtime.nim, wasm_main.nim), so
  ## this is where the run's budgets are armed: the wall-clock deadline that
  ## counts native calls too, and the dispatch budget. Re-entrant: a nested run
  ## rides on the outer one's budgets (run_budget.nim).
  let armedHere = armRenderDeadline(resolvedRenderDeadlineMs(self.frameConfig))
  if armedHere:
    setDispatchBudget(resolvedDispatchBudget(self.frameConfig))
  # The outermost render is a pass: embedded scenes decide against its start
  # whether they are due (scene_rhythm.nim).
  let rendering = context.event == "render"
  let passStarted = rendering and rhythmEnterRender(self, if context.hasImage: context.image else: nil)
  let outerYield = yieldScene
  try:
    # The layout wraps the frame's own scene and nothing else, so it comes to
    # life on the pass that starts here and is looked at no other time.
    let layout =
      if self == yieldScene: nil
      elif self of InterpretedFrameScene:
        (if passStarted: ensureLayoutScene(InterpretedFrameScene(self)) else: self.wornLayout)
      elif self.ownRun.isNil: nil
      else: ensureBuiltInLayout(self)
    if layout.isNil:
      if rendering:
        renderChrome(self, context)
      else:
        runEventInner(self, context)
    else:
      yieldScene = self
      if rendering:
        # A layout's nextSleep is the layout's: it never reaches the frame.
        let parentSleep = context.nextSleep
        let saved = rhythmEnterHole()
        context.nextSleep = -1
        runEvent(layout, context)
        rhythmLeaveChild(saved)
        context.nextSleep = parentSleep
      elif context.event in PointerEvents:
        # Over the chrome it is the layout's; over the content it comes
        # back here through the layout's slots.
        runEvent(layout, context)
      else:
        runEventInner(self, context)
        # What is said to the scene's state is the scene's alone.
        if context.event != "setCurrentScene" and context.event != "setSceneState" and context.event != "uiTimer":
          runEvent(layout, context)
  finally:
    yieldScene = outerYield
    if rendering:
      rhythmLeaveRender(self, passStarted)
    # The run may have moved the interval: a setSceneState from a control
    # panel, the scene's own code assigning `state.refreshInterval`, or (a
    # generated split) the time until its first panel is due.
    self.syncRefreshInterval()
    if armedHere:
      disarmRenderDeadline()
      setDispatchBudget(0)

proc runBuiltIn(self: FrameScene, context: ExecutionContext): bool =
  if self == yieldScene or self.state{"noLayout"}.getBool() or layoutFor(self.state{"layout", "sceneId"}.getStr()).len == 0:
    return false
  runEvent(self, context)
  true

builtInRunner = runBuiltIn

proc render*(self: FrameScene, context: ExecutionContext): Image =
  if TRACING:
    self.logger.log(%*{
      "event": "renderInterpreted",
      "sceneId": self.id,
      "width": self.frameConfig.width,
      "height": self.frameConfig.height
    })
  runEvent(self, context)
  result = context.image

proc clearRunNodeStacks*(scene: FrameScene) =
  ## After an out-of-memory abort (single_scene_host.recoverAbortedRun), for
  ## the scene and every child scene it holds: runNode pops its stack in a
  ## `defer`, which the longjmp skipped, and a node left on it read as its
  ## own producer ("depends on itself") on every later render.
  if scene.isNil or not (scene of InterpretedFrameScene):
    return
  let interpreted = InterpretedFrameScene(scene)
  interpreted.runNodeStack.setLen(0)
  yieldScene = nil # the same abort skipped the layout's `finally`
  clearRunNodeStacks(scene.wornLayout)
  for _, child in interpreted.sceneNodes:
    clearRunNodeStacks(child)

# -------------------------
# Writing scene types with jsony (toJson); reading is below
# -------------------------

proc dumpHook*(s: var string, v: StateFieldOption) =
  ## Round-trips back to the shape it came in as: a bare string unless it
  ## carries a label of its own.
  if v.label == "" or v.label == v.value:
    dumpHook(s, v.value)
  else:
    s.add("{\"value\":")
    dumpHook(s, v.value)
    s.add(",\"label\":")
    dumpHook(s, v.label)
    s.add('}')

proc dumpHook*(s: var string, v: SplitLayoutMarker) =
  s.add(if v.present: "{}" else: "null")

proc dumpHook*(s: var string, v: Color) =
  s.add('"')
  s.add(toHtmlHex(v))
  s.add('"')

# -------------------------
# Reading scenes.json
# -------------------------
#
# jsony's untyped pieces (strings, numbers, JsonNode, skipping a value) and a
# loop per type over the keys. jsony read this JSON straight into the types
# until 2026-11-14, and its generic typed parse was 27 KB of the ESP32
# firmware, all for this one call; a tree from std/json walked afterwards was
# a third the size and three times slower, which a deep sleeper pays on every
# wake. The loops read the JSON as jsony did: a key names a field by its name
# or its snake_case form ("type" is the node's, the edge's and the field's
# kind), the last of a repeated key wins, an absent key leaves the default, a
# JSON field keeps the value it was given (null included), unknown keys are
# skipped without being built, and node ids are numbered in the order the
# document names them. Where jsony refused a value of the wrong type (a number
# for a name, null for a list) the loops take the default instead: a scene
# that fails to parse takes the whole frame down. tests/test_scene_reader.nim
# reads every repo and e2e scene both ways and compares.

proc mapSourceNodeId*(source: string): NodeId =
  ## The runtime's id for a node id as the scene JSON wrote it: one table for
  ## every scene loaded, so the same name is the same node across reloads.
  if nodeMappingTable.hasKey(source):
    return nodeMappingTable[source]
  globalNodeCounter += 1
  result = NodeId(globalNodeCounter)
  nodeMappingTable[source] = result

proc openValue(s: string, i: var int, open: char): bool =
  ## At `open` ('{' or '['): consumes it. At anything else (null, a number, the
  ## other bracket): skips that value, and the field keeps its default.
  eatSpace(s, i)
  if i < s.len and s[i] == open:
    inc i
    return true
  skipValue(s, i)

proc expectChar(s: string, i: var int, c: char) =
  ## jsony's eatChar, which is a template: its message is built once here.
  eatSpace(s, i)
  if i < s.len and s[i] == c:
    inc i
  else:
    raise newException(jsony.JsonError, "Expected " & c & " at offset " & $i)

proc moreItems(s: string, i: var int, close: char): bool =
  ## Before the next key or item of the object or list `openValue` opened:
  ## false at its end, `close` consumed. The end of the text or the other
  ## bracket raises, so a broken scene can never loop here.
  eatSpace(s, i)
  if i < s.len and s[i] == ',':
    inc i
    eatSpace(s, i)
  if i >= s.len or s[i] in {'}', ']'}:
    expectChar(s, i, close)
    return false
  true

proc readKey(s: string, i: var int): string =
  parseHook(s, i, result)
  expectChar(s, i, ':')

proc readText(s: string, i: var int): string =
  ## A string; null and anything else are "" (anything else is skipped).
  eatSpace(s, i)
  if i < s.len and s[i] in {'"', 'n'}:
    parseHook(s, i, result)
  elif i < s.len and s[i] in {'-', '+', '0'..'9', 't', 'f'}:
    result = parseSymbol(s, i) # a number or a boolean, as written
  else:
    skipValue(s, i)

proc readNumber(s: string, i: var int): float =
  eatSpace(s, i)
  if i < s.len and s[i] in {'-', '+', '0'..'9'}:
    parseHook(s, i, result)
  else:
    skipValue(s, i)

proc readFlag(s: string, i: var int): bool =
  eatSpace(s, i)
  if i < s.len and s[i] in {'t', 'f'}:
    parseHook(s, i, result)
  else:
    skipValue(s, i)

proc readJson(s: string, i: var int): JsonNode =
  parseHook(s, i, result)

proc readNode(s: string, i: var int): DiagramNode =
  result = DiagramNode()
  var source = ""
  while moreItems(s, i, '}'):
    case readKey(s, i)
    of "id":
      source = readText(s, i)
      result.id = mapSourceNodeId(source)
    of "data": result.data = readJson(s, i)
    of "type", "nodeType", "node_type": result.nodeType = readText(s, i)
    else: skipValue(s, i)
  # The id as the scene wrote it goes on the node's data, as
  # `__frameosSourceNodeId`: the name an error line gives the editor.
  if source.len > 0:
    if result.data.isNil or result.data.kind != JObject:
      result.data = newJObject()
    if not result.data.hasKey("__frameosSourceNodeId"):
      result.data["__frameosSourceNodeId"] = newJString(source)

proc readEdge(s: string, i: var int): DiagramEdge =
  result = DiagramEdge()
  while moreItems(s, i, '}'):
    case readKey(s, i)
    of "id": result.id = mapSourceNodeId(readText(s, i))
    of "source": result.source = mapSourceNodeId(readText(s, i))
    of "target": result.target = mapSourceNodeId(readText(s, i))
    of "sourceHandle", "source_handle": result.sourceHandle = readText(s, i)
    of "targetHandle", "target_handle": result.targetHandle = readText(s, i)
    of "data": result.data = readJson(s, i)
    of "type", "edgeType", "edge_type": result.edgeType = readText(s, i)
    else: skipValue(s, i)

proc readOption(s: string, i: var int): StateFieldOption =
  ## A select option is stored either as "value" (the value doubles as the
  ## label) or as {"value": .., "label": ..}. Editors have also shipped numbers
  ## and half-filled objects, and a scene that fails to parse takes the whole
  ## frame down, so take whatever is there.
  eatSpace(s, i)
  if i < s.len and s[i] == '{':
    inc i
    while moreItems(s, i, '}'):
      case readKey(s, i)
      of "value": result.value = readText(s, i)
      of "label": result.label = readText(s, i)
      else: skipValue(s, i)
  else:
    result.value = readText(s, i) # a list is nothing usable, and skipped
  if result.label == "":
    result.label = result.value

proc readField(s: string, i: var int): StateField =
  result = StateField()
  while moreItems(s, i, '}'):
    case readKey(s, i)
    of "name": result.name = readText(s, i)
    of "label": result.label = readText(s, i)
    of "type", "fieldType", "field_type": result.fieldType = readText(s, i)
    of "value": result.value = readJson(s, i)
    of "options":
      result.options = @[]
      if openValue(s, i, '['):
        while moreItems(s, i, ']'):
          result.options.add(readOption(s, i))
    of "placeholder": result.placeholder = readText(s, i)
    of "required": result.required = readFlag(s, i)
    of "secret": result.secret = readFlag(s, i)
    of "persist": result.persist = readText(s, i)
    of "access": result.access = readText(s, i)
    of "showIf", "show_if": result.showIf = readJson(s, i)
    of "role": result.role = readText(s, i)
    else: skipValue(s, i)

proc readSettings(s: string, i: var int): FrameSceneSettings =
  result = FrameSceneSettings()
  while moreItems(s, i, '}'):
    case readKey(s, i)
    # A color that does not parse refuses the scene, as it always has.
    of "backgroundColor", "background_color": result.backgroundColor = parseHtmlColor(readText(s, i))
    of "refreshInterval", "refresh_interval": result.refreshInterval = readNumber(s, i)
    of "renderScale", "render_scale": result.renderScale = readNumber(s, i)
    # The split drawer's layout is the editor's; the runtime only asks
    # whether it is there.
    of "splitScreenLayout", "split_screen_layout":
      eatSpace(s, i)
      result.splitScreenLayout.present = i < s.len and s[i] == '{'
      skipValue(s, i)
    of "isLayout", "is_layout": result.isLayout = readFlag(s, i)
    else: skipValue(s, i)

proc readList[T](s: string, i: var int, read: proc(s: string, i: var int): T {.nimcall.}): seq[T] =
  ## A list of objects; an item that is not one (null) is skipped.
  if openValue(s, i, '['):
    while moreItems(s, i, ']'):
      if openValue(s, i, '{'):
        result.add(read(s, i))

proc readScene(s: string, i: var int): FrameSceneInput =
  result = FrameSceneInput()
  while moreItems(s, i, '}'):
    case readKey(s, i)
    of "id": result.id = readText(s, i).SceneId
    of "name": result.name = readText(s, i)
    of "nodes": result.nodes = readList(s, i, readNode)
    of "edges": result.edges = readList(s, i, readEdge)
    of "apps": result.apps = readJson(s, i)
    of "fields": result.fields = readList(s, i, readField)
    of "settings": result.settings = if openValue(s, i, '{'): readSettings(s, i) else: nil
    of "origin": result.origin = readJson(s, i)
    of "customEvents", "custom_events": result.customEvents = readJson(s, i)
    of "eventMap", "event_map": result.eventMap = readJson(s, i)
    of "layout": result.layout = readJson(s, i)
    else: skipValue(s, i)

# -------------------------
# Scene registry (loader)
# -------------------------

proc buildInterpretedSceneExport(scene: FrameSceneInput): ExportedInterpretedScene =
  let settingsInterval = if scene.settings != nil: scene.settings.refreshInterval else: 0.0
  let backgroundColor = if scene.settings != nil: scene.settings.backgroundColor else: parseHtmlColor("#000000")
  # The refresh interval is a state field: the scene's own (by role or by
  # name), where the scene put it, or an implicit public one added last.
  let refresh = resolveRefreshInterval(scene.fields, settingsInterval)
  ExportedInterpretedScene(
    name: scene.name,
    nodes: scene.nodes,
    edges: scene.edges,
    apps: if scene.apps.isNil: %*{} else: scene.apps,
    stateFields: refresh.fields,
    customEventOrigins: declaredCustomEventOrigins(scene.customEvents),
    # The installed copy's rules as they came; nil when there are none, so
    # the dispatcher's check per event is one nil test (event_map.nim).
    eventMap: if scene.eventMap.isNil or scene.eventMap.kind != JArray or
      scene.eventMap.len == 0: nil else: scene.eventMap,
    # A scene the split drawer generated draws nothing of its own that
    # changes: it waits for its panels, but never renders more often than
    # its own interval (scene_rhythm.nim).
    refreshFollowsChildren: scene.settings != nil and scene.settings.splitScreenLayout.present,
    # The install's layout, read here so that nothing else knows its shape.
    isLayout: scene.settings != nil and scene.settings.isLayout,
    layoutSceneId: scene.layout{"sceneId"}.getStr().SceneId,
    layoutState: scene.layout{"state"},
    # Fields without an explicit access default to public for interpreted
    # scenes to keep older scenes.json exports controllable.
    publicStateFields: refresh.fields.filterIt(it.access != "private"),
    persistedStateKeys: refresh.fields.filterIt(it.persist == "disk").mapIt(it.name),
    refreshIntervalKey: refresh.key,
    refreshIntervalDefault: refresh.defaultSeconds,
    refreshIntervalImplicit: refresh.implicit,
    # Its own render scale, over the frame's: a role field, else the setting.
    renderScaleKey: renderScaleFieldKey(scene.fields),
    # Out of range is ignored where it is read (sceneRenderScale).
    renderScaleSetting: if scene.settings != nil: scene.settings.renderScale else: 0.0,
    init: init,
    render: render,
    runEvent: runEvent,
    refreshInterval: refresh.defaultSeconds,
    backgroundColor: backgroundColor
  )

proc parseInterpretedSceneInputs*(data: string): seq[FrameSceneInput] =
  ## scenes.json, an array of scenes ("Reading scenes.json" above).
  if data == "":
    return @[]
  var i = 0
  expectChar(data, i, '[') # anything but a list refuses the payload
  while moreItems(data, i, ']'):
    if openValue(data, i, '{'):
      result.add(readScene(data, i))

proc buildInterpretedScenes*(scenes: seq[FrameSceneInput]): Table[SceneId, ExportedInterpretedScene] =
  result = initTable[SceneId, ExportedInterpretedScene]()
  for scene in scenes:
    result[scene.id] = buildInterpretedSceneExport(scene)

proc parseInterpretedScenes*(data: string): Table[SceneId, ExportedInterpretedScene] =
  ## The deployed scenes (scenes.json), and their order (sceneOrderSnapshot).
  result = initTable[SceneId, ExportedInterpretedScene]()
  let scenes = parseInterpretedSceneInputs(data)
  deployedSceneOrder = @[]
  if scenes.len == 0:
    return
  for scene in scenes:
    try:
      result[scene.id] = buildInterpretedSceneExport(scene)
      deployedSceneOrder.add(scene.id)
    except Exception as e:
      echo "Warning: Failed to load interpreted scene: ", e.msg

type InterpretedScenesLoadError* = object of CatchableError
  ## The scene payload on disk could not be read. Named so the fatal-startup
  ## path can say which file and why: "Unable to detect compressed data
  ## format" on its own tells nobody that a deploy landed a corrupt
  ## scenes.json.gz and that a redeploy is the fix.

proc loadInterpretedScenesFromDisk*(): Table[SceneId, ExportedInterpretedScene] =
  let configuredFile = getEnv("FRAMEOS_SCENES_JSON")
  var sourcePath = ""
  var compressed = false

  if configuredFile.len > 0:
    if configuredFile.endsWith(".gz") and fileExists(configuredFile):
      sourcePath = configuredFile
      compressed = true
    elif fileExists(configuredFile):
      sourcePath = configuredFile
  elif fileExists("./scenes.json.gz"):
    sourcePath = "./scenes.json.gz"
    compressed = true
  elif fileExists("./scenes.json"):
    sourcePath = "./scenes.json"

  if sourcePath.len == 0:
    when compileOption("threads"):
      deployedScenesDigest = ""
    return initTable[SceneId, ExportedInterpretedScene]()

  let encoded =
    try:
      readFile(sourcePath)
    except CatchableError as e:
      raise newException(InterpretedScenesLoadError,
        "Could not read the scenes from " & sourcePath & ": " & e.msg)

  let decoded =
    if compressed:
      try:
        uncompress(encoded)
      except CatchableError as e:
        raise newException(InterpretedScenesLoadError,
          "The scenes on this frame are corrupt: " & sourcePath & " (" & $encoded.len &
          " bytes) could not be decompressed: " & e.msg & ". Deploy the frame again.")
    else:
      encoded

  try:
    result = parseInterpretedScenes(decoded)
  except CatchableError as e:
    raise newException(InterpretedScenesLoadError,
      "The scenes on this frame are corrupt: " & sourcePath & " could not be parsed: " &
      e.msg & ". Deploy the frame again.")
  when compileOption("threads"):
    # By content, not by file time: an upgrade copies scenes.json.gz into the
    # new release unchanged.
    deployedScenesDigest = getMD5(decoded)

proc replaceInterpretedScenesCache*(scenes: Table[SceneId, ExportedInterpretedScene]) =
  loadedScenes = scenes
  allScenesLoaded = true
  lastInterpretedScenesLoadError = ""

proc addInterpretedSceneToCache*(scene: FrameSceneInput) =
  ## Alongside what is already resident: how the ESP32's one-scene-at-a-time
  ## loader brings in the scenes a resident scene embeds (a split's panels),
  ## through `sceneLoader`.
  loadedScenes[scene.id] = buildInterpretedSceneExport(scene)

proc removeInterpretedSceneFromCache*(sceneId: SceneId) =
  ## A scene added beside the others going again: the browser preview's store
  ## preview, discarded (scene_store_preview.nim).
  loadedScenes.del(sceneId)

proc loadInterpretedScenesForStartup*(): Table[SceneId, ExportedInterpretedScene] =
  ## `loadInterpretedScenesFromDisk` for callers that cannot afford to raise.
  ##
  ## scenes.nim reads the scene table into a module-level `var`, which Nim
  ## runs before `main` — so an exception there escapes the fatal-startup
  ## handler in frameos.nim entirely and kills the process before the logger,
  ## the boot guard, the error screen or the retry timer exist. A deploy that
  ## loses its writes does exactly that: ext4 holds a just-written
  ## scenes.json.gz in delayed allocation, and a frame that resets inside that
  ## window comes back with a file that has a size and no blocks — 21 KB of
  ## NULs that zippy cannot inflate. The frame then restarted every five
  ## seconds forever with nothing on the panel and nothing in the log but the
  ## traceback (ukseraamike, 2026-09-14: 2893 restarts in one boot).
  ##
  ## So: record the failure and hand back an empty table. The result is
  ## deliberately *not* cached, so the next read tries the disk again and a
  ## redeploy heals the frame without a restart.
  try:
    result = loadInterpretedScenesFromDisk()
    lastInterpretedScenesLoadError = ""
  except CatchableError as e:
    lastInterpretedScenesLoadError = e.msg
    result = initTable[SceneId, ExportedInterpretedScene]()

proc getInterpretedScenes*(): Table[SceneId, ExportedInterpretedScene] =
  if allScenesLoaded:
    return loadedScenes

  let scenes = loadInterpretedScenesForStartup()
  if lastInterpretedScenesLoadError.len > 0:
    return scenes
  replaceInterpretedScenesCache(scenes)

  return loadedScenes
