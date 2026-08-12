## Capability negotiation for interpreted scene graphs.
##
## Every edge in a scene graph is a fully materialized `Value` by default, so
## peak memory is the sum of everything live along the deepest active path. An
## app can declare in its config.json that one of its ports speaks something
## cheaper — writing into a caller-supplied image, or forwarding that request
## further upstream — and this planner works out, per edge, whether the shape
## of the graph actually allows it.
##
## It runs once per scene load, not per render: the graph is static between
## deploys, so the answer is too. The per-render facts (is there a canvas, what
## does a wired state field say right now) stay cheap checks against the plan
## in interpreter.nim.
##
## Three rules decide everything, and each has a materialized floor:
##
## * **A node cache is a materialization barrier.** A cached node cannot own
##   the live canvas (its cache would hold the canvas and redraw it onto
##   itself), and it cannot sit mid-chain in a one-shot handoff. The one
##   exception is a cached terminal producer, which still must not decode at
##   native resolution — it gets a canvas-*sized* target it allocates itself.
## * **Shapes that would change pixels do not fuse.** Anything the app
##   declared as `requireStatic` / `requireUnset` / `ownedTargetExcludes`, plus
##   any field wired to something the planner cannot resolve up front.
## * **Opaque nodes materialize.** Code nodes, JS apps, child scenes, state
##   reads, and any app that declares no capability at all.
##
## See docs/value-pipeline.md for the design and the protocol table.

import tables, json, os, sets, strutils
import chroma
import frameos/types
import frameos/node_config
import frameos/app_capabilities
import apps/apps

const NoNodeId* = (-1).NodeId

const MaxForwardHops = 8
  ## A forwarding chain longer than this is not a shape worth fusing, and the
  ## bound doubles as cycle insurance next to the visited set.

var imageFusionEnabled* = getEnv("FRAMEOS_DISABLE_FUSION").len == 0
  ## Kill switch for the differential harness: with fusion off every edge falls
  ## back to the materialized floor, and the rendered pixels must not change.
  ## Anything that diverges is a planner bug, not a rendering preference.

var imageBoundsEnabled* = getEnv("FRAMEOS_DISABLE_BOUNDS").len == 0
  ## Separate switch for the requestedBounds protocol, because its contract is
  ## deliberately weaker than fusion's: a bounded decode resamples where the
  ## materialized floor decodes native, so bounded output is *equivalent*, not
  ## byte-identical. The pixel-exact differentials run with this off and the
  ## bounds behavior gets its own classified comparison instead.

proc appKeyword(node: DiagramNode): string =
  if node.data.isNil or node.data.kind != JObject: return ""
  node.data{"keyword"}.getStr()

proc isWiredInput(scene: InterpretedFrameScene, nodeId: NodeId, field: string): bool =
  ## True when a field's value comes from another node or from inline code, in
  ## which case the planner cannot know it up front.
  (scene.appInputsForNodeId.hasKey(nodeId) and
    scene.appInputsForNodeId[nodeId].hasKey(field)) or
  (scene.appInlineInputsForNodeId.hasKey(nodeId) and
    scene.appInlineInputsForNodeId[nodeId].hasKey(field))

proc staticFieldValue(scene: InterpretedFrameScene, node: DiagramNode,
    caps: AppCapabilities, field: string): tuple[known: bool, value: string] =
  ## The value a field is going to have at render time. Scene JSON only stores
  ## explicitly-set config values, so an absent one means the app's config.json
  ## default — the same fallback the editor shows.
  if isWiredInput(scene, node.id, field):
    return (false, "")
  let (present, value) = configFieldString(node.data, field)
  if present:
    (true, value)
  else:
    (true, caps.fieldDefault(field))

proc staticBoundsMultiplier(scene: InterpretedFrameScene, node: DiagramNode,
    caps: AppCapabilities, fields: seq[string]): tuple[known: bool, scale: float] =
  ## The bounds multiplier a set of zoom fields resolves to: the maximum of
  ## their static values, floored at 1.0 — the same clamp the app applies to
  ## its effective zoom, and a multiplier must never shrink a bound. An empty
  ## value means "the app's own default", which the floor already covers; a
  ## wired or unparseable field refuses, never guesses.
  var scale = 1.0
  for field in fields:
    let (known, value) = staticFieldValue(scene, node, caps, field)
    if not known:
      return (false, 0.0)
    if value.len == 0:
      continue
    var parsed: float
    try:
      parsed = parseFloat(value)
    except CatchableError:
      return (false, 0.0)
    if parsed > scale:
      scale = parsed
  (true, scale)

