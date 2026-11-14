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
import frameos/js_runtime/burrito
import frameos/scene_compiler
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
when not defined(frameosEmbedded):
  from frameos/ui/theme import themeSource
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

proc cacheLookup(scene: InterpretedFrameScene, nodeId: NodeId, cache: NodeCacheConfig,
    inputKey, expr: JsonNode, allowStore: bool): tuple[hit: bool, value: Value] =
  ## The node cache's answer for a node about to compute: the value it holds,
  ## if it is still good (its duration, its cache expression's value and its
  ## inputs, each when the node keys on it). `inputKey` is nil when no input
  ## was built, `expr` when the node has no expression (or it failed).
  ##
  ## `allowStore = false` (the inputs were degraded: a producer failed and was
  ## zero-filled) still serves an entry; it only keeps the entry from going
  ## before the replacement is made, which that pass will not store.
  var useCached = scene.cacheValues.hasKey(nodeId)
  if useCached and cache.durationEnabled:
    useCached = scene.cacheTimes.hasKey(nodeId) and
      epochTime() <= scene.cacheTimes[nodeId] + cache.durationSec
  if useCached and not expr.isNil:
    # Recompute when the cache expression's value changes.
    useCached = scene.cacheExprs.hasKey(nodeId) and scene.cacheExprs[nodeId] == expr
  if useCached and cache.inputEnabled and not inputKey.isNil and inputKey.len > 0:
    useCached = scene.cacheKeys.hasKey(nodeId) and scene.cacheKeys[nodeId] == inputKey
  if useCached:
    var served = scene.cacheValues[nodeId]
    if served.kind == fkImageSpool:
      # The disk tier: read the pixels back, whole, byte for byte the image a
      # memory cache would have held. An entry that cannot be served (the
      # file swept, the card pulled, no memory to read it into) IS a miss.
      let img = materializeImageSpool(served.imgSp)
      if img.isNil:
        scene.cacheValues.del(nodeId)
      else:
        return (true, VImage(img))
    else:
      return (true, served)
  # A stale image goes before its replacement is made, not after: a
  # slideshow's last photo held through the next one's decode was the
  # difference between a photo and an error frame on the SenseCAP Indicator
  # (2026-10-25). Not on degraded inputs, whose pass leaves the entry for a
  # healthy one to hit.
  if allowStore and scene.cacheValues.hasKey(nodeId) and
      scene.cacheValues[nodeId].kind == fkImage:
    scene.cacheValues.del(nodeId)

proc cacheStore(scene: InterpretedFrameScene, nodeId: NodeId, context: ExecutionContext,
    cache: NodeCacheConfig, inputKey, expr: JsonNode, fresh: Value) =
  ## A freshly computed value into the node cache. `context` is read by the
  ## image disk tier only: to refuse snapshotting the live canvas, and to
  ## size the spill cap.
  var toStore = fresh
  let memoryLimit = cachedImageMemoryLimit()
  if memoryLimit > 0 and fresh.kind == fkImage and not fresh.img.isNil and
      fresh.img.byteSize > memoryLimit and not affordsKeeping(fresh.img, memoryLimit, context):
    # Never retain a frame-sized image in memory on embedded: the next render
    # needs a second canvas and runs the module out of memory, and an alias
    # of the live canvas would redraw the since-overwritten canvas onto
    # itself. The disk tier takes what memory refuses; with nothing to spill
    # to, nothing is stored and the producer runs again next time.
    let spool = trySpillCachedImage(scene, nodeId, fresh.img, context)
    if spool.isNil:
      return
    toStore = VImageSpool(spool)
  scene.cacheValues[nodeId] = toStore
  if cache.durationEnabled:
    scene.cacheTimes[nodeId] = epochTime()
  if not expr.isNil:
    scene.cacheExprs[nodeId] = expr
  if cache.inputEnabled and not inputKey.isNil and inputKey.len > 0:
    scene.cacheKeys[nodeId] = inputKey

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

when not defined(frameosEmbedded):
  proc layoutTheme(): JsonNode {.nimcall, gcsafe, raises: [].} =
    ## The `theme` of the layout around the frame's scene, during its pass:
    ## what the UIs built in Nim are drawn in (ui/theme.nim; not on an ESP32).
    {.cast(gcsafe).}:
      let shown = yieldScene
      if not shown.isNil and not shown.wornLayout.isNil and not shown.wornLayout.state.isNil and
          shown.wornLayout.state.kind == JObject:
        result = shown.wornLayout.state.getOrDefault("theme")
  themeSource = layoutTheme

when not defined(frameosEmbedded):
  proc desktopShown(): bool {.nimcall, gcsafe.} =
    ## The frame's scene, during its layout's pass, wears a desktop: a layout
    ## with scenes open in windows (types.onDesktop).
    {.cast(gcsafe).}:
      let shown = yieldScene
      if shown.isNil or shown.wornLayout.isNil or shown.wornLayout.state.isNil:
        return false
      let open = shown.wornLayout.state{"openScenes"}
      result = not open.isNil and open.kind == JArray and open.len > 0
  onDesktop = desktopShown
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

when not defined(frameosEmbedded):
  var carried {.threadvar.}: tuple[layoutId: string, state: JsonNode]
    ## What a desktop kept (its windows, where they are) when its scenes were
    ## replaced (a push, a deploy, a reload): handed to the next instance of
    ## that layout, under what the install and the frame set (`startLayout`).
  var carriedOpen {.threadvar.}: JsonNode
    ## The scenes a desktop had open (its `openScenes`, docs/scene-layouts.md
    ## "Windows") when another layout took its place: the frame's layout chosen
    ## anew, or scenes replaced by ones that wear another. The next layout
    ## started afresh is handed them, whichever it is, and opens them.

  proc keepOpenScenes(layout: FrameScene) =
    if not layout.isNil and not layout.state.isNil and layout.state.kind == JObject:
      let open = layout.state{"openScenes"}
      if not open.isNil and open.kind == JArray:
        carriedOpen = copy(open)

  proc carryLayoutState*(scene: FrameScene) =
    ## Before a host drops its scenes: the state of the layout `scene` wears
    ## (or a parked layout, given as `scene`), for the next one.
    let layout = if scene.isNil: nil elif scene.wornLayout.isNil: scene else: scene.wornLayout
    if not layout.isNil and not layout.state.isNil and layout.state.kind == JObject:
      carried = (layout.id.string, copy(layout.state))
      keepOpenScenes(layout)

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
      when not defined(frameosEmbedded):
        if carried.layoutId == layoutId:
          carried = ("", nil) # the instance itself came along
        carriedOpen = nil
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
      when not defined(frameosEmbedded):
        if carried.layoutId == layoutId and not carried.state.isNil:
          for key, value in carried.state.pairs:
            if not state.hasKey(key):
              result.state[key] = value
          carried = ("", nil)
        # Another layout's scenes, for this one to open: its own kept state, a
        # same layout's carried above, goes first.
        if not carriedOpen.isNil and result.state.kind == JObject and not result.state.hasKey("openScenes"):
          result.state["openScenes"] = carriedOpen
        carriedOpen = nil
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
    when not defined(frameosEmbedded):
      keepOpenScenes(result)
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
    when not defined(frameosEmbedded):
      keepOpenScenes(self.wornLayout)
    dropLayout(self.wornLayout)
    self.wornLayout = nil
  if self.wornLayout.isNil and wanted.len > 0 and self.wornLayoutFailedFor != wanted:
    self.wornLayout = startLayout(self, wanted, ownId, own{"state"})
    if self.wornLayout.isNil:
      self.wornLayoutFailedFor = wanted
    else:
      self.wornLayout.systemScene = true
  self.wornLayout

