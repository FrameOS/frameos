## The loading mark on a Linux framebuffer panel (frameos/loading_mark.nim is
## the mark itself; docs/realtime-rendering.md "A switch that takes a while").
##
## The runner thread is the one building the next scene, so it cannot draw
## anything meanwhile. A thread of its own does: from the moment a switch
## begins (`beginLoadingMark`, runner.nim's `selectScene`) it waits out the
## delay, then draws the mark straight into /dev/fb0 over what the panel
## shows, a frame every `LoadingMarkFrameMs`, until the first frame rendered
## for that switch is pushed.
##
## The framebuffer driver keeps a copy of what the panel shows and writes only
## the rows that differ from it (drivers/frameBuffer/panel_push.nim), so the
## mark must never be on the panel when the driver writes. Every push goes
## through `withLoadingMarkAway`, which holds the mark's lock across the
## driver's render and first writes back what the mark covered: the panel is
## then exactly what the driver last wrote, and the mark thread cannot draw
## until the push is done.
##
## What the two threads share is one object of plain values and raw pointers
## (`MarkState`), only ever touched under `markLock`: no ref crosses
## (AGENTS.md, "Refs do not cross threads"). The steps themselves are plain
## procs over a `MarkState` and a clock the caller passes, which is how the
## tests run them without a thread or a panel.

import std/[locks, monotimes, os]
import ./loading_mark
when defined(linux):
  import posix
  import linuxfb
  import ./panel_shape

export loading_mark

const
  LoadingMarkMaxMs* = 120_000
    ## A switch that has not landed after this long stops showing the mark:
    ## past every render's own deadline (90 s), so it only ever ends a mark
    ## whose landing was missed.

type
  MarkPanelIo* = object
    ## How the mark reaches the panel: /dev/fb0, or a test's buffer.
    handle*: cint
    read*: proc (handle: cint, offset: int, dst: pointer, len: int): bool {.nimcall, gcsafe, raises: [].}
    write*: proc (handle: cint, offset: int, src: pointer, len: int): bool {.nimcall, gcsafe, raises: [].}

  MarkPanel* = object
    io*: MarkPanelIo
    lineLength*: int ## bytes per panel row, padding included
    pixels*: MarkPixels
    view*: MarkView

  MarkState* = object
    panel*: MarkPanel
    style*: LoadingMarkStyle
    rect*: MarkRect
    asked*: int    ## switches begun, ever: a push says which one it rendered for
    active*: bool  ## a switch is loading
    sinceMs*: int64
    drawn*: bool   ## the mark is on the panel now
    frames*: int   ## frames of it drawn for this switch
    shownMs*: int  ## how long the last switch that showed the mark took, -1 when taken
    saved, work: ptr UncheckedArray[uint8]
    capacity: int

proc rowBytes(s: MarkState): int =
  int(s.rect.w) * int(s.panel.pixels.bytesPerPixel)

proc rowOffset(s: MarkState, row: int): int =
  (int(s.rect.y) + row) * s.panel.lineLength + int(s.rect.x) * int(s.panel.pixels.bytesPerPixel)

proc transfer(s: MarkState, buffer: ptr UncheckedArray[uint8], write: bool): bool =
  ## Every row of the mark's rectangle between `buffer` and the panel.
  let io = s.panel.io
  let n = s.rowBytes
  if n <= 0 or (if write: io.write.isNil else: io.read.isNil):
    return false
  for row in 0 ..< int(s.rect.h):
    let at = buffer[row * n].addr
    let ok = if write: io.write(io.handle, s.rowOffset(row), at, n)
             else: io.read(io.handle, s.rowOffset(row), at, n)
    if not ok:
      return false
  true

proc markClear*(s: var MarkState): bool =
  ## Puts back what the mark covered, if it is on the panel. False when that
  ## write failed (the panel is then not what the driver thinks: its next
  ## full write heals it within a minute).
  if not s.drawn:
    return true
  s.drawn = false
  s.transfer(s.saved, write = true)

proc reserve(s: var MarkState, bytes: int) =
  if bytes <= s.capacity:
    return
  if not s.saved.isNil:
    deallocShared(s.saved)
    deallocShared(s.work)
  s.saved = cast[ptr UncheckedArray[uint8]](allocShared0(bytes))
  s.work = cast[ptr UncheckedArray[uint8]](allocShared0(bytes))
  s.capacity = bytes

