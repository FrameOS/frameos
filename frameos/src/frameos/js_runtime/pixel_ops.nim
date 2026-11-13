## The loops an app computing its own raster spends a frame in, on their own
## so that an ESP32 can compile them at -O2 while the JS runtime around them
## stays -Os (FRAMEOS_NIM_HOT_MODULES,
## embedded/esp32/components/frameos_nim/CMakeLists.txt). No QuickJS and no
## pixie here: `frameos.putPixels` and `frameos.pixels` (app_runtime.nim)
## unpack their arguments and call in. What an app simulates (a fire's spread,
## a plasma, an automaton) is the app's own JS: the runtime knows pixels, not
## rules.

type Cells* = ptr UncheckedArray[uint8]

proc maxCell*(cells: Cells; count: int): uint8 {.raises: [].} =
  ## The largest index in `cells`: below the palette's length, none is left
  ## out and a frame of them covers what is under it.
  for i in 0 ..< count:
    if cells[i] > result:
      result = cells[i]

template blitLoop(T: typedesc) =
  ## Each cell a `size` square of its packed color, rows top to bottom. With
  ## `shadow` (the cells this canvas holds already, kept up to date here) a
  ## row and a cell that did not change are not written: a cold cell costs no
  ## trip over the PSRAM bus. An index past the palette leaves the canvas.
  ##
  ## A row of cells is written once, into its first pixel row, and the span
  ## that changed is copied into the rows below it: a cell's rows are all
  ## alike, and one copy of a row is a fraction of `size` passes over it
  ## (8 px cells at 480x480 on an ESP32: 21 ms of a frame). Not when a cell
  ## in the row is left as it was: its rows below need not match the first.
  var
    top = -1
    bottom = -1
  for sy in 0 ..< height:
    let src = cast[Cells](addr cells[sy * width])
    let old = if shadow.isNil: nil else: cast[Cells](addr shadow[sy * width])
    if not old.isNil and equalMem(src, old, width):
      continue
    if top < 0:
      top = sy
    bottom = sy
    let firstRow = cast[ptr UncheckedArray[T]](addr first[sy * size * stride])
    var
      at = 0
      lo = -1
      hi = -1
      kept = false
    for sx in 0 ..< width:
      let index = src[sx].int
      if index >= count:
        kept = true
      elif old.isNil or src[sx] != old[sx]:
        let color = colors[index]
        for d in 0 ..< size:
          firstRow[at + d] = color
        if lo < 0:
          lo = at
        hi = at + size
      at += size
    if lo >= 0:
      if not kept:
        for k in 1 ..< size:
          let row = cast[ptr UncheckedArray[T]](addr first[(sy * size + k) * stride])
          copyMem(addr row[lo], addr firstRow[lo], (hi - lo) * sizeof(T))
      else:
        for k in 1 ..< size:
          let row = cast[ptr UncheckedArray[T]](addr first[(sy * size + k) * stride])
          at = 0
          for sx in 0 ..< width:
            let index = src[sx].int
            if index < count and (old.isNil or src[sx] != old[sx]):
              copyMem(addr row[at], addr firstRow[at], size * sizeof(T))
            at += size
    if not old.isNil:
      copyMem(old, src, width)
  result = (top, bottom)

proc blitCells16*(first: ptr UncheckedArray[uint16]; stride: int; cells, shadow: Cells;
    width, height, size: int; colors: ptr UncheckedArray[uint16]; count: int): tuple[top, bottom: int] {.raises: [].} =
  ## An RGB565 canvas. The rows that changed, as (first, last); -1 for none.
  blitLoop(uint16)

proc blitCells32*(first: ptr UncheckedArray[uint32]; stride: int; cells, shadow: Cells;
    width, height, size: int; colors: ptr UncheckedArray[uint32]; count: int): tuple[top, bottom: int] {.raises: [].} =
  ## An RGBX canvas.
  blitLoop(uint32)

proc blitCells8*(first: ptr UncheckedArray[uint8]; stride: int; cells, shadow: Cells;
    width, height, size: int; colors: ptr UncheckedArray[uint8]; count: int): tuple[top, bottom: int] {.raises: [].} =
  ## A grey canvas.
  blitLoop(uint8)

