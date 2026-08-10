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

import tables, json, os, sets
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

proc constraintsHold(scene: InterpretedFrameScene, node: DiagramNode,
    caps: AppCapabilities, constraints: seq[FieldConstraint]): bool =
  for constraint in constraints:
    let (known, value) = staticFieldValue(scene, node, caps, constraint.field)
    if not known or value notin constraint.allowed:
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

type OpaqueCheck* = proc (nodeId: NodeId): bool {.closure, gcsafe, raises: [].}
  ## Lets the interpreter mark nodes the planner cannot see into — today the
  ## dynamic JS apps, whose behaviour comes from scene JSON rather than from
  ## the app's declared capabilities.

proc resolveFit(scene: InterpretedFrameScene, node: DiagramNode,
    caps: AppCapabilities, spec: ProvidesTargetSpec,
    fit: var string, fitFromNodeId: var NodeId): bool =
  ## Where the fit (cover/contain/stretch) comes from. A literal in the config
  ## resolves now; a field wired to a state node is a pure read, so it resolves
  ## per render; anything else — an app output, a code node, inline JS — could
  ## be any value and disqualifies the edge.
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
  fit in spec.fits

proc walkProducerChain(scene: InterpretedFrameScene, startId: NodeId,
    isOpaque: OpaqueCheck, hops: var seq[NodeId],
    producerFits: var seq[string]): NodeId =
  ## Follows `forwardsTarget` hops from a consumer's input until it reaches an
  ## app whose output declares `intoTarget`. Returns that producer, or
  ## NoNodeId when the chain runs into anything opaque.
  var currentId = startId
  var visited = initHashSet[NodeId]()
  hops = @[]
  producerFits = @[]

  for _ in 0 .. MaxForwardHops:
    if currentId == NoNodeId or not scene.nodes.hasKey(currentId):
      return NoNodeId
    if visited.containsOrIncl(currentId):
      return NoNodeId
    let node = scene.nodes[currentId]
    if node.nodeType != "app":
      return NoNodeId # code nodes, state reads and child scenes are opaque
    if isOpaque != nil and isOpaque(currentId):
      return NoNodeId
    let caps = appCapabilities(node.appKeyword())
    if caps.isEmpty:
      return NoNodeId

    var terminal = false
    for into in caps.intoTarget:
      if not constraintsHold(scene, node, caps, into.requireStatic): continue
      if not unsetHolds(scene, node, into.requireUnset): continue
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
    isOpaque: OpaqueCheck): ImageFusionPlan =
  # The consumer's own cache is a materialization barrier: a cached render
  # cannot be the thing that owns the canvas it is drawn onto.
  if readCacheConfig(node.data).enabled:
    return nil
  if not constraintsHold(scene, node, caps, spec.requireStatic):
    return nil
  if not unsetHolds(scene, node, spec.requireUnset):
    return nil

  var fit = ""
  var fitFromNodeId = NoNodeId
  if not resolveFit(scene, node, caps, spec, fit, fitFromNodeId):
    return nil

  let inputId = connectedInput(scene, node.id, spec.input)
  if inputId == NoNodeId:
    return nil

  var hops: seq[NodeId] = @[]
  var producerFits: seq[string] = @[]
  let producerId = walkProducerChain(scene, inputId, isOpaque, hops, producerFits)
  if producerId == NoNodeId:
    return nil

  var fits: seq[string] = @[]
  for candidate in spec.fits:
    if candidate in producerFits:
      fits.add(candidate)
  if fits.len == 0:
    return nil
  if fitFromNodeId == NoNodeId and fit notin fits:
    return nil

  let producerCached = readCacheConfig(scene.nodes[producerId].data).enabled
  var tier: ImageFusionTier
  if hops.len == 0:
    # Today's two shapes: an uncached producer decodes straight into the live
    # canvas; a cached one gets a canvas-sized image of its own, because a
    # cache holding the live canvas would redraw it onto itself forever.
    tier = if producerCached: iftOwnedScratch else: iftLiveCanvas
  else:
    # Forwarding means a transformer mutates the image in place on the way
    # back down. It must therefore own what it mutates: not the live canvas
    # (which the consumer is going to composite onto, and whose untouched
    # regions belong to whatever rendered before), and not a cached producer's
    # value (which is shared with every later render).
    if producerCached:
      return nil
    tier = iftOwnedScratch

  var blockedOutright = false
  let excluded = excludedOwnedFits(scene, node, caps, spec, blockedOutright)
  if tier == iftOwnedScratch:
    if blockedOutright:
      return nil
    if fitFromNodeId == NoNodeId and fit in excluded:
      return nil
    var anyAllowed = false
    for candidate in fits:
      if candidate notin excluded:
        anyAllowed = true
        break
    if not anyAllowed:
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
    producerNodeId: producerId
  )

proc planImageFusion*(scene: InterpretedFrameScene, isOpaque: OpaqueCheck = nil) =
  ## Fills `scene.imageFusionPlans`. Called once per scene load, after the
  ## edges are wired and the apps are initialized.
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
      let plan = planImageEdge(scene, node, caps, spec, isOpaque)
      if plan != nil:
        # One target per node: the hint is a single slot on the context, and a
        # consumer with two fusible image inputs would have to hand out two.
        scene.imageFusionPlans[nodeId] = plan
        break