when not defined(frameosEmbedded):
  proc wearLayout*(scene: FrameScene) =
    ## The frame's new scene puts its layout on at the switch, not at its next
    ## render pass, on a host that runs scenes side by side (runner.nim,
    ## single_scene_host.nim): what comes before that pass (the release of the
    ## press that switched, a second Alt+Tab) reaches it through the layout,
    ## in the layout's place, as everything after does.
    if scene of InterpretedFrameScene:
      discard ensureLayoutScene(InterpretedFrameScene(scene))
    elif not scene.isNil and not scene.ownRun.isNil:
      discard ensureBuiltInLayout(scene)

proc translatedPayload(payload: JsonNode, slot: SceneSlot): JsonNode =
  result = copy(payload)
  for i, key in ["x", "y", "startX", "startY"]:
    if result.hasKey(key):
      result[key] = %(result[key].getFloat() - (if (i and 1) == 0: slot.x else: slot.y))

when not defined(frameosEmbedded):
  var uiPresses {.threadvar.}: seq[(string, int)]
    ## (layout, pointer) for each press a layout's UI took over a scene it
    ## embeds, until that pointer presses again.

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
  when not defined(frameosEmbedded):
    # A press the layout's own UI holds (a bar or a title bar dragged over the
    # scenes) is its own to the end: the moves and the release over a scene are
    # never that scene's, even one an earlier press left captured here.
    if event != "pointerDown" and uiHoldsPointer(self.id.string, pid):
      if lifted and self.capturedPointer == pid:
        self.capturedChild = nil
      return false
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
  when not defined(frameosEmbedded):
    # Something of the UI's drawn over the scene there (a menu, the window
    # on top, a cover that brings a window forward) is what the pointer is on,
    # and a press it took is its own to the end: its tap, double tap, long
    # press or swipe too, which the scene under it never hears.
    if slot >= 0 and not held:
      let press = (self.id.string, pid)
      let took = uiPresses.find(press)
      if event == "pointerDown":
        if uiOverScene(self.id.string, event, x, y, pid):
          if took < 0:
            uiPresses.add press
          return false
        if took >= 0:
          uiPresses.del(took)
      elif took >= 0 and event in ["tap", "doubleTap", "longPress", "swipe"]:
        return false
      elif uiOverScene(self.id.string, event, x, y, pid):
        return false
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
  when not defined(frameosEmbedded):
    # The layout's own handler on that <Scene> (`onPointerDown`) hears that the
    # event went in there, as it starts: a tiling layout gives the scene the
    # focus on the press its button has.
    if not held and uiSceneHandler(self.id.string, event, payload):
      rhythmMarkDue(self)
      sendEvent("render", %*{}, eoScene)
    if event == "wheel" and wheelScrolled:
      # Scrolled in a window behind, or a built-in scene's: drawn anew, due or
      # not (a window behind waits for nobody otherwise).
      rhythmMarkDue(child)
  true

when defined(frameosEmbedded):
  const PointerEvents = ["tap", "doubleTap", "longPress", "swipe", "pointerDown", "pointerUp",
    "pointerMove", "pointerCancel"]
else:
  const PointerEvents = ["tap", "doubleTap", "longPress", "swipe", "pointerDown", "pointerUp",
    "pointerMove", "pointerCancel", "wheel"]
    ## And the wheel, which an ESP32 has none of: over a scene in a layout's
    ## window it is that scene's, a window behind's included (routePointer).

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

when not defined(frameosEmbedded):
  var hostSceneFor* {.threadvar.}: proc(sceneId: SceneId): FrameScene {.closure, gcsafe.}
    ## A host that runs a frame's scenes side by side (runner.nim,
    ## single_scene_host.nim): its instance of a scene, started if need be,
    ## and a built-in scene's only while it is open (it has nothing to show
    ## until the dispatcher opens it from a scene). With it, a `<Scene id>` in
    ## the layout around the frame's scene is that scene itself, not a copy of
    ## its own, so the scenes of a frame run side by side in its windows and
    ## each is the same one when it comes forward as the frame's scene
    ## (docs/scene-layouts.md "Windows").

when not defined(frameosEmbedded):
  proc windowedBy(owner: FrameScene, sceneId, props: string, child: var FrameScene): bool =
    ## Whether `<Scene id>` in `owner` is the host's own scene (`hostSceneFor`):
    ## then `child` is that, or nil when it cannot show there (the scene the
    ## layout wraps, which is its `<yield />`, one drawn already this pass, or
    ## a built-in scene that is not open). One given props is a copy those
    ## props set, as anywhere (`<Scene id="clock" city="Oslo" />` twice).
    if hostSceneFor.isNil or yieldScene.isNil or owner != yieldScene.wornLayout:
      return false
    try:
      if parseEmbedProps(props).len > 0:
        return false
    except CatchableError:
      return false
    result = true
    child = nil
    if sceneId == yieldScene.id.string or sceneId == owner.id.string:
      return
    let found = hostSceneFor(SceneId(sceneId))
    if found.isNil:
      if not sceneId.startsWith("system/"): # a built-in scene that is not open
        owner.logScene("scene:embed:unknown", "embedded", sceneId)
      return
    for slot in owner.slots:
      if slot.child == found:
        return
    if not found.wornLayout.isNil:
      # A scene in a window wears no layout of its own; the one it wore as
      # the frame's scene may be this very one, moved on (runner.nim).
      if found.wornLayout != owner:
        dropLayout(found.wornLayout)
      found.wornLayout = nil
    child = found
else:
  template windowedBy(owner: FrameScene, sceneId, props: string, child: var FrameScene): bool = false
    ## An ESP32 runs one scene at a time: a `<Scene>` is always a copy.

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
  var
    child: FrameScene
    asItIs = yielded # the scene itself, not a copy: props do not set its state
  if yielded:
    child = yieldScene
    if child.isNil or child == owner:
      return nil
  elif windowedBy(owner, sceneId, props, child):
    if child.isNil:
      return nil
    asItIs = true
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
  if props != r.embedProps and not asItIs:
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
  var due = rhythmEmbedDue(child)
  let like {.cursor.} = if context.hasImage: context.image else: nil
  let format = if like.isNil: pfRgbx else: like.format
  var image = r.embedImage
  let fits = not image.isNil and image.width == width and image.height == height and image.format == format
  when not defined(frameosEmbedded):
    # A new size (a window sized or snapped): what its apps made last is the
    # wrong shape, and a repaint would stretch it. It runs.
    if not fits and not image.isNil:
      due = true
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

when not defined(frameosEmbedded):
  proc wrappedSceneId(owner: FrameScene): string =
    if not yieldScene.isNil and owner == yieldScene.wornLayout: yieldScene.id.string
    else: owner.id.string

  layoutWrappedSceneId = wrappedSceneId