proc constraintsHold(scene: InterpretedFrameScene, node: DiagramNode,
    caps: AppCapabilities, constraints: seq[FieldConstraint]): bool =
  for constraint in constraints:
    let (known, value) = staticFieldValue(scene, node, caps, constraint.field)
    if not known or value notin constraint.allowed:
      return false
  true

proc opaqueColorsHold(scene: InterpretedFrameScene, node: DiagramNode,
    caps: AppCapabilities, fields: seq[string]): bool =
  ## The "output is opaque given these fields" promise. A generator whose
  ## paint is fully opaque overwrites every pixel it fills, so a set and a
  ## composite are the same picture and it may claim the live canvas. Any
  ## alpha below 1 makes the fused fill an erase where the materialized floor
  ## composites — "tint the photo" must never delete the photo — and a wired
  ## color could be anything, so both stay on the floor.
  ##
  ## Only a value that provably parses to alpha 1 passes. A string that does
  ## not parse falls to the materialized floor rather than to a guess about
  ## the app's fallback — parseHtmlColor throws a Defect (not a
  ## CatchableError) on an empty string, which is exactly the kind of crack a
  ## "mirror the app's parse" rule would fall through.
  for field in fields:
    let (known, value) = staticFieldValue(scene, node, caps, field)
    if not known:
      return false
    var color: Color
    try:
      color = parseHtmlColor(value)
    except Exception:
      return false
    if color.a < 1.0:
      return false
  true

proc unsetHolds(scene: InterpretedFrameScene, node: DiagramNode,
    fields: seq[string]): bool =
  for field in fields:
    if isWiredInput(scene, node.id, field):
      return false
    if configFieldString(node.data, field).present:
      return false
  true

proc connectedInput(scene: InterpretedFrameScene, nodeId: NodeId,
    field: string): NodeId =
  if scene.appInputsForNodeId.hasKey(nodeId) and
      scene.appInputsForNodeId[nodeId].hasKey(field):
    return scene.appInputsForNodeId[nodeId][field]
  NoNodeId

type
  FusionRefusal* = enum
    ## Why an image edge that *could* have been negotiated was left
    ## materialized. The planner reports this rather than only deciding,
    ## because "why is this scene slow / why did it OOM" is otherwise a
    ## question you can only answer by reading the planner — and every answer
    ## here is either a rule doing its job or a gap worth closing.
    frFused = "fused"
    frConsumerCached = "consumer node has caching on"
    frStaticFieldWired = "a placement-affecting field is wired to something unresolvable"
    frFieldSet = "a field that must stay unset is configured or wired"
    frFitUnsupported = "the configured placement is not a fit the producer accepts"
    frInputUnwired = "the image input is not connected"
    frChainOpaque = "the producer chain runs into a node with no declared capability"
    frNoCommonFit = "producer and consumer share no fit"
    frForwardingOverCache = "a transformer would have to mutate a cached producer's value"
    frOwnedTargetExcluded = "an app-owned target would change the pixels here"
    frDynamicFitOverCache = "a state-wired placement would be baked into a cached producer's value"
    frCompositeBlend = "the producer composites into its target and the consumer's draw is not a plain composite"

  EdgeDiagnosis* = object
    nodeId*: NodeId
    keyword*: string
    input*: string
    refusal*: FusionRefusal
    ## Set when the chain walk stopped at a specific node.
    blockedAt*: NodeId
    blockedKeyword*: string

type OpaqueCheck* = proc (nodeId: NodeId): bool {.closure, gcsafe, raises: [].}
  ## Lets the interpreter mark nodes the planner cannot see into — today the
  ## dynamic JS apps, whose behaviour comes from scene JSON rather than from
  ## the app's declared capabilities.

