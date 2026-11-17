## The mouse cursor's shapes, named as CSS names them (docs/jsx-ui.md
## "Cursor"): what a JSX UI asks for with a `cursor-*` class, what the Linux
## runner draws (frameos/cursor_sprite.nim) and what the browser preview hands
## the page's own cursor when the frame's is off.

type
  CursorShape* = enum
    csArrow = "default"
    csPointer = "pointer"   ## a hand: something to click
    csText = "text"         ## an I-beam: text to type into
    csMove = "move"         ## four arrows: something to drag around
    csEwResize = "ew-resize"
    csNsResize = "ns-resize"
    csNwseResize = "nwse-resize"
    csNeswResize = "nesw-resize"
    csNone = "none"         ## no cursor at all

const
  CursorEdges* = 255'u8
    ## A region's `cursor` that is none of the shapes but `cursor-resize`:
    ## a window's frame, whose shape is the edge or the corner the pointer is
    ## on (`edgeCursor`).

proc cursorCode*(shape: CursorShape): uint8 =
  ## How a region keeps a shape: 0 is "none asked for".
  uint8(ord(shape) + 1)

proc cursorOfCode*(code: uint8): CursorShape =
  if code == 0 or code == CursorEdges or int(code) - 1 > ord(high(CursorShape)): csArrow
  else: CursorShape(int(code) - 1)

proc edgeCursor*(lx, ly, w, h, band: float32): CursorShape =
  ## `cursor-resize`'s shape at (lx, ly) in a box of w x h: a diagonal within
  ## `band` of two edges (a corner), else the arrow along the nearest edge;
  ## the way the desktops' frames decide which edge a press drags.
  let
    left = lx < band
    right = lx >= w - band
    top = ly < band
    bottom = ly >= h - band
  if (left and top) or (right and bottom): csNwseResize
  elif (right and top) or (left and bottom): csNeswResize
  elif left or right: csEwResize
  elif top or bottom: csNsResize
  # Nowhere near an edge (the box is wider than its frame shows): the edge
  # nearest the pointer.
  elif min(lx, w - lx) < min(ly, h - ly): csEwResize
  else: csNsResize