proc markBegin*(s: var MarkState, panel: MarkPanel, style: LoadingMarkStyle, nowMs: int64): int =
  ## A switch begins, now. Returns its number, for the push that lands it. A
  ## switch begun while another still loads keeps the first one's start (the
  ## person has been waiting since then) and its mark, if one is showing.
  let rect = loadingMarkRect(panel.view, style)
  if s.drawn and (rect != s.rect or panel != s.panel or style != s.style):
    discard s.markClear()
  inc s.asked
  if style == lmOff or rect.w <= 0 or rect.h <= 0 or panel.io.write.isNil:
    s.active = false
    return s.asked
  s.panel = panel
  s.style = style
  s.rect = rect
  s.reserve(int(rect.w) * int(rect.h) * int(panel.pixels.bytesPerPixel))
  if not s.active:
    s.active = true
    s.sinceMs = nowMs
    s.frames = 0
  s.asked

proc markStep*(s: var MarkState, nowMs: int64): int =
  ## One step of the mark thread: draws the frame due now, if any. Returns
  ## how many milliseconds until the next step is wanted, -1 when there is
  ## nothing to wait for.
  if not s.active:
    discard s.markClear()
    return -1
  let elapsed = nowMs - s.sinceMs
  if elapsed >= LoadingMarkMaxMs:
    s.active = false
    discard s.markClear()
    return -1
  let t = loadingMarkTime(elapsed)
  if t < 0:
    return int(LoadingMarkDelayMs - elapsed)
  if not s.drawn:
    # What the panel shows under the mark, read back from the panel itself:
    # the last frame pushed, whatever the driver did to it on the way.
    if not s.transfer(s.saved, write = false):
      s.active = false
      return -1
  let stride = int32(s.rowBytes)
  drawLoadingMark(s.panel.view, s.style, t, s.rect, s.panel.pixels, s.saved, stride, s.work, stride)
  s.drawn = true
  if not s.transfer(s.work, write = true):
    discard s.markClear()
    s.active = false
    return -1
  inc s.frames
  LoadingMarkFrameMs

proc markLanded*(s: var MarkState, switch: int, nowMs: int64) =
  ## A frame rendered for switch number `switch` was pushed (the mark was put
  ## away before the push). An older switch's frame lands nothing: another
  ## switch began while it rendered. -1 is a push of a frame already shown.
  if switch < 0 or not s.active or switch < s.asked:
    return
  s.active = false
  if s.frames > 0:
    s.shownMs = int(nowMs - s.sinceMs)
  s.frames = 0

# ------------------------------------------------------------ the thread

var
  markLock: Lock
  markState: MarkState
  markWake: Channel[int]
  markThread: Thread[void]
  markStarted = false ## runner thread only
  fbHandle: cint = -1 ## runner thread only

proc monoMs(): int64 =
  getMonoTime().ticks div 1_000_000

proc markThreadMain() {.thread.} =
  {.cast(gcsafe).}:
    while true:
      discard markWake.recv()
      while true:
        var waitMs: int
        withLock markLock:
          waitMs = markStep(markState, monoMs())
        if waitMs < 0:
          break
        sleep(max(waitMs, 1))

proc startMarkThread() =
  if markStarted:
    return
  markStarted = true
  initLock(markLock)
  markState.shownMs = -1
  markWake.open()
  createThread(markThread, markThreadMain)

proc loadingMarkDevice*(device: string): bool =
  ## The frames whose panel shows a frame the moment it is written: the
  ## framebuffer family (HDMI, DPI, the HyperPixels). Never e-paper.
  device == "framebuffer" or device == "pimoroni.hyperpixel2r" or
    device in ["pimoroni.hyperpixel4", "pimoroni.hyperpixel4_touch",
      "pimoroni.hyperpixel4sq", "pimoroni.hyperpixel4sq_touch"]