proc resolveFit(scene: InterpretedFrameScene, node: DiagramNode,
    caps: AppCapabilities, spec: ProvidesTargetSpec,
    fit: var string, fitFromNodeId: var NodeId): bool =
  ## Resolves *where* the fit comes from: a literal in the config resolves now;
  ## a field wired to a state node is a pure read, so it resolves per render;
  ## anything else — an app output, a code node, inline JS — could be any value
  ## and disqualifies the edge. Whether the value is one the producer accepts
  ## is decided later, once the chain is known — a natural-size producer
  ## accepts any placement, so the answer depends on both ends.
  fit = ""
  fitFromNodeId = NoNodeId
  if spec.fitFrom.len == 0:
    return true
  if scene.appInlineInputsForNodeId.hasKey(node.id) and
      scene.appInlineInputsForNodeId[node.id].hasKey(spec.fitFrom):
    return false
  let wired = connectedInput(scene, node.id, spec.fitFrom)
  if wired != NoNodeId:
    if not scene.nodes.hasKey(wired) or scene.nodes[wired].nodeType != "state":
      return false
    fitFromNodeId = wired
    return true
  let (known, value) = staticFieldValue(scene, node, caps, spec.fitFrom)
  if not known:
    return false
  fit = value
  true

proc walkProducerChain(scene: InterpretedFrameScene, startId: NodeId,
    isOpaque: OpaqueCheck, hops: var seq[NodeId],
    producerFits: var seq[string], producerComposites: var bool,
    diagnosis: var EdgeDiagnosis): NodeId =
  ## Follows `forwardsTarget` hops from a consumer's input until it reaches an
  ## app whose output declares `intoTarget`. Returns that producer, or
  ## NoNodeId when the chain runs into anything opaque.
  ##
  ## `producerComposites` distinguishes the two ways a producer can honour a
  ## target: a decoder or generator overwrites every pixel of its fitted rect,
  ## while a dynamic JS app draws source-over onto whatever is already there.
  var currentId = startId
  var visited = initHashSet[NodeId]()
  hops = @[]
  producerFits = @[]
  producerComposites = false

  for _ in 0 .. MaxForwardHops:
    if currentId == NoNodeId or not scene.nodes.hasKey(currentId):
      return NoNodeId
    if visited.containsOrIncl(currentId):
      return NoNodeId
    let node = scene.nodes[currentId]
    diagnosis.blockedAt = currentId
    diagnosis.blockedKeyword = node.appKeyword()
    if node.nodeType != "app":
      diagnosis.blockedKeyword = node.nodeType
      return NoNodeId # code nodes, state reads and child scenes are opaque
    if isOpaque != nil and isOpaque(currentId):
      # A JS app does not make its own pixels: it asks the runtime for an image
      # (js_runtime/app_runtime.nim `imageFromSpec`) whose default size is the
      # context's, and draws into that with normal-blend operations. Handing it
      # the target instead of a fresh canvas is the `intoTarget` protocol with
      # a natural fit — not "streaming through JS", which stays a non-goal.
      #
      # It is a promise the app cannot make in advance, because the same entry
      # point also returns decoded SVG, data URLs and explicitly-sized images.
      # So this is offered, not assumed: the runtime takes the target only in
      # the branch where it would have allocated a target-sized canvas, and an
      # unclaimed target simply goes unused.
      producerFits = @[NaturalFit]
      producerComposites = true
      return currentId
    let caps = appCapabilities(node.appKeyword())
    if caps.isEmpty:
      return NoNodeId

    var terminal = false
    for into in caps.intoTarget:
      if not constraintsHold(scene, node, caps, into.requireStatic): continue
      if not unsetHolds(scene, node, into.requireUnset): continue
      if not opaqueColorsHold(scene, node, caps, into.requireOpaqueColor): continue
      producerFits = into.fits
      terminal = true
      break
    if terminal:
      return currentId

    var forwarded = false
    for forwards in caps.forwardsTarget:
      if not constraintsHold(scene, node, caps, forwards.requireStatic): continue
      # A cached transformer breaks the handoff: on a cache hit it returns a
      # value it does not own, and mutating that in place would poison the
      # cache for every later render.
      if readCacheConfig(node.data).enabled: continue
      let upstream = connectedInput(scene, currentId, forwards.input)
      if upstream == NoNodeId: continue
      hops.add(currentId)
      currentId = upstream
      forwarded = true
      break
    if not forwarded:
      return NoNodeId

  NoNodeId

