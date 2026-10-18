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
## The frame's own pace does not change: it still wakes on the top scene's
## interval. A generated split has nothing of its own that changes with time,
## so it also waits until its first embedded scene is due, if that is later
## (`refreshFollowsChildren`). docs/scene-rhythm.md is the long version.
##
## Every proc here is on every ESP32 render, in an image with little room:
## no tables, no per-pass lists, one walk over the scene tree. A scene's
## copies are a seq found by their place on the canvas.

import std/[hashes, json, monotimes, tables]
import pixie
import frameos/types
import frameos/refresh_interval
from frameos/utils/memory import availableRenderBytes, availableRenderHeadroomBytes, runsAsEmbedded

type
  RhythmDecision* = enum
    rdRun      ## due: the scene runs and its due time moves on
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
    ## The ESP32's render task sleeps in whole seconds, rounding down.

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

when defined(testing):
  var rhythmClockOverride* {.threadvar.}: float
    ## Tests set the monotonic clock (seconds); 0 = the real one.

proc rhythmNow*(): float =
  when defined(testing):
    if rhythmClockOverride > 0:
      return rhythmClockOverride
  getMonoTime().ticks.float / 1e9

proc dueSlack(interval: float): float =
  clamp(interval * DueSlackShare, DueSlackMinSeconds, DueSlackMaxSeconds) + WholeSecondSleepSlack

proc dueBy(r: SceneRhythm, at: float): bool =
  r.dueAt <= at + dueSlack(r.interval)

proc logLine(scene: FrameScene, payload: JsonNode) =
  if not scene.logger.isNil and not scene.logger.log.isNil:
    scene.logger.log(payload)

proc stateKey(scene: FrameScene): int =
  if scene.state.isNil: 0 else: hash(scene.state).int

proc followedInterval(scene: FrameScene): float =
  ## A scene's interval. A generated split's is the time until its first
  ## panel is due, as its last render left it, or before its first render the
  ## shortest of its panels' intervals (they are instantiated with it); and
  ## never less than its own.
  if not scene.refreshFollowsChildren or not (scene of InterpretedFrameScene):
    return scene.refreshInterval
  let own = ownRefreshInterval(scene)
  if scene.followInterval >= 0:
    return max(own, scene.followInterval)
  var soonest = Inf
  for child in InterpretedFrameScene(scene).sceneNodes.values:
    soonest = min(soonest, child.refreshInterval)
  if soonest == Inf: own else: max(own, soonest)

# ------------------------------------------------------------------- copies

proc copyPixels(dst, src: Image) =
  ## Row by row, in either pixel format: either side may be a view onto a
  ## bigger canvas.
  let bpp = src.bytesPerPixel
  let d = cast[ptr UncheckedArray[byte]](dst.bufferPointer)
  let s = cast[ptr UncheckedArray[byte]](src.bufferPointer)
  for y in 0 ..< src.height:
    copyMem(d[dst.dataIndex(0, y) * bpp].addr, s[src.dataIndex(0, y) * bpp].addr, src.width * bpp)

proc copyIndex(r: SceneRhythm, image: Image): int =
  ## The copy of `image`'s rectangle, or -1. A rectangle is its place on the
  ## canvas (origin and stride) and its size: one scene drawn into several
  ## cells keeps one copy per cell, nested splits included.
  for i in 0 ..< r.copies.len:
    let copy = r.copies[i]
    if copy.width == image.width and copy.height == image.height and copy.format == image.format and
        r.copyAt[3 * i] == image.origin and r.copyAt[3 * i + 1] == image.stride:
      return i
  -1

proc dropCopy(r: SceneRhythm, i: int) =
  ## The last copy takes its slot: copies are found by their place, not their
  ## order, and a shifting `delete` cost 600 bytes of ESP32 image.
  heldBytes -= r.copies[i].byteSize
  let last = r.copies.high
  r.copies[i] = r.copies[last]
  r.copies.setLen(last)
  for k in 0 .. 2:
    r.copyAt[3 * i + k] = r.copyAt[3 * last + k]
  r.copyAt.setLen(3 * last)

proc dropCopy(r: SceneRhythm, image: Image) =
  let i = r.copyIndex(image)
  if i >= 0:
    r.dropCopy(i)

proc walkCopies(scene: FrameScene, dropDueBy: float): int =
  ## The bytes still kept for `scene` and the scenes it embeds, after letting
  ## go of the pictures of those due by `dropDueBy` (-Inf keeps everything,
  ## Inf drops everything), and of cells its last due run no longer drew (a
  ## layout that changed).
  let r = scene.rhythm
  if not r.isNil:
    var i = r.copies.len
    while i > 0:
      dec i
      if r.dueBy(dropDueBy) or r.copyAt[3 * i + 2] < r.scheduledPass:
        r.dropCopy(i)
      else:
        result += r.copies[i].byteSize
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

