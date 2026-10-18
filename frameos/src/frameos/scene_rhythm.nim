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
  passFresh {.threadvar.}: bool
  freshRequested {.threadvar.}: bool
  passRoot {.threadvar.}: FrameScene
  passRootInterval {.threadvar.}: float
    ## The top scene's interval as the pass starts.
  passRootOwn {.threadvar.}: float
    ## A generated split's own interval: it never renders more often.
  passDue1 {.threadvar.}: float
  passDue1Scene {.threadvar.}: FrameScene
  passDue2 {.threadvar.}: float
    ## The two earliest due times of the embedded scenes this pass has met so
    ## far, so a scene can ask when the next pass is without counting itself.
  heldBytes {.threadvar.}: int
  passRestored {.threadvar.}: seq[string]
  passRepainted {.threadvar.}: seq[string]

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

proc logLine(scene: FrameScene, payload: JsonNode) =
  if not scene.logger.isNil and not scene.logger.log.isNil:
    scene.logger.log(payload)

proc stateKey(scene: FrameScene): int =
  if scene.state.isNil: 0 else: hash(scene.state).int

proc noteDue(scene: FrameScene, dueAt: float) =
  if dueAt < passDue1:
    if passDue1Scene != scene:
      passDue2 = passDue1
    passDue1 = dueAt
    passDue1Scene = scene
  elif dueAt < passDue2 and passDue1Scene != scene:
    passDue2 = dueAt

proc nextPassAt(scene: FrameScene): float =
  ## When the next pass is expected, as far as `scene` can tell. A generated
  ## split's also depends on the first due time among its embedded scenes,
  ## which the pass learns as it goes (a panel's `nextSleep` can bring it
  ## forward), but never comes before its own interval is up.
  result = passStart + passRootInterval
  if passRoot.refreshFollowsChildren:
    let soonest = if passDue1Scene == scene: passDue2 else: passDue1
    result = max(passStart + passRootOwn, min(result, soonest))

proc followedInterval(scene: FrameScene, depth = 0): float =
  ## A scene's interval. A generated split's is the time until its first
  ## panel is due, as its last render left it, or before its first render the
  ## shortest of its panels' intervals (they are instantiated with it); and
  ## never less than its own.
  if not scene.refreshFollowsChildren or not (scene of InterpretedFrameScene):
    return scene.refreshInterval
  let own = ownRefreshInterval(scene)
  if scene.followInterval >= 0:
    return max(own, scene.followInterval)
  if depth > 8:
    return own
  var soonest = Inf
  for _, child in InterpretedFrameScene(scene).sceneNodes:
    soonest = min(soonest, followedInterval(child, depth + 1))
  if soonest == Inf: own else: max(own, soonest)

proc dueByNextPass(r: SceneRhythm, nextPass: float): bool =
  r.dueAt <= nextPass + dueSlack(r.interval)

# ------------------------------------------------------------------- copies

proc copyPixels(dst, src: Image) =
  ## Row by row: either side may be a view onto a bigger canvas.
  let rowBytes = src.width * src.bytesPerPixel
  for y in 0 ..< src.height:
    if src.format == pfRgb565:
      copyMem(dst.data16[dst.dataIndex(0, y)].addr, src.data16[src.dataIndex(0, y)].addr, rowBytes)
    else:
      copyMem(dst.data[dst.dataIndex(0, y)].addr, src.data[src.dataIndex(0, y)].addr, rowBytes)

proc fits(copy: RhythmCopy, image: Image): bool =
  not copy.pixels.isNil and not image.isNil and
    copy.pixels.width == image.width and copy.pixels.height == image.height and
    copy.pixels.format == image.format and copy.origin == image.origin and copy.stride == image.stride

proc heldBy(scene: FrameScene): int =
  if not scene.rhythm.isNil:
    for _, copy in scene.rhythm.copies:
      if not copy.pixels.isNil:
        result += copy.pixels.byteSize
  if scene of InterpretedFrameScene:
    for _, child in InterpretedFrameScene(scene).sceneNodes:
      result += heldBy(child)

proc releaseCopies*(scene: FrameScene) =
  ## Drop every picture kept for `scene` and the scenes it embeds.
  if scene.isNil:
    return
  if not scene.rhythm.isNil:
    scene.rhythm.copies.clear()
  if scene of InterpretedFrameScene:
    for _, child in InterpretedFrameScene(scene).sceneNodes:
      releaseCopies(child)

proc pruneCopies(scene: FrameScene, nextPass: float) =
  ## Drop the pictures of embedded scenes that will run on the next pass
  ## anyway: keeping them would only cost a copy per pass.
  if not scene.rhythm.isNil and scene.rhythm.copies.len > 0 and
      scene.rhythm.dueByNextPass(nextPass):
    scene.rhythm.copies.clear()
  if scene of InterpretedFrameScene:
    for _, child in InterpretedFrameScene(scene).sceneNodes:
      pruneCopies(child, nextPass)

proc copyBudgetBytes(): int =
  let headroom = availableRenderHeadroomBytes()
  if headroom <= 0 and not runsAsEmbedded():
    return UnknownHeadroomCopyCapBytes
  result = (headroom + heldBytes) div CopyBudgetShare
  if runsAsEmbedded():
    result = min(result, EmbeddedCopyCapBytes)