proc excludedOwnedFits(scene: InterpretedFrameScene, node: DiagramNode,
    caps: AppCapabilities, spec: ProvidesTargetSpec,
    blockedOutright: var bool): seq[string] =
  ## Reduces the app's `ownedTargetExcludes` clauses against the config we can
  ## already see, leaving only the fits an app-owned scratch target must
  ## refuse. A clause that matches with no fit left in it blocks the tier for
  ## every fit.
  ##
  ## Only the owned tier is affected. A scratch carries margins of its own —
  ## a `contain` fit leaves them transparent, and drawing those over the canvas
  ## with `overwrite` erases what was there. The live canvas has no such
  ## margins: the producer's fitted draw simply leaves the rest alone, which is
  ## exactly what a materialized draw would have done.
  blockedOutright = false
  for clause in spec.ownedTargetExcludes:
    var fitValue = ""
    var matches = true
    for entry in clause:
      if entry.field == spec.fitFrom:
        fitValue = entry.value
        continue
      let (known, value) = staticFieldValue(scene, node, caps, entry.field)
      if not known or value != entry.value:
        matches = false
        break
    if not matches:
      continue
    if fitValue.len == 0:
      blockedOutright = true
      return @[]
    if fitValue notin result:
      result.add(fitValue)

proc planImageEdge(scene: InterpretedFrameScene, node: DiagramNode,
    caps: AppCapabilities, spec: ProvidesTargetSpec,
    isOpaque: OpaqueCheck, diagnosis: var EdgeDiagnosis): ImageFusionPlan =
  diagnosis = EdgeDiagnosis(nodeId: node.id, keyword: node.appKeyword(),
                            input: spec.input, refusal: frFused,
                            blockedAt: NoNodeId)
  # The consumer's own cache is a materialization barrier: a cached render
  # cannot be the thing that owns the canvas it is drawn onto.
  if readCacheConfig(node.data).enabled:
    diagnosis.refusal = frConsumerCached
    return nil
  if not constraintsHold(scene, node, caps, spec.requireStatic):
    diagnosis.refusal = frStaticFieldWired
    return nil
  if not unsetHolds(scene, node, spec.requireUnset):
    diagnosis.refusal = frFieldSet
    return nil

  var fit = ""
  var fitFromNodeId = NoNodeId
  if not resolveFit(scene, node, caps, spec, fit, fitFromNodeId):
    diagnosis.refusal = frFitUnsupported
    return nil

  let inputId = connectedInput(scene, node.id, spec.input)
  if inputId == NoNodeId:
    diagnosis.refusal = frInputUnwired
    return nil

  var hops: seq[NodeId] = @[]
  var producerFits: seq[string] = @[]
  var producerComposites = false
  let producerId = walkProducerChain(scene, inputId, isOpaque, hops, producerFits,
      producerComposites, diagnosis)
  if producerId == NoNodeId:
    diagnosis.refusal = frChainOpaque
    return nil
  if producerComposites and
      not constraintsHold(scene, node, caps, spec.compositingRequireStatic):
    # A compositing producer leaves the target's existing pixels visible under
    # everything it does not paint. That equals the materialized result only
    # when the consumer's draw is itself a plain composite; an `overwrite`
    # blend of the materialized (possibly transparent) image would have erased
    # them.
    diagnosis.refusal = frCompositeBlend
    return nil

  var fits: seq[string] = @[]
  let naturalProducer = NaturalFit in producerFits
  if naturalProducer:
    # Its output is target-sized whatever we ask for, so every placement the
    # consumer might be configured with reduces to the same 1:1 draw. The
    # offsets and blend still matter and are already covered by requireStatic.
    fits = spec.fits
    if fit.len > 0 and fit notin fits:
      fits.add(fit)
  else:
    for candidate in spec.fits:
      if candidate in producerFits:
        fits.add(candidate)
  if fits.len == 0:
    diagnosis.refusal = frNoCommonFit
    return nil
  if fitFromNodeId == NoNodeId and fit notin fits:
    diagnosis.refusal = frNoCommonFit
    return nil

  let producerCached = readCacheConfig(scene.nodes[producerId].data).enabled
  if producerCached and fitFromNodeId != NoNodeId and not naturalProducer:
    # A cached producer bakes the fit it was handed into the canvas-sized value
    # it caches. A placement wired from a state field can change between
    # renders, and every cache hit would keep serving the old fit — the
    # materialized floor re-fits per render, so this shape must too. A natural
    # producer is exempt: its output is target-sized under every placement, so
    # there is no fit to go stale.
    diagnosis.refusal = frDynamicFitOverCache
    return nil
  var tier: ImageFusionTier
  var ownedForCache = false
  if hops.len == 0:
    # Today's two shapes: an uncached producer decodes straight into the live
    # canvas; a cached one gets a canvas-sized image of its own, because a
    # cache holding the live canvas would redraw it onto itself forever.
    tier = if producerCached: iftOwnedScratch else: iftLiveCanvas
    ownedForCache = producerCached
  else:
    # Forwarding means a transformer mutates the image in place on the way
    # back down. It must therefore own what it mutates: not the live canvas
    # (which the consumer is going to composite onto, and whose untouched
    # regions belong to whatever rendered before), and not a cached producer's
    # value (which is shared with every later render).
    if producerCached:
      diagnosis.refusal = frForwardingOverCache
      return nil
    tier = iftOwnedScratch

  var blockedOutright = false
  let excluded = excludedOwnedFits(scene, node, caps, spec, blockedOutright)
  if tier == iftOwnedScratch:
    if blockedOutright:
      diagnosis.refusal = frOwnedTargetExcluded
      return nil
    if fitFromNodeId == NoNodeId and fit in excluded:
      diagnosis.refusal = frOwnedTargetExcluded
      return nil
    var anyAllowed = false
    for candidate in fits:
      if candidate notin excluded:
        anyAllowed = true
        break
    if not anyAllowed:
      diagnosis.refusal = frOwnedTargetExcluded
      return nil

  ImageFusionPlan(
    inputName: spec.input,
    tier: tier,
    fit: fit,
    fitFromNodeId: fitFromNodeId,
    defaultFit: caps.fieldDefault(spec.fitFrom),
    fits: fits,
    excludedFits: (if tier == iftOwnedScratch: excluded else: @[]),
    inPlaceNodeIds: hops,
    producerNodeId: producerId,
    ownedForCache: ownedForCache
  )

