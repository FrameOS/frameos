## The mouse cursor (frameos/cursor_sprite.nim) and the Linux runner's way of
## drawing it on the panel (frameos/cursor_panel.nim): where it lands at every
## turn and flip, that a move writes only its two rectangles, that it goes
## away leaving the picture exactly as it was, and that the framebuffer
## driver's row diff (drivers/frameBuffer/panel_push.nim) stays right with it
## drawn between pushes.

import std/[sets, unittest]
import pixie
import frameos/loading_mark
import frameos/cursor_panel
import drivers/frameBuffer/panel_push

const
  PanelW = 96
  PanelH = 64

# A panel in memory, as /dev/fb0 would be: every write counted, and out of
# bounds is a failed write, never a silent one.
var fakeBytes: seq[uint8]
var fakeLine = 0
var fakeWrites: seq[(int, int)] ## (offset, len)

proc fakeRead(handle: cint, offset: int, dst: pointer, len: int): bool {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if offset < 0 or offset + len > fakeBytes.len:
      return false
    copyMem(dst, fakeBytes[offset].addr, len)
    true

proc fakeWrite(handle: cint, offset: int, src: pointer, len: int): bool {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if offset < 0 or offset + len > fakeBytes.len:
      return false
    copyMem(fakeBytes[offset].addr, src, len)
    fakeWrites.add((offset, len))
    true

proc fakePanel(width = PanelW, height = PanelH, bytesPerPixel = 4, rotation = 0,
    flip = ""): MarkPanel =
  fakeLine = width * bytesPerPixel
  fakeBytes = newSeq[uint8](fakeLine * height)
  fakeWrites = @[]
  MarkPanel(io: MarkPanelIo(read: fakeRead, write: fakeWrite), lineLength: fakeLine,
    pixels: if bytesPerPixel == 2: Rgb565MarkPixels else: RgbMarkPixels,
    view: MarkView(panelWidth: int32(width), panelHeight: int32(height), rotation: int32(rotation),
      flipX: flip in ["horizontal", "both"], flipY: flip in ["vertical", "both"]))

proc paintPanel(seed: int) =
  ## A picture with a different byte almost everywhere, never pure black or
  ## white, so a misplaced restore or a stray cursor pixel shows.
  for i in 0 ..< fakeBytes.len:
    fakeBytes[i] = uint8(17 + (i * 7 + seed * 31) mod 200)

proc pixelAt(panel: MarkPanel, x, y: int): seq[uint8] =
  let bpp = int(panel.pixels.bytesPerPixel)
  fakeBytes[y * fakeLine + x * bpp ..< y * fakeLine + (x + 1) * bpp]

proc isBlack(p: seq[uint8]): bool =
  if p.len == 2: p[0] == 0 and p[1] == 0 else: p[0] == 0 and p[1] == 0 and p[2] == 0

proc isWhite(p: seq[uint8]): bool =
  if p.len == 2: p[0] == 255 and p[1] == 255 else: p[0] == 255 and p[1] == 255 and p[2] == 255

proc viewerToPanel(x, y, rotation: int, flip: string, panelW = PanelW, panelH = PanelH): (int, int) =
  ## A pixel of the scene (as the viewer sees it) on the panel: the flip,
  ## then rotateDegrees' turn.
  let (fw, fh) = if rotation in [90, 270]: (panelH, panelW) else: (panelW, panelH)
  var (fx, fy) = (x, y)
  if flip in ["horizontal", "both"]: fx = fw - 1 - fx
  if flip in ["vertical", "both"]: fy = fh - 1 - fy
  case rotation
  of 90: (fh - 1 - fy, fx)
  of 180: (fw - 1 - fx, fh - 1 - fy)
  of 270: (fy, fw - 1 - fx)
  else: (fx, fy)

proc changedPixels(before: seq[uint8], bytesPerPixel = 4): HashSet[(int, int)] =
  for i in 0 ..< fakeBytes.len div bytesPerPixel:
    for k in 0 ..< bytesPerPixel:
      if fakeBytes[i * bytesPerPixel + k] != before[i * bytesPerPixel + k]:
        result.incl((i mod (fakeLine div bytesPerPixel), i div (fakeLine div bytesPerPixel)))
        break

proc fillRows(image: Image, y0, y1: int, color: ColorRGBA) =
  for y in y0 ..< y1:
    for x in 0 ..< image.width:
      image[x, y] = color

proc inRect(p: (int, int), r: MarkRect): bool =
  p[0] >= r.x and p[0] < r.x + r.w and p[1] >= r.y and p[1] < r.y + r.h

proc at(x, y: int, panel: MarkPanel): CursorAt =
  let rotated = panel.view.rotation in [90'i32, 270]
  let (w, h) = if rotated: (panel.view.panelHeight, panel.view.panelWidth)
               else: (panel.view.panelWidth, panel.view.panelHeight)
  CursorAt(x: int32(x), y: int32(y), sceneWidth: w, sceneHeight: h)

suite "the cursor sprite":
  test "it grows in whole steps with the screen":
    check cursorScale(MarkView(panelWidth: 480, panelHeight: 480)) == 1
    check cursorScale(MarkView(panelWidth: 800, panelHeight: 480)) == 1
    check cursorScale(MarkView(panelWidth: 1920, panelHeight: 1080)) == 2
    check cursorScale(MarkView(panelWidth: 1080, panelHeight: 1920, rotation: 90)) == 2
    check cursorScale(MarkView(panelWidth: 3840, panelHeight: 2160)) == 3

  test "the arrow's tip is the cursor and it points up and left as the viewer sees it, at every turn and flip":
    for rotation in [0, 90, 180, 270]:
      for flip in ["", "horizontal", "vertical", "both"]:
        let panel = fakePanel(rotation = rotation, flip = flip)
        paintPanel(1)
        let before = fakeBytes
        var s: CursorPanelState
        let (cx, cy) = (20, 10)
        check s.cursorShow(panel, true, at(cx, cy, panel))
        proc viewer(dx, dy: int): seq[uint8] =
          let (px, py) = viewerToPanel(cx + dx, cy + dy, rotation, flip)
          panel.pixelAt(px, py)
        checkpoint($rotation & " " & flip)
        check viewer(0, 0).isBlack          # the tip
        check viewer(1, 2).isWhite          # inside
        check viewer(0, 16).isBlack         # the left edge runs down
        check viewer(10, 10).isBlack        # the diagonal
        check not viewer(-1, 0).isBlack and not viewer(-1, 0).isWhite # left of the tip: the picture
        check not viewer(11, 0).isBlack     # up and right of it: the picture
        # Nothing outside its rectangle changed.
        for p in changedPixels(before):
          check p.inRect(s.rect)

  test "an RGB565 panel's cursor is black and white words":
    let panel = fakePanel(bytesPerPixel = 2)
    paintPanel(2)
    var s: CursorPanelState
    check s.cursorShow(panel, true, at(30, 20, panel))
    check panel.pixelAt(30, 20).isBlack
    check panel.pixelAt(31, 22).isWhite

  test "at the panel's edge it is clipped, never written past the panel":
    let panel = fakePanel()
    paintPanel(3)
    var s: CursorPanelState
    check s.cursorShow(panel, true, at(PanelW - 1, PanelH - 1, panel))
    check s.drawn and s.rect.w == 1 and s.rect.h == 1
    check panel.pixelAt(PanelW - 1, PanelH - 1).isBlack
    let before = fakeBytes
    check s.cursorShow(panel, true, at(PanelW + 40, PanelH + 40, panel)) # off it
    check not s.drawn
    check s.cursorShow(panel, false, at(0, 0, panel))

suite "the cursor on a panel":
  test "it goes away leaving the picture exactly as it was":
    for bpp in [2, 3, 4]:
      let panel = fakePanel(bytesPerPixel = bpp)
      paintPanel(4)
      let picture = fakeBytes
      var s: CursorPanelState
      check s.cursorShow(panel, true, at(40, 30, panel))
      check fakeBytes != picture
      check s.cursorShow(panel, false, at(40, 30, panel))
      check fakeBytes == picture
      check not s.drawn

  test "a move writes its old rectangle and its new one, and nothing else":
    let panel = fakePanel()
    paintPanel(5)
    let picture = fakeBytes
    var s: CursorPanelState
    check s.cursorShow(panel, true, at(10, 10, panel))
    let oldRect = s.rect
    fakeWrites = @[]
    check s.cursorShow(panel, true, at(50, 30, panel))
    let newRect = s.rect
    for (offset, len) in fakeWrites:
      let y = offset div fakeLine
      let x = (offset mod fakeLine) div 4
      check (y >= oldRect.y and y < oldRect.y + oldRect.h and x == oldRect.x and len == oldRect.w * 4) or
        (y >= newRect.y and y < newRect.y + newRect.h and x == newRect.x and len == newRect.w * 4)
    check fakeWrites.len == oldRect.h + newRect.h
    # The old place shows the picture again.
    for p in changedPixels(picture):
      check p.inRect(newRect)
    # The same place again writes nothing at all.
    fakeWrites = @[]
    check s.cursorShow(panel, true, at(50, 30, panel))
    check fakeWrites.len == 0

  test "the framebuffer driver's row diff stays right with the cursor drawn between pushes":
    # The driver's copy of the panel (panel_push.nim) and a 565 panel: a push
    # writes only the rows that changed from that copy, so the panel must be
    # exactly the copy whenever the driver writes. The runner puts the cursor
    # away before every push and back after (runner.nim pushToPanel).
    let panel = fakePanel(bytesPerPixel = 2)
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(PanelLayout(width: PanelW, height: PanelH, bytesPerPixel: 2, lineLength: fakeLine))
    proc push(image: Image) =
      let changed = shadow.stageImage(image, scratch)
      for run in changedRuns(changed):
        let offset = run.first * fakeLine
        copyMem(fakeBytes[offset].addr, shadow.bytes[offset].addr, (run.last - run.first + 1) * fakeLine)
    var s: CursorPanelState
    proc pushWithCursor(image: Image) =
      check s.cursorClear()
      check fakeBytes == shadow.bytes or not shadow.valid # what the driver thinks is there
      push(image)
      check fakeBytes == shadow.bytes
      check s.cursorShow(panel, true, s.at)

    let a = newImage(PanelW, PanelH)
    a.fill(rgba(30, 60, 90, 255))
    let b = a.copy()
    b.fillRows(50, 60, rgba(200, 10, 10, 255)) # rows far from the cursor
    let c = a.copy()
    c.fillRows(8, 14, rgba(10, 200, 10, 255)) # rows under it
    push(a)
    check s.cursorShow(panel, true, at(10, 6, panel))
    let cursorRows = (s.rect.y, s.rect.y + s.rect.h - 1)
    pushWithCursor(b)
    pushWithCursor(c)
    pushWithCursor(a)
    # Away for good: the panel is the last frame, to the byte, with no trace
    # of the cursor in rows the driver skipped.
    check s.cursorShow(panel, false, s.at)
    check fakeBytes == shadow.bytes
    check cursorRows[1] >= 8

  test "without putting it away first, a push leaves a cursor behind in the rows it skips":
    # What the rule above prevents: the driver skips rows it thinks unchanged.
    let panel = fakePanel(bytesPerPixel = 2)
    var shadow: PanelShadow
    var scratch: seq[uint8]
    shadow.prepare(PanelLayout(width: PanelW, height: PanelH, bytesPerPixel: 2, lineLength: fakeLine))
    let a = newImage(PanelW, PanelH)
    a.fill(rgba(30, 60, 90, 255))
    discard shadow.stageImage(a, scratch)
    copyMem(fakeBytes[0].addr, shadow.bytes[0].addr, fakeBytes.len)
    var s: CursorPanelState
    check s.cursorShow(panel, true, at(10, 6, panel))
    let b = a.copy()
    b.fillRows(50, 60, rgba(200, 10, 10, 255))
    for run in changedRuns(shadow.stageImage(b, scratch)):
      let offset = run.first * fakeLine
      copyMem(fakeBytes[offset].addr, shadow.bytes[offset].addr, (run.last - run.first + 1) * fakeLine)
    check fakeBytes != shadow.bytes

suite "the runner's cursor":
  test "it shows on a framebuffer, goes away for a push and comes back over the new picture":
    let panel = fakePanel()
    paintPanel(6)
    let picture = fakeBytes
    cursorTestPanel = panel
    try:
      presentPanelCursor("framebuffer", 0, "", true, at(20, 20, panel))
      check panelCursorDrawn()
      check fakeBytes != picture
      putCursorAway()
      check fakeBytes == picture
      paintPanel(7) # the push
      let next = fakeBytes
      putCursorBack()
      check panelCursorDrawn()
      check panel.pixelAt(20, 20).isBlack
      presentPanelCursor("framebuffer", 0, "", false, at(20, 20, panel))
      check not panelCursorDrawn()
      check fakeBytes == next
      # Hidden, a push draws nothing back.
      putCursorAway()
      putCursorBack()
      check fakeBytes == next
    finally:
      cursorTestPanel = MarkPanel()

  test "an e-paper frame or one without a screen never draws one":
    let panel = fakePanel()
    paintPanel(8)
    let picture = fakeBytes
    cursorTestPanel = panel
    try:
      for device in ["waveshare.EPD_7in5_V2", "pimoroni.inky_impression", "http.upload", "web_only"]:
        presentPanelCursor(device, 0, "", true, at(20, 20, panel))
        check not panelCursorDrawn()
        putCursorBack()
        check fakeBytes == picture
    finally:
      cursorTestPanel = MarkPanel()
