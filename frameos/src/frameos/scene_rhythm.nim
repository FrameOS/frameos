## Scene rhythm: every embedded scene renders when IT is due.
##
## The unit of scheduling is the scene node — any scene embedded in any scene,
## at any depth. A split of two photos (every ten minutes) and a clock (every
## second) shows a clock that ticks and photos that do not move, without a
## second copy of the picture. docs/scene-rhythm.md is the long form; the short
## one:
##
## * **Due times.** Each scene-node run gets a fresh `nextSleep`; afterwards
##   the child instance is due at `now + (nextSleep or its refreshInterval)`.
##   The render loop wakes at the minimum over the top scene and every active
##   descendant.
## * **Partial passes.** When only descendants are due, the top scene does not
##   run. Each due node is run straight into a view of the persistent canvas at
##   the rectangle it was last handed. Nothing else executes; its neighbours'
##   pixels are simply still there.
## * **The overpaint rule.** That is only right if nothing painted over the
##   node's rectangle after it. Every full pass keeps a paint log (a rectangle
##   per executed render node); a node with a later record outside itself that
##   intersects its rectangle is *overpainted* and never runs alone — when it is
##   due the whole scene re-renders, which is what always happened.
## * **Pixel reuse.** A full pass wipes the canvas, and would re-run children
##   that are nowhere near due (a photo refetched because its sibling forced a
##   pass). What a device can afford decides what happens instead:
##     - *memory, transient*: right before a full pass wipes the canvas, the
##       rectangles of not-due nodes are copied out, and copied back when the
##       pass reaches them. Freed when the pass ends.
##     - *memory, kept*: an overpainted node's pixels on the canvas are not its
##       own, so its snapshot is taken right after it runs and kept.
##     - *storage*: a deep-sleeping frame loses the canvas with its PSRAM. A
##       node that will outlive the next wake has its rectangle written to
##       flash (or the SD card), raw rows in the canvas's own format, and read
##       straight back into the canvas on wake.
##   Every tier is budgeted against what is free right now, and "store nothing"
##   is always a valid answer: the child just runs, as it did before.

import std/[monotimes, times, os, strutils, math, json]
import pixie
import frameos/types
import frameos/spool
import frameos/utils/memory

const
  PaintLogCap = 512
    ## Paint records one pass may keep. Past it the pass is treated as
    ## "everything overpainted": exactly today's behaviour, never a wrong one.
  KeptSnapshotMinSeconds = 5.0
    ## A node due again sooner than this is not worth copying out.
  StoredMinSeconds = 120.0
    ## The storage tier costs flash wear; a node must have at least this long
    ## left, and must outlive the next wake by `StoredMinGainSeconds`.
  StoredMinGainSeconds = 30.0
  StoredWriteMarginFactor = 2.0
    ## A store must be expected to save this many times what it costs to write.
  StoredMinSavingSeconds = 10.0
    ## ...and at least this much awake time over the node's life. On a
    ## deep-sleeping e-ink frame the wake itself costs a minute (boot, hello,
    ## dither, a 30 s panel refresh); a store that shaves seconds off that is
    ## flash wear for nothing, and re-rendering is the simpler answer.
  StoredMaxWriteSeconds = 60.0
    ## And never take longer than this, whatever it would save: a battery frame
    ## that stays awake for minutes to write a cache has lost more than a
    ## fetch costs. SPIFFS on the E1004 wrote a 1.9 MB cell in 32 s when the
    ## partition was fresh and in 425 s once its dead pages needed collecting.
  StoredMaxAheadSeconds = 8.0 * 86400.0
    ## A stored due date further out than this is a clock that jumped.
  StoredChunkBytes = 32 * 1024
    ## Rows are written and read through a buffer this size.
  StoredFileMagic = "FOSR"
  StoredFileVersion = 2'u32
  StoredFileEnd = "FOSRDONE"
  PlausibleEpoch = 1_600_000_000.0
  HostKeptBudgetBytes = 96 * 1024 * 1024
  EmbeddedKeptSnapshotBytes = 1024 * 1024
    ## Same line the node cache draws (interpreter.nim): an embedded frame
    ## never pins more than this per image across renders.

type
  PaintRecord = object
    x, y, w, h: int32

  SceneNodeVisit* = object
    tracked*: bool      ## a pass is in flight and the node is being scheduled
    restored*: bool     ## pixels came from a cache tier: do not run the child
    tier*: string       ## which one, for the log
    imageBefore: Image
    startedAt: float
    stateKeyBefore: string

  PassState = ref object
    top: FrameScene
    tree: RhythmTree
    canvas: Image
    partial: bool
    allowReuse: bool
    now: float
    log: seq[PaintRecord]
    logBase: int
    overflowed: bool
    stack: seq[FrameScene]
    ran: seq[FrameScene]
    previous: seq[FrameScene]   ## full pass: the nodes that were active before it
    transient: seq[FrameScene]  ## nodes holding a snapshot this pass must free
    restoredNames: seq[string]
    ranNames: seq[string]

  RhythmPassInfo* = object
    partial*: bool
    reason*: string
    ran*: seq[string]       ## scene nodes that executed, "sceneId#nodeId"
    restored*: seq[string]  ## scene nodes served from cached pixels

var
  pass {.threadvar.}: PassState
  paintSeq {.threadvar.}: int
  passCounter {.threadvar.}: int
  lastPassInfo {.threadvar.}: RhythmPassInfo