proc planImageBoundsEdge(scene: InterpretedFrameScene, node: DiagramNode,
    input: string, requireUnset: seq[string], originScale: float,
    isOpaque: OpaqueCheck): ImageBoundsPlan =
  ## The requestedBounds walk. Bounds are an upper limit, so the consumer's
  ## blend, offsets and fit do not matter (any placement into the canvas uses
  ## at most canvas-resolution pixels at cover scale); only inputs that
  ## change what the node draws (`requireUnset`, e.g. "draw onto this image
  ## instead") disqualify. The chain walks `forwardsBounds` hops — each one
  ## swaps, keeps, replaces or multiplies the bounds, all statically — and
  ## terminates at a producer whose `intoTarget` says it can decode to a
  ## requested resolution. A hop whose geometry cannot be known statically
  ## (an arbitrary rotation angle, a wired resize width, a wired zoom)
  ## refuses: a missing bound is the floor, a wrong bound is a bug.
  if not unsetHolds(scene, node, requireUnset):
    return nil

  var
    fromCanvas = true
    fixedWidth = 0
    fixedHeight = 0
    swapped = false
    scale = originScale
    currentId = connectedInput(scene, node.id, input)
    visited = initHashSet[NodeId]()

  if currentId == NoNodeId:
    return nil

  for _ in 0 .. MaxForwardHops:
    if currentId == NoNodeId or not scene.nodes.hasKey(currentId):
      return nil
    if visited.containsOrIncl(currentId):
      return nil
    let chainNode = scene.nodes[currentId]
    if chainNode.nodeType != "app":
      return nil
    if isOpaque != nil and isOpaque(currentId):
      # A JS app sizes its own output; nothing upstream of it is bounded by
      # the consumer anymore.
      return nil
    let chainCaps = appCapabilities(chainNode.appKeyword())

    var terminal = false
    for into in chainCaps.intoTarget:
      if NaturalFit in into.fits:
        # A generator's output is target-sized by construction; bounds have
        # nothing to bound.
        return nil
      terminal = true
      break
    if terminal:
      return ImageBoundsPlan(
        inputName: input,
        producerNodeId: currentId,
        fromCanvas: fromCanvas,
        fixedWidth: fixedWidth,
        fixedHeight: fixedHeight,
        swapped: swapped,
        scale: scale
      )

    var hopped = false
    for bounds in chainCaps.forwardsBounds:
      if bounds.widthFrom.len > 0:
        let (wKnown, wValue) = staticFieldValue(scene, chainNode, chainCaps, bounds.widthFrom)
        let (hKnown, hValue) = staticFieldValue(scene, chainNode, chainCaps, bounds.heightFrom)
        if not wKnown or not hKnown:
          return nil
        var w, h: int
        try:
          w = int(parseFloat(wValue))
          h = int(parseFloat(hValue))
        except CatchableError:
          return nil
        if w <= 0 or h <= 0:
          return nil
        # A replace discards everything downstream of this hop, the
        # accumulated multiplier included.
        fromCanvas = false
        fixedWidth = w
        fixedHeight = h
        swapped = false
        scale = 1.0
      elif bounds.boundsField.len > 0:
        let (known, value) = staticFieldValue(scene, chainNode, chainCaps, bounds.boundsField)
        if not known:
          return nil
        if value in bounds.swapValues:
          swapped = not swapped
        elif value in bounds.keepValues:
          discard
        else:
          return nil
      if bounds.multiplyFrom.len > 0:
        let (known, hopScale) = staticBoundsMultiplier(
          scene, chainNode, chainCaps, bounds.multiplyFrom)
        if not known:
          return nil
        scale = scale * hopScale
      let upstream = connectedInput(scene, currentId, bounds.input)
      if upstream == NoNodeId:
        return nil
      currentId = upstream
      hopped = true
      break
    if not hopped:
      return nil

  nil