{.pop.}

# -------------------------
# The scene's program
# -------------------------
#
# A scene runs as the program scene_compiler.nim wrote for its diagram: a
# function per node, calling the functions of the nodes that feed it. What the
# program cannot do in JavaScript it asks of the natives below: run and read
# the apps and set their fields, the node cache, the image hints, the state,
# the scene nodes, the logs. They take node ids and handles (indexes into
# `scene.values`), so a value goes from one app to the next as it is.

type ProgramOp = enum
  opGet, opRun, opSet, opInputImage, opPre, opPost, opState, opToJs, opFromJs, opZero,
  opDispatch, opChildState, opScene, opCacheKey, opCacheLookup, opCacheStore, opMatch,
  opBackground, opProfileStart, opProfileEnd, opLog, opLogOutput, opStateRead, opContextRead

const ProgramNativeNames: array[ProgramOp, cstring] = ["g", "r", "s", "ei", "p", "q",
  "t", "j", "v", "zv", "d", "ss", "sc", "ka", "cq", "cs", "m", "bg", "n0", "n1",
  "L", "lo", "st", "cx"]

const ProgramFile = "<frameos:scene>"

proc sourceNodeIdForLog(scene: InterpretedFrameScene, nodeId: NodeId): string =
  let node = scene.nodes.getOrDefault(nodeId, nil)
  if node.isNil or node.data.isNil or node.data.kind != JObject:
    return ""
  node.data{"__frameosSourceNodeId"}.getStr()

proc logNodeErrorPayload(scene: InterpretedFrameScene, nodeId: NodeId, payload: JsonNode) =
  ## An error about a node, with the id the scene JSON gave it: what the
  ## editor puts the error on.
  let sourceNodeId = sourceNodeIdForLog(scene, nodeId)
  if sourceNodeId.len > 0:
    payload["sourceNodeId"] = %sourceNodeId
  scene.logger.log(payload)

proc hold(scene: InterpretedFrameScene, ctx: ptr JSContext, v: Value): JSValue =
  ## A value for the program: its handle.
  if v.kind == fkNone:
    return JS_NewInt32(ctx, 0)
  scene.values.add v
  JS_NewInt32(ctx, scene.values.len.int32)

proc held(scene: InterpretedFrameScene, ctx: ptr JSContext, h: JSValueConst): Value =
  var i: int32
  if JS_ToInt32(ctx, addr i, h) != 0 or i <= 0 or i > scene.values.len:
    return VNone()
  scene.values[i - 1]

var passingError: ref Exception
var passingErrorId: int32
  ## The last Nim exception a native threw into a program, and its number on
  ## the JavaScript error: one that no JavaScript caught leaves the program as
  ## itself (a JsAppError stays one), not as a JSException carrying its text.

proc throwNimError(ctx: ptr JSContext, e: ref Exception): JSValue =
  ## A Nim exception as a JavaScript error: its message as it was, its stack
  ## kept for the log line that will name it.
  discard JS_ThrowInternalError(ctx, "%s", e.msg.cstring)
  let error = JS_GetException(ctx)
  inc passingErrorId
  passingError = e
  discard JS_SetPropertyStr(ctx, error, "nimStack", nimStringToJS(ctx, e.getStackTrace()))
  discard JS_SetPropertyStr(ctx, error, "nimError", JS_NewInt32(ctx, passingErrorId))
  JS_Throw(ctx, error)

proc raiseProgramError(scene: InterpretedFrameScene, ctx: ptr JSContext) =
  ## What a run of the program threw, as a Nim exception: the native's own
  ## when it came through untouched, else the JavaScript error (a blown
  ## budget named as one).
  let error = JS_GetException(ctx)
  var id: int32 = 0
  if jsIsObject(error):
    let tag = JS_GetPropertyStr(ctx, error, "nimError")
    discard JS_ToInt32(ctx, addr id, tag)
    JS_FreeValue(ctx, tag)
  if id != 0 and id == passingErrorId and not passingError.isNil:
    JS_FreeValue(ctx, error)
    let original = passingError
    passingError = nil
    raise original
  discard JS_Throw(ctx, error)
  raise newException(JSException, jsExceptionDetails(ctx).message)

proc appOf(scene: InterpretedFrameScene, nodeId: NodeId): AppRoot =
  result = scene.appsByNodeId.getOrDefault(nodeId, nil)
  if result.isNil:
    let node = scene.nodes.getOrDefault(nodeId, nil)
    raise newException(Exception, "App not initialized for node id: " & $nodeId.int &
      ", keyword: " & (if node.isNil: "" else: diagnosticKeyword(node)))

proc stateFieldType(scene: InterpretedFrameScene, key: string): string =
  result = "string"
  if stateFieldTypesByScene.hasKey(scene.id):
    result = stateFieldTypesByScene[scene.id].getOrDefault(key, "string")

proc stateValue(scene: InterpretedFrameScene, key: string): Value =
  ## A state node's value: the state, read as its field's type.
  valueFromJsonByType(if scene.state.hasKey(key): scene.state[key] else: %"",
    scene.stateFieldType(key))

proc paintInputError(scene: InterpretedFrameScene, app: AppRoot, field, message: string,
    context: ExecutionContext) =
  ## A producer failed: if its field takes an image, the consumer gets an
  ## image with the producer's error on it ("response too large", an HTTP
  ## error …), not a nil one that would only say "No image provided". A field
  ## that takes no image rejects it and keeps its default.
  let keyword = app.appKeyword
  try:
    if runsAsEmbedded():
      # The live canvas takes the error frame: a second full-frame image next
      # to it is what runs a memory-tight board (and the preview running as
      # one) out of memory. Painted only once the field took the image.
      if context.hasImage and not context.image.isNil:
        setInterpretedAppField(keyword, app, field, Value(kind: fkImage, img: context.image))
        paintPendingBackground(context)
        renderErrorInto(context.image, context.image.width, context.image.height, message)
      else:
        setInterpretedAppField(keyword, app, field, Value(kind: fkImage,
          img: renderError(scene.frameConfig.width, scene.frameConfig.height, message)))
    else:
      let width = if context.hasImage and not context.image.isNil: context.image.width
                  else: scene.frameConfig.width
      let height = if context.hasImage and not context.image.isNil: context.image.height
                   else: scene.frameConfig.height
      setInterpretedAppField(keyword, app, field, Value(kind: fkImage,
        img: renderError(width, height, message)))
  except Exception:
    discard