var
  rhythmSlackSeconds* = (when defined(frameosEmbedded): 1.5 else: 0.02)
    ## A node due within this much of "now" counts as due. The ESP32's render
    ## task sleeps in whole seconds, so its wakes land up to a second early.
  rhythmSlackFraction* = (when defined(frameosEmbedded): 0.1 else: 0.0)
    ## On top of that, a node may run early by this share of its own interval
    ## (at most a minute) when a pass is happening anyway. A battery frame that
    ## wakes for its clock takes the photo due five seconds later along, instead
    ## of waking twice; a wall-clock-aligned wake schedule does not drift a
    ## ten-minute photo onto an eleven-minute cycle. Off on hosts, whose wakes
    ## cost nothing and land when asked.
  rhythmCanvasVolatile* = false
    ## The host says the canvas will not survive until the next pass (the ESP32
    ## is about to deep sleep). Turns the storage tier's writes on.
  rhythmStorageTier* = (when defined(frameosEmbedded): true else: false)
    ## Whether pixels may be read back from storage at all. Off on hosts: a Pi
    ## keeps its canvas and has memory for the rest.

var storedReadBytesPerSecond = 300_000.0
  ## What the last restore measured (SPIFFS on the E1004: ~300 KB/s). A
  ## rectangle is only worth storing when reading it back beats running the
  ## scene: for a small comic that is a wash, for a 30 s photo decode it is not.
var storedWriteBytesPerSecond = 60_000.0
  ## What the last store measured (SPIFFS on the E1004: ~60 KB/s; an SD card
  ## is faster). The first estimate is the slow case, so a frame never pays
  ## for a store the arithmetic below would have refused.

when defined(testing):
  var rhythmNowOverride* = -1.0
  var rhythmWallOverride* = -1.0
  var rhythmRunSecondsOverride* = -1.0 ## a frozen clock measures every run as 0

proc rhythmNow*(): float =
  ## Monotonic seconds. Due times never ride the wall clock: NTP moves it by
  ## decades on a frame's first sync.
  when defined(testing):
    if rhythmNowOverride >= 0: return rhythmNowOverride
  getMonoTime().ticks.float / 1_000_000_000.0

proc rhythmWallNow(): float =
  when defined(testing):
    if rhythmWallOverride >= 0: return rhythmWallOverride
  epochTime()

proc rhythmLastPassInfo*(): RhythmPassInfo = lastPassInfo

proc dueSlack(interval: float): float =
  if interval == Inf or interval <= 0: rhythmSlackSeconds
  else: max(rhythmSlackSeconds, min(interval * rhythmSlackFraction, 60.0))

proc isDue(r: SceneRhythm, now: float): bool =
  r.dueAt <= now + dueSlack(r.interval)

# ------------------------------------------------------------------ geometry

proc absoluteRect*(image: Image): tuple[x, y, w, h: int] =
  ## Where a view sits in its owner's buffer. Views flatten onto the owner
  ## (pixie/common.nim), so `origin` and `stride` say it outright.
  if image.isNil or image.stride <= 0:
    return (0, 0, 0, 0)
  (image.origin mod image.stride, image.origin div image.stride, image.width, image.height)

proc intersects(a: PaintRecord, x, y, w, h: int): bool =
  a.x.int < x + w and x < a.x.int + a.w.int and
    a.y.int < y + h and y < a.y.int + a.h.int

proc copyRows(dst, src: Image): bool =
  ## Raw row copy between two images of the same shape and format; either may
  ## be a view. Pixel-exact: no blending, no re-dither of a 565 store.
  if dst.isNil or src.isNil or dst.width != src.width or dst.height != src.height or
      dst.format != src.format:
    return false
  for y in 0 ..< src.height:
    if src.format == pfRgbx:
      copyMem(addr dst.data[dst.dataIndex(0, y)], addr src.data[src.dataIndex(0, y)], src.width * 4)
    else:
      copyMem(addr dst.data16[dst.dataIndex(0, y)], addr src.data16[src.dataIndex(0, y)], src.width * 2)
  true

proc nodeName(scene: FrameScene): string =
  if scene.rhythm.isNil: scene.id.string
  else: scene.id.string & "#" & $scene.rhythm.nodeId.int

# ---------------------------------------------------------------------- tree

proc isDescendantOf(node, ancestor: FrameScene): bool =
  var cursor = if node.rhythm.isNil: nil else: node.rhythm.parent
  var hops = 0
  while not cursor.isNil and hops < 64:
    if cursor == ancestor: return true
    cursor = if cursor.rhythm.isNil: nil else: cursor.rhythm.parent
    inc hops
  false

proc subtreeDueAt(tree: RhythmTree, node: FrameScene): float =
  ## When anything inside `node` next wants to run: the node's own due time or
  ## any active descendant's, whichever is sooner. Pixels cached for the node
  ## are only good until then.
  result = node.rhythm.dueAt
  for other in tree.nodes:
    if other.rhythm.active and other.isDescendantOf(node):
      result = min(result, other.rhythm.dueAt)

proc subtreeIsDue(nodes: seq[FrameScene], node: FrameScene, now: float): bool =
  if node.rhythm.isDue(now): return true
  for other in nodes:
    if other.rhythm.active and other.isDescendantOf(node) and other.rhythm.isDue(now):
      return true
  false

proc hasActiveDescendant(tree: RhythmTree, node: FrameScene): bool =
  for other in tree.nodes:
    if other.rhythm.active and other.isDescendantOf(node):
      return true
  false

proc ensureRhythm*(scene: FrameScene): SceneRhythm =
  if scene.rhythm.isNil:
    scene.rhythm = SceneRhythm(dueAt: 0)
  scene.rhythm

proc rhythmTree(top: FrameScene): RhythmTree =
  if top.isNil or top.rhythm.isNil: nil else: top.rhythm.tree

proc eligible(tree: RhythmTree, node: FrameScene): bool =
  ## May this node run alone, straight into the canvas? Only when its pixels
  ## are provably its own: it drew into a view of the canvas, nothing painted
  ## over it afterwards, and no ancestor is in the same trouble.
  let r = node.rhythm
  if not (r.active and r.interpreted and r.onCanvas and not r.overpainted and
      not r.shared and r.w > 0 and r.h > 0):
    return false
  var cursor = r.parent
  var hops = 0
  while not cursor.isNil and hops < 64:
    if cursor.rhythm.isNil or cursor.rhythm.overpainted or cursor.rhythm.shared or
        not cursor.rhythm.onCanvas:
      return false
    cursor = cursor.rhythm.parent
    inc hops
  true

