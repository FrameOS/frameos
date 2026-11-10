## Scenes inside scenes render on their own schedule.
##
## A scene drawn through a scene node (a split's panel, a scene embedded in
## another) gets a due time from its own refresh interval, or from the
## `nextSleep` its last run set. Every render pass still starts at the top
## scene; when the pass reaches a scene node whose scene is not due, the node
## puts back the pixels that scene drew last time instead of running it. A
## device that could not afford to keep those pixels runs the scene again
## anyway, without moving its due time: the run is a *repaint*
## (`FrameScene.repainting`), and anything that can answer from what it
## fetched last time should.
##
## The frame wakes when the first thing on it is due (`refreshInterval`, kept
## by `syncRefreshInterval`): on an LCD or HDMI a generated split waits for its
## first panel whatever its own interval says, and e-paper or a deep sleeper
## keeps that interval as the fastest it refreshes.
##
## A panel that is not due and whose pixels the canvas still holds costs
## nothing at all (`rdKeep`): a canvas that survives between renders, in a
## parent that draws nothing over its panels, needs neither a copy nor a run.
## docs/scene-rhythm.md is the long version.
##
## Every proc here is on every ESP32 render, in an image with little room:
## no tables, no per-pass lists, one walk over the scene tree. A scene's
## cells are a seq found by their place on the canvas.

import std/[hashes, json, monotimes, tables]
import pixie
import frameos/types
import frameos/panel_shape
import frameos/refresh_interval
import frameos/layout_choice
import frameos/utils/canvas_log
from frameos/utils/svg_frames import forgetPanelRegions, aroundHoles, PixelBox
from frameos/loading_mark import LoadingMarkMinIntervalSeconds
from frameos/utils/memory import availableRenderBytes, availableRenderHeadroomBytes, runsAsEmbedded

