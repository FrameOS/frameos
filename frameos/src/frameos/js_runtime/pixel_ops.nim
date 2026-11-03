## The two loops an app computing its own raster spends a frame in, on their
## own so that an ESP32 can compile them at -O2 while the JS runtime around
## them stays -Os (FRAMEOS_NIM_HOT_MODULES,
## embedded/esp32/components/frameos_nim/CMakeLists.txt). No QuickJS and no
## pixie here: `frameos.fire` and `frameos.putPixels` (app_runtime.nim) unpack
## their arguments and call in.

type Cells* = ptr UncheckedArray[uint8]

proc fireSpread*(heat: Cells; cols, rows, wind, steps: int; seed: uint32): uint32 {.raises: [].} =
  ## The PlayStation Doom fire's spread rule over a byte of heat per cell, the
  ## bottom row feeding it, `steps` times; the seed to go on from. A small LCG
  ## keeps the same seed the same fire on every frame type.
  result = seed
  for _ in 0 ..< steps:
    var y = rows - 1
    while y > 0:
      let
        row = y * cols
        above = row - cols
      var lit = false
      for x in 0 ..< cols:
        let h = heat[row + x]
        if h == 0:
          heat[above + x] = 0
          continue
        lit = true
        result = result * 1664525'u32 + 1013904223'u32
        let r = int(result shr 30) # 0..3
        var dx = x - r + wind
        while dx < 0: dx += cols
        while dx >= cols: dx -= cols
        heat[above + dx] = h - uint8(r and 1)
      if not lit:
        # A row with no heat puts every row above it out, and the row above
        # was just cleared by the loop.
        zeroMem(heat, above)
        break
      dec y

proc maxCell*(cells: Cells; count: int): uint8 {.raises: [].} =
  ## The largest index in `cells`: below the palette's length, none is left
  ## out and a frame of them covers what is under it.
  for i in 0 ..< count:
    if cells[i] > result:
      result = cells[i]

template blitLoop(T: typedesc) =
  ## Each cell a `size` square of its packed colour, rows top to bottom. With
  ## `shadow` (the cells this canvas holds already, kept up to date here) a
  ## row and a cell that did not change are not written: a cold cell costs no
  ## trip over the PSRAM bus. An index past the palette leaves the canvas.
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
    for k in 0 ..< size:
      let row = cast[ptr UncheckedArray[T]](addr first[(sy * size + k) * stride])
      var at = 0
      for sx in 0 ..< width:
        let index = src[sx].int
        if index < count and (old.isNil or src[sx] != old[sx]):
          let color = colors[index]
          for d in 0 ..< size:
            row[at + d] = color
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
