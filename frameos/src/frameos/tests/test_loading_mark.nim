## The loading mark (frameos/loading_mark.nim) and its Linux panel thread
## (frameos/loading_mark_panel.nim): when it shows, where, what it leaves
## behind, and how a push puts it away. The clock is the caller's, so the
## steps run here without a thread; the last test runs the real one.

import std/[os, unittest]
import frameos/loading_mark
import frameos/loading_mark_panel
import frameos/panel_shape

const
  PanelW = 96
  PanelH = 64

# A panel in memory, as raw shared bytes: the mark thread writes it too.
var fakeBytes: ptr UncheckedArray[uint8]
var fakeLen = 0
var fakeLine = 0
var fakeFailWrites = false

proc fakeRead(handle: cint, offset: int, dst: pointer, len: int): bool {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if offset < 0 or offset + len > fakeLen:
      return false
    copyMem(dst, fakeBytes[offset].addr, len)
    true

proc fakeWrite(handle: cint, offset: int, src: pointer, len: int): bool {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    if fakeFailWrites or offset < 0 or offset + len > fakeLen:
      return false
    copyMem(fakeBytes[offset].addr, src, len)
    true

proc fakePanel(width = PanelW, height = PanelH, bytesPerPixel = 4, rotation = 0): MarkPanel =
  fakeLine = width * bytesPerPixel
  fakeLen = fakeLine * height
  if not fakeBytes.isNil:
    deallocShared(fakeBytes)
  fakeBytes = cast[ptr UncheckedArray[uint8]](allocShared0(fakeLen))
  MarkPanel(io: MarkPanelIo(read: fakeRead, write: fakeWrite), lineLength: fakeLine,
    pixels: if bytesPerPixel == 2: Rgb565MarkPixels else: RgbMarkPixels,
    view: MarkView(panelWidth: int32(width), panelHeight: int32(height), rotation: int32(rotation)))

proc paintPanel(seed: int) =
  ## A picture: a different byte everywhere, so a misplaced restore shows.
  for i in 0 ..< fakeLen:
    fakeBytes[i] = uint8((i * 7 + seed * 31) mod 251)

proc snapshot(): seq[uint8] =
  result = newSeq[uint8](fakeLen)
  copyMem(result[0].addr, fakeBytes[0].addr, fakeLen)

proc changedPixels(before: seq[uint8], bytesPerPixel = 4): seq[(int, int)] =
  for i in 0 ..< fakeLen div bytesPerPixel:
    for k in 0 ..< bytesPerPixel:
      if fakeBytes[i * bytesPerPixel + k] != before[i * bytesPerPixel + k]:
        result.add((i mod (fakeLine div bytesPerPixel), i div (fakeLine div bytesPerPixel)))
        break

proc turnBack(x, y, rotation, panelW, panelH: int): (int, int) =
  ## A panel pixel back in the frame as the viewer sees it (rotateDegrees).
  let (fw, fh) = if rotation in [90, 270]: (panelH, panelW) else: (panelW, panelH)
  case rotation
  of 90: (y, fh - 1 - x)
  of 180: (fw - 1 - x, fh - 1 - y)
  of 270: (fw - 1 - y, x)
  else: (x, y)

suite "the loading mark":
  test "it is due after the delay, not before":
    check loadingMarkTime(0) == -1
    check loadingMarkTime(LoadingMarkDelayMs - 1) == -1
    check loadingMarkTime(LoadingMarkDelayMs) == 0
    check loadingMarkTime(LoadingMarkDelayMs + 1000) == 1000
    check LoadingMarkDelayMs in 150 .. 250

  test "frame.json names a style; anything else is the dots":
    check parseLoadingMarkStyle("") == lmDots
    check parseLoadingMarkStyle("dots") == lmDots
    check parseLoadingMarkStyle("spinner") == lmSpinner
    check parseLoadingMarkStyle("squares") == lmSquares
    check parseLoadingMarkStyle("bar") == lmBar
    check parseLoadingMarkStyle("off") == lmOff
    check parseLoadingMarkStyle("none") == lmOff
    check parseLoadingMarkStyle("sparkles") == lmDots

  test "every style sits in the viewer's top right, or along the top, at every turn and flip":
    for rotation in [0, 90, 180, 270]:
      for flip in ["", "horizontal", "vertical", "both"]:
        for style in [lmDots, lmSpinner, lmSquares, lmBar]:
          let (pw, ph) = if rotation in [90, 270]: (PanelH, PanelW) else: (PanelW, PanelH)
          var panel = fakePanel(pw, ph, rotation = rotation)
          panel.view.flipX = flip in ["horizontal", "both"]
          panel.view.flipY = flip in ["vertical", "both"]
          paintPanel(1)
          let before = snapshot()
          let rect = loadingMarkRect(panel.view, style)
          check rect.w > 0 and rect.h > 0
          check rect.x >= 0 and rect.y >= 0 and rect.x + rect.w <= pw and rect.y + rect.h <= ph
          let origin = fakeBytes[(rect.y * int32(fakeLine)) + rect.x * 4].addr
          let rows = cast[ptr UncheckedArray[uint8]](origin)
          drawLoadingMark(panel.view, style, 400, rect, panel.pixels, rows, int32(fakeLine),
            rows, int32(fakeLine))
          let changed = changedPixels(before)
          check changed.len > 0
          for (x, y) in changed:
            check x >= rect.x and x < rect.x + rect.w and y >= rect.y and y < rect.y + rect.h
            var (fx, fy) = turnBack(x, y, rotation, pw, ph)
            if panel.view.flipX: fx = PanelW - 1 - fx
            if panel.view.flipY: fy = PanelH - 1 - fy
            if style == lmBar:
              check fy < 6
            else:
              if not (fx >= PanelW div 2 and fy < PanelH div 2):
                checkpoint "style " & $style & " rotation " & $rotation & " flip " & flip &
                  " drew at frame " & $fx & "," & $fy
                fail()

  test "on a round panel every pixel of every style is on the glass, 12 px in from the rim":
    # The HyperPixel 2.1 Round shows the circle inside its 480x480 square:
    # a mark in the corner, or along the top edge, would never be seen.
    const Side = 480
    for rotation in [0, 90, 180, 270]:
      for style in [lmDots, lmSpinner, lmSquares, lmBar]:
        let panel = fakePanel(Side, Side, rotation = rotation)
        var view = panel.view
        view.round = true
        let rect = loadingMarkRect(view, style)
        check rect.w > 0 and rect.h > 0
        var touched = 0
        for t in [0'i32, 160, 420, 900, 1300]:
          paintPanel(int(t))
          let before = snapshot()
          let rows = cast[ptr UncheckedArray[uint8]](fakeBytes[rect.y * int32(fakeLine) + rect.x * 4].addr)
          drawLoadingMark(view, style, t, rect, panel.pixels, rows, int32(fakeLine), rows,
            int32(fakeLine))
          for y in rect.y ..< rect.y + rect.h:
            for x in rect.x ..< rect.x + rect.w:
              let at = (y * int32(fakeLine) + x * 4).int
              if fakeBytes[at] == before[at] and fakeBytes[at + 1] == before[at + 1] and
                  fakeBytes[at + 2] == before[at + 2]:
                continue
              inc touched
              if not insideRound(Side, Side, x, y, inset = 12):
                checkpoint "style " & $style & " rotation " & $rotation & " t " & $t &
                  " touched " & $x & "," & $y & ", off the glass"
                fail()
              # Where the viewer sees it: the upper right, or the top for the bar.
              let (fx, fy) = turnBack(x, y, rotation, Side, Side)
              if fy >= Side div 2 or (style != lmBar and fx < Side div 2):
                checkpoint "style " & $style & " rotation " & $rotation & " at frame " &
                  $fx & "," & $fy
                fail()
        check touched > 0

  test "the mark scales with the panel":
    let small = loadingMarkRect(MarkView(panelWidth: 480, panelHeight: 480), lmDots)
    let large = loadingMarkRect(MarkView(panelWidth: 1920, panelHeight: 1080), lmDots)
    check large.w > small.w * 2
    check small.w >= 40 and small.w <= 60

  test "an RGB565 panel's mark darkens its pill and lights its dots":
    let panel = fakePanel(bytesPerPixel = 2)
    for i in 0 ..< fakeLen:
      fakeBytes[i] = 0xFF # white
    let rect = loadingMarkRect(panel.view, lmDots)
    let rows = cast[ptr UncheckedArray[uint8]](fakeBytes[rect.y * int32(fakeLine) + rect.x * 2].addr)
    drawLoadingMark(panel.view, lmDots, 0, rect, panel.pixels, rows, int32(fakeLine), rows,
      int32(fakeLine))
    var darker, white = 0
    for y in rect.y ..< rect.y + rect.h:
      for x in rect.x ..< rect.x + rect.w:
        let at = y * int32(fakeLine) + x * 2
        let word = uint16(fakeBytes[at]) or (uint16(fakeBytes[at + 1]) shl 8)
        if word == 0xFFFF: inc white
        elif (word shr 11) < 20: inc darker
    check darker > 100 # the pill, at half strength over white
    check white > 0    # its corners, and the dots at full
    # The squares invert in the panel's own steps: white goes black whole.
    for i in 0 ..< fakeLen:
      fakeBytes[i] = 0xFF
    let squares = loadingMarkRect(panel.view, lmSquares)
    let at = cast[ptr UncheckedArray[uint8]](fakeBytes[squares.y * int32(fakeLine) + squares.x * 2].addr)
    drawLoadingMark(panel.view, lmSquares, 0, squares, panel.pixels, at, int32(fakeLine), at,
      int32(fakeLine))
    var black = 0
    for y in squares.y ..< squares.y + squares.h:
      for x in squares.x ..< squares.x + squares.w:
        let i = y * int32(fakeLine) + x * 2
        if fakeBytes[i] == 0 and fakeBytes[i + 1] == 0: inc black
    check black > 0

suite "the loading mark on a panel":
  test "nothing before the delay, the mark after it, the picture back when it goes":
    let panel = fakePanel()
    paintPanel(2)
    let picture = snapshot()
    var state: MarkState
    let switch = markBegin(state, panel, lmDots, 1000)
    check switch == 1
    check state.active
    check markStep(state, 1000) == LoadingMarkDelayMs
    check markStep(state, 1150) == LoadingMarkDelayMs - 150
    check snapshot() == picture
    check markStep(state, 1200) == LoadingMarkFrameMs
    let rect = state.rect
    let changed = changedPixels(picture)
    check changed.len > 0
    for (x, y) in changed:
      check x >= rect.x and x < rect.x + rect.w and y >= rect.y and y < rect.y + rect.h
    # The next frames animate, over the same saved picture.
    discard markStep(state, 1250)
    let frame2 = snapshot()
    discard markStep(state, 1500)
    check snapshot() != frame2
    check markClear(state)
    check snapshot() == picture

  test "a push of the old frame puts the mark away, and it comes back over what was pushed":
    let panel = fakePanel()
    paintPanel(3)
    var state: MarkState
    let switch = markBegin(state, panel, lmSpinner, 0)
    discard markStep(state, 300)
    check state.drawn
    # The runner pushes (a driver retry): mark away, the driver writes.
    check markClear(state)
    paintPanel(4)
    let pushed = snapshot()
    markLanded(state, -1, 320)
    check state.active
    discard markStep(state, 350)
    check snapshot() != pushed
    # The landing push: mark away, the new scene's frame written, done.
    check markClear(state)
    paintPanel(5)
    let landed = snapshot()
    markLanded(state, switch, 900)
    check not state.active
    check state.shownMs == 900
    check markStep(state, 950) == -1
    check snapshot() == landed

  test "a frame rendered for an older switch does not end a newer one":
    let panel = fakePanel()
    paintPanel(6)
    var state: MarkState
    state.shownMs = -1
    let first = markBegin(state, panel, lmDots, 0)
    let second = markBegin(state, panel, lmDots, 100)
    check second == first + 1
    check state.sinceMs == 0 # the wait started with the first
    markLanded(state, first, 150)
    check state.active
    markLanded(state, second, 160)
    check not state.active
    check state.shownMs == -1 # nothing showed: nothing to report

  test "a quick switch shows nothing and reports nothing":
    let panel = fakePanel()
    paintPanel(7)
    let picture = snapshot()
    var state: MarkState
    state.shownMs = -1
    let switch = markBegin(state, panel, lmDots, 0)
    check markStep(state, 120) > 0
    markLanded(state, switch, 150)
    check not state.active
    check state.shownMs == -1
    check markStep(state, 400) == -1
    check snapshot() == picture

  test "off is no mark, and a panel that refuses a write ends it with the picture back":
    let panel = fakePanel()
    paintPanel(8)
    let picture = snapshot()
    var state: MarkState
    discard markBegin(state, panel, lmOff, 0)
    check not state.active
    check markStep(state, 500) == -1
    discard markBegin(state, panel, lmBar, 0)
    fakeFailWrites = true
    check markStep(state, 500) == -1
    fakeFailWrites = false
    check not state.active
    check snapshot() == picture

  test "a switch that never lands stops showing it":
    let panel = fakePanel()
    paintPanel(9)
    let picture = snapshot()
    var state: MarkState
    discard markBegin(state, panel, lmSquares, 0)
    discard markStep(state, 1000)
    check state.drawn
    check markStep(state, LoadingMarkMaxMs + 1) == -1
    check not state.active
    check snapshot() == picture

  test "the mark thread never draws while the runner pushes":
    # The runner thread and the mark thread, as on a frame: every push finds
    # the panel exactly as the last push left it, and the landing leaves it so.
    let panel = fakePanel(240, 160)
    paintPanel(10)
    var last = snapshot()
    let switch = beginLoadingMarkOn(panel, lmDots)
    check switch == loadingMarkSwitches()
    proc markShows(last: seq[uint8]): bool =
      # Drawn over what was pushed, between pushes, within a couple of
      # frames (two seconds at most, for a loaded machine). A read without
      # the lock: it may catch a frame half written, which is still a mark.
      for _ in 0 ..< 200:
        if snapshot() != last:
          return true
        sleep(10)
      false
    check markShows(last)
    for round in 0 ..< 4:
      withLoadingMarkAway(-1):
        check snapshot() == last
        paintPanel(11 + round)
        last = snapshot()
      check markShows(last)
    withLoadingMarkAway(switch):
      check snapshot() == last
      paintPanel(99)
      last = snapshot()
    sleep(3 * LoadingMarkFrameMs)
    check snapshot() == last
    check takeLoadingMarkShown() > LoadingMarkDelayMs
    check takeLoadingMarkShown() == -1