# -------------------------------------------------------------- budget: memory

proc snapshotBytes(tree: RhythmTree, skip: FrameScene = nil): int =
  if tree.isNil: return 0
  for node in tree.nodes:
    if node != skip and not node.rhythm.snapshot.isNil:
      result += node.rhythm.snapshot.byteSize

proc memoryRefusal(bytes, held: int, kept: bool): string =
  ## "" when a snapshot of `bytes` is affordable right now, otherwise why not.
  ## `kept` snapshots live across passes and answer to the stricter budget.
  let headroom = availableRenderHeadroomBytes()
  let contiguous = availableRenderBytes()
  when defined(frameosEmbedded):
    const embedded = true
  else:
    let embedded = false
  if embedded or (when defined(testing): availableRenderBytesOverride > 0 else: false):
    if headroom <= 0:
      return "available render memory unknown"
    if contiguous > 0 and contiguous < bytes:
      return "largest free block " & $(contiguous div 1024) & "K cannot hold " & $(bytes div 1024) & "K"
    if kept:
      if bytes + held > EmbeddedKeptSnapshotBytes:
        return $((bytes + held) div 1024) & "K kept is over the " &
          $(EmbeddedKeptSnapshotBytes div 1024) & "K an embedded frame may pin"
      if headroom < 4 * bytes:
        return "headroom " & $(headroom div 1024) & "K is under 4x the " & $(bytes div 1024) & "K snapshot"
    elif headroom < 3 * (bytes + held):
      # The pass that follows still has to decode whatever IS due, next to
      # these copies; leave it two thirds of what is free.
      return "headroom " & $(headroom div 1024) & "K is under 3x the " &
        $((bytes + held) div 1024) & "K of snapshots"
    return ""
  # A host. Unknown headroom (macOS dev box) is not a refusal.
  if headroom > 0 and headroom < 4 * (bytes + held):
    return "headroom " & $(headroom div 1024) & "K is under 4x the " &
      $((bytes + held) div 1024) & "K of snapshots"
  if kept and bytes + held > HostKeptBudgetBytes:
    return $((bytes + held) div 1024) & "K kept is over the budget"
  ""

proc takeSnapshot(state: PassState, node: FrameScene, source: Image, kept: bool): bool =
  let r = node.rhythm
  let bytes = source.byteSize
  let refusal = memoryRefusal(bytes, snapshotBytes(state.tree, node), kept)
  if refusal.len > 0:
    if not node.logger.isNil:
      node.logger.log(%*{"event": "rhythm:snapshot:refused", "node": nodeName(node),
        "bytes": bytes, "kept": kept, "reason": refusal})
    return false
  try:
    r.snapshot = source.copy()
  except CatchableError:
    r.snapshot = nil
    return false
  r.snapshotSeq = paintSeq
  r.snapshotKey = r.stateKey
  true

# ------------------------------------------------------------- budget: storage

proc storeDir(frameConfig: FrameConfig): string =
  ## Where stored rectangles live: the assets directory — on an embedded
  ## frame the SD card, when one is mounted — and nowhere else. NOT the
  ## spool's scratch directory (swept on every boot, and surviving a
  ## deep-sleep reboot is the point), and NOT the ESP32's SPIFFS state
  ## partition: SPIFFS garbage-collects dead pages when it runs out of fresh
  ## ones, and rewriting a 1.9 MB cell there took 32 s on a fresh partition
  ## and 425–500 s once a few dead copies had piled up — the E1004 sat awake
  ## for eight minutes to save itself a sixteen-second fetch. Without an SD
  ## card the tier is a no-op: the child renders again, as it always did.
  if not frameConfig.isNil and frameConfig.assetsPath.len > 0:
    let preferred = frameConfig.assetsPath & "/.rhythm"
    if usableScratchDir(preferred):
      return preferred
  ""

proc cRename(a, b: cstring): cint {.importc: "rename", header: "<stdio.h>".}