proc offerImageHints(scene: InterpretedFrameScene, nodeId: NodeId, keyword: string,
    context: ExecutionContext): int =
  ## Before a flow app's inputs: the background it does not settle itself,
  ## then what its image input may skip materializing (decided at load by
  ## frameos/planner.nim; what is left here are the facts that are not
  ## static: is there a canvas, is another hint in flight, what does a
  ## placement wired from a state field say). Bit 1: a decode target was
  ## offered; bit 2: bounds were.
  let plan = scene.imageFusionPlans.getOrDefault(nodeId, nil)
  if context.backgroundPending and plan.isNil and keyword notin FlowAppsSettlingBackground:
    paintPendingBackground(context)
  let profiled = scene.profiles.len > 0 and scene.profiles[^1].nodeId == nodeId
  if not plan.isNil and context.hasImage and not context.image.isNil and
      context.decodeTargetImage.isNil and context.decodeTargetWidth == 0:
    var fit = plan.fit
    if plan.fitFromNodeId != NoNodeId:
      try:
        let state = scene.nodes.getOrDefault(plan.fitFromNodeId, nil)
        fit = scene.stateValue(state.data{"keyword"}.getStr()).asString()
      except CatchableError:
        fit = ""
      if fit.len == 0:
        # Scene JSON only stores explicitly set values; an empty state field
        # means the app's config.json default.
        fit = plan.defaultFit
    if fit in plan.fits:
      var tier = plan.tier
      if tier == iftOwnedScratch and plan.ownedForCache:
        # The scratch exists so a cached producer never owns the live canvas.
        # Past the in-memory limit the cache cannot hold the value, so the
        # scratch is only worth its PSRAM if the disk tier will take the
        # pixels; when it will not, nothing is stored and nothing aliases the
        # canvas across renders, so the producer decodes into the canvas.
        let memoryLimit = cachedImageMemoryLimit()
        let scratchBytes = context.image.width * context.image.height * 4
        if memoryLimit > 0 and scratchBytes > memoryLimit:
          let refusal = imageSpillRefusalReason(scene.frameConfig, scratchBytes)
          if refusal.len > 0:
            tier = iftLiveCanvas
            scene.logger.log(%*{"event": "interpreter:cache:imageTier", "sceneId": scene.id.string,
              "nodeId": plan.producerNodeId.int, "tier": "liveCanvas", "reason": refusal})
      var offered = false
      if tier == iftLiveCanvas:
        context.decodeTargetImage = context.image
        context.decodeTargetScalingMode = fit
        offered = true
      elif fit notin plan.excludedFits:
        # Canvas-sized, allocated by the producer: the consumer then draws a
        # same-size source, a plain draw.
        context.decodeTargetWidth = context.image.width
        context.decodeTargetHeight = context.image.height
        context.decodeTargetScalingMode = fit
        context.decodeTargetOwned = true
        offered = true
      if offered:
        result = 1
        context.decodeTargetNodeId = plan.producerNodeId
        context.decodeTargetClaimedBy = 0.NodeId
        if plan.inPlaceNodeIds.len > 0:
          context.inPlaceImageNodes = plan.inPlaceNodeIds
        if profiled:
          scene.profiles[^1].fit = fit
          scene.profiles[^1].tier = tier
  # The consumer's useful resolution for an edge that could not fuse (a
  # 90/270 rotation or a resize mid-chain): the producer decodes bounded
  # instead of at native resolution.
  if result == 0 and imageBoundsEnabled and context.hasImage and not context.image.isNil and
      context.decodeBoundsNodeId == 0.NodeId:
    let bounds = scene.imageBoundsPlans.getOrDefault(nodeId, nil)
    if not bounds.isNil:
      var width = if bounds.fromCanvas: context.image.width else: bounds.fixedWidth
      var height = if bounds.fromCanvas: context.image.height else: bounds.fixedHeight
      if bounds.swapped:
        swap(width, height)
      if bounds.scale > 1.0:
        # A static zoom: the largest crop the consumer will show needs scale
        # times its own resolution, rounded up.
        width = int(ceil(width.float * bounds.scale))
        height = int(ceil(height.float * bounds.scale))
      if width > 0 and height > 0:
        context.decodeBoundsWidth = width
        context.decodeBoundsHeight = height
        context.decodeBoundsNodeId = bounds.producerNodeId
        context.decodeBoundsClaimedBy = 0.NodeId
        result = 2
        if profiled:
          scene.profiles[^1].boundsWidth = width
          scene.profiles[^1].boundsHeight = height

proc withdrawImageHints(keyword: string, offered: int, context: ExecutionContext) =
  ## After a flow app's inputs: the hints go, and whatever the producer did
  ## not settle, the node draws over, unless it settles the background itself.
  if (offered and 1) != 0:
    context.decodeTargetImage = nil
    context.decodeTargetScalingMode = ""
    context.decodeTargetWidth = 0
    context.decodeTargetHeight = 0
    context.decodeTargetNodeId = 0.NodeId
    context.decodeTargetOwned = false
    context.inPlaceImageNodes = @[]
  if keyword notin FlowAppsSettlingBackground:
    paintPendingBackground(context)
  if (offered and 2) != 0:
    context.decodeBoundsWidth = 0
    context.decodeBoundsHeight = 0
    context.decodeBoundsNodeId = 0.NodeId

proc cacheExpressionKey(scene: InterpretedFrameScene, ctx: ptr JSContext, x: JSValueConst): JsonNode =
  ## A cache expression's value as the program hands it (`[value]`), as a
  ## key; nil when the node has none or it did not compile.
  if JS_IsArray(ctx, x) == 0:
    return nil
  let value = JS_GetPropertyUint32(ctx, x, 0)
  result = valueToKeyJson(jsValueToValue(ctx, value))
  JS_FreeValue(ctx, value)

proc takeCacheInputKey(scene: InterpretedFrameScene, nodeId: NodeId): JsonNode =
  result = scene.cacheInputKeys.getOrDefault(nodeId, nil)
  if not result.isNil:
    scene.cacheInputKeys.del(nodeId)

proc ensureChildScene(scene: InterpretedFrameScene, nodeId: NodeId): tuple[child: FrameScene, exported: ExportedScene] =
  ## A scene node's scene, started on first use.
  result.exported = scene.sceneExportByNodeId.getOrDefault(nodeId, nil)
  let node = scene.nodes.getOrDefault(nodeId, nil)
  let childSceneId = (if node.isNil: "" else: node.data{"keyword"}.getStr()).SceneId
  if result.exported.isNil:
    result.exported = resolveSceneExport(childSceneId)
    if result.exported.isNil:
      raise newException(Exception, "Scene node references unknown scene id: " & childSceneId.string)
    scene.sceneExportByNodeId[nodeId] = result.exported
  result.child = scene.sceneNodes.getOrDefault(nodeId, nil)
  if result.child.isNil:
    let config = node.data{"config"}
    result.child = result.exported.init(childSceneId, scene.frameConfig, scene.logger,
      if not config.isNil and config.kind == JObject: config else: %*{})
    scene.sceneNodes[nodeId] = result.child

proc runChildScene(scene: InterpretedFrameScene, nodeId: NodeId, context: ExecutionContext) =
  ## A scene node handling the current event: its scene's turn.
  let (child, exported) = ensureChildScene(scene, nodeId)
  if scene.frameConfig.debug:
    markRuntimeCheckpoint("scene:delegate", currentSceneId = scene.id.string, contextEvent = context.event,
      nodeId = nodeId.int, nodeType = "scene", keyword = child.id.string, childSceneId = child.id.string)
  if context.event == "render" and context.hasImage and not context.image.isNil:
    runSceneNodeRender(scene, child, exported.runEvent, context)
  else:
    exported.runEvent(child, context)

