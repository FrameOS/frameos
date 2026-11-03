## Canvases a JS app draws into (`frameos.canvas`, docs/jsx-ui.md
## "Canvases"): pictures whose pixels change in place. A frame that shows one
## repaints what was drawn into it since the frame its buffer holds
## (utils/svg_frames.nim), not the whole picture, and pixie cannot see the
## change: the element is the same, and so is its picture.

import pixie

const CanvasLogLength* = 48
  ## The draws a canvas remembers. A buffer whose frame is older than that
  ## repaints the canvas whole.

type CanvasLog* = ref object
  image*: Image
  version*: int ## draws so far
  draws: seq[tuple[version: int, box: Rect]] ## newest last

var logs {.threadvar.}: seq[CanvasLog]

proc canvasLogOf*(image: Image): CanvasLog =
  ## The log of the canvas that is `image`, nil for any other picture.
  if image.isNil:
    return nil
  for log in logs:
    if log.image == image:
      return log

proc registerCanvas*(image: Image): CanvasLog =
  result = canvasLogOf(image)
  if result.isNil:
    result = CanvasLog(image: image)
    logs.add result

proc unregisterCanvas*(image: Image) =
  for i in countdown(logs.high, 0):
    if logs[i].image == image:
      logs.delete(i)

proc drew*(log: CanvasLog, box: Rect) =
  ## Something was drawn in `box` (the canvas's pixels): a new version.
  inc log.version
  log.draws.add((log.version, box))
  if log.draws.len > CanvasLogLength:
    log.draws.delete(0)

const MaxChangedBoxes = 4
  ## Boxes changedSince hands back at most: the two whose join adds the least
  ## are joined past that.

proc join(a, b: Rect): Rect =
  let
    x = min(a.x, b.x)
    y = min(a.y, b.y)
  rect(x, y, max(a.x + a.w, b.x + b.w) - x, max(a.y + a.h, b.y + b.h) - y)

proc changedSince*(log: CanvasLog, version: int): tuple[known: bool, boxes: seq[Rect]] =
  ## The boxes drawn into after `version` (a stroke's segments, each its own
  ## box rather than one around them all): none when nothing was, unknown
  ## when the log no longer reaches back that far.
  if version >= log.version:
    return (true, @[])
  if log.draws.len == 0 or log.draws[0].version > version + 1:
    return (false, @[])
  result.known = true
  for draw in log.draws:
    if draw.version > version and draw.box.w > 0 and draw.box.h > 0:
      result.boxes.add draw.box
  # Boxes that cost no more as one are one: an animation notes nearly the same
  # box every frame, and an LCD's buffer is three frames behind, so apart they
  # repainted the same pixels three times over. A stroke's segments, which
  # hardly meet, stay apart.
  var i = 0
  while i < result.boxes.len:
    var joinedAny = false
    var j = i + 1
    while j < result.boxes.len:
      let
        a = result.boxes[i]
        b = result.boxes[j]
        joined = join(a, b)
      if joined.w * joined.h <= a.w * a.h + b.w * b.h:
        result.boxes[i] = joined
        result.boxes.delete(j)
        joinedAny = true
      else:
        inc j
    if joinedAny:
      i = 0
    else:
      inc i
  while result.boxes.len > MaxChangedBoxes:
    var
      best = float32.high
      bi, bj = 0
    for i in 0 ..< result.boxes.len:
      for j in i + 1 ..< result.boxes.len:
        let
          joined = join(result.boxes[i], result.boxes[j])
          added = joined.w * joined.h - result.boxes[i].w * result.boxes[i].h -
            result.boxes[j].w * result.boxes[j].h
        if added < best:
          best = added
          bi = i
          bj = j
    let joined = join(result.boxes[bi], result.boxes[bj])
    result.boxes.delete(bj)
    result.boxes[bi] = joined
