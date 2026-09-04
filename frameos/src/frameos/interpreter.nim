import frameos/types
import frameos/values
import frameos/spool
from frameos/apps as frameos_apps import spoolDir
from frameos/utils/image import renderError, renderErrorInto, spillImageToSpool, materializeImageSpool
from frameos/utils/memory import renderMemoryInUse, availableRenderBytes,
  availableRenderHeadroomBytes
when defined(memProbe): import frameos/utils/memory
import frameos/js_runtime/app_runtime
import frameos/js_runtime/runtime
import frameos/channels
import frameos/node_config
import frameos/planner
import frameos/runtime_diagnostics
import tables, json, os, zippy, chroma, pixie, jsony, sequtils, options, strutils, times, math
import apps/apps

# Runtime verbs a scene's dispatch node must not reach. Keep in step with
# schedulerRefusedEvents in scheduler.nim.
const sceneRefusedDispatchEvents* = ["uploadScenes", "reboot", "restart", "reload"]

const TRACING = false
when defined(frameosEmbedded):
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
  when defined(testing):
    if cachedImageMemoryLimitOverride > 0:
      return cachedImageMemoryLimitOverride
  when defined(frameosEmbedded):
    EmbeddedMaxCachedImageBytes
  else:
    0

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
  proc refuse(reason: string): ImageSpool =
    scene.logger.log(%*{
      "event": "interpreter:cache:imageSpill:refused",
      "sceneId": scene.id.string,
      "nodeId": nodeId.int,
      "reason": reason
    })
    nil

  if imageSpillDisabled:
    return refuse("spill disabled after an earlier storage failure")
  if context != nil and context.hasImage and not context.image.isNil and
      image.bufferPointer == context.image.bufferPointer:
    return refuse("value aliases the live canvas")
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
      fresh.img.byteSize > memoryLimit:
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

proc resetInterpretedScenes*() =
  allScenesLoaded = false
  # A card that was full or missing may have been swapped along with the
  # scenes; give the disk tier another chance.
  imageSpillDisabled = false
  loadedScenes = initTable[SceneId, ExportedInterpretedScene]()
var compiledSceneExports = initTable[SceneId, ExportedScene]()

proc registerCompiledScene*(sceneId: SceneId, exported: ExportedScene) =
  compiledSceneExports[sceneId] = exported

proc setUploadedInterpretedScenes*(scenes: Table[SceneId, ExportedInterpretedScene]) =
  uploadedScenes = scenes