proc dispatchNode(scene: InterpretedFrameScene, nodeId: NodeId, payload: JsonNode,
    context: ExecutionContext): Value =
  ## A dispatch node: the payload the program made of its config and its
  ## inputs, the event sent from the scene; the payload is its value.
  let node = scene.nodes.getOrDefault(nodeId, nil)
  let eventName = node.data{"keyword"}.getStr()
  var payload = if payload.kind == JObject: payload else: newJObject()
  if eventName == "setSceneState":
    # Typed as the scene's fields are; `render` is the one key that is not
    # state.
    var state = newJObject()
    var root = newJObject()
    for key, value in payload.pairs:
      if stateFieldTypesByScene.hasKey(scene.id) and stateFieldTypesByScene[scene.id].hasKey(key):
        state[key] = valueToJson(valueFromJsonByType(value, stateFieldTypesByScene[scene.id][key]))
      elif key == "render":
        root[key] = valueToJson(valueFromJsonByType(value, "boolean"))
      else:
        state[key] = copy(value)
    if state.len > 0:
      root["state"] = state
    payload = root
  dispatchFromScene(scene, eventName, payload, nodeId.int, context.event)
  VJson(copy(payload))

proc profileStart(scene: InterpretedFrameScene, nodeId: NodeId, asData: bool, context: ExecutionContext) =
  let node = scene.nodes.getOrDefault(nodeId, nil)
  let keyword = if node.isNil: "" else: diagnosticKeyword(node)
  markRuntimeCheckpoint("node:start", currentSceneId = scene.id.string, contextEvent = context.event,
    nodeId = nodeId.int, nodeType = (if node.isNil: "" else: node.nodeType), keyword = keyword)
  scene.profiles.add NodeProfile(nodeId: nodeId, startedAt: epochTime(),
    memoryBefore: renderMemoryInUse(), keyword: keyword)

proc profileEnd(scene: InterpretedFrameScene, nodeId: NodeId, asData: bool, value: Value,
    context: ExecutionContext) =
  ## How long the node took, what it cost in heap and how big the value on
  ## its edge is: where a render's peak memory goes, per node and per edge
  ## (docs/value-pipeline.md, phase 0).
  if scene.profiles.len == 0 or scene.profiles[^1].nodeId != nodeId:
    return
  let entry = scene.profiles.pop()
  let node = scene.nodes.getOrDefault(nodeId, nil)
  let nodeType = if node.isNil: "" else: node.nodeType
  markRuntimeCheckpoint("node:done", currentSceneId = scene.id.string, contextEvent = context.event,
    nodeId = nodeId.int, nodeType = nodeType, keyword = entry.keyword)
  var profile = %*{"event": "interpreter:node:profile", "sceneId": scene.id.string,
    "nodeId": nodeId.int, "nodeType": nodeType, "keyword": entry.keyword, "dataNode": asData,
    "durationMs": (epochTime() - entry.startedAt) * 1000.0}
  if asData:
    profile["valueKind"] = %($value.kind)
    profile["valueBytes"] = %value.approxByteSize()
    if value.kind == fkImage and not value.img.isNil:
      profile["valueWidth"] = %value.img.width
      profile["valueHeight"] = %value.img.height
    if value.kind == fkSpool:
      profile["valueTier"] = %(if value.sp.isFileBacked(): "storage" else: "memory")
      profile["valueTotalBytes"] = %value.sp.len
  let after = renderMemoryInUse()
  if entry.memoryBefore.known and after.known:
    profile["heapDeltaBytes"] = %(after.bytes - entry.memoryBefore.bytes)
  let plan = scene.imageFusionPlans.getOrDefault(nodeId, nil)
  if not plan.isNil:
    # Applied: the offer was made. Claimed: the planned producer took it. A
    # persistent applied-but-unclaimed edge is a producer allocating its own
    # value while the plan says fused.
    profile["fusion"] = %*{"input": plan.inputName, "applied": entry.fit.len > 0,
      "claimed": entry.fit.len > 0 and context.decodeTargetClaimedBy == plan.producerNodeId,
      "tier": (if entry.tier == iftLiveCanvas: "liveCanvas" else: "ownedScratch"),
      "plannedTier": (if plan.tier == iftLiveCanvas: "liveCanvas" else: "ownedScratch"),
      "producerNodeId": plan.producerNodeId.int, "forwardedThrough": plan.inPlaceNodeIds.len,
      "fit": entry.fit}
  let bounds = scene.imageBoundsPlans.getOrDefault(nodeId, nil)
  if not bounds.isNil:
    profile["bounds"] = %*{"input": bounds.inputName, "applied": entry.boundsWidth > 0,
      "claimed": entry.boundsWidth > 0 and context.decodeBoundsClaimedBy == bounds.producerNodeId,
      "producerNodeId": bounds.producerNodeId.int, "width": entry.boundsWidth,
      "height": entry.boundsHeight}
  scene.logger.log(profile)

proc contextValue(ctx: ptr JSContext, context: ExecutionContext, key: string): JSValue =
  ## `context.<key>` in a snippet. The canvas size is this run's (a cell's
  ## inside render/split); undefined without a canvas.
  case key
  of "loopIndex": nimIntToJS(ctx, context.loopIndex.int32)
  of "loopKey": nimStringToJS(ctx, context.loopKey)
  of "event": nimStringToJS(ctx, context.event)
  of "payload": jsonToJS(ctx, context.payload)
  of "hasImage": nimBoolToJS(ctx, context.hasImage)
  of "imageWidth", "imageHeight":
    if context.hasImage and not context.image.isNil:
      nimIntToJS(ctx, (if key == "imageWidth": context.image.width else: context.image.height).int32)
    else:
      jsUndefined(ctx)
  else: jsUndefined(ctx)

