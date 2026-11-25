## Display planes in memory for tests (video/planes.nim setPlaneSinkForTest):
## what a video's reader would have put on the glass, and when.

import std/locks
import ../player

type Shown* = object
  plane*: int
  buffer*: uint32
  rect*: PlaneRect
  at*: float

var
  sinkLock: Lock
  shown: array[4096, Shown]
  shownCount: int
  hides: int
  nextId: uint32
  pitchPad*: int  ## the buffers' rows this much longer than the frame's
  refuse: bool    ## the display says no
  imports, importedFrees: int
initLock(sinkLock)

proc sinkNew(width, height: int, buffer: var PlaneBuffer): bool {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    let pitch = width + pitchPad
    let (size, u, v, _) = yuv420Layout(width, height, pitch)
    var id: uint32
    withLock sinkLock:
      inc nextId
      id = nextId
    buffer = PlaneBuffer(id: id, handle: id, map: cast[ptr UncheckedArray[byte]](allocShared0(size)), size: size,
      width: width, height: height, pitch: pitch, uOffset: u, vOffset: v)
  true

proc sinkFree(buffer: PlaneBuffer) {.nimcall, gcsafe, raises: [].} =
  if not buffer.map.isNil:
    deallocShared(buffer.map)

proc sinkImport(dmabuf: cint, layout: ImportLayout, buffer: var PlaneBuffer): bool {.nimcall, gcsafe,
    raises: [].} =
  ## A decoder's frame: an id, no memory of its own.
  {.cast(gcsafe).}:
    withLock sinkLock:
      inc nextId
      inc imports
      buffer = PlaneBuffer(id: nextId, handle: nextId, width: layout.width, height: layout.height,
        pitch: layout.pitches[0], uOffset: layout.offsets[1], interleaved: true, imported: true, dmabuf: dmabuf)
  true

proc sinkFreeImported(buffer: PlaneBuffer) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    withLock sinkLock:
      inc importedFrees

proc sinkShow(plane: int, buffer: uint32, rect: PlaneRect): bool {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    withLock sinkLock:
      if refuse:
        return false
      if shownCount < shown.len:
        shown[shownCount] = Shown(plane: plane, buffer: buffer, rect: rect, at: nowSeconds())
        inc shownCount
  true

proc sinkHide(plane: int) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    withLock sinkLock:
      inc hides

proc useSink*(refusing = false) =
  ## Planes in memory from now on, nothing shown yet.
  withLock sinkLock:
    shownCount = 0
    hides = 0
    imports = 0
    importedFrees = 0
    refuse = refusing
  setPlaneSinkForTest(PlaneSink(newBuffer: sinkNew, freeBuffer: sinkFree, show: sinkShow, hide: sinkHide,
    importBuffer: sinkImport, freeImported: sinkFreeImported))
  doAssert planesReady(720, 720)

proc noSink*() =
  setPlaneSinkForTest(PlaneSink())

proc showsSoFar*(): int =
  withLock sinkLock:
    result = shownCount

proc hidesSoFar*(): int =
  withLock sinkLock:
    result = hides

proc shownAt*(i: int): Shown =
  ## The `i`th frame shown, from the last when negative.
  withLock sinkLock:
    let at = if i < 0: shownCount + i else: i
    if at >= 0 and at < shownCount:
      result = shown[at]

proc importsSoFar*(): tuple[made, freed: int] =
  withLock sinkLock:
    result = (imports, importedFrees)