proc keepCopy(scene: FrameScene, image: Image) =
  let r = scene.rhythm
  let i = r.copyIndex(image)
  let bytes = image.byteSize
  let others = heldBytes - (if i >= 0: bytes else: 0)
  let budget = copyBudgetBytes()
  # A new copy needs one contiguous block, which fragmented PSRAM may not
  # have even with the budget to spare.
  let largest = availableRenderBytes()
  if others + bytes > budget or not (i >= 0 or bytes <= largest or (largest <= 0 and not runsAsEmbedded())):
    if i >= 0:
      r.dropCopy(i)
    if not r.copyRefused:
      r.copyRefused = true
      scene.logLine(%*{"event": "render:rhythm:copyRefused", "sceneId": scene.id.string, "bytes": bytes})
    return
  r.copyRefused = false
  if i >= 0:
    copyPixels(r.copies[i], image)
    r.copyAt[3 * i + 2] = passId
  else:
    r.copies.add(image.copy())
    r.copyAt.add(image.origin)
    r.copyAt.add(image.stride)
    r.copyAt.add(passId)
    heldBytes += bytes

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

proc rhythmEnterRender*(scene: FrameScene): bool =
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
  passFresh = freshRequested or switched
  freshRequested = false
  passRoot = scene
  passNext = passStart + followedInterval(scene)
  heldBytes = walkCopies(scene, -Inf)
  passReused = 0
  passRepainted = 0
  true

proc rhythmLeaveRender*(scene: FrameScene, passStarted: bool) =
  ## After the render run `rhythmEnterRender` saw. A scene that follows its
  ## embedded scenes takes as its interval the time until the first is due.
  if passDepth > 0:
    dec passDepth
  if scene.refreshFollowsChildren and scene of InterpretedFrameScene:
    var soonest = Inf
    for child in InterpretedFrameScene(scene).sceneNodes.values:
      if not child.rhythm.isNil and child.rhythm.visitPass == passId:
        soonest = min(soonest, child.rhythm.dueAt)
    if soonest != Inf:
      scene.followInterval = max(0.0, soonest - passStart)
  if not passStarted:
    return
  # Pictures of scenes that will run on the next pass anyway would only cost
  # a copy per pass.
  discard walkCopies(scene, passStart + followedInterval(scene))
  # Not on the ESP32, where every byte of the image counts: there a panel
  # that cannot be kept says so once (`render:rhythm:copyRefused`).
  when not defined(frameosEmbedded):
    if passReused + passRepainted > 0:
      scene.logLine(%*{"event": "render:rhythm", "sceneId": scene.id.string,
        "reused": passReused, "repainted": passRepainted})

proc rhythmResetAfterAbort*() =
  ## The ESP32's out-of-memory abort skips every `finally`: the next render
  ## must still start a pass (single_scene_host.recoverAbortedRun).
  passDepth = 0

# ------------------------------------------------------------- scene nodes

proc rhythmVisit*(scene: FrameScene, image: Image): RhythmDecision =
  ## A scene node is about to draw `scene` into `image`. The first visit in a
  ## pass decides whether it is due: a scene drawn into several cells (a
  ## split's "render all other cells") runs in all of them or in none.
  if passDepth == 0:
    return rdRun
  if scene.rhythm.isNil:
    scene.rhythm = SceneRhythm()
  let r = scene.rhythm
  if r.visitPass != passId:
    r.visitPass = passId
    r.runsThisPass = passFresh or r.dueAt <= 0 or stateKey(scene) != r.stateKey or
      r.dueBy(passStart)
  if r.runsThisPass:
    rdRun
  elif r.copyIndex(image) >= 0:
    inc passReused
    rdRestore
  else:
    inc passRepainted
    rdRepaint

proc rhythmRestore*(scene: FrameScene, image: Image) =
  let r = scene.rhythm
  copyPixels(image, r.copies[r.copyIndex(image)])

proc rhythmAfterRun*(scene: FrameScene, decision: RhythmDecision, given, drawn: Image,
    nextSleep: float) =
  ## After `scene` ran for a scene node: schedule it (a due run only), and
  ## keep what it drew if it will not be due again by the next pass and the
  ## memory allows. `nextSleep` is what its run set (-1: nothing), which
  ## means "this scene next renders in N seconds" and never reaches the
  ## scene drawing it.
  let r = scene.rhythm
  if r.isNil:
    return
  r.stateKey = stateKey(scene)
  if decision == rdRun and r.scheduledPass != passId:
    r.scheduledPass = passId
    let wait = max(if nextSleep >= 0: nextSleep else: scene.refreshInterval, 0.0)
    r.interval = wait
    r.dueAt = passStart + wait
  # A scene that swapped its canvas for an image of its own did not draw into
  # the rectangle, and one due again by the next pass would be copied for
  # nothing.
  if given.isNil:
    return
  if drawn != given or r.dueBy(passNext):
    r.dropCopy(given)
    return
  keepCopy(scene, given)