proc programOp(scene: InterpretedFrameScene, ctx: ptr JSContext, op: ProgramOp, argc: int,
    argv: ptr UncheckedArray[JSValueConst]): JSValue =
  ## The natives. Most take a node id first; the log lines are written by the
  ## program itself (`L`), which costs the program's memory and not flash.
  let context = scene.programCtx
  template a(i: int): JSValueConst = (if i < argc: argv[i] else: jsUndefined(ctx))
  proc num(ctx: ptr JSContext, v: JSValueConst): int {.inline.} =
    var n: int32
    discard JS_ToInt32(ctx, addr n, v)
    n.int
  let id = num(ctx, a(0)).NodeId
  result = jsUndefined(ctx)
  case op
  of opGet:
    let app = scene.appOf(id)
    let cache = scene.cacheConfigs.getOrDefault(id)
    if not cache.enabled:
      return scene.hold(ctx, getInterpretedApp(app.appKeyword, app, context))
    let key = scene.takeCacheInputKey(id)
    let expr = scene.cacheExpressionKey(ctx, a(1))
    let found = scene.cacheLookup(id, cache, key, expr, true)
    if found.hit:
      return scene.hold(ctx, found.value)
    let fresh = getInterpretedApp(app.appKeyword, app, context)
    scene.cacheStore(id, context, cache, key, expr, fresh)
    result = scene.hold(ctx, fresh)
  of opRun:
    let app = scene.appOf(id)
    scene.cacheInputKeys.del(id)
    runInterpretedApp(app.appKeyword, app, context)
  of opSet:
    let app = scene.appOf(id)
    let field = toNimString(ctx, a(1))
    let value = scene.held(ctx, a(2))
    setInterpretedAppField(app.appKeyword, app, field, value)
    let cache = scene.cacheConfigs.getOrDefault(id)
    if cache.enabled and cache.inputEnabled:
      scene.cacheInputKeys.mgetOrPut(id, newJObject())[field] = valueToKeyJson(value)
  of opInputImage:
    # A producer failed. It may have taken the decode target first, the state
    # mayMutateImageInPlace reads as "the chain fused", and the error image
    # can be the live canvas: the clearance goes, then the error is painted.
    context.inPlaceImageNodes = @[]
    let app = scene.appsByNodeId.getOrDefault(id, nil)
    if not app.isNil:
      scene.paintInputError(app, toNimString(ctx, a(1)), toNimString(ctx, a(2)), context)
  of opPre:
    result = JS_NewInt32(ctx, scene.offerImageHints(id, scene.appOf(id).appKeyword, context).int32)
  of opPost:
    withdrawImageHints(scene.appOf(id).appKeyword, num(ctx, a(1)), context)
  of opState:
    result = scene.hold(ctx, scene.stateValue(toNimString(ctx, a(0))))
  of opToJs:
    result = valueToJS(ctx, scene.held(ctx, a(0)))
  of opFromJs:
    result = scene.hold(ctx, jsValueToValue(ctx, a(0), toNimString(ctx, a(1))))
  of opZero:
    # The zero a value of this type gets when it failed: a code node's
    # argument (spread-safe: "" or [] rather than null), or its result.
    let kind = toNimString(ctx, a(0))
    result = scene.hold(ctx, if num(ctx, a(1)) == 0: zeroValueForCodeArgType(kind)
      elif kind.len == 0: VNone()
      elif kind == "string": VString("")
      else: valueFromJsonByType(newJNull(), kind))
  of opDispatch:
    result = scene.hold(ctx, scene.dispatchNode(id, jsValueToJson(ctx, a(1)), context))
  of opChildState:
    scene.ensureChildScene(id).child.state[toNimString(ctx, a(1))] = valueToJson(scene.held(ctx, a(2)))
  of opScene:
    scene.runChildScene(id, context)
  of opCacheKey:
    scene.cacheInputKeys.mgetOrPut(id, newJObject())[toNimString(ctx, a(1))] = valueToKeyJson(scene.held(ctx, a(2)))
  of opCacheLookup:
    let key = scene.takeCacheInputKey(id)
    let expr = scene.cacheExpressionKey(ctx, a(2))
    let found = scene.cacheLookup(id, scene.cacheConfigs.getOrDefault(id), key, expr, num(ctx, a(1)) != 0)
    if found.hit:
      return scene.hold(ctx, found.value)
    scene.cachePending[id] = (key, expr)
    result = JS_NewInt32(ctx, -1)
  of opCacheStore:
    let pending = scene.cachePending.getOrDefault(id)
    scene.cachePending.del(id)
    # Computed on degraded inputs (a producer failed and was zero-filled): the
    # value is this pass's only, never pinned in the cache as real data.
    if num(ctx, a(2)) != 0:
      scene.cacheStore(id, context, scene.cacheConfigs.getOrDefault(id), pending.key, pending.expr,
        scene.held(ctx, a(1)))
  of opMatch:
    var i = 0
    while i + 1 < argc:
      if not eventPayloadValueMatches(context.payload, toNimString(ctx, a(i)), toNimString(ctx, a(i + 1))):
        return jsFalse(ctx)
      i += 2
    result = jsTrue(ctx)
  of opBackground:
    paintPendingBackground(context)
  of opProfileStart:
    scene.profileStart(id, num(ctx, a(1)) != 0, context)
  of opProfileEnd:
    scene.profileEnd(id, num(ctx, a(1)) != 0, scene.held(ctx, a(2)), context)
  of opLog:
    # A line the program wrote: whose scene it is, what `out of memory`
    # means here, and (second argument) the event's payload where the
    # event's may be logged.
    var entry = jsValueToJson(ctx, a(0))
    if entry.kind == JObject:
      entry[if entry.hasKey("parentSceneId"): "parentSceneId" else: "sceneId"] = %scene.id.string
      let message = entry{"message"}
      if not message.isNil and message.kind == JString:
        entry["message"] = %describeJsError(message.getStr())
      if argc > 1:
        entry = withEventPayload(entry, context.event, context.payload)
      scene.logger.log(entry)
  of opLogOutput:
    logCodeNodeOutput(FrameScene(scene), id, scene.held(ctx, a(1)))
  of opStateRead:
    let key = toNimString(ctx, a(0))
    if scene.state.hasKey(key):
      result = jsonToJS(ctx, scene.state[key])
  of opContextRead:
    if not context.isNil:
      result = contextValue(ctx, context, toNimString(ctx, a(0)))

proc programNative(ctx: ptr JSContext, thisVal: JSValueConst, argc: cint, argv: ptr JSValueConst,
    magic: cint, data: ptr JSValue): JSValue {.cdecl.} =
  ## Every native the program calls. The interpreter clock stops while one
  ## runs (an app may wait on the network), as for any binding; the run's
  ## wall-clock deadline does not.
  var address: float64
  discard JS_ToFloat64(ctx, addr address, data[])
  let scene {.cursor.} = cast[InterpretedFrameScene](cast[pointer](address.int))
  let guard = guardForContext(ctx)
  enterNativeCall(guard)
  try:
    result = programOp(scene, ctx, ProgramOp(magic), argc.int, cast[ptr UncheckedArray[JSValueConst]](argv))
  except Exception as e:
    result = throwNimError(ctx, e)
  leaveNativeCall(guard)
  if guard != nil and guard.wallTripped:
    JS_FreeValue(ctx, result)
    result = JS_ThrowInternalError(ctx, "%s",
      deadlineTripMessage(max(1, renderDeadlineBudgetMs()), true).cstring)
    JS_SetUncatchableException(ctx, 1)

proc programProfile(scene: InterpretedFrameScene): bool {.inline.} =
  scene.frameConfig != nil and scene.frameConfig.debug

proc programFor(scene: InterpretedFrameScene): CompiledScene =
  ## The scene's program: made by the first instance of the scene and shared
  ## (a split may draw one scene many times), and made again when the debug
  ## profile is switched on or off.
  let profile = scene.programProfile
  if not scene.program.isNil and scene.program.profile == profile:
    return scene.program
  let source = scene.source
  if source.isNil:
    return scene.program
  if source.compiled.isNil or source.compiled.profile != profile:
    source.compiled = compileScene(source.nodes, source.edges, profile)
  source.compiled