proc planImageBounds*(scene: InterpretedFrameScene, isOpaque: OpaqueCheck = nil) =
  ## Fills `scene.imageBoundsPlans` for the consumer edges the fusion planner
  ## left materialized. Fused edges already carry a target, which is a
  ## stronger promise than a bound.
  scene.imageBoundsPlans = initTable[NodeId, ImageBoundsPlan]()
  if not imageFusionEnabled or not imageBoundsEnabled:
    return
  for nodeId, node in scene.nodes:
    if node.nodeType != "app":
      continue
    if scene.imageFusionPlans.hasKey(nodeId):
      continue
    if isOpaque != nil and isOpaque(nodeId):
      continue
    let caps = appCapabilities(node.appKeyword())
    var planned = false
    for spec in caps.providesTarget:
      let plan = planImageBoundsEdge(scene, node, spec.input,
        spec.requireUnset, 1.0, isOpaque)
      if plan != nil:
        scene.imageBoundsPlans[nodeId] = plan
        planned = true
        break
    if planned:
      continue
    for spec in caps.requestsBounds:
      # A bounds-only consumer (zoomPan): it can never hand its producer a
      # target — its draw is a per-render crop — but the crop shown at zoom Z
      # uses at most Z times the canvas resolution from the source.
      let (known, originScale) = staticBoundsMultiplier(
        scene, node, caps, spec.multiplyFrom)
      if not known:
        continue
      let plan = planImageBoundsEdge(scene, node, spec.input,
        spec.requireUnset, originScale, isOpaque)
      if plan != nil:
        scene.imageBoundsPlans[nodeId] = plan
        break

proc planImageFusion*(scene: InterpretedFrameScene, isOpaque: OpaqueCheck = nil,
    diagnoses: ptr seq[EdgeDiagnosis] = nil) =
  ## Fills `scene.imageFusionPlans`. Called once per scene load, after the
  ## edges are wired and the apps are initialized.
  ##
  ## `diagnoses`, when given, collects one entry per candidate edge including
  ## the ones that were refused and why — see `FusionRefusal`.
  scene.imageFusionPlans = initTable[NodeId, ImageFusionPlan]()
  if not imageFusionEnabled:
    return
  for nodeId, node in scene.nodes:
    if node.nodeType != "app":
      continue
    if isOpaque != nil and isOpaque(nodeId):
      continue
    let caps = appCapabilities(node.appKeyword())
    if caps.providesTarget.len == 0:
      continue
    for spec in caps.providesTarget:
      var diagnosis: EdgeDiagnosis
      let plan = planImageEdge(scene, node, caps, spec, isOpaque, diagnosis)
      if diagnoses != nil:
        diagnoses[].add(diagnosis)
      if plan != nil:
        # One target per node: the hint is a single slot on the context, and a
        # consumer with two fusible image inputs would have to hand out two.
        scene.imageFusionPlans[nodeId] = plan
        break
