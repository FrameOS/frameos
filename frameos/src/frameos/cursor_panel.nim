## The mouse cursor on a Linux framebuffer panel (frameos/cursor_sprite.nim
## is the cursor itself; docs/events.md "The cursor").
##
## A classic desktop's software cursor: drawn straight into /dev/fb0 over the
## picture the panel shows, the pixels under it kept, and written back before
## anything else draws there. It is never in the canvas, the stored frame
## (`GET /image`, snapshots), the driver's copy of the panel or any other
## surface, and a pure mouse move writes the cursor's old rectangle and its
## new one: no scene runs, no frame is pushed.
##
## The framebuffer driver keeps a copy of what the panel shows and writes only
## the rows that differ from it (drivers/frameBuffer/panel_push.nim), so the
## cursor must never be on the panel when the driver writes: every push puts
## it away first and back after (`putCursorAway` / `putCursorBack`, runner.nim
## `pushToPanel`), inside `withLoadingMarkAway`, the loading mark's lock. A
## move is drawn under the same lock (runner.nim `presentCursor`), so the
## mark thread never reads or writes the panel half way through one, and
## what either keeps of the panel is what the panel shows.
##
## Runner thread only: the cursor's state is this thread's, and the steps are
## plain procs over a `CursorPanelState`, which is how the tests run them on a
## panel in memory.

import ./loading_mark
import ./loading_mark_panel
import ./cursor_sprite

export cursor_sprite, loading_mark_panel.MarkPanel, loading_mark_panel.MarkPanelIo

type
  CursorPanelState* = object
    panel*: MarkPanel
    drawn*: bool    ## the cursor is on the panel now
    at*: CursorAt   ## where, when it is
    rect*: MarkRect ## the panel pixels it covers, when it is
    saved, work: seq[uint8]

proc transfer(panel: MarkPanel, rect: MarkRect, buffer: var seq[uint8], write: bool): bool =
  ## Every row of `rect` between `buffer` and the panel.
  let bpp = int(panel.pixels.bytesPerPixel)
  let n = int(rect.w) * bpp
  let io = panel.io
  if n <= 0 or (if write: io.write.isNil else: io.read.isNil):
    return false
  if buffer.len < n * int(rect.h):
    buffer.setLen(n * int(rect.h))
  for row in 0 ..< int(rect.h):
    let offset = (int(rect.y) + row) * panel.lineLength + int(rect.x) * bpp
    let at = buffer[row * n].addr
    let ok = if write: io.write(io.handle, offset, at, n) else: io.read(io.handle, offset, at, n)
    if not ok:
      return false
  true

proc cursorClear*(s: var CursorPanelState): bool =
  ## Puts back what the cursor covered, if it is on the panel. False when
  ## that write failed (the driver's next full write heals the panel).
  if not s.drawn:
    return true
  s.drawn = false
  transfer(s.panel, s.rect, s.saved, write = true)

proc cursorDraw(s: var CursorPanelState, panel: MarkPanel, at: CursorAt): bool =
  ## The cursor at `at`, over what the panel shows now. Not on the panel yet.
  let rect = cursorRect(panel.view, at)
  if rect.w <= 0 or rect.h <= 0:
    return true # off the panel: nothing to draw
  # What the panel shows under it, read back from the panel itself: the
  # last frame pushed, whatever the driver did to it on the way.
  if not transfer(panel, rect, s.saved, write = false):
    return false
  if s.work.len < s.saved.len:
    s.work.setLen(s.saved.len)
  let stride = rect.w * panel.pixels.bytesPerPixel
  drawCursorSprite(panel.view, at, rect, panel.pixels,
    cast[ptr UncheckedArray[uint8]](s.saved[0].addr), stride,
    cast[ptr UncheckedArray[uint8]](s.work[0].addr), stride)
  s.panel = panel
  s.rect = rect
  s.at = at
  s.drawn = true
  if not transfer(panel, rect, s.work, write = true):
    discard s.cursorClear()
    return false
  true

proc cursorShow*(s: var CursorPanelState, panel: MarkPanel, shown: bool, at: CursorAt): bool =
  ## The cursor as it should be now: at `at` when `shown`, else not at all.
  ## Writes nothing when that is what the panel shows already; else the old
  ## rectangle goes back and the new one is drawn.
  if s.drawn and shown and s.at == at and s.panel == panel:
    return true
  result = s.cursorClear()
  if shown and not panel.io.write.isNil:
    result = s.cursorDraw(panel, at) and result

# ------------------------------------------------------- the runner's cursor

var
  cursorState: CursorPanelState
  cursorWanted: bool
  cursorWantedAt: CursorAt
  cursorDevice: string
  cursorRotation: int
  cursorFlip: string

when defined(testing):
  var cursorTestPanel*: MarkPanel
    ## A panel the tests hand the runner in place of /dev/fb0.

proc cursorPanelDevice*(device: string): bool =
  ## The frames a mouse cursor is drawn on: the framebuffer family, whose
  ## panel shows a write the moment it is made (HDMI, DPI, the HyperPixels).
  ## Never e-paper, an upload target or a frame without a screen.
  loadingMarkDevice(device)

proc currentPanel(): MarkPanel =
  when defined(testing):
    if not cursorTestPanel.io.write.isNil:
      return cursorTestPanel
  when defined(linux):
    if cursorPanelDevice(cursorDevice):
      return framebufferPanel(cursorRotation, cursorFlip, false)

proc presentPanelCursor*(device: string, rotation: int, flip: string, shown: bool, at: CursorAt) =
  ## The cursor as the dispatcher has it now (input_state.nim): drawn, moved
  ## or put away, on the panel as it is. Inside `withLoadingMarkAway`.
  cursorDevice = device
  cursorRotation = rotation
  cursorFlip = flip
  cursorWanted = shown and cursorPanelDevice(device)
  cursorWantedAt = at
  if not cursorWanted and not cursorState.drawn:
    return
  discard cursorState.cursorShow(currentPanel(), cursorWanted, at)

proc putCursorAway*() =
  ## Before a push to the panel: the panel is then exactly what the driver
  ## last wrote. Inside `withLoadingMarkAway`.
  discard cursorState.cursorClear()

proc putCursorBack*() =
  ## After a push: the cursor over the new picture, if it shows.
  if cursorWanted:
    discard cursorState.cursorShow(currentPanel(), true, cursorWantedAt)

proc panelCursorDrawn*(): bool =
  cursorState.drawn