proc blitCells4*(data: ptr UncheckedArray[uint8]; firstIndex, stride: int; cells, shadow: Cells;
    width, height, size: int; levels: ptr UncheckedArray[uint8]; count: int): tuple[top, bottom: int] {.raises: [].} =
  ## A sixteen-grey canvas, two pixels a byte from the pixel index
  ## `firstIndex`. Every store is dithered by its place in the buffer (pixie's
  ## `storeGray4`), so `levels` holds sixteen per palette entry, one for each
  ## cell of the 4x4 ordered matrix, and no row is a copy of another.
  var
    top = -1
    bottom = -1
  let
    row0 = firstIndex div stride
    col0 = firstIndex mod stride
  for sy in 0 ..< height:
    let src = cast[Cells](addr cells[sy * width])
    let old = if shadow.isNil: nil else: cast[Cells](addr shadow[sy * width])
    if not old.isNil and equalMem(src, old, width):
      continue
    if top < 0:
      top = sy
    bottom = sy
    for k in 0 ..< size:
      let
        y = sy * size + k
        rowIndex = firstIndex + y * stride
        bayerRow = ((row0 + y) and 3) * 4
      var x = 0
      for sx in 0 ..< width:
        let index = src[sx].int
        if index < count and (old.isNil or src[sx] != old[sx]):
          let table = index * 16 + bayerRow
          for d in 0 ..< size:
            let
              at = rowIndex + x + d
              level = levels[table + ((col0 + x + d) and 3)]
              b = at shr 1
            if (at and 1) == 0:
              data[b] = (data[b] and 0x0F) or (level shl 4)
            else:
              data[b] = (data[b] and 0xF0) or level
        x += size
    if not old.isNil:
      copyMem(old, src, width)
  result = (top, bottom)

# Cells of RGBA, four bytes each (a canvas ImageData's layout): what
# `frameos.pixels` takes without a palette. The bytes are a typed array's, at
# any offset, so they are read a byte at a time: an unaligned word load is an
# exception on an ESP32. Alpha 0 leaves the pixel as it is; any other alpha is
# opaque (no blending: a cell is a pixel the app computed).

proc allOpaque*(cells: Cells; count: int): bool {.raises: [].} =
  ## Every cell has alpha: a frame of them covers what is under it.
  for i in 0 ..< count:
    if cells[i * 4 + 3] == 0:
      return false
  true

template sameCell(src, old: Cells; at: int): bool =
  src[at] == old[at] and src[at + 1] == old[at + 1] and src[at + 2] == old[at + 2] and src[at + 3] == old[at + 3]

template rgbaLoop(T: typedesc; pack: untyped) =
  ## blitLoop's shape for RGBA cells: `pack(r, g, b)` is the stored pixel.
  var
    top = -1
    bottom = -1
  let rowBytes = width * 4
  for sy in 0 ..< height:
    let src = cast[Cells](addr cells[sy * rowBytes])
    let old = if shadow.isNil: nil else: cast[Cells](addr shadow[sy * rowBytes])
    if not old.isNil and equalMem(src, old, rowBytes):
      continue
    if top < 0:
      top = sy
    bottom = sy
    let firstRow = cast[ptr UncheckedArray[T]](addr first[sy * size * stride])
    var
      at = 0
      lo = -1
      hi = -1
      kept = false
    for sx in 0 ..< width:
      let c = sx * 4
      if src[c + 3] == 0:
        kept = true
      elif old.isNil or not sameCell(src, old, c):
        let color = pack(src[c], src[c + 1], src[c + 2])
        for d in 0 ..< size:
          firstRow[at + d] = color
        if lo < 0:
          lo = at
        hi = at + size
      at += size
    if lo >= 0:
      for k in 1 ..< size:
        let row = cast[ptr UncheckedArray[T]](addr first[(sy * size + k) * stride])
        if not kept:
          copyMem(addr row[lo], addr firstRow[lo], (hi - lo) * sizeof(T))
        else:
          at = 0
          for sx in 0 ..< width:
            let c = sx * 4
            if src[c + 3] != 0 and (old.isNil or not sameCell(src, old, c)):
              copyMem(addr row[at], addr firstRow[at], size * sizeof(T))
            at += size
    if not old.isNil:
      copyMem(old, src, rowBytes)
  result = (top, bottom)