proc compileFailure(scene: InterpretedFrameScene, message, stack: string): ref Exception =
  ## The program did not compile: the snippet the error is in (or that left
  ## something open the line after it) is named. A code node or an inline
  ## input that does not compile fails the scene, as it always did; a cache
  ## expression only loses its cache (nil: the program is made again with it
  ## left out).
  const at = ProgramFile & ":"
  var line = 0
  let found = stack.find(at)
  if found >= 0:
    var k = found + at.len
    while k < stack.len and stack[k] in {'0'..'9'}:
      line = line * 10 + ord(stack[k]) - ord('0')
      inc k
  var culprit = -1
  for k, snippet in scene.program.snippets:
    if snippet.firstLine > 0 and snippet.firstLine <= line and line <= snippet.lastLine + 1:
      culprit = k
  if culprit >= 0:
    let snippet = scene.program.snippets[culprit]
    let error = message & " (line " & $(min(line, snippet.lastLine) - snippet.firstLine + 1) & ")"
    if snippet.kind == psCache:
      if not scene.source.isNil:
        let program = compileScene(scene.source.nodes, scene.source.edges, scene.program.profile,
          scene.program.brokenCache & @[(snippet.nodeId, error)])
        scene.program = program
        scene.source.compiled = program
        return nil
    else:
      scene.logNodeErrorPayload(snippet.nodeId, %*{"event": "interpreter:jsCompileError",
        "sceneId": scene.id.string, "nodeId": snippet.nodeId.int,
        "sourceKind": (if snippet.kind == psCode: "code" else: "inline"),
        "sourceName": snippet.name, "error": error, "snippet": snippet.snippet})
      return newException(JSException, "Evaluation failed: " & error)
  # Nothing of the scene's own: the program around it.
  scene.logger.log(%*{"event": "interpreter:programError", "sceneId": scene.id.string, "error": message})
  newException(JSException, "Evaluation failed: " & message)

proc ensureProgram(scene: InterpretedFrameScene) =
  ## The scene's program evaluated into the programs' context, and its ways
  ## in kept.
  ensureSceneJs(scene)
  if scene.programReady and not scene.program.isNil and scene.program.profile == scene.programProfile:
    return
  # The debug profile was switched: the same context, another program.
  dropProgram(scene)
  scene.program = programFor(scene)
  let ctx = scene.js.context
  var attempts = 0
  while true:
    inc attempts
    let source = scene.program.source
    let fn = JS_Eval(ctx, source.cstring, source.len.csize_t, ProgramFile,
      (JS_EVAL_TYPE_GLOBAL or snippetEvalFlags).cint)
    if JS_IsException(fn) == 0:
      var address = JS_NewFloat64(ctx, cast[int](cast[pointer](scene)).float64)
      let natives = JS_NewObject(ctx)
      for op in ProgramOp:
        discard JS_SetPropertyStr(ctx, natives, ProgramNativeNames[op],
          JS_NewCFunctionData(ctx, programNative, 2, op.ord.cint, 1, addr address))
      var argv = [natives]
      let entries = JS_Call(ctx, fn, jsUndefined(ctx), 1, addr argv[0])
      JS_FreeValue(ctx, natives)
      JS_FreeValue(ctx, fn)
      if JS_IsException(entries) != 0:
        raise newException(JSException, "Evaluation failed: " & jsExceptionDetails(ctx).message)
      scene.programEntries[0] = JS_GetPropertyStr(ctx, entries, "ev")
      scene.programEntries[1] = JS_GetPropertyStr(ctx, entries, "flow")
      scene.programEntries[2] = JS_GetPropertyStr(ctx, entries, "data")
      JS_FreeValue(ctx, entries)
      scene.programReady = true
      return
    let details = jsExceptionDetails(ctx)
    let failure = scene.compileFailure(details.message, details.stack)
    if not failure.isNil or attempts > 4:
      raise (if failure.isNil: newException(JSException, "Evaluation failed: " & details.message) else: failure)

template programRun(scene: InterpretedFrameScene, context: ExecutionContext, entry: int,
    argument: JSValue, onResult: untyped) =
  ## One entry into the program: the context its natives work in, the
  ## interpreter-time budget (re-entrant: a flow inside a flow rides on its
  ## caller's), and the values its run made, dropped when the outermost run
  ## ends.
  ensureProgram(scene)
  let ctx {.inject.} = scene.js.context
  let savedContext = scene.programCtx
  scene.programCtx = context
  inc scene.programDepth
  var argv = [argument]
  scene.onSceneJsStack:
    try:
      withContextDeadline(ctx):
        let value {.inject.} = JS_Call(ctx, scene.programEntries[entry], jsUndefined(ctx), 1, addr argv[0])
        if JS_IsException(value) != 0:
          scene.raiseProgramError(ctx)
        try:
          onResult
        finally:
          JS_FreeValue(ctx, value)
    finally:
      JS_FreeValue(ctx, argv[0])
      scene.programCtx = savedContext
      dec scene.programDepth
      if scene.programDepth == 0:
        scene.values.setLen(0)

proc programEvent(scene: InterpretedFrameScene, context: ExecutionContext): int =
  ## The event's listeners; how many ran.
  programRun(scene, context, 0, nimStringToJS(scene.js.context, context.event)):
    var count: int32
    discard JS_ToInt32(ctx, addr count, value)
    result = count.int

proc programFlow(scene: InterpretedFrameScene, nodeId: NodeId, context: ExecutionContext) =
  ## The flow from a node: what an app's `execNode` runs.
  programRun(scene, context, 1, JS_NewInt32(scene.js.context, nodeId.int32)):
    discard