proc fnv1a(parts: varargs[string]): string =
  var h = 14695981039346656037'u64
  for part in parts:
    for c in part:
      h = (h xor uint64(c)) * 1099511628211'u64
    h = (h xor 0xff'u64) * 1099511628211'u64
  toHex(h).toLowerAscii()

proc rhythmHash*(text: string): string = fnv1a(text)

proc storedPath(state: PassState, node: FrameScene): string =
  ## One file per (top scene, chain of embedded scenes, rectangle). The
  ## rectangle is in the name so two cells showing the same scene keep two
  ## files; what must MATCH for a read is checked in the header instead.
  let dir = storeDir(node.frameConfig)
  if dir.len == 0:
    return ""
  var chain = node.id.string
  var cursor = node.rhythm.parent
  var hops = 0
  while not cursor.isNil and hops < 64:
    chain = cursor.id.string & ">" & chain
    cursor = if cursor.rhythm.isNil: nil else: cursor.rhythm.parent
    inc hops
  let r = node.rhythm
  dir & "/" & fnv1a(state.top.id.string, chain, $r.x, $r.y, $r.w, $r.h) & ".px"

proc fixed16(text: string): array[16, char] =
  for i in 0 ..< 16:
    result[i] = if i < text.len: text[i] else: '\0'

proc writeStored(state: PassState, node: FrameScene, dueWall: float): bool =
  let r = node.rhythm
  let startedAt = rhythmNow()
  let path = storedPath(state, node)
  if path.len == 0:
    return false
  let bytesPerPixel = if state.canvas.format == pfRgbx: 4 else: 2
  let bytes = r.w * r.h * bytesPerPixel
  let shortfall = spoolHeadroomShortfall(path.parentDir, bytes)
  if shortfall.len > 0:
    node.logger.log(%*{"event": "rhythm:store:refused", "node": nodeName(node), "reason": shortfall})
    return false
  var view: Image
  try:
    view = state.canvas.view(r.x, r.y, r.w, r.h)
  except CatchableError:
    return false
  # Written beside the old file and renamed over it: a power cut mid-write
  # leaves the previous good rectangle, not half of a new one.
  let tmpPath = path & ".tmp"
  var file: File
  if not file.open(tmpPath, fmWrite):
    return false
  var ok = true
  try:
    var magic = StoredFileMagic
    var version = StoredFileVersion
    var dims = [r.w.uint32, r.h.uint32, (if view.format == pfRgbx: 0'u32 else: 1'u32)]
    # The rate is in the header so the wake that reads this back knows how
    # slow this flash was before it decides on its own write.
    var due = [dueWall, r.interval, storedWriteBytesPerSecond]
    var defHash = fixed16(r.defHash)
    # The state the pixels were rendered FROM, not the state the run left
    # behind: a scene that writes its own state while rendering (setAsState)
    # starts every wake from its seed again, and that is what must match.
    var stateKey = fixed16(r.seedKey)
    ok = file.writeBuffer(addr magic[0], 4) == 4 and
      file.writeBuffer(addr version, 4) == 4 and
      file.writeBuffer(addr dims[0], 12) == 12 and
      file.writeBuffer(addr due[0], 24) == 24 and
      file.writeBuffer(addr defHash[0], 16) == 16 and
      file.writeBuffer(addr stateKey[0], 16) == 16
    # Rows go out through one chunk buffer: SPIFFS costs per write call as
    # much as per byte, and a 1200-byte row at a time was 42 KB/s on the
    # E1004 (46 s for a half-canvas cell).
    let rowBytes = r.w * bytesPerPixel
    var chunk = newString(StoredChunkBytes)
    var filled = 0
    for y in 0 ..< r.h:
      if not ok: break
      let row =
        if view.format == pfRgbx: cast[pointer](addr view.data[view.dataIndex(0, y)])
        else: cast[pointer](addr view.data16[view.dataIndex(0, y)])
      if filled + rowBytes > chunk.len:
        ok = file.writeBuffer(addr chunk[0], filled) == filled
        filled = 0
      copyMem(addr chunk[filled], row, rowBytes)
      filled += rowBytes
    if ok and filled > 0:
      ok = file.writeBuffer(addr chunk[0], filled) == filled
    if ok:
      var tail = StoredFileEnd
      ok = file.writeBuffer(addr tail[0], 8) == 8
  except CatchableError:
    ok = false
  file.close()
  if ok:
    # C rename, not os.moveFile: its copy fallback drags symlink support into
    # a firmware with no symlinks.
    ok = cRename(tmpPath.cstring, path.cstring) == 0
  if not ok:
    try: removeFile(tmpPath)
    except CatchableError: discard
    return false
  let seconds = rhythmNow() - startedAt
  if seconds > 0.05:
    storedWriteBytesPerSecond = bytes.float / seconds
  node.logger.log(%*{"event": "rhythm:store", "node": nodeName(node), "bytes": bytes,
    "validSeconds": round(dueWall - rhythmWallNow()), "ms": round(seconds * 1000)})
  true

const StoredHeaderBytes = 4 + 4 + 12 + 24 + 16 + 16

proc readStored(state: PassState, node: FrameScene, target: Image, stateKey: string): float =
  ## Reads the node's stored rectangle straight into `target` (a view of the
  ## canvas: no intermediate buffer). Returns the seconds the pixels are still
  ## good for, or -1 for any reason at all not to trust them. A read that fails
  ## halfway leaves junk in the view — and the caller then runs the child,
  ## whose first act is to fill that same rectangle.
  result = -1
  let r = node.rhythm
  let path = storedPath(state, node)
  if path.len == 0 or not fileExists(path):
    return
  let wallNow = rhythmWallNow()
  if wallNow < PlausibleEpoch:
    return # no clock yet: "is it due" has no answer
  let bytesPerPixel = if target.format == pfRgbx: 4 else: 2
  let expected = StoredHeaderBytes + target.width * target.height * bytesPerPixel + 8
  try:
    if getFileSize(path) != expected:
      return
  except CatchableError:
    return
  var file: File
  if not file.open(path):
    return
  defer: file.close()
  var magic = newString(4)
  var version: uint32
  var dims: array[3, uint32]
  var due: array[3, float]
  var defHash, storedKey: array[16, char]
  if file.readBuffer(addr magic[0], 4) != 4 or magic != StoredFileMagic or
      file.readBuffer(addr version, 4) != 4 or version != StoredFileVersion or
      file.readBuffer(addr dims[0], 12) != 12 or
      file.readBuffer(addr due[0], 24) != 24 or
      file.readBuffer(addr defHash[0], 16) != 16 or
      file.readBuffer(addr storedKey[0], 16) != 16:
    return
  if dims[0].int != target.width or dims[1].int != target.height or
      dims[2] != (if target.format == pfRgbx: 0'u32 else: 1'u32):
    return
  if defHash != fixed16(r.defHash) or storedKey != fixed16(stateKey):
    return
  let remaining = due[0] - wallNow
  if remaining <= dueSlack(due[1]) or remaining > StoredMaxAheadSeconds:
    return
  r.interval = due[1]
  if due[2] > 0: storedWriteBytesPerSecond = due[2]
  let rowBytes = target.width * bytesPerPixel
  var chunk = newString(StoredChunkBytes)
  var have = 0
  var used = 0
  for y in 0 ..< target.height:
    if used + rowBytes > have:
      # Keep the partial row's bytes, top the chunk up from the file.
      let rest = have - used
      if rest > 0: moveMem(addr chunk[0], addr chunk[used], rest)
      let got = file.readBuffer(addr chunk[rest], chunk.len - rest)
      have = rest + got
      used = 0
      if have < rowBytes:
        return
    let row =
      if target.format == pfRgbx: cast[pointer](addr target.data[target.dataIndex(0, y)])
      else: cast[pointer](addr target.data16[target.dataIndex(0, y)])
    copyMem(row, addr chunk[used], rowBytes)
    used += rowBytes
  # The end marker: whatever of it the last chunk already holds, the rest
  # from the file.
  var tail = newString(8)
  let rest = min(have - used, 8)
  if rest > 0: copyMem(addr tail[0], addr chunk[used], rest)
  if rest < 8 and file.readBuffer(addr tail[rest], 8 - rest) != 8 - rest:
    return
  if tail != StoredFileEnd:
    return
  result = remaining

proc sweepStored(state: PassState, keep: seq[string]) =
  ## Drops stored rectangles nothing in the current picture owns any more (a
  ## scene that changed shape, a cell that went away).
  let dir = storeDir(state.top.frameConfig)
  if dir.len == 0:
    return
  try:
    for kind, path in walkDir(dir):
      if kind == pcFile and (path.endsWith(".px") or path.endsWith(".px.tmp")) and path notin keep:
        try: removeFile(path)
        except CatchableError: discard
  except CatchableError:
    discard

proc storeWorthwhile(state: PassState): seq[FrameScene] =
  ## Which of the nodes that RAN this pass are worth their flash wear and the
  ## time the write takes: provably their own pixels, a long time left, still
  ## not due at the next wake — and expected to save more than the write costs.
  ## The saving is the node's own last run time (a photo: fetch + decode) per
  ## wake it will sit out; the cost is its bytes at the rate the last write
  ## measured. A node whose ancestor is stored and good for just as long adds
  ## nothing.
  let tree = state.tree
  var nextWake = tree.topDueAt
  var cadence = Inf
  for node in tree.nodes:
    if node.rhythm.active:
      nextWake = min(nextWake, node.rhythm.dueAt)
      if node.rhythm.interval > 0: cadence = min(cadence, node.rhythm.interval)
  if tree.topInterval > 0 and tree.topDueAt != Inf: cadence = min(cadence, tree.topInterval)
  for node in tree.nodes:
    if not eligible(tree, node) or nodeName(node) in state.restoredNames: continue
    let r = node.rhythm
    let due = subtreeDueAt(tree, node)
    if due == Inf or due - state.now < StoredMinSeconds or due - nextWake < StoredMinGainSeconds:
      continue
    let bytes = r.w * r.h * (if state.canvas.format == pfRgbx: 4 else: 2)
    let writeSeconds = bytes.float / max(storedWriteBytesPerSecond, 1.0)
    let readSeconds = bytes.float / max(storedReadBytesPerSecond, 1.0)
    let reuses = if cadence == Inf: 1.0 else: max(1.0, floor((due - state.now) / max(cadence, 1.0)))
    if r.runSeconds < readSeconds * StoredWriteMarginFactor:
      node.logger.log(%*{"event": "rhythm:store:refused", "node": nodeName(node),
        "reason": "reading it back (" & $round(readSeconds) & " s) is not faster than running it (" &
          $round(r.runSeconds) & " s)"})
      continue
    if writeSeconds > StoredMaxWriteSeconds:
      node.logger.log(%*{"event": "rhythm:store:refused", "node": nodeName(node),
        "reason": "a " & $round(writeSeconds) & " s write at " &
          $(storedWriteBytesPerSecond / 1024).int & " KB/s is over the " &
          $StoredMaxWriteSeconds.int & " s ceiling"})
      continue
    let saving = (r.runSeconds - readSeconds) * reuses
    if saving < writeSeconds * StoredWriteMarginFactor or saving < StoredMinSavingSeconds:
      node.logger.log(%*{"event": "rhythm:store:refused", "node": nodeName(node),
        "reason": "a " & $round(writeSeconds) & " s write to save " & $round(saving) &
          " s over " & $reuses.int & " wake(s); rendering it again is cheaper"})
      continue
    var covered = false
    for other in result:
      if node.isDescendantOf(other) and subtreeDueAt(tree, other) >= due - 1.0:
        covered = true
    if not covered:
      result.add(node)

# --------------------------------------------------------------- the paint log

proc notePaintRect(state: PassState, x, y, w, h: int) =
  inc paintSeq
  if state.log.len >= PaintLogCap:
    state.overflowed = true
    return
  state.log.add(PaintRecord(x: x.int32, y: y.int32, w: w.int32, h: h.int32))

proc rhythmNotePaint*(image: Image) =
  ## Called for every executed render node. A node handed the whole canvas is
  ## assumed to touch all of it; one handed an image that is not the canvas
  ## (data/newImage's own buffer) cannot touch the canvas at all.
  if pass.isNil or image.isNil:
    return
  if image.bufferPointer != pass.canvas.bufferPointer:
    return
  let rect = absoluteRect(image)
  pass.notePaintRect(rect.x, rect.y, rect.w, rect.h)

proc analyzeOverpaint(state: PassState, fromSeq, toSeq: int, skip: FrameScene) =
  ## For every node that ran with its sequence interval inside
  ## [fromSeq, toSeq): overpainted iff a record after the node's own interval
  ## (so: not painted by the node or anything inside it) intersects its rect.
  for node in state.ran:
    let r = node.rhythm
    if node == skip or r.seqBegin < fromSeq or r.seqEnd > toSeq:
      continue
    if state.overflowed:
      r.overpainted = true
      continue
    r.overpainted = false
    if not r.onCanvas:
      continue
    for seq in r.seqEnd ..< toSeq:
      let index = seq - state.logBase
      if index >= 0 and index < state.log.len and state.log[index].intersects(r.x, r.y, r.w, r.h):
        r.overpainted = true
        break

# ------------------------------------------------------------------- the pass

proc rhythmPassActive*(): bool = not pass.isNil

proc captureBeforeWipe(state: PassState, scope: FrameScene) =
  ## Memory tier, transient. `scope` (nil: the whole canvas) is about to be
  ## wiped by a fill. Copy out the rectangles inside it that are not due and
  ## provably their own, outermost first; the run copies them back when it
  ## reaches them, and the end of the pass frees them.
  let tree = state.tree
  var took = false
  for node in tree.nodes:
    let r = node.rhythm
    if not r.active or not r.snapshot.isNil or r.w <= 0 or r.h <= 0:
      continue
    if not scope.isNil and not node.isDescendantOf(scope):
      continue
    if not eligible(tree, node):
      continue
    if subtreeIsDue(tree.nodes, node, state.now):
      continue
    var covered = false
    for other in state.transient:
      if node.isDescendantOf(other): covered = true
    if covered:
      continue
    try:
      if takeSnapshot(state, node, state.canvas.view(r.x, r.y, r.w, r.h), kept = false):
        state.transient.add(node)
        took = true
    except CatchableError:
      discard
  if took:
    # The decoders budget themselves from what is free; ask again now that
    # some of it is spoken for.
    refreshDecodeBudget()

proc rhythmBeginPass*(top: FrameScene, canvas: Image, partial, allowReuse: bool, reason: string) =
  let topRhythm = ensureRhythm(top)
  if topRhythm.tree.isNil:
    topRhythm.tree = RhythmTree()
  let tree = topRhythm.tree
  let sameCanvas = tree.valid and tree.canvasBuffer == canvas.bufferPointer and
    tree.canvasWidth == canvas.width and tree.canvasHeight == canvas.height and
    tree.canvasFormat == canvas.format
  inc passCounter
  pass = PassState(top: top, tree: tree, canvas: canvas, partial: partial,
    allowReuse: allowReuse, now: rhythmNow(), logBase: paintSeq + 1)
  lastPassInfo = RhythmPassInfo(partial: partial, reason: reason)
  if partial:
    return
  if allowReuse and sameCanvas:
    captureBeforeWipe(pass, nil)
  # A full pass rebuilds the list: only what it reaches is part of the picture.
  pass.previous = tree.nodes
  tree.nodes = @[]
  for node in pass.previous:
    node.rhythm.active = false
    if not allowReuse:
      node.rhythm.snapshot = nil

proc rhythmBeginDirectRun*(node: FrameScene) =
  ## A partial pass is about to run `node` alone. Its fill wipes whatever is
  ## embedded inside it, so the same rescue applies one level down.
  if pass.isNil: return
  captureBeforeWipe(pass, node)
  for other in pass.tree.nodes:
    if other.isDescendantOf(node) and other notin pass.previous:
      pass.previous.add(other)

proc rhythmEndPass*(finalImage: Image, topNextSleep: float, topInterval: float,
    topFollowsChildren: bool, startedAt: float) =
  if pass.isNil:
    return
  let state = pass
  let tree = state.tree
  pass = nil
  try:
    if not state.partial:
      state.analyzeOverpaint(state.logBase, paintSeq + 1, nil)
      tree.canvasBuffer = state.canvas.bufferPointer
      tree.canvasWidth = state.canvas.width
      tree.canvasHeight = state.canvas.height
      tree.canvasFormat = state.canvas.format
      # The top scene swapped its image for one of its own: nothing reached the
      # canvas through the recorded rectangles. Full passes from here on.
      tree.valid = not finalImage.isNil and
        finalImage.bufferPointer == state.canvas.bufferPointer and
        finalImage.width == state.canvas.width and finalImage.height == state.canvas.height
      let finished = rhythmNow()
      tree.topInterval = if topNextSleep >= 0: topNextSleep else: topInterval
      tree.topDueAt =
        if topNextSleep >= 0: finished + topNextSleep
        elif topFollowsChildren and tree.nodes.len > 0: Inf
        else: startedAt + topInterval
    # Snapshots: transient ones go; kept ones stay only where the canvas
    # cannot serve (overpainted, or never on it).
    for node in state.transient:
      node.rhythm.snapshot = nil
    for node in tree.nodes:
      let r = node.rhythm
      if not r.snapshot.isNil and r.onCanvas and not r.overpainted and tree.valid and
          eligible(tree, node):
        r.snapshot = nil
    for node in state.previous:
      if not node.rhythm.active:
        node.rhythm.snapshot = nil
    # Storage tier: only when the canvas will not be there next time.
    if rhythmStorageTier and not state.partial and storeDir(state.top.frameConfig).len > 0:
      var keep: seq[string] = @[]
      if rhythmCanvasVolatile and tree.valid and rhythmWallNow() > PlausibleEpoch:
        # What came off storage this pass is still good: its write is paid for.
        for node in tree.nodes:
          if node.rhythm.active and nodeName(node) in state.restoredNames:
            let path = storedPath(state, node)
            if path.len > 0 and fileExists(path): keep.add(path)
        for node in storeWorthwhile(state):
          if writeStored(state, node, rhythmWallNow() + (subtreeDueAt(tree, node) - rhythmNow())):
            keep.add(storedPath(state, node))
      sweepStored(state, keep)
  finally:
    lastPassInfo.ran = state.ranNames
    lastPassInfo.restored = state.restoredNames

# ------------------------------------------------------------- scene-node hooks

proc rhythmBeginSceneNode*(child, owner: FrameScene, nodeId: NodeId,
    context: ExecutionContext, stateKey: string, direct = false): SceneNodeVisit =
  ## Entering a scene node on a render. Records where the child is about to
  ## draw, and decides whether it needs to run at all: a child that is not due,
  ## whose state has not changed, and whose pixels a tier still holds is
  ## painted from those pixels instead.
  let r = ensureRhythm(child)
  r.isNode = true
  result.startedAt = rhythmNow()
  result.stateKeyBefore = stateKey
  if pass.isNil or context.image.isNil:
    return
  let state = pass
  let tree = state.tree
  result.tracked = true
  result.imageBefore = context.image
  let rect = absoluteRect(context.image)
  let onCanvas = context.image.bufferPointer == state.canvas.bufferPointer
  let sameRect = r.ranOnce and r.x == rect.x and r.y == rect.y and r.w == rect.w and
    r.h == rect.h and r.onCanvas == onCanvas
  let wasKnown = r.ranOnce
  # The same instance twice in one pass — a split whose cells all use its
  # default renderer. Each cell must run; one rectangle cannot stand for them.
  if r.visitPass == passCounter:
    r.shared = true
  r.visitPass = passCounter
  r.parent = if state.stack.len > 0: state.stack[^1] else: nil
  r.owner = owner
  r.nodeId = nodeId
  r.ctxScene = context.scene
  r.loopIndex = context.loopIndex
  r.loopKey = context.loopKey
  r.x = rect.x; r.y = rect.y; r.w = rect.w; r.h = rect.h
  r.onCanvas = onCanvas

  # ---- reuse? ----
  if state.allowReuse and not direct and not r.shared and r.w > 0 and r.h > 0:
    var descendants: seq[FrameScene] = @[]
    for other in state.previous:
      if other.isDescendantOf(child): descendants.add(other)
    if wasKnown and sameRect and not r.snapshot.isNil and r.snapshotKey == stateKey:
      var due = r.isDue(state.now)
      var current = true
      for other in descendants:
        if other.rhythm.isDue(state.now): due = true
        # A descendant that ran on its own after a kept snapshot was taken is
        # newer than the snapshot: those pixels would bring its old self back.
        if other.rhythm.seqEnd > r.snapshotSeq: current = false
      if current and not due and copyRows(context.image, r.snapshot):
        result.restored = true
        result.tier = "memory"
    if not result.restored and not wasKnown and rhythmStorageTier and onCanvas:
      let remaining = readStored(state, child, context.image, stateKey)
      if remaining > 0:
        r.dueAt = state.now + remaining
        r.interpreted = true
        r.stateKey = stateKey
        r.seedKey = stateKey
        result.restored = true
        result.tier = "storage"
        let seconds = rhythmNow() - result.startedAt
        if seconds > 0.05:
          storedReadBytesPerSecond = (r.w * r.h * context.image.bytesPerPixel).float / seconds
        child.logger.log(%*{"event": "rhythm:restore", "node": nodeName(child), "tier": "storage",
          "validSeconds": round(remaining), "ms": round(seconds * 1000)})
    if result.restored:
      r.seqBegin = paintSeq + 1
      state.notePaintRect(rect.x, rect.y, rect.w, rect.h)
      r.seqEnd = paintSeq + 1
      r.ranOnce = true
      r.active = true
      if child notin tree.nodes: tree.nodes.add(child)
      state.ran.add(child)
      state.restoredNames.add(nodeName(child))
      # What is inside it is still there too, exactly where it was.
      for other in descendants:
        other.rhythm.active = true
        if other notin tree.nodes: tree.nodes.add(other)
      return

  # ---- it runs ----
  # Whatever was inside it is about to be wiped by its fill; descendants are
  # part of the picture again only if this run reaches them.
  var kept: seq[FrameScene] = @[]
  for other in tree.nodes:
    if other.isDescendantOf(child):
      other.rhythm.active = false
    else:
      kept.add(other)
  tree.nodes = kept
  if child notin tree.nodes: tree.nodes.add(child)
  r.active = true
  r.seqBegin = paintSeq + 1
  # The child's first act is an opaque fill of its whole image.
  # (Off the canvas it touches nothing: an empty record keeps the numbering.)
  if onCanvas:
    state.notePaintRect(rect.x, rect.y, rect.w, rect.h)
  else:
    state.notePaintRect(0, 0, 0, 0)
  state.stack.add(child)
  state.ran.add(child)
  state.ranNames.add(nodeName(child))

proc rhythmEndSceneNode*(child: FrameScene, context: ExecutionContext, visit: SceneNodeVisit,
    nextSleep: float, followsChildren, interpreted: bool, stateKey: string) =
  let r = child.rhythm
  if r.isNil:
    return
  let finished = rhythmNow()
  let interval = if child.refreshInterval > 0: child.refreshInterval else: 0.0
  r.runSeconds = finished - visit.startedAt
  when defined(testing):
    if rhythmRunSecondsOverride >= 0: r.runSeconds = rhythmRunSecondsOverride
  r.interval = if nextSleep >= 0: nextSleep else: interval
  r.dueAt = if nextSleep >= 0: finished + nextSleep else: visit.startedAt + interval
  # The seed is the state this INSTANCE started life with: a scene that
  # writes its own state while rendering carries that state into its next
  # run, but a fresh instance (every deep-sleep wake) starts from the seed
  # again — and that is what a stored rectangle has to be matched against.
  if not r.ranOnce:
    r.seedKey = visit.stateKeyBefore
  r.ranOnce = true
  r.interpreted = interpreted
  r.stateKey = stateKey
  if not visit.tracked or pass.isNil:
    return
  let state = pass
  if state.stack.len > 0 and state.stack[^1] == child:
    state.stack.setLen(state.stack.len - 1)
  r.seqEnd = paintSeq + 1
  if context.image != visit.imageBefore:
    # It swapped the context image for one of its own: whatever reached the
    # canvas did not get there through this rectangle.
    r.onCanvas = false
  if followsChildren and nextSleep < 0 and hasActiveDescendant(state.tree, child):
    r.dueAt = Inf
  # Memory tier, kept. A host takes one for every node and lets the end of the
  # pass drop those the canvas can serve; an embedded frame only for a node
  # already known to need it.
  r.snapshot = nil
  when defined(frameosEmbedded):
    let wanted = r.overpainted or not r.onCanvas
  else:
    let wanted = true
  if wanted and interpreted and context.image == visit.imageBefore and
      subtreeDueAt(state.tree, child) - finished >= KeptSnapshotMinSeconds:
    discard takeSnapshot(state, child, context.image, kept = true)

# ------------------------------------------------------------------ scheduling

proc rhythmDueNodes*(top: FrameScene, now: float): seq[FrameScene] =
  let tree = rhythmTree(top)
  if tree.isNil: return
  for node in tree.nodes:
    if node.rhythm.active and node.rhythm.isDue(now):
      result.add(node)

proc rhythmPlan*(top: FrameScene, canvas: Image, force: RhythmForce):
    tuple[partial: bool, nodes: seq[FrameScene], reason: string] =
  ## Full pass or partial, and why — the why goes in the render log.
  let tree = rhythmTree(top)
  if force == rfFresh: return (false, @[], "requested")
  if tree.isNil: return (false, @[], (if force == rfRedraw: "redraw" else: "first render"))
  if not tree.valid: return (false, @[], "no persistent canvas")
  if tree.canvasBuffer != canvas.bufferPointer or tree.canvasWidth != canvas.width or
      tree.canvasHeight != canvas.height or tree.canvasFormat != canvas.format:
    return (false, @[], "canvas changed")
  let now = rhythmNow()
  if tree.topDueAt <= now + dueSlack(tree.topInterval):
    return (false, @[], "scene due")
  let due = rhythmDueNodes(top, now)
  if due.len == 0:
    # A redraw with a good canvas and nothing due: the scene's picture is
    # already there. An overlay changed, not the scene — run nothing.
    if force == rfRedraw: return (true, @[], "canvas kept")
    return (false, @[], "nothing due")
  for node in due:
    if not eligible(tree, node):
      return (false, @[], nodeName(node) & " is due and cannot render alone")
  # Outermost only: a due node inside a due node runs as part of it.
  var outer: seq[FrameScene] = @[]
  for node in due:
    var inside = false
    for other in due:
      if node != other and node.isDescendantOf(other): inside = true
    if not inside: outer.add(node)
  (true, outer, "nodes due")

proc rhythmAnalyzeDirectRun*(node: FrameScene) =
  ## After a partial pass ran `node` directly: what is inside it may have
  ## painted over each other differently this time.
  if pass.isNil: return
  pass.analyzeOverpaint(node.rhythm.seqBegin, node.rhythm.seqEnd, node)

proc rhythmNextWakeSeconds*(top: FrameScene): float =
  ## Seconds until anything wants to render; -1 when this scene has never been
  ## through a rhythm pass (a compiled scene: the host's own interval applies).
  let tree = rhythmTree(top)
  if tree.isNil or tree.canvasBuffer.isNil:
    return -1
  var due = tree.topDueAt
  for node in tree.nodes:
    if node.rhythm.active:
      due = min(due, node.rhythm.dueAt)
  if due == Inf:
    return (if top.refreshInterval > 0: top.refreshInterval else: 300.0)
  max(0.0, due - rhythmNow())

proc rhythmAnythingDue*(top: FrameScene): bool =
  ## False before the first pass too: there is nothing to be due yet.
  let tree = rhythmTree(top)
  if tree.isNil or tree.canvasBuffer.isNil: return false
  let now = rhythmNow()
  tree.topDueAt <= now + dueSlack(tree.topInterval) or rhythmDueNodes(top, now).len > 0

proc rhythmPullEarliestDue*(top: FrameScene) =
  ## A timed wake that landed before anything was due (the host sleeps in
  ## whole seconds, or aligns its wakes to the wall clock) is still a wake for
  ## whatever is due next: make that due now, rather than rendering everything.
  let tree = rhythmTree(top)
  if tree.isNil or tree.canvasBuffer.isNil: return
  var earliest = tree.topDueAt
  for node in tree.nodes:
    if node.rhythm.active: earliest = min(earliest, node.rhythm.dueAt)
  if earliest == Inf: return
  if tree.topDueAt <= earliest + dueSlack(tree.topInterval): tree.topDueAt = 0
  for node in tree.nodes:
    if node.rhythm.active and node.rhythm.dueAt <= earliest + dueSlack(node.rhythm.interval):
      node.rhythm.dueAt = 0

proc rhythmNextWakeCadence*(top: FrameScene): float =
  ## The interval of whatever is due next; -1 when there is nothing to go by.
  let tree = rhythmTree(top)
  if tree.isNil or tree.canvasBuffer.isNil: return -1
  var due = tree.topDueAt
  result = if due == Inf: -1.0 else: tree.topInterval
  for node in tree.nodes:
    if node.rhythm.active and node.rhythm.dueAt < due:
      due = node.rhythm.dueAt
      result = node.rhythm.interval
  if due == Inf or result <= 0: result = -1

proc rhythmMarkDue*(scene: FrameScene) =
  ## This scene wants to render again now: a `render` dispatched from inside
  ## it, or state set on it. For an embedded scene that is a partial pass.
  if scene.isNil or scene.rhythm.isNil: return
  scene.rhythm.dueAt = 0
  if not scene.rhythm.tree.isNil:
    scene.rhythm.tree.topDueAt = 0

proc rhythmIsNode*(scene: FrameScene): bool =
  not scene.isNil and not scene.rhythm.isNil and scene.rhythm.isNode

proc rhythmInvalidate*(top: FrameScene) =
  ## Something other than a rhythm pass drew on the canvas (an error frame, the
  ## status screen): nothing on it can be trusted as any node's pixels.
  let tree = rhythmTree(top)
  if tree.isNil: return
  tree.valid = false
  for node in tree.nodes:
    node.rhythm.snapshot = nil

proc rhythmRelease*(scene: FrameScene) =
  ## Break the references a torn-down scene holds (parent/owner links, pixels).
  if scene.isNil or scene.rhythm.isNil: return
  if not scene.rhythm.tree.isNil:
    for node in scene.rhythm.tree.nodes:
      if not node.rhythm.isNil:
        node.rhythm.snapshot = nil
        node.rhythm.parent = nil
        node.rhythm.owner = nil
        node.rhythm.ctxScene = nil
    scene.rhythm.tree.nodes = @[]
  scene.rhythm = nil