template pack565(r, g, b: uint8): uint16 =
  # pixie's rgbxToRgb565: each channel rounded to nearest.
  uint16((((r.uint32 * 249 + 1014) shr 11) shl 11) or (((g.uint32 * 253 + 505) shr 10) shl 5) or
    ((b.uint32 * 249 + 1014) shr 11))

template packRgbx(r, g, b: uint8): uint32 =
  # An opaque ColorRGBX as the word it is in memory: r, g, b, 255.
  r.uint32 or (g.uint32 shl 8) or (b.uint32 shl 16) or 0xff000000'u32

template luma8(r, g, b: uint8): uint8 =
  # pixie's rgbxToGray8: BT.601 weights in 256ths, rounded.
  uint8((r.uint32 * 77 + g.uint32 * 150 + b.uint32 * 29 + 128) shr 8)

proc blitRgba16*(first: ptr UncheckedArray[uint16]; stride: int; cells, shadow: Cells;
    width, height, size: int): tuple[top, bottom: int] {.raises: [].} =
  ## RGBA cells into an RGB565 canvas. The rows that changed; -1 for none.
  rgbaLoop(uint16, pack565)

proc blitRgba32*(first: ptr UncheckedArray[uint32]; stride: int; cells, shadow: Cells;
    width, height, size: int): tuple[top, bottom: int] {.raises: [].} =
  ## RGBA cells into an RGBX canvas.
  rgbaLoop(uint32, packRgbx)

proc blitRgba8*(first: ptr UncheckedArray[uint8]; stride: int; cells, shadow: Cells;
    width, height, size: int): tuple[top, bottom: int] {.raises: [].} =
  ## RGBA cells into a grey canvas.
  rgbaLoop(uint8, luma8)

const Bayer4x4 = [0'u8, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  ## pixie's OrderedThresholds4x4.

proc blitRgba4*(data: ptr UncheckedArray[uint8]; firstIndex, stride: int; cells, shadow: Cells;
    width, height, size: int): tuple[top, bottom: int] {.raises: [].} =
  ## RGBA cells into a sixteen-grey canvas, each pixel dithered by its place
  ## in the buffer as pixie's storeGray4 does (grayLevel16Ordered).
  var
    top = -1
    bottom = -1
  let
    rowBytes = width * 4
    row0 = firstIndex div stride
    col0 = firstIndex mod stride
  for sy in 0 ..< height:
    let src = cast[Cells](addr cells[sy * rowBytes])
    let old = if shadow.isNil: nil else: cast[Cells](addr shadow[sy * rowBytes])
    if not old.isNil and equalMem(src, old, rowBytes):
      continue
    if top < 0:
      top = sy
    bottom = sy
    for k in 0 ..< size:
      let
        y = sy * size + k
        rowIndex = firstIndex + y * stride
        bayerRow = ((row0 + y) and 3) * 4
      var x = 0
      for sx in 0 ..< width:
        let c = sx * 4
        if src[c + 3] != 0 and (old.isNil or not sameCell(src, old, c)):
          let luma = luma8(src[c], src[c + 1], src[c + 2]).uint32
          for d in 0 ..< size:
            let
              at = rowIndex + x + d
              value = luma * 15 + Bayer4x4[bayerRow + ((col0 + x + d) and 3)].uint32 * 16 + 8
              level = uint8(((value + 1) * 257) shr 16)
              b = at shr 1
            if (at and 1) == 0:
              data[b] = (data[b] and 0x0F) or (level shl 4)
            else:
              data[b] = (data[b] and 0xF0) or level
        x += size
    if not old.isNil:
      copyMem(old, src, rowBytes)
  result = (top, bottom)
