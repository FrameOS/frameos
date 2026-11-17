## The mouse cursor as a picture: what a Linux frame draws over its panel
## while a mouse moves (frameos/cursor_panel.nim does the drawing,
## docs/events.md "The cursor").
##
## A classic desktop's cursor: pixel art, black with a white inside, so it
## reads on any picture, made bigger in whole steps on a big screen (a 4K
## panel's cursor is not a 480-pixel panel's). It is placed in the scene's
## own pixels, where the dispatcher keeps the cursor (input_state.nim), and
## drawn in panel pixels through frame.json's `flip` and `rotate`, the
## mapping utils/image.nim `rotateDegrees` uses: the cursor is turned with
## the picture, so it points up and left as the viewer sees the scene.
##
## Like the loading mark (loading_mark.nim), it is drawn into a rectangle of
## the panel's own pixels composed over a copy of what was there, so a host
## puts it away by writing that copy back. It allocates nothing and touches
## no ref.

import std/math
import ./loading_mark
import ./cursor_shape

export cursor_shape

type
  CursorSprite = object
    width, height: int32
    hotX, hotY: int32 ## the pixel that points
    pixels: string ## a row after the other: '.' clear, 'X' black, 'o' white

# ------------------------------------------------- the shapes, at compile time

type Poly = seq[(float, float)]

proc insidePoly(poly: Poly, x, y: float): bool =
  ## Even-odd: whether (x, y) is inside the polygon.
  var j = poly.high
  for i in 0 .. poly.high:
    let (xi, yi) = poly[i]
    let (xj, yj) = poly[j]
    if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
      result = not result
    j = i

proc turned(poly: Poly, degrees: float): Poly =
  let (c, s) = (cos(degrees * PI / 180), sin(degrees * PI / 180))
  for (x, y) in poly:
    result.add((x * c - y * s, x * s + y * c))

proc outlined(shapes: seq[Poly], radius: int): CursorSprite =
  ## Polygons around (0, 0), white, in a one-pixel black outline: a pixel of
  ## the sprite is white when its center is inside one of them, black when
  ## it is not but touches a white one. The hot spot is (0, 0); the sprite is
  ## trimmed to what it draws.
  let size = 2 * radius + 1
  var white = newSeq[bool](size * size)
  for row in 0 ..< size:
    for col in 0 ..< size:
      # A hair off the pixel's center, so no center lies on an edge the
      # shape is symmetric about.
      let (x, y) = (float(col - radius) + 0.0011, float(row - radius) + 0.0017)
      for poly in shapes:
        if poly.insidePoly(x, y):
          white[row * size + col] = true
  var grid = newSeq[char](size * size)
  var (x0, y0, x1, y1) = (size, size, -1, -1)
  for row in 0 ..< size:
    for col in 0 ..< size:
      var c = '.'
      if white[row * size + col]:
        c = 'o'
      else:
        for dy in -1 .. 1:
          for dx in -1 .. 1:
            let (r, k) = (row + dy, col + dx)
            if r >= 0 and r < size and k >= 0 and k < size and white[r * size + k]:
              c = 'X'
      grid[row * size + col] = c
      if c != '.':
        (x0, y0, x1, y1) = (min(x0, col), min(y0, row), max(x1, col), max(y1, row))
  result = CursorSprite(width: int32(x1 - x0 + 1), height: int32(y1 - y0 + 1),
    hotX: int32(radius - x0), hotY: int32(radius - y0))
  for row in y0 .. y1:
    for col in x0 .. x1:
      result.pixels.add grid[row * size + col]

proc art(hotX, hotY: int, rows: openArray[string]): CursorSprite =
  ## Pixel art, a row a string.
  result = CursorSprite(width: int32(rows[0].len), height: int32(rows.len), hotX: int32(hotX),
    hotY: int32(hotY))
  for row in rows:
    doAssert row.len == rows[0].len
    result.pixels.add row

proc doubleArrow(half, head, wing, shaft: float): Poly =
  ## An arrow both ways along x: `half` from the middle to each tip, `head`
  ## long heads `wing` wide each side, a shaft `shaft` wide each side.
  @[(-half, 0.0), (-half + head, -wing), (-half + head, -shaft), (half - head, -shaft),
    (half - head, -wing), (half, 0.0), (half - head, wing), (half - head, shaft),
    (-half + head, shaft), (-half + head, wing)]