proc programData(scene: InterpretedFrameScene, nodeId: NodeId, context: ExecutionContext): Value =
  ## A node's value: what an app's `getDataNode` reads.
  programRun(scene, context, 2, JS_NewInt32(scene.js.context, nodeId.int32)):
    result = scene.held(ctx, value)

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
    apps: exportedScene.apps,
    customEventOrigins: exportedScene.customEventOrigins,
    eventMap: exportedScene.eventMap,
    shownName: exportedScene.name,
    refreshFollowsChildren: exportedScene.refreshFollowsChildren,
    followInterval: -1,
    layoutSceneId: exportedScene.layoutSceneId,
    layoutState: exportedScene.layoutState,
    publicStateFields: exportedScene.publicStateFields,
    source: exportedScene,
  )
  scene.execNode = proc(nodeId: NodeId, context: ExecutionContext) =
    programFlow(scene, nodeId, context)
  scene.getDataNode = proc(nodeId: NodeId, context: ExecutionContext): Value =
    programData(scene, nodeId, context)
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

  # The nodes, and what the planner and the apps read off the edges: which
  # node feeds an app's field, and the node a `field/<name>` edge names (into
  # the app's config, e.g. logic/ifElse's thenNode). The flow itself is the
  # program's (scene_compiler.nim).
  for node in exportedScene.nodes:
    scene.nodes[node.id] = node
    if node.nodeType in ["app", "code"]:
      let cache = readCacheConfig(node.data)
      if cache.enabled:
        scene.cacheConfigs[node.id] = cache
  for edge in exportedScene.edges:
    let th = edge.targetHandle
    let sh = edge.sourceHandle
    if th.startsWith("fieldInput/"):
      let inline = sh.startsWith("code/")
      if inline or sh == "fieldOutput" or sh == "stateOutput":
        scene.appInputs.add AppInput(target: edge.target, source: edge.source,
          field: th.split("/")[1], inline: inline)
        continue
    elif sh.startsWith("field/") and th == "prev":
      scene.setNodeFieldFromEdge(edge)
      continue
    if (sh == "next" and th == "prev") or edge.edgeType == "codeNodeEdge" or
        (th.startsWith("codeField/") and (sh in ["fieldOutput", "stateOutput"] or sh.startsWith("code/"))):
      continue
    logger.log(%*{"event": "initInterpretedEdge:ignored", "sceneId": scene.id.string, "edgeId": edge.id.int,
        "source": edge.source.int, "target": edge.target.int, "sourceHandle": sh, "targetHandle": th})

  # The apps, after the edges have written what they name into their config.
  for node in exportedScene.nodes:
    if node.nodeType == "app":
      let keyword = node.data{"keyword"}.getStr()
      let app = initInterpretedApp(keyword, node, scene)
      scene.appsByNodeId[node.id] = app
      if app.dynamicJsAppSubscribes():
        scene.eventApps.add(node.id)
    elif node.nodeType == "scene":
      let childSceneId = node.data{"keyword"}.getStr().SceneId
      let exportedChild = resolveSceneExport(childSceneId)
      if exportedChild.isNil:
        raise newException(Exception,
          "Scene node references unknown scene id: " & childSceneId.string)
      # Its config is the child's initial state; the child's own init fires
      # its "init" event, interpreted or compiled.
      let config = node.data{"config"}
      let child = exportedChild.init(childSceneId, frameConfig, logger,
        if not config.isNil and config.kind == JObject: config else: %*{})
      scene.sceneNodes[node.id] = child
      scene.sceneExportByNodeId[node.id] = exportedChild
      scene.logger.log(%*{
        "event": "initChildScene",
        "parentSceneId": scene.id.string,
        "nodeId": node.id.int,
        "childSceneId": childSceneId.string,
        "execution": if exportedChild of ExportedInterpretedScene: "interpreted" else: "compiled"
      })

  # What each image edge may skip materializing, after the apps exist: a
  # node whose behaviour comes from scene JSON (a dynamic JS app) is opaque
  # whatever its keyword declares. Then the edges the fusion planner left
  # materialized get the consumer's useful resolution passed upstream.
  let opaqueCheck: OpaqueCheck = proc (nodeId: NodeId): bool {.closure, gcsafe, raises: [].} =
    scene.appsByNodeId.getOrDefault(nodeId, nil).isDynamicJsApp()
  scene.planImageFusion(opaqueCheck)
  scene.planImageBounds(opaqueCheck)

  # The program, made once per scene. A scene with code of its own compiles
  # it now, so a snippet that does not parse fails the scene here, naming
  # its node; one without needs no JavaScript until it runs.
  scene.program = programFor(scene)
  if scene.program.snippets.len > 0:
    ensureProgram(scene)

  logger.log(%*{"event": "initInterpretedDone", "sceneId": sceneId.string, "nodes": scene.nodes.len,
      "edges": exportedScene.edges.len, "eventListeners": scene.program.listens.len,
      "apps": scene.appsByNodeId.len, "imageFusionPlans": scene.imageFusionPlans.len,
      "imageBoundsPlans": scene.imageBoundsPlans.len})

  # "init" fires here, once per scene instance and after its apps exist.
  if "init" in scene.program.listens:
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

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

proc logListenerError(scene: FrameScene, event: string, nodeId: NodeId, e: ref Exception) =
  ## `nodeId` is how the editor puts the error on its node (frameRuntimeErrors.ts).
  scene.logger.log(%*{"event": "runEventInterpreted:error", "sceneId": scene.id,
    "contextEvent": event, "nodeId": nodeId.int, "error": $e.msg, "stacktrace": e.getStackTrace()})

proc listensFor(scene: InterpretedFrameScene, event: string): bool {.inline.} =
  ## An event node of its own listens for `event`.
  not scene.program.isNil and event in scene.program.listens

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
  if interpreted.listensFor(event) or uiListens(scene.id.string, event) or interpreted.appsHear(event):
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
    if scene.listensFor(event) or scene.appsHear(event):
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
      when not defined(frameosEmbedded):
        if uiOverScene(scene.id.string, "pointerDown", x, y, -1):
          break
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
    context.wholeFrame = not scene.program.isNil and scene.program.wholeFrame
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
      if context.event == "wheel":
        # The box that scrolls under the pointer: in the scene there (a window,
        # a panel), in its own coordinates; this UI's own when that scene's
        # did not move, as a browser hands a wheel to the box around.
        wheelScrolled = false
        if (not routePointer(scene, context) or not wheelScrolled) and
            dispatchUiEvent(self.id.string, context.event, context.payload):
          rhythmMarkDue(self)
          sendEvent("render", %*{}, eoScene)
      elif context.event in ["keyDown", "textInput"]:
        if dispatchUiEvent(self.id.string, context.event, context.payload):
          sendEvent("render", %*{}, eoScene)
      else:
        uiSceneEvent(self.id.string)

  if scene.listensFor(context.event):
    # The listeners are the program's (a listener filtered out that leaves
    # none matched says so there). Each catches its own error; what reaches
    # here is what no JavaScript catch can stop, the run's deadline.
    try:
      eventListenersRun += programEvent(scene, context)
    except Exception as e:
      self.logListenerError(context.event, 0.NodeId, e)
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

when defined(frameosEmbedded):
  template builtInLayout(self: FrameScene, inWindow: bool): FrameScene = ensureBuiltInLayout(self)
else:
  proc builtInLayout(self: FrameScene, inWindow: bool): FrameScene =
    ## The layout a built-in scene wears on this run. In a window (a run
    ## inside the layout of the frame's scene, drawn or clicked), none, as no
    ## scene in a window wears one: made there, it would be a second desktop
    ## inside the window.
    if inWindow: self.wornLayout else: ensureBuiltInLayout(self)

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
      else: builtInLayout(self, not yieldScene.isNil)
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
  ## the scene and every child scene it holds: the runs of its program that
  ## the longjmp skipped never counted themselves out, and their values and
  ## profiles were left behind.
  if scene.isNil or not (scene of InterpretedFrameScene):
    return
  let interpreted = InterpretedFrameScene(scene)
  interpreted.programDepth = 0
  interpreted.programCtx = nil
  interpreted.values.setLen(0)
  interpreted.profiles.setLen(0)
  interpreted.cacheInputKeys.clear()
  yieldScene = nil # the same abort skipped the layout's `finally`
  clearRunNodeStacks(scene.wornLayout)
  for _, child in interpreted.sceneNodes:
    clearRunNodeStacks(child)

proc forgetSceneGraph*(scene: InterpretedFrameScene) =
  ## A scene that goes lets go of its apps, its values and its program (the
  ## hosts' teardown, scenes.nim and single_scene_host.nim, after its child
  ## scenes). Closures go first: they hold the scene, an ORC cycle otherwise.
  scene.execNode = nil
  scene.getDataNode = nil
  # Before the apps are dropped: each JS app node owns a QuickJS runtime
  # with no destructor, so losing the last reference would leak it outright.
  for _, app in scene.appsByNodeId:
    releaseJsAppRuntime(app)
  scene.appsByNodeId.clear()
  scene.appInputs = @[]
  scene.sceneNodes.clear()
  scene.sceneExportByNodeId.clear()
  scene.eventApps = @[]
  scene.nodes.clear()
  scene.values = @[]
  scene.cacheValues.clear()
  scene.cacheTimes.clear()
  scene.cacheKeys.clear()
  scene.cacheExprs.clear()
  scene.cacheInputKeys.clear()
  cleanupSceneJs(scene)

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
