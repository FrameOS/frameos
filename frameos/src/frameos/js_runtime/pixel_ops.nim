## The loop an 8-bit palette frame (`frameos.pixels`, app_runtime.nim) spends
## its time in on an LCD, on its own so that an ESP32 can compile it at -O2
## while the JS runtime around it stays -Os (FRAMEOS_NIM_HOT_MODULES,
## embedded/esp32/components/frameos_nim/CMakeLists.txt). No QuickJS and no
## pixie here. What an app simulates or cycles is the app's own JS: the
## runtime knows cells and a palette, not effects.
##
## RGB565 only: an LCD's canvas, where a frame is a race. Any other format
## (e-paper's greys and colors, a Pi's RGBX) goes a pixel at a time through
## pixie's setPixel (app_runtime's writeCells), at no cost a refresh of
## seconds or a Pi would notice, and in a fraction of this loop's flash.

type
  Cells* = ptr UncheckedArray[uint8]
  Palette565* = array[256, uint16]
  Recolored* = array[256, bool]
    ## The palette entries whose color is not what the buffer was drawn with.

proc blitCells16*(first: ptr UncheckedArray[uint16]; stride: int; cells, known: Cells;
    width, height, size: int; colors: ptr Palette565; recolored: ptr Recolored;
    anyRecolored: bool) {.raises: [].} =
  ## Each cell a `size` square of its packed color, rows top to bottom. With
  ## `known` (the cells this buffer holds) a cell is written only when its
  ## index changed or its color did: a cold cell costs no trip over the PSRAM
  ## bus, and a cycled palette rewrites only the cells of the colors that moved.
  ##
  ## A row of cells is written once, into its first pixel row, and the span
  ## that changed is copied into the rows below it: every cell is a square of
  ## one color, so its rows are alike, and one copy of a row is a fraction of
  ## `size` passes over it (8 px cells at 480x480 on an ESP32: 21 ms of a frame).
  for sy in 0 ..< height:
    let src = cast[Cells](addr cells[sy * width])
    let old = if known.isNil: nil else: cast[Cells](addr known[sy * width])
    if not old.isNil and not anyRecolored and equalMem(src, old, width):
      continue
    let firstRow = cast[ptr UncheckedArray[uint16]](addr first[sy * size * stride])
    var
      at = 0
      lo = -1
      hi = -1
    for sx in 0 ..< width:
      let index = src[sx]
      if old.isNil or index != old[sx] or recolored[index]:
        let color = colors[index]
        for d in 0 ..< size:
          firstRow[at + d] = color
        if lo < 0:
          lo = at
        hi = at + size
      at += size
    if lo >= 0:
      for k in 1 ..< size:
        let row = cast[ptr UncheckedArray[uint16]](addr first[(sy * size + k) * stride])
        copyMem(addr row[lo], addr firstRow[lo], (hi - lo) * sizeof(uint16))