const
  ArrowSprite = art(0, 0, [
    "X...........",
    "XX..........",
    "XoX.........",
    "XooX........",
    "XoooX.......",
    "XooooX......",
    "XoooooX.....",
    "XooooooX....",
    "XoooooooX...",
    "XooooooooX..",
    "XoooooooooX.",
    "XooooooXXXXX",
    "XoooXooX....",
    "XooXXooX....",
    "XoX..XooX...",
    "XX...XooX...",
    "X.....XooX..",
    "......XooX..",
    ".......XX...",
  ])
  HandSprite = art(5, 0, [
    ".....XX..........",
    "....XooX.........",
    "....XooX.........",
    "....XooX.........",
    "....XooX.........",
    "....XooXXX.......",
    "....XooXooXXX....",
    "....XooXooXooXX..",
    "XX..XooXooXooXoX.",
    "XoX.XooooooooXooX",
    "XooXXoooooooooooX",
    ".XooXoooooooooooX",
    "..XoooooooooooooX",
    "..XoooooooooooooX",
    "...XooooooooooooX",
    "...XoooooooooooX.",
    "....XooooooooooX.",
    "....XooooooooooX.",
    ".....XooooooooX..",
    ".....XooooooooX..",
    ".....XXXXXXXXXX..",
  ])
  IBeamSprite = art(4, 9, [
    "XXXX.XXXX",
    "XoooXoooX",
    "XXXXoXXXX",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "...XoX...",
    "XXXXoXXXX",
    "XoooXoooX",
    "XXXX.XXXX",
  ])
  # Every edge off the pixel grid (bases at 5.5, tips at 9.5), so each shape
  # comes out as symmetric as it is.
  EwSprite = outlined(@[doubleArrow(9.5, 4.0, 4.5, 1.5)], 11)
  NsSprite = outlined(@[doubleArrow(9.5, 4.0, 4.5, 1.5).turned(90)], 11)
  NwseSprite = outlined(@[doubleArrow(8.5, 4.0, 4.5, 1.6).turned(45)], 9)
  NeswSprite = outlined(@[doubleArrow(8.5, 4.0, 4.5, 1.6).turned(-45)], 9)
  MoveSprite = outlined(@[doubleArrow(9.5, 4.0, 3.5, 1.5), doubleArrow(9.5, 4.0, 3.5, 1.5).turned(90)], 11)
  NoSprite = CursorSprite()

proc sprite(shape: CursorShape): CursorSprite =
  case shape
  of csArrow: ArrowSprite
  of csPointer: HandSprite
  of csText: IBeamSprite
  of csMove: MoveSprite
  of csEwResize: EwSprite
  of csNsResize: NsSprite
  of csNwseResize: NwseSprite
  of csNeswResize: NeswSprite
  of csNone: NoSprite

when defined(testing):
  proc spriteRows*(shape: CursorShape): seq[string] =
    ## The tests' look at a shape.
    let s = sprite(shape)
    for row in 0 ..< int(s.height):
      result.add s.pixels[row * int(s.width) ..< (row + 1) * int(s.width)]

{.push checks: off, stackTrace: off, raises: [].}

type
  CursorAt* = object
    ## Where the cursor is and what it looks like, in the scene's pixels.
    x*, y*: int32
    sceneWidth*, sceneHeight*: int32 ## the scene the position is in
    shape*: CursorShape

proc viewerSize(view: MarkView): (int32, int32) =
  ## The panel as the viewer sees it: the scene's orientation.
  if view.rotation == 90 or view.rotation == 270: (view.panelHeight, view.panelWidth)
  else: (view.panelWidth, view.panelHeight)