when defined(linux):
  proc fbRead(handle: cint, offset: int, dst: pointer, len: int): bool {.nimcall, gcsafe, raises: [].} =
    pread(handle, dst, len, Off(offset)) == len

  proc fbWrite(handle: cint, offset: int, src: pointer, len: int): bool {.nimcall, gcsafe, raises: [].} =
    pwrite(handle, src, len, Off(offset)) == len

  proc framebufferPanel(rotation: int, flip: string, round: bool): MarkPanel =
    ## /dev/fb0 as it is now; `io.write` nil when it does not answer.
    if fbHandle < 0:
      fbHandle = posix.open("/dev/fb0", O_RDWR)
      if fbHandle < 0:
        return
    var vinfo: fb_var_screeninfo
    var finfo: fb_fix_screeninfo
    if ioctl(fbHandle, FBIOGET_VSCREENINFO, addr vinfo) != 0 or vinfo.xres == 0 or vinfo.yres == 0:
      return
    let bytesPerPixel = int(vinfo.bits_per_pixel) div 8
    # 16 bpp is taken as 5/6/5 whichever way round: the mark is grey, white
    # and inversions, the same in every channel.
    if bytesPerPixel notin [2, 3, 4]:
      return
    var lineLength = int(vinfo.xres) * bytesPerPixel
    if ioctl(fbHandle, FBIOGET_FSCREENINFO, addr finfo) == 0 and int(finfo.line_length) >= lineLength:
      lineLength = int(finfo.line_length)
    result = MarkPanel(
      io: MarkPanelIo(handle: fbHandle, read: fbRead, write: fbWrite),
      lineLength: lineLength,
      pixels: MarkPixels(bytesPerPixel: int32(bytesPerPixel), redByte: int32(vinfo.red.offset div 8),
        greenByte: int32(vinfo.green.offset div 8), blueByte: int32(vinfo.blue.offset div 8)),
      view: MarkView(panelWidth: int32(vinfo.xres), panelHeight: int32(vinfo.yres),
        rotation: int32(((rotation mod 360) + 360) mod 360),
        flipX: flip in ["horizontal", "both"], flipY: flip in ["vertical", "both"], round: round))

proc beginLoadingMarkOn*(panel: MarkPanel, style: LoadingMarkStyle): int =
  ## `beginLoadingMark` on a panel of the caller's (the tests'). Runner thread.
  startMarkThread()
  withLock markLock:
    {.cast(gcsafe).}:
      result = markBegin(markState, panel, style, monoMs())
  markWake.send(1)

when defined(testing):
  var loadingMarkTestPanel*: MarkPanel
    ## A panel the tests hand the runner in place of /dev/fb0.

proc beginLoadingMark*(device: string, rotation: int, flip: string, style: LoadingMarkStyle): int =
  ## A switch begins on this frame: the scene shown is going away, the next
  ## one is being built. Returns the switch's number for the render that
  ## lands it (`withLoadingMarkAway`), 0 on a frame that has no mark.
  ## Runner thread.
  if style == lmOff or not loadingMarkDevice(device):
    return 0
  when defined(testing):
    if not loadingMarkTestPanel.io.write.isNil:
      return beginLoadingMarkOn(loadingMarkTestPanel, style)
  when defined(linux):
    let panel = framebufferPanel(rotation, flip, panelIsRound(device))
    if panel.io.write.isNil:
      return 0
    beginLoadingMarkOn(panel, style)
  else:
    0

proc loadingMarkSwitches*(): int =
  ## The newest switch's number: a render tagged with it lands that switch.
  ## Runner thread.
  if not markStarted:
    return 0
  withLock markLock:
    {.cast(gcsafe).}:
      result = markState.asked

proc takeLoadingMarkShown*(): int =
  ## How long the last switch that showed the mark took to land, in ms,
  ## once; -1 when there is none to tell. Runner thread, for its log.
  if not markStarted:
    return -1
  withLock markLock:
    {.cast(gcsafe).}:
      result = markState.shownMs
      markState.shownMs = -1

proc loadingMarkStarted*(): bool =
  ## Whether a switch ever began here. Runner thread.
  markStarted

proc acquireLoadingMark*() =
  ## Takes the panel from the mark thread and puts the mark away.
  acquire(markLock)
  {.cast(gcsafe).}:
    discard markClear(markState)

proc releaseLoadingMark*(switch: int) =
  ## Gives the panel back after a push of a frame rendered for `switch`.
  {.cast(gcsafe).}:
    markLanded(markState, switch, monoMs())
  release(markLock)

template withLoadingMarkAway*(switch: int, body: untyped) =
  ## Around every push to the panel driver: the mark is put away first and
  ## cannot be drawn again until the push is done. `switch` is the switch
  ## the frame was rendered for (`loadingMarkSwitches` when its render
  ## began), -1 for a push of a frame already shown (a driver retry, the
  ## cursor). Runner thread.
  if not loadingMarkStarted():
    body
  else:
    let landingSwitch = switch
    acquireLoadingMark()
    try:
      body
    finally:
      releaseLoadingMark(landingSwitch)
