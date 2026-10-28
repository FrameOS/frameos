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

  test "the mark sits in the viewer's top right at every turn and flip":
    for rotation in [0, 90, 180, 270]:
      for flip in ["", "horizontal", "vertical", "both"]:
        let (pw, ph) = if rotation in [90, 270]: (PanelH, PanelW) else: (PanelW, PanelH)
        var panel = fakePanel(pw, ph, rotation = rotation)
        panel.view.flipX = flip in ["horizontal", "both"]
        panel.view.flipY = flip in ["vertical", "both"]
        paintPanel(1)
        let before = snapshot()
        let rect = loadingMarkRect(panel.view)
        check rect.w > 0 and rect.h > 0
        check rect.x >= 0 and rect.y >= 0 and rect.x + rect.w <= pw and rect.y + rect.h <= ph
        let origin = fakeBytes[(rect.y * int32(fakeLine)) + rect.x * 4].addr
        let rows = cast[ptr UncheckedArray[uint8]](origin)
        drawLoadingMark(panel.view, 400, rect, panel.pixels, rows, int32(fakeLine), rows,
          int32(fakeLine))
        let changed = changedPixels(before)
        check changed.len > 0
        for (x, y) in changed:
          check x >= rect.x and x < rect.x + rect.w and y >= rect.y and y < rect.y + rect.h
          var (fx, fy) = turnBack(x, y, rotation, pw, ph)
          if panel.view.flipX: fx = PanelW - 1 - fx
          if panel.view.flipY: fy = PanelH - 1 - fy
          if not (fx >= PanelW div 2 and fy < PanelH div 2):
            checkpoint "rotation " & $rotation & " flip " & flip & " drew at frame " & $fx & "," & $fy
            fail()

  test "the dots light up left to right as the viewer sees them, at every turn and flip":
    for rotation in [0, 90, 180, 270]:
      for flip in ["", "horizontal", "vertical", "both"]:
        let (pw, ph) = if rotation in [90, 270]: (PanelH, PanelW) else: (PanelW, PanelH)
        var panel = fakePanel(pw, ph, rotation = rotation)
        panel.view.flipX = flip in ["horizontal", "both"]
        panel.view.flipY = flip in ["vertical", "both"]
        let rect = loadingMarkRect(panel.view)
        let rows = cast[ptr UncheckedArray[uint8]](fakeBytes[rect.y * int32(fakeLine) + rect.x * 4].addr)
        proc brightest(t: int32): int =
          ## Where the brightest pixel is, along the viewer's x, on black.
          for i in 0 ..< fakeLen:
            fakeBytes[i] = 0
          drawLoadingMark(panel.view, t, rect, panel.pixels, rows, int32(fakeLine), rows, int32(fakeLine))
          var best = -1
          for y in 0 ..< ph:
            for x in 0 ..< pw:
              let level = int(fakeBytes[y * fakeLine + x * 4])
              if level > best:
                best = level
                var (fx, _) = turnBack(x, y, rotation, pw, ph)
                if panel.view.flipX: fx = PanelW - 1 - fx
                result = fx
        # At 270 ms the first dot is at its brightest, 360 ms later the last.
        let (first, last) = (brightest(270), brightest(630))
        if not (first < last):
          checkpoint "rotation " & $rotation & " flip " & flip & ": first dot at " & $first &
            ", last at " & $last
          fail()

  test "on a round panel the mark is at the top middle, on the glass 12 px in from the rim":
    # The HyperPixel 2.1 Round shows the circle inside its 480x480 square: a
    # mark in the corner would never be seen.
    const Side = 480
    for rotation in [0, 90, 180, 270]:
      let panel = fakePanel(Side, Side, rotation = rotation)
      var view = panel.view
      view.round = true
      let rect = loadingMarkRect(view)
      check rect.w > 0 and rect.h > 0
      var touched = 0
      var (left, right, top) = (Side, 0, Side)
      for t in [0'i32, 160, 420, 900, 1300]:
        paintPanel(int(t))
        let before = snapshot()
        let rows = cast[ptr UncheckedArray[uint8]](fakeBytes[rect.y * int32(fakeLine) + rect.x * 4].addr)
        drawLoadingMark(view, t, rect, panel.pixels, rows, int32(fakeLine), rows, int32(fakeLine))
        for y in rect.y ..< rect.y + rect.h:
          for x in rect.x ..< rect.x + rect.w:
            let at = (y * int32(fakeLine) + x * 4).int
            if fakeBytes[at] == before[at] and fakeBytes[at + 1] == before[at + 1] and
                fakeBytes[at + 2] == before[at + 2]:
              continue
            inc touched
            if not insideRound(Side, Side, x, y, inset = 12):
              checkpoint "rotation " & $rotation & " t " & $t & " touched " & $x & "," & $y &
                ", off the glass"
              fail()
            let (fx, fy) = turnBack(x, y, rotation, Side, Side)
            left = min(left, fx)
            right = max(right, fx)
            top = min(top, fy)
      check touched > 0
      # Where the viewer sees it: centered, near the top.
      checkpoint "rotation " & $rotation & ": x " & $left & ".." & $right & ", top " & $top
      check abs((left + right) - (Side - 1)) <= 2
      check top < Side div 6

  test "the mark scales with the panel":
    let small = loadingMarkRect(MarkView(panelWidth: 480, panelHeight: 480))
    let large = loadingMarkRect(MarkView(panelWidth: 1920, panelHeight: 1080))
    check large.w > small.w * 2
    check small.w >= 40 and small.w <= 60

  test "an RGB565 panel's mark darkens its pill and lights its dots":
    let panel = fakePanel(bytesPerPixel = 2)
    for i in 0 ..< fakeLen:
      fakeBytes[i] = 0xFF # white
    let rect = loadingMarkRect(panel.view)
    let rows = cast[ptr UncheckedArray[uint8]](fakeBytes[rect.y * int32(fakeLine) + rect.x * 2].addr)
    drawLoadingMark(panel.view, 0, rect, panel.pixels, rows, int32(fakeLine), rows, int32(fakeLine))
    var darker, white, other = 0
    for y in rect.y ..< rect.y + rect.h:
      for x in rect.x ..< rect.x + rect.w:
        let at = y * int32(fakeLine) + x * 2
        let word = uint16(fakeBytes[at]) or (uint16(fakeBytes[at + 1]) shl 8)
        let (r, g, b) = (word shr 11, (word shr 5) and 63, word and 31)
        if word == 0xFFFF: inc white
        elif r < 20:
          inc darker
          # A grey: the channels move together, none spilling into the next.
          if abs(int(r) * 2 - int(g)) > 2 or r != b: inc other
    check darker > 100 # the pill, at half strength over white
    check white > 0    # its corners, and the dots at full
    check other == 0

suite "the loading mark on a panel":
  test "nothing before the delay, the mark after it, the picture back when it goes":
    let panel = fakePanel()
    paintPanel(2)
    let picture = snapshot()
    var state: MarkState
    let switch = markBegin(state, panel, 1000)
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
    let switch = markBegin(state, panel, 0)
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
    let first = markBegin(state, panel, 0)
    let second = markBegin(state, panel, 100)
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
    let switch = markBegin(state, panel, 0)
    check markStep(state, 120) > 0
    markLanded(state, switch, 150)
    check not state.active
    check state.shownMs == -1
    check markStep(state, 400) == -1
    check snapshot() == picture

  test "a panel that refuses a write ends it with the picture back":
    let panel = fakePanel()
    paintPanel(8)
    let picture = snapshot()
    var state: MarkState
    discard markBegin(state, panel, 0)
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
    discard markBegin(state, panel, 0)
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
    let switch = beginLoadingMarkOn(panel)
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