proc cursorScale*(view: MarkView): int32 =
  ## How many panel pixels a pixel of the sprite takes: 1 below a 1080-pixel
  ## short side, 2 on 1080p, 3 on 4K.
  let (fw, fh) = view.viewerSize
  max(1'i32, (min(fw, fh) + 200) div 640)

proc toPanel(view: MarkView, x, y: int32): (int32, int32) =
  ## A pixel of the frame as the viewer sees it, on the panel: the flip
  ## first, then the turn (rotateDegrees).
  let (fw, fh) = view.viewerSize
  var (fx, fy) = (x, y)
  if view.flipX: fx = fw - 1 - fx
  if view.flipY: fy = fh - 1 - fy
  case view.rotation
  of 90: (fh - 1 - fy, fx)
  of 180: (fw - 1 - fx, fh - 1 - fy)
  of 270: (fy, fw - 1 - fx)
  else: (fx, fy)

proc toViewer(view: MarkView, px, py: int32): (int32, int32) =
  ## A panel pixel in the frame as the viewer sees it: `toPanel` backwards.
  let (fw, fh) = view.viewerSize
  var (fx, fy) =
    case view.rotation
    of 90: (py, fh - 1 - px)
    of 180: (fw - 1 - px, fh - 1 - py)
    of 270: (fw - 1 - py, px)
    else: (px, py)
  if view.flipX: fx = fw - 1 - fx
  if view.flipY: fy = fh - 1 - fy
  (fx, fy)

proc spriteOrigin(view: MarkView, at: CursorAt): (int32, int32, int32) =
  ## The sprite's top left in the viewer's frame pixels, and its scale.
  let (fw, fh) = view.viewerSize
  let k = view.cursorScale
  let s = sprite(at.shape)
  # The scene is normally the panel's size; one that is not is fitted to it.
  let x = if at.sceneWidth > 0 and at.sceneWidth != fw: int32(int64(at.x) * fw div at.sceneWidth) else: at.x
  let y = if at.sceneHeight > 0 and at.sceneHeight != fh: int32(int64(at.y) * fh div at.sceneHeight) else: at.y
  (x - s.hotX * k, y - s.hotY * k, k)

proc cursorRect*(view: MarkView, at: CursorAt): MarkRect =
  ## The panel rectangle the cursor covers, clipped to the panel; `w` 0 when
  ## none of it is on the panel.
  let (fw, fh) = view.viewerSize
  let (ox, oy, k) = view.spriteOrigin(at)
  let s = sprite(at.shape)
  let x0 = max(0'i32, ox)
  let y0 = max(0'i32, oy)
  let x1 = min(fw, ox + s.width * k)
  let y1 = min(fh, oy + s.height * k)
  if x1 <= x0 or y1 <= y0:
    return MarkRect()
  let (ax, ay) = view.toPanel(x0, y0)
  let (bx, by) = view.toPanel(x1 - 1, y1 - 1)
  MarkRect(x: min(ax, bx), y: min(ay, by), w: abs(ax - bx) + 1, h: abs(ay - by) + 1)

proc drawCursorSprite*(view: MarkView, at: CursorAt, rect: MarkRect, pixels: MarkPixels,
    src: ptr UncheckedArray[uint8], srcStride: int32, dst: ptr UncheckedArray[uint8],
    dstStride: int32) =
  ## The cursor over `rect` (`cursorRect`'s): every pixel composed from `src`
  ## (what the panel showed there, `rect`'s first pixel first, `srcStride`
  ## bytes a row) into `dst` (the same shape). A pixel the cursor leaves
  ## alone is copied as it was; one it covers is black or white, which is
  ## the same bytes in every channel order.
  let (ox, oy, k) = view.spriteOrigin(at)
  let s = sprite(at.shape)
  let bpp = pixels.bytesPerPixel
  for row in 0'i32 ..< rect.h:
    let srcRow = cast[ptr UncheckedArray[uint8]](src[row * srcStride].addr)
    let dstRow = cast[ptr UncheckedArray[uint8]](dst[row * dstStride].addr)
    if srcRow != dstRow:
      copyMem(dstRow, srcRow, rect.w * bpp)
    for col in 0'i32 ..< rect.w:
      let (fx, fy) = view.toViewer(rect.x + col, rect.y + row)
      let sx = fx - ox
      let sy = fy - oy
      if sx < 0 or sy < 0:
        continue
      let (cx, cy) = (sx div k, sy div k)
      if cx >= s.width or cy >= s.height:
        continue
      let c = s.pixels[cy * s.width + cx]
      if c == '.':
        continue
      let value = if c == 'X': 0'u8 else: 255'u8
      if bpp == 2:
        let d = cast[ptr UncheckedArray[uint16]](dstRow)
        d[col] = if value == 0: 0'u16 else: 0xFFFF'u16
      else:
        let d = cast[ptr UncheckedArray[uint8]](dstRow[col * bpp].addr)
        d[pixels.redByte] = value
        d[pixels.greenByte] = value
        d[pixels.blueByte] = value

{.pop.}