proc dropCopy(r: SceneRhythm, loopKey: string) =
  if r.copies.hasKey(loopKey):
    let old = r.copies[loopKey]
    if not old.pixels.isNil:
      heldBytes -= old.pixels.byteSize
    r.copies.del(loopKey)

proc keepCopy(scene: FrameScene, image: Image, loopKey: string) =
  let r = scene.rhythm
  let bytes = image.byteSize
  let existing = r.copies.getOrDefault(loopKey)
  let reuse = existing.fits(image)
  let existingBytes = if existing.pixels.isNil: 0 else: existing.pixels.byteSize
  let budget = copyBudgetBytes()
  # A new copy needs one contiguous block, which fragmented PSRAM may not
  # have even with the budget to spare.
  let largest = availableRenderBytes()
  let contiguous = reuse or bytes <= largest or (largest <= 0 and not runsAsEmbedded())
  if heldBytes - existingBytes + bytes > budget or not contiguous:
    r.dropCopy(loopKey)
    if not r.copyRefused:
      r.copyRefused = true
      scene.logLine(%*{"event": "render:rhythm:copyRefused", "sceneId": scene.id.string,
        "bytes": bytes, "budget": budget, "held": heldBytes,
        "message": "Not enough memory to keep this scene's picture between its renders; " &
          "it is drawn again on every pass until it is due."})
    return
  r.copyRefused = false
  if reuse:
    copyPixels(existing.pixels, image)
  else:
    r.dropCopy(loopKey)
    r.copies[loopKey] = RhythmCopy(pixels: image.copy(), origin: image.origin, stride: image.stride)
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
    releaseCopies(passRoot)
  passFresh = freshRequested or switched
  freshRequested = false
  passRoot = scene
  passRootInterval = followedInterval(scene)
  passRootOwn = ownRefreshInterval(scene)
  passDue1 = Inf
  passDue2 = Inf
  passDue1Scene = nil
  heldBytes = heldBy(scene)
  passRestored.setLen(0)
  passRepainted.setLen(0)
  true

proc rhythmLeaveRender*(scene: FrameScene, passStarted: bool) =
  ## After the render run `rhythmEnterRender` saw. A scene that follows its
  ## embedded scenes takes as its interval the time until the first is due.
  if passDepth > 0:
    dec passDepth
  if scene.refreshFollowsChildren and scene of InterpretedFrameScene:
    var soonest = Inf
    for _, child in InterpretedFrameScene(scene).sceneNodes:
      if not child.rhythm.isNil and child.rhythm.visitPass == passId:
        soonest = min(soonest, child.rhythm.dueAt)
    if soonest != Inf:
      scene.followInterval = max(0.0, soonest - passStart)
  if not passStarted:
    return
  pruneCopies(scene, passStart + followedInterval(scene))
  if passRestored.len > 0 or passRepainted.len > 0:
    scene.logLine(%*{"event": "render:rhythm", "sceneId": scene.id.string,
      "reused": passRestored, "repainted": passRepainted})

proc rhythmResetAfterAbort*() =
  ## The ESP32's out-of-memory abort skips every `finally`: the next render
  ## must still start a pass (single_scene_host.recoverAbortedRun).
  passDepth = 0

# ------------------------------------------------------------- scene nodes

proc rhythmVisit*(scene: FrameScene, image: Image, loopKey: string): RhythmDecision =
  ## A scene node is about to draw `scene` into `image`. The first visit in a
  ## pass decides whether it is due; a scene drawn into several cells (a
  ## split's "render all other cells") runs in all of them or in none.
  if passDepth == 0:
    return rdRun
  if scene.rhythm.isNil:
    scene.rhythm = SceneRhythm(copies: initTable[string, RhythmCopy]())
  let r = scene.rhythm
  if r.visitPass != passId:
    r.visitPass = passId
    r.runsThisPass = passFresh or r.dueAt <= 0 or stateKey(scene) != r.stateKey or
      passStart + dueSlack(r.interval) >= r.dueAt
    if not r.runsThisPass:
      noteDue(scene, r.dueAt)
  if r.runsThisPass:
    return rdRun
  if r.copies.getOrDefault(loopKey).fits(image):
    passRestored.add(scene.id.string)
    rdRestore
  else:
    passRepainted.add(scene.id.string)
    rdRepaint

proc rhythmRestore*(scene: FrameScene, image: Image, loopKey: string) =
  copyPixels(image, scene.rhythm.copies[loopKey].pixels)

proc rhythmAfterRun*(scene: FrameScene, decision: RhythmDecision, given, drawn: Image,
    loopKey: string, nextSleep: float) =
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
    noteDue(scene, r.dueAt)
  # A scene that swapped its canvas for an image of its own did not draw into
  # the rectangle, and one due again by the next pass would be copied for
  # nothing. (When a panel's `nextSleep` brings the next pass forward after
  # others were kept, the end of the pass drops what it no longer needs.)
  if given.isNil or drawn != given or r.dueByNextPass(nextPassAt(scene)):
    r.dropCopy(loopKey)
    return
  keepCopy(scene, given, loopKey)