{.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

type
  RhythmDecision* = enum
    rdRun      ## due: the scene runs and its due time moves on
    rdKeep     ## not due, and the canvas still holds its pixels: nothing to do
    rdRestore  ## not due: its pixels go back where they were
    rdRepaint  ## not due and nothing kept: it runs again, its due time stays

const
  CopyBudgetShare = 4
    ## Kept copies may hold at most a quarter of the render memory that would
    ## be free without them: the scene that IS due still has to decode and
    ## draw next to them.
  EmbeddedCopyCapBytes = 1024 * 1024
    ## And never more than this on an ESP32-class device, whatever is free.
  UnknownHeadroomCopyCapBytes = 64 * 1024 * 1024
    ## A host that cannot say how much memory it has (no /proc/meminfo).
  DueSlackShare = 0.1
  DueSlackMinSeconds = 0.002
  DueSlackMaxSeconds = 60.0
    ## A scene counts as due this much early: a tenth of its interval, at
    ## least two milliseconds, at most a minute. Wakes land a hair off the due
    ## time (the pass starts a little after the loop's timer), and a scene
    ## that just missed would otherwise wait a whole extra tick.
  WholeSecondSleepSlack = (when defined(frameosEmbedded): 1.5 else: 0.0)
    ## The ESP32's render task sleeps in whole seconds, rounding down, when
    ## the frame's next pass is a second or more away.
  ShortestPace = 0.01
    ## A panel already overdue asks for the next pass now; 0 would mean "no
    ## opinion" to the hosts.
  MaxCanvasMarks = 4

type CanvasMark = object
  canvas: Image
  generation: int64
  finishedPass: int

var
  passDepth {.threadvar.}: int
  passId {.threadvar.}: int
  passStart {.threadvar.}: float
  passNext {.threadvar.}: float
    ## When the next pass is expected: this one's start plus the top scene's
    ## interval as it starts. A panel's `nextSleep` can bring it forward; the
    ## end of the pass then drops what that made unnecessary.
  passFresh {.threadvar.}: bool
  freshRequested {.threadvar.}: bool
  passRoot {.threadvar.}: FrameScene
  heldBytes {.threadvar.}: int
  passReused {.threadvar.}: int
  passRepainted {.threadvar.}: int
  passKept {.threadvar.}: int
  passPace {.threadvar.}: float
  passHoldsFloor {.threadvar.}: bool
  passCanvas {.threadvar.}: Image
  passGeneration {.threadvar.}: int64
  keepAllowed {.threadvar.}: bool
    ## This pass may leave a cell as the canvas holds it: every scene on the
    ## way here draws nothing but its panels (a generated split).
  chromeStays {.threadvar.}: bool
    ## Nothing outside the scene entered last will paint over its rectangle,
    ## so its UI's chrome can be left there (rhythmVisitChrome). Not
    ## `keepAllowed`, which also asks what that scene itself paints.
  canvasMarks {.threadvar.}: array[MaxCanvasMarks, CanvasMark]
  nextCanvasMark {.threadvar.}: int
  rhythmHoldFloor*: bool
    ## Set by a host whose next wake is expensive whatever its panel (an
    ## ESP32 in deep sleep).
  rhythmCanvasGeneration*: proc(canvas: Image): int64 {.nimcall, raises: [].}
    ## Counts writes into a canvas that kept between renders and were not the
    ## render's own; -1 for a canvas that is new or cannot be trusted. Unset
    ## (the preview, a Pi's fresh RGBA canvas): every pass starts from nothing.

when defined(testing):
  var rhythmClockOverride* {.threadvar.}: float
    ## Tests set the monotonic clock (seconds); 0 = the real one.

var builtInRunner*: proc(scene: FrameScene, context: ExecutionContext): bool {.nimcall.}
  ## Set by the interpreter: a built-in scene's event, through the layout it
  ## wears; false when it wears none, and the scene runs by itself.

proc rhythmNow*(): float =
  when defined(testing):
    if rhythmClockOverride > 0:
      return rhythmClockOverride
  getMonoTime().ticks.float / 1e9

proc earlySlack(interval: float): float =
  clamp(interval * DueSlackShare, DueSlackMinSeconds, DueSlackMaxSeconds)

proc dueSlack(interval: float): float =
  # Only when the task will sleep in whole seconds: at 20 frames a second the
  # 1.5 s would make a once-a-second panel due on every frame.
  earlySlack(interval) + (if passPace >= 1.0: WholeSecondSleepSlack else: 0.0)

proc dueBy(r: SceneRhythm, at: float): bool =
  r.dueAt <= at + dueSlack(r.interval)

proc logLine(scene: FrameScene, payload: JsonNode) =
  if not scene.logger.isNil and not scene.logger.log.isNil:
    scene.logger.log(payload)

proc stateKey(scene: FrameScene): int =
  if scene.state.isNil: 0 else: hash(scene.state).int

proc followedInterval(scene: FrameScene): float =
  ## When the next pass is expected. Before a scene's first render with its
  ## layout nobody knows yet (0: nothing is "due by then"), and a generated
  ## split's first render guesses from its panels' intervals (they are
  ## instantiated with it).
  if scene.layoutPaced:
    return scene.layoutInterval
  if scene of InterpretedFrameScene:
    let interpreted = InterpretedFrameScene(scene)
    let wanted = layoutFor(interpreted.layoutSceneId.string)
    if wanted.len > 0 and interpreted.layoutFailedFor != wanted:
      return 0
  if scene.refreshFollowsChildren and scene.followInterval < 0 and scene of InterpretedFrameScene:
    let own = ownRefreshInterval(scene)
    var soonest = Inf
    for child in InterpretedFrameScene(scene).sceneNodes.values:
      soonest = min(soonest, child.refreshInterval)
    return (if soonest == Inf: own elif passHoldsFloor: max(own, soonest) else: soonest)
  if scene.refreshFollowsChildren or scene.embedPaced:
    return contentInterval(scene)
  scene.refreshInterval

# ------------------------------------------------------------------- copies

proc copyPixels(dst, src: Image) =
  ## Row by row, in either pixel format: either side may be a view onto a
  ## bigger canvas.
  for y in 0 ..< src.height:
    dst.copyPixelRow(dst.dataIndex(0, y), src, src.dataIndex(0, y), src.width)

proc cellOf(r: SceneRhythm, image: Image): RhythmCell =
  ## The cell of `image`'s rectangle, or nil. A rectangle is its place on the
  ## canvas (origin and stride) and its size: one scene drawn into several
  ## cells has one entry per cell, nested splits included.
  result = r.cells
  while not result.isNil and not (result.width == image.width and result.height == image.height and
      result.format == image.format and result.origin == image.origin and result.stride == image.stride):
    result = result.next

proc dropCell(r: SceneRhythm, c: RhythmCell) =
  if not c.copy.isNil:
    heldBytes -= c.copy.byteSize
  if r.cells == c:
    r.cells = c.next
  else:
    var before = r.cells
    while before.next != c:
      before = before.next
    before.next = c.next

proc walkCopies(scene: FrameScene, dropDueBy: float): int =
  ## The bytes still kept for `scene` and the scenes it embeds, after letting
  ## go of the cells of those due by `dropDueBy` (-Inf keeps everything, Inf
  ## drops everything), and of cells its last due run no longer drew (a
  ## layout that changed).
  let r = scene.rhythm
  if not r.isNil:
    var c = r.cells
    while not c.isNil:
      let next = c.next
      if r.dueBy(dropDueBy) or c.drawnPass < r.scheduledPass:
        r.dropCell(c)
      elif not c.copy.isNil:
        result += c.copy.byteSize
      c = next
    if not r.embedImage.isNil:
      if dropDueBy == Inf:
        unregisterCanvas(r.embedImage)
        r.embedImage = nil
      else:
        result += r.embedImage.byteSize
  if not scene.wornLayout.isNil:
    result += walkCopies(scene.wornLayout, dropDueBy)
  if scene of InterpretedFrameScene:
    for child in InterpretedFrameScene(scene).sceneNodes.values:
      result += walkCopies(child, dropDueBy)

proc copyBudgetBytes(): int =
  let headroom = availableRenderHeadroomBytes()
  if headroom <= 0 and not runsAsEmbedded():
    return UnknownHeadroomCopyCapBytes
  result = (headroom + heldBytes) div CopyBudgetShare
  if runsAsEmbedded():
    result = min(result, EmbeddedCopyCapBytes)

proc keepCopy(scene: FrameScene, image: Image, c: RhythmCell) =
  ## Cell `c` (the rectangle of `image`) as the scene just left it.
  let r = scene.rhythm
  let bytes = image.byteSize
  let others = heldBytes - (if c.copy.isNil: 0 else: bytes)
  let budget = copyBudgetBytes()
  # A new copy needs one contiguous block, which fragmented PSRAM may not
  # have even with the budget to spare.
  let largest = availableRenderBytes()
  if others + bytes > budget or not (not c.copy.isNil or bytes <= largest or (largest <= 0 and not runsAsEmbedded())):
    r.dropCell(c)
    if not r.copyRefused:
      r.copyRefused = true
      scene.logLine(%*{"event": "render:rhythm:copyRefused", "sceneId": scene.id.string, "bytes": bytes})
    return
  r.copyRefused = false
  if c.copy.isNil:
    c.copy = image.copy()
    heldBytes += bytes
  else:
    copyPixels(c.copy, image)

proc embedBytesAllowed*(bytes: int): bool =
  ## May a `<Scene>` keep a picture this big between renders?
  heldBytes + bytes <= copyBudgetBytes()

proc noteEmbedImage*(delta: int) =
  heldBytes += delta

# ----------------------------------------------------------- canvases that stay

proc canvasMarkOf(canvas: Image): int =
  if canvas.isNil: return -1
  for i in 0 ..< MaxCanvasMarks:
    if not canvasMarks[i].canvas.isNil and canvasMarks[i].canvas.bufferPointer == canvas.bufferPointer:
      return i
  -1

proc markHolds(m: CanvasMark, drawnPass: int): bool =
  ## This canvas finished a pass after the cell last ran, and nothing but
  ## renders wrote into it since.
  m.finishedPass >= drawnPass and not rhythmCanvasGeneration.isNil and
    m.generation >= 0 and rhythmCanvasGeneration(m.canvas) == m.generation

proc keepable(c: RhythmCell): bool =
  ## The canvas this pass draws on still holds the cell's pixels.
  let i = canvasMarkOf(passCanvas)
  keepAllowed and i >= 0 and canvasMarks[i].markHolds(c.drawnPass)

proc otherCanvasHolding(drawnPass: int): Image =
  ## An LCD's other frame buffer that holds what that pass drew: the picture to
  ## put back when this buffer's is a frame or two old, with no memory of its
  ## own. Same size, same format: they are buffers of one panel.
  for i in 0 ..< MaxCanvasMarks:
    template m: untyped = canvasMarks[i]
    if not m.canvas.isNil and m.canvas.bufferPointer != passCanvas.bufferPointer and
        m.canvas.width == passCanvas.width and m.canvas.height == passCanvas.height and
        m.canvas.format == passCanvas.format and m.markHolds(drawnPass):
      return m.canvas

proc cellHolder(c: RhythmCell): Image =
  if keepAllowed and not passCanvas.isNil:
    result = otherCanvasHolding(c.drawnPass)

proc forgetCanvasMarks() =
  for i in 0 ..< MaxCanvasMarks:
    canvasMarks[i].canvas = nil

# ------------------------------------------------------------------- passes

proc rhythmRequestFreshPass*() =
  ## Somebody outside the scene asked for a render (the API, the cloud, a
  ## schedule, a button, the preview): the next pass runs every embedded
  ## scene, due or not.
  freshRequested = true

proc rhythmMarkDue*(scene: FrameScene) =
  ## The scene asked to be drawn again (its own `render` dispatch).
  if not scene.isNil and not scene.rhythm.isNil:
    scene.rhythm.dueAt = 0
    scene.rhythm.chromeDueAt = 0

proc rhythmAwaited*(scene: FrameScene): bool =
  ## May the next pass show the loading mark? Not when the frame's own clock
  ## repeats what it draws within seconds: an animation, a ticking clock. With
  ## a layout that is the scene's own interval, not the bar's, and only a pass
  ## that will run the scene counts: the bar ticking over a slow map is not
  ## something anybody waits for, the map coming in is.
  if scene.isNil:
    return true
  let every = if scene.layoutPaced: contentInterval(scene) else: scene.refreshInterval
  if every > 0 and every < LoadingMarkMinIntervalSeconds.float:
    return false
  let r = scene.rhythm
  not scene.layoutPaced or r.isNil or freshRequested or r.dueAt <= 0 or
    stateKey(scene) != r.stateKey or r.dueBy(rhythmNow())

proc rhythmEnterRender*(scene: FrameScene, canvas: Image): bool =
  ## Every render run of an interpreted scene comes through here
  ## (interpreter.runEvent). The outermost one is a pass, and true is returned.
  inc passDepth
  if passDepth > 1:
    return false
  inc passId
  passStart = rhythmNow()
  # A different top scene than last time (a switch, a redeploy) is drawn
  # from scratch, and whatever the old one kept goes.
  let switched = not passRoot.isNil and passRoot != scene
  if switched:
    discard walkCopies(passRoot, Inf)
    forgetCanvasMarks()
    forgetPanelRegions()
  passFresh = freshRequested or switched
  freshRequested = false
  passRoot = scene
  passHoldsFloor = rhythmHoldFloor or scene.frameConfig.isNil or (not canvas.isNil and
    panelIsPaper(scene.frameConfig.device, canvas.format == pfRgb565))
  passCanvas = canvas
  passGeneration = if canvas.isNil or rhythmCanvasGeneration.isNil: -1'i64 else: rhythmCanvasGeneration(canvas)
  keepAllowed = scene.refreshFollowsChildren and passGeneration >= 0
  passPace = followedInterval(scene)
  passNext = passStart + passPace
  heldBytes = walkCopies(scene, -Inf)
  passReused = 0
  passRepainted = 0
  passKept = 0
  true

proc rhythmEnterChild*(child: FrameScene): bool =
  ## A scene is about to run inside the current one. What it draws under
  ## lasts only if it, too, draws nothing but its panels.
  result = keepAllowed
  chromeStays = keepAllowed
  keepAllowed = keepAllowed and child.refreshFollowsChildren

proc rhythmEnterEmbed*(): bool =
  ## A `<Scene>` draws into a picture of its own, which is no canvas that
  ## holds anything from last time.
  result = keepAllowed
  keepAllowed = false
  chromeStays = false

proc rhythmEnterHole*(): bool =
  ## A layout's `<yield />` hole: nothing is drawn over it, so what the canvas
  ## holds there stays, as under a generated split's panel.
  result = keepAllowed
  keepAllowed = passGeneration >= 0
  chromeStays = keepAllowed

proc rhythmPass*(): int =
  passId

proc rhythmDepth*(): int =
  ## How many renders deep this one is, for the check that stops a scene
  ## embedding itself through another.
  passDepth

proc rhythmLeaveChild*(saved: bool) =
  keepAllowed = saved

proc soonestEmbedded(scene: FrameScene): float =
  ## When the first embedded scene that paces this one is due. A generated
  ## split is paced by every panel, anything else by its `<Scene>`s alone (a
  ## hand-built scene node renders at most as often as the scene holding it).
  result = Inf
  for key, child in InterpretedFrameScene(scene).sceneNodes.pairs:
    if (scene.refreshFollowsChildren or key.int < 0) and not child.rhythm.isNil and
        child.rhythm.visitPass == passId:
      result = min(result, child.rhythm.dueAt)

proc rhythmLeaveRender*(scene: FrameScene, passStarted: bool) =
  ## After the render run `rhythmEnterRender` saw: when does the scene want
  ## its next pass?
  if passDepth > 0:
    dec passDepth
  scene.holdsIntervalFloor = passHoldsFloor
  if scene of InterpretedFrameScene:
    let soonest = soonestEmbedded(scene)
    if soonest != Inf:
      scene.followInterval = max(ShortestPace, soonest - passStart)
    if not scene.refreshFollowsChildren:
      scene.embedPaced = soonest != Inf
  if passStarted:
    let layout = scene.wornLayout
    if not layout.isNil:
      # The layout's own wait (its chrome), and the scene it wraps. The full
      # interval even around a hole, whose chrome knows when it is due: a
      # wait under a second reads as an animation on an ESP32, which would
      # run another pass at once after every tap.
      var wait = layout.refreshInterval
      if passHoldsFloor:
        # On e-paper or a deep sleeper the chrome never wakes the frame
        # sooner than the scene it wraps would.
        wait = max(wait, contentInterval(scene))
      if not scene.rhythm.isNil and scene.rhythm.visitPass == passId:
        wait = min(wait, scene.rhythm.dueAt - passStart)
      scene.layoutInterval = max(ShortestPace, wait)
      scene.layoutPaced = true
    else:
      scene.layoutPaced = false
  if not passStarted:
    return
  if not passCanvas.isNil and passGeneration >= 0:
    let i = canvasMarkOf(passCanvas)
    if i >= 0:
      canvasMarks[i].generation = passGeneration
      canvasMarks[i].finishedPass = passId
    else:
      canvasMarks[nextCanvasMark] = CanvasMark(canvas: passCanvas, generation: passGeneration, finishedPass: passId)
      nextCanvasMark = (nextCanvasMark + 1) mod MaxCanvasMarks
  # Pictures of scenes that will run on the next pass anyway would only cost
  # a copy per pass.
  discard walkCopies(scene, passStart + followedInterval(scene))
  # Not on the ESP32, where every byte of the image counts: there a panel
  # that cannot be kept says so once (`render:rhythm:copyRefused`).
  when not defined(frameosEmbedded):
    if passReused + passRepainted + passKept > 0:
      scene.logLine(%*{"event": "render:rhythm", "sceneId": scene.id.string,
        "reused": passReused, "repainted": passRepainted, "kept": passKept})

proc rhythmReleaseScene*(scene: FrameScene) =
  ## The scene is going away: a `<Scene>`'s picture is held by the canvas
  ## log until it says otherwise.
  if not scene.rhythm.isNil and not scene.rhythm.embedImage.isNil:
    unregisterCanvas(scene.rhythm.embedImage)
    scene.rhythm.embedImage = nil

proc rhythmForgetCanvases*() =
  ## Something other than a scene drew over the canvas (an error screen, the
  ## status screen).
  forgetCanvasMarks()
  forgetPanelRegions()

proc rhythmResetAfterAbort*() =
  ## The ESP32's out-of-memory abort skips every `finally`: the next render
  ## must still start a pass (single_scene_host.recoverAbortedRun).
  passDepth = 0
  rhythmForgetCanvases()
  keepAllowed = false

# ------------------------------------------------------------- scene nodes

proc rhythmOf(scene: FrameScene): SceneRhythm =
  if scene.rhythm.isNil:
    scene.rhythm = SceneRhythm()
  scene.rhythm

proc decided(scene: FrameScene): SceneRhythm =
  ## The first visit in a pass decides whether the scene is due: a scene drawn
  ## into several cells (a split's "render all other cells") runs in all of
  ## them or in none.
  result = rhythmOf(scene)
  if result.visitPass != passId:
    result.visitPass = passId
    result.runsThisPass = passFresh or result.dueAt <= 0 or stateKey(scene) != result.stateKey or
      result.dueBy(passStart)

proc rhythmVisit*(scene: FrameScene, image: Image): RhythmDecision =
  ## A scene node is about to draw `scene` into `image`.
  if passDepth == 0:
    return rdRun
  let r = decided(scene)
  if r.runsThisPass:
    return rdRun
  let c = r.cellOf(image)
  if not c.isNil:
    if c.keepable:
      inc passKept
      return rdKeep
    if not c.copy.isNil or not c.cellHolder.isNil:
      inc passReused
      return rdRestore
  inc passRepainted
  rdRepaint

proc rhythmRestore*(scene: FrameScene, image: Image) =
  let
    c = scene.rhythm.cellOf(image)
    other = c.cellHolder
  if not other.isNil:
    let
      x = image.origin mod max(image.stride, 1)
      y = image.origin div max(image.stride, 1)
    copyPixels(image, other.view(x, y, image.width, image.height))
  else:
    copyPixels(image, c.copy)

proc rhythmAfterRun*(scene: FrameScene, decision: RhythmDecision, given, drawn: Image,
    nextSleep: float) =
  ## After `scene` ran for a scene node: schedule it (a due run only), and
  ## keep what it drew if it will not be due again by the next pass and the
  ## canvas will not keep it for us. `nextSleep` is what its run set (-1:
  ## nothing), which means "this scene next renders in N seconds" and never
  ## reaches the scene drawing it. Nothing `given` (a `<Scene>`, a layout's
  ## chrome): the schedule alone.
  let r = scene.rhythm
  if r.isNil:
    return
  r.stateKey = stateKey(scene)
  if decision == rdRun and r.scheduledPass != passId:
    r.scheduledPass = passId
    let interval = if scene.layoutPaced: contentInterval(scene) else: scene.refreshInterval
    let wait = max(if nextSleep >= 0: nextSleep else: interval, 0.0)
    r.interval = wait
    r.dueAt = passStart + wait
  if given.isNil:
    return
  var c = r.cellOf(given)
  # A scene that swapped its canvas for an image of its own did not draw into
  # the rectangle, and one due again by the next pass would be copied for
  # nothing.
  if drawn != given or r.dueBy(passNext):
    if not c.isNil:
      r.dropCell(c)
    return
  if c.isNil:
    c = RhythmCell(origin: given.origin, stride: given.stride, width: given.width,
      height: given.height, format: given.format, next: r.cells)
    r.cells = c
  c.drawnPass = passId
  if keepAllowed:
    # The canvas stays: nothing to keep but the record that it holds this.
    if not c.copy.isNil:
      heldBytes -= c.copy.byteSize
      c.copy = nil
    return
  keepCopy(scene, given, c)

# --------------------------------------------------- around a layout's hole

proc rhythmChromeCanStay*(host: FrameScene): bool =
  ## Every embedded scene of this UI is a hole. A picture of one is part of the
  ## UI's drawing, and a split's panels are no UI of its own.
  for i in 0 ..< host.slots.len:
    if not host.slots[i].hole:
      return false
  host.slots.len > 0

proc rhythmVisitChrome*(host: FrameScene): RhythmDecision =
  ## May this pass leave a UI's chrome (all of it but its holes) as it is, and
  ## not run the UI at all? A scene that animates at 20 frames a second inside a
  ## clock bar would otherwise pay for the bar's JavaScript, tree and layout
  ## twenty times a second.
  if passDepth == 0 or not rhythmChromeCanStay(host):
    return rdRun
  let r = rhythmOf(host)
  # Not dueBy: its whole-second slack calls a one-second clock bar due on any
  # pass at all, so a tap on the content would pay for the bar as well. A bar
  # a little early waits for the pass its own due time wakes.
  if passFresh or r.chromeDueAt <= 0 or stateKey(host) != r.stateKey or
      r.chromeDueAt <= passStart + earlySlack(r.chromeInterval):
    return rdRun
  # Inside something else, what is under it lasts only if that says so.
  if passGeneration < 0 or (passDepth > 1 and not chromeStays):
    return rdRepaint
  let i = canvasMarkOf(passCanvas)
  if i >= 0 and canvasMarks[i].markHolds(r.chromePass):
    return rdKeep
  if not otherCanvasHolding(r.chromePass).isNil:
    return rdRestore
  rdRepaint

proc rhythmRestoreChrome*(host: FrameScene, image: Image) =
  ## The chrome out of the frame buffer that holds it, around the holes: what
  ## this buffer's holes hold is their scenes' business.
  let src = otherCanvasHolding(host.rhythm.chromePass)
  if src.isNil:
    return
  var holes: seq[PixelBox]
  for i in 0 ..< host.slots.len:
    template s: untyped = host.slots[i]
    holes.add((s.x.int, s.y.int, int(s.visible[2] - s.x), int(s.visible[3] - s.y)))
  for r in aroundHoles(image.width, image.height, holes):
    if r.w > 0 and r.h > 0:
      copyPixels(image.view(r.x, r.y, r.w, r.h), src.view(host.canvasX.int + r.x, host.canvasY.int + r.y, r.w, r.h))

proc rhythmChromeRan*(host: FrameScene, decision: RhythmDecision, nextSleep: float) =
  ## The UI just drew around its holes: schedule it (a due run only). Its own
  ## interval: when its embedded scenes are due is theirs to say.
  let r = rhythmOf(host)
  r.chromePass = passId
  r.stateKey = stateKey(host)
  if decision == rdRun:
    r.chromeInterval = max(if nextSleep >= 0: nextSleep else: ownRefreshInterval(host), 0.0)
    r.chromeDueAt = passStart + r.chromeInterval

# ------------------------------------------------------------- `<Scene>` tags

proc rhythmEmbedDue*(scene: FrameScene): bool =
  ## A `<Scene>`, whose picture the UI draws: does it run on this pass?
  passDepth == 0 or decided(scene).runsThisPass

{.pop.}