proc getUploadedInterpretedScenes*(): Table[SceneId, ExportedInterpretedScene] =
  uploadedScenes

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
      self.logger.log(%*{
        "event": "interpreter:graph:hopLimit",
        "sceneId": self.id.string,
        "startNodeId": nodeId.int,
        "atNodeId": currentNodeId.int,
        "limit": maxHops
      })
      break
    if visited.hasKey(currentNodeId):
      self.logger.log(%*{
        "event": "interpreter:graph:cycle",
        "sceneId": self.id.string,
        "startNodeId": nodeId.int,
        "atNodeId": currentNodeId.int
      })
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
              self.logger.log(%*{
                "event": "interpreter:setField:error",
                "sceneId": self.id,
                "nodeId": currentNodeId.int,
                "input": inputName,
                "producer": producerNodeId.int,
                "error": $e.msg,
                "stacktrace": e.getStackTrace()
              })
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
                when defined(frameosEmbedded):
                  # Reuse the live canvas for the error frame: allocating a
                  # second full-frame image next to it OOMs memory-tight
                  # devices. Paint only after the field accepted the image,
                  # so a non-image field mismatch leaves the canvas untouched.
                  if context.hasImage and not context.image.isNil:
                    setInterpretedAppField(keyword, app, inputName,
                      Value(kind: fkImage, img: context.image))
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
            self.logger.log(%*{
              "event": "interpreter:setField:error:inlineCode",
              "sceneId": self.id,
              "nodeId": currentNodeId.int,
              "input": inputName,
              "code": codeSnippet,
              "error": $e.msg,
              "stacktrace": e.getStackTrace()
            })

      if setDecodeTargetHint:
        context.decodeTargetImage = nil
        context.decodeTargetScalingMode = ""
        context.decodeTargetWidth = 0
        context.decodeTargetHeight = 0
        context.decodeTargetNodeId = 0.NodeId
        context.decodeTargetOwned = false
        context.inPlaceImageNodes = @[]
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
              self.logger.log(%*{
                "event": "interpreter:dispatch:setField:error",
                "sceneId": self.id,
                "nodeId": currentNodeId.int,
                "input": inputName,
                "producer": producerNodeId.int,
                "error": $e.msg,
                "stacktrace": e.getStackTrace()
              })

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
            self.logger.log(%*{
              "event": "interpreter:dispatch:setField:error:inlineCode",
              "sceneId": self.id,
              "nodeId": currentNodeId.int,
              "input": inputName,
              "code": codeSnippet,
              "error": $e.msg,
              "stacktrace": e.getStackTrace()
            })

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
      if eventName == "render" and context.event == "render":
        self.logger.log(%*{
          "event": "interpreter:dispatch:ignored",
          "sceneId": self.id.string,
          "nodeId": currentNodeId.int,
          "eventName": eventName,
          "reason": "renderSelfDispatch"
        })
      elif eventName in sceneRefusedDispatchEvents:
        # Scene code is untrusted (it may be anyone's store scene). A dispatch
        # node may drive scenes and state; it may not replace the installed
        # scene set (skipping every guard the push path applies) or take the
        # runtime down on each render.
        self.logger.log(%*{
          "event": "interpreter:dispatch:ignored",
          "sceneId": self.id.string,
          "nodeId": currentNodeId.int,
          "eventName": eventName,
          "reason": "runtimeVerb"
        })
      else:
        sendEvent(eventName, finalPayload)
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
              self.logger.log(%*{
                "event": "interpreter:codeArg:error",
                "sceneId": self.id,
                "nodeId": currentNodeId.int,
                "arg": argName,
                "producer": producerNodeId.int,
                "error": $e.msg,
                "stacktrace": e.getStackTrace(),
                "defaulted": true,
                "defaultValue": valueToJson(zero)
              })
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
            self.logger.log(%*{
              "event": "interpreter:codeArg:error:inlineCode",
              "sceneId": self.id,
              "nodeId": currentNodeId.int,
              "arg": argName,
              "code": snippet,
              "error": $e.msg,
              "stacktrace": e.getStackTrace(),
              "defaulted": true,
              "defaultValue": valueToJson(zero)
            })
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
      var needsInitEvent = false

      if self.sceneExportByNodeId.hasKey(currentNodeId):
        exportedChild = self.sceneExportByNodeId[currentNodeId]
      else:
        if loadedScenes.hasKey(childSceneId):
          let interpretedExport = loadedScenes[childSceneId]
          exportedChild = ExportedScene(interpretedExport)
          needsInitEvent = true
        elif compiledSceneExports.hasKey(childSceneId):
          exportedChild = compiledSceneExports[childSceneId]
        elif uploadedScenes.hasKey(childSceneId):
          # uploaded scene id-s start with "uploaded/"
          # we should implement isloated scopes/applications later, but this will do for now
          let interpretedExport = uploadedScenes[childSceneId]
          exportedChild = ExportedScene(interpretedExport)
          needsInitEvent = true
        else:
          raise newException(Exception,
            "Scene node references unknown scene id: " & childSceneId.string)
        self.sceneExportByNodeId[currentNodeId] = exportedChild

      if not self.sceneNodes.hasKey(currentNodeId):
        var persisted = %*{}
        if currentNode.data.hasKey("config") and currentNode.data["config"].kind == JObject:
          persisted = currentNode.data["config"]
        let child = exportedChild.init(childSceneId, self.frameConfig, self.logger, persisted)
        self.sceneNodes[currentNodeId] = child
        if needsInitEvent:
          var initCtx = ExecutionContext(scene: child, event: "init",
                                        payload: child.state, hasImage: false,
                                        loopIndex: 0, loopKey: ".")
          exportedChild.runEvent(child, initCtx)

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
            self.logger.log(%*{
              "event": "interpreter:setChildState:error",
              "parentSceneId": self.id,
              "nodeId": currentNodeId.int,
              "input": inputName,
              "producer": producerNodeId.int,
              "error": $e.msg,
              "stacktrace": e.getStackTrace()
            })

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
            self.logger.log(%*{
              "event": "interpreter:setChildState:error:inlineCode",
              "parentSceneId": self.id,
              "nodeId": currentNodeId.int,
              "input": inputName,
              "code": codeSnippet,
              "error": $e.msg,
              "stacktrace": e.getStackTrace()
            })

      # Delegate handling of the current event to the child scene.
      exportedChild = self.sceneExportByNodeId[currentNodeId]
      if debugRuntime:
        markRuntimeCheckpoint("scene:delegate", currentSceneId = self.id.string, contextEvent = context.event,
          nodeId = currentNodeId.int, nodeType = nodeType, keyword = checkpointKeyword,
          childSceneId = childScene.id.string)
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
  if loadedScenes.hasKey(sceneId):
    exportedScene = loadedScenes[sceneId]
  elif uploadedScenes.hasKey(sceneId):
    exportedScene = uploadedScenes[sceneId]
  else:
    raise newException(Exception, "Scene not found: " & sceneId.string)

  let scene = InterpretedFrameScene(
    id: sceneId,
    isRendering: false,
    frameConfig: frameConfig,
    logger: logger,
    refreshInterval: exportedScene.refreshInterval,
    backgroundColor: exportedScene.backgroundColor,
    state: %*{},
    nodes: initTable[NodeId, DiagramNode](),
    edges: @[],
    apps: exportedScene.apps,
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
    if not scene.state.hasKey(field.name) and not field.value.isNil and field.value.kind != JNull:
      if field.value.kind == JString and field.value.getStr().len == 0:
        continue
      var seedValue = field.value
      if field.fieldType == "json" and seedValue.kind == JString:
        # Compiled scenes parse JSON string defaults; stay consistent
        try:
          seedValue = parseJson(seedValue.getStr())
        except CatchableError:
          discard
      scene.state[field.name] = valueToJson(valueFromJsonByType(seedValue, field.fieldType))
  stateFieldTypesByScene[sceneId] = typeMap

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
      scene.appsByNodeId[node.id] = initInterpretedApp(keyword, node, scene)

    elif node.nodeType == "scene":
      let childSceneId = node.data{"keyword"}.getStr().SceneId
      var exportedChild: ExportedScene
      var isInterpretedChild = false

      if loadedScenes.hasKey(childSceneId):
        let interpretedExport = loadedScenes[childSceneId]
        exportedChild = ExportedScene(interpretedExport)
        isInterpretedChild = true
      elif compiledSceneExports.hasKey(childSceneId):
        exportedChild = compiledSceneExports[childSceneId]
      elif uploadedScenes.hasKey(childSceneId):
        let interpretedExport = uploadedScenes[childSceneId]
        exportedChild = ExportedScene(interpretedExport)
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

      if isInterpretedChild:
        # Fire child's init event once (compiled scenes do this inside their init)
        var initCtx = ExecutionContext(
          scene: child,
          event: "init",
          payload: child.state,
          hasImage: false,
          loopIndex: 0,
          loopKey: "."
        )
        exportedChild.runEvent(child, initCtx)


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

proc eventFilterValue(value: JsonNode): string =
  if value.isNil:
    return ""
  case value.kind
  of JString:
    return strip(value.getStr())
  of JInt:
    return $value.getInt()
  of JFloat:
    return $value.getFloat()
  of JBool:
    if value.getBool():
      return "true"
    return "false"
  of JNull:
    return "null"
  else:
    return $value

proc eventNodeMatchesPayload(node: DiagramNode, payload: JsonNode): bool =
  if node.data.isNil or node.data.kind != JObject:
    return true

  var hasLabelFilter = false
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

proc runEvent*(self: FrameScene, context: ExecutionContext) =
  var scene: InterpretedFrameScene = InterpretedFrameScene(self)
  markRuntimeCheckpoint("event:start", currentSceneId = self.id.string, contextEvent = context.event,
    clearNode = true)

  case context.event:
  of "setSceneState":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      applyPublicStateFromPayload(scene, context.payload["state"])
    if context.payload.hasKey("render"):
      sendEvent("render", %*{})
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
    context.image.fill(scene.backgroundColor)
  else:
    discard

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
          discard scene.runNode(nextNode, context)
        except Exception as e:
          self.logger.log(%*{
            "event": "runEventInterpreted:error",
            "sceneId": self.id,
            "contextEvent": context.event,
            "nodeId": nextNode.int,
            "error": $e.msg,
            "stacktrace": e.getStackTrace()
          })
      else:
        listenersFiltered += 1
    if listenersFiltered > 0 and matched == 0:
      self.logger.log(%*{
        "event": "runEvent:noListenerMatched",
        "sceneId": self.id,
        "contextEvent": context.event,
        "payload": context.payload,
        "expected": expectedFilters,
        "error": "\"" & context.event & "\" reached the scene but every listener filtered it out" &
          (if expectedFilters.len > 0: " (nodes want " & expectedFilters.join(", ") & ")" else: "")
      })

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

# -------------------------
# Serialization hooks
# -------------------------

proc renameHook*(v: var DiagramNode, fieldName: var string) =
  if fieldName == "type":
    fieldName = "nodeType"

proc renameHook*(v: var DiagramEdge, fieldName: var string) =
  if fieldName == "type":
    fieldName = "edgeType"

proc renameHook*(v: var StateField, fieldName: var string) =
  if fieldName == "type":
    fieldName = "fieldType"

proc parseHook*(s: string, i: var int, v: var NodeId) =
  var str: string
  parseHook(s, i, str)
  if nodeMappingTable.hasKey(str):
    v = nodeMappingTable[str]
    return
  globalNodeCounter += 1
  nodeMappingTable[str] = NodeId(globalNodeCounter)
  v = NodeId(globalNodeCounter)

type RawStateFieldOption = object
  value: string
  label: string

proc parseHook*(s: string, i: var int, v: var StateFieldOption) =
  ## A select option is stored either as "value" (the value doubles as the
  ## label) or as {"value": .., "label": ..}. Editors have also shipped numbers
  ## and half-filled objects, and a scene that fails to parse takes the whole
  ## frame down, so take whatever is there.
  eatSpace(s, i)
  if i < s.len and s[i] == '{':
    var raw: RawStateFieldOption
    parseHook(s, i, raw)
    v = StateFieldOption(value: raw.value, label: if raw.label != "": raw.label else: raw.value)
  elif i < s.len and s[i] == '"':
    var tmp: string
    parseHook(s, i, tmp)
    v = StateFieldOption(value: tmp, label: tmp)
  elif i < s.len and s[i] == '[':
    # Nothing usable, but consume it so the rest of the scene still parses.
    skipValue(s, i)
    v = StateFieldOption()
  else:
    let symbol = parseSymbol(s, i)
    let value = if symbol == "null": "" else: symbol
    v = StateFieldOption(value: value, label: value)

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

proc parseHook*(s: string, i: var int, v: var SceneId) =
  var tmp: string
  parseHook(s, i, tmp)
  v = SceneId(tmp)

proc parseHook*(s: string, i: var int, v: var Color) =
  var tmp: string
  parseHook(s, i, tmp)
  v = parseHtmlColor(tmp)

proc dumpHook*(s: var string, v: Color) =
  s.add('"')
  s.add(toHtmlHex(v))
  s.add('"')

proc jsonNodeIdString(value: JsonNode): string =
  if value.isNil:
    return ""
  case value.kind
  of JString:
    return value.getStr()
  of JInt:
    return $value.getInt()
  else:
    return ""

proc annotateInterpretedSceneSourceNodeIds(data: string): string =
  let scenes = parseJson(data)
  if scenes.kind != JArray:
    return data
  for scene in scenes:
    if scene.kind != JObject or not scene.hasKey("nodes") or scene["nodes"].kind != JArray:
      continue
    for node in scene["nodes"]:
      if node.kind != JObject or not node.hasKey("id"):
        continue
      let sourceNodeId = jsonNodeIdString(node["id"])
      if sourceNodeId.len == 0:
        continue
      if not node.hasKey("data") or node["data"].kind != JObject:
        node["data"] = newJObject()
      if not node["data"].hasKey("__frameosSourceNodeId"):
        node["data"]["__frameosSourceNodeId"] = %sourceNodeId
  $scenes

# -------------------------
# Scene registry (loader)
# -------------------------

proc buildInterpretedSceneExport(scene: FrameSceneInput): ExportedInterpretedScene =
  let refreshInterval = if scene.settings != nil: scene.settings.refreshInterval else: 300.0
  let backgroundColor = if scene.settings != nil: scene.settings.backgroundColor else: parseHtmlColor("#000000")
  ExportedInterpretedScene(
    name: scene.name,
    nodes: scene.nodes,
    edges: scene.edges,
    apps: if scene.apps.isNil: %*{} else: scene.apps,
    stateFields: scene.fields,
    # Fields without an explicit access default to public for interpreted
    # scenes to keep older scenes.json exports controllable.
    publicStateFields: scene.fields.filterIt(it.access != "private"),
    persistedStateKeys: scene.fields.filterIt(it.persist == "disk").mapIt(it.name),
    init: init,
    render: render,
    runEvent: runEvent,
    refreshInterval: if refreshInterval > 0.0: refreshInterval else: 300.0,
    backgroundColor: backgroundColor
  )

proc parseInterpretedSceneInputs*(data: string): seq[FrameSceneInput] =
  if data == "":
    return @[]
  annotateInterpretedSceneSourceNodeIds(data).fromJson(seq[FrameSceneInput])

proc buildInterpretedScenes*(scenes: seq[FrameSceneInput]): Table[SceneId, ExportedInterpretedScene] =
  result = initTable[SceneId, ExportedInterpretedScene]()
  for scene in scenes:
    result[scene.id] = buildInterpretedSceneExport(scene)

proc parseInterpretedScenes*(data: string): Table[SceneId, ExportedInterpretedScene] =
  result = initTable[SceneId, ExportedInterpretedScene]()
  let scenes = parseInterpretedSceneInputs(data)
  if scenes.len == 0:
    return
  for scene in scenes:
    try:
      result[scene.id] = buildInterpretedSceneExport(scene)
    except Exception as e:
      echo "Warning: Failed to load interpreted scene: ", e.msg

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
    return initTable[SceneId, ExportedInterpretedScene]()

  let encoded = readFile(sourcePath)

  let decoded =
    if compressed:
      uncompress(encoded)
    else:
      encoded

  result = parseInterpretedScenes(decoded)

proc replaceInterpretedScenesCache*(scenes: Table[SceneId, ExportedInterpretedScene]) =
  loadedScenes = scenes
  allScenesLoaded = true

proc getInterpretedScenes*(): Table[SceneId, ExportedInterpretedScene] =
  if allScenesLoaded:
    return loadedScenes

  replaceInterpretedScenesCache(loadInterpretedScenesFromDisk())

  return loadedScenes
