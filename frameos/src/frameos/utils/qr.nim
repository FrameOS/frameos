## QR codes (ISO/IEC 18004, model 2) at error correction level L, and the
## pixie renderer the QR app and the system screens draw them with.
##
## This replaced the QRgen package (2026-10-18), which was 21.9 KB of the
## ESP32 firmware: its templates expanded the reserved-area test once per
## mask, its tables carried all four levels and every caller asked for L.
## The codes are QRgen's module for module (the same mode, the same version:
## the smallest that holds one character MORE than the text, which was
## QRgen's rule; the same mask, scored by QRgen's penalty before the format
## bits are drawn), and `qrImage` lays them out in QRgen's pixels, so a
## scene's QR code did not move. One difference on purpose: QRgen wrote a
## numeric group with a leading zero in 7 or 4 bits (a tutorial's mistake)
## where the standard has 10, so digit-only text with such a group scanned
## as something else. tests/test_qr.nim pins all of it.

import pixie

# On the ESP32 the module runs unchecked, which is 40% of its flash: every
# index is in range by construction (the grid is size x size, the codewords
# are the version's, qrImage clamps what a scene can pass), and everywhere
# else, the tests included, the same code runs with every check on.
when defined(frameosEmbedded):
  {.push boundChecks: off, overflowChecks: off, rangeChecks: off.}

const
  EccPerBlock = [7'u8, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
    ## Level L error correction codewords per block, by version - 1.
  Blocks = [1'u8, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
    8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25]
    ## Level L blocks, by version - 1.
  Alphanumeric = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"

type
  QrCode* = object
    size*: int ## Modules per side.
    cells: seq[uint8] ## 1: dark, 2: a function module (no data, no mask).

proc `[]`*(qr: QrCode, x, y: int): bool = (qr.cells[y * qr.size + x] and 1) != 0

proc put(qr: var QrCode, x, y: int, dark: bool) =
  qr.cells[y * qr.size + x] = 2 or ord(dark).uint8

proc rawCodewords(version: int): int =
  ## The modules a symbol has left for codewords once its function patterns
  ## are drawn, in whole bytes.
  result = (16 * version + 128) * version + 64
  if version >= 2:
    let n = version div 7 + 2
    result -= (25 * n - 10) * n - 55
    if version >= 7: result -= 36
  result = result div 8

proc dataCodewords(version: int): int =
  rawCodewords(version) - EccPerBlock[version - 1].int * Blocks[version - 1].int

proc gfMul(x, y: int): int =
  for i in countdown(7, 0):
    result = (result shl 1) xor ((result shr 7) * 0x11D)
    result = result xor (((y shr i) and 1) * x)

proc putBits(data: var seq[uint8], bitLen: var int, value, count: int) =
  for i in countdown(count - 1, 0):
    if ((value shr i) and 1) != 0:
      data[bitLen shr 3] = data[bitLen shr 3] or (0x80'u8 shr (bitLen and 7))
    inc bitLen

proc payloadBits(mode, chars: int): int =
  case mode
  of 1: chars div 3 * 10 + [0, 4, 7][chars mod 3]
  of 2: chars div 2 * 11 + chars mod 2 * 6
  else: chars * 8

proc drawInfo(qr: var QrCode, format, version: int) =
  ## The format bits (both copies) and, from version 7, the version bits.
  ## Drawn light first to reserve their modules, for real once the mask is
  ## chosen.
  let n = qr.size
  for i in 0 .. 14:
    let bit = ((format shr i) and 1) != 0
    # Around the top-left finder, stepping over the timing patterns...
    if i < 8: qr.put(8, i + ord(i >= 6), bit) else: qr.put(14 - i + ord(i == 8), 8, bit)
    # ...and split between the other two.
    if i < 8: qr.put(n - 1 - i, 8, bit) else: qr.put(8, n - 15 + i, bit)
  if n >= 45:
    for i in 0 ..< 18:
      let bit = ((version shr i) and 1) != 0
      qr.put(n - 11 + i mod 3, i div 3, bit)
      qr.put(i div 3, n - 11 + i mod 3, bit)

proc applyMask(qr: var QrCode, mask: int) =
  for y in 0 ..< qr.size:
    for x in 0 ..< qr.size:
      let flip = case mask
        of 0: (x + y) mod 2 == 0
        of 1: y mod 2 == 0
        of 2: x mod 3 == 0
        of 3: (x + y) mod 3 == 0
        of 4: (x div 3 + y div 2) mod 2 == 0
        of 5: x * y mod 2 + x * y mod 3 == 0
        of 6: (x * y mod 2 + x * y mod 3) mod 2 == 0
        else: ((x + y) mod 2 + x * y mod 3) mod 2 == 0
      let i = y * qr.size + x
      if flip and qr.cells[i] < 2: qr.cells[i] = 1 - qr.cells[i]

proc penalty(qr: QrCode): int =
  let n = qr.size
  for vertical in [false, true]:
    for i in 0 ..< n:
      var run = 0
      var window = 0
      var previous = false
      for j in 0 ..< n:
        let dark = (qr.cells[if vertical: j * n + i else: i * n + j] and 1) != 0
        if j > 0 and dark == previous:
          inc run
        else:
          if run >= 5: result += run - 2
          run = 1
        previous = dark
        window = ((window shl 1) or ord(dark)) and 0x7FF
        if j >= 10 and (window == 0b10111010000 or window == 0b00001011101): result += 40
      if run >= 5: result += run - 2
  var darkCount = 0
  for i in 0 ..< n * n:
    let dark = qr.cells[i] and 1
    darkCount += dark.int
    if i mod n < n - 1 and i < n * (n - 1) and
        (qr.cells[i + 1] and 1) == dark and (qr.cells[i + n] and 1) == dark and (qr.cells[i + n + 1] and 1) == dark:
      result += 3
  result += abs(darkCount * 100 div (n * n) * 2 - 99) div 10 * 10

proc qrEncode*(text: string): QrCode =
  ## Raises ValueError when the text does not fit a version 40 symbol.
  var mode = 1 # numeric; 2 alphanumeric, 4 bytes: the mode indicator
  for c in text:
    if Alphanumeric.find(c) < 0:
      mode = 4
      break
    if c notin {'0' .. '9'}: mode = 2
  let modeIndex = mode shr 1
  var version = 1
  var countBits = 0
  while true:
    countBits = (if version <= 9: [10, 9, 8] elif version <= 26: [12, 11, 16] else: [14, 13, 16])[modeIndex]
    if 4 + countBits + payloadBits(mode, text.len + 1) <= dataCodewords(version) * 8: break
    if version == 40: raise newException(ValueError, "Too much text for a QR code: " & $text.len & " characters")
    inc version

  let capacity = dataCodewords(version)
  var data = newSeq[uint8](capacity)
  var bitLen = 0
  data.putBits(bitLen, mode, 4)
  data.putBits(bitLen, text.len, countBits)
  var i = 0
  while i < text.len:
    let rest = text.len - i
    case mode
    of 1:
      let digits = min(3, rest)
      var value = 0
      for k in 0 ..< digits: value = value * 10 + ord(text[i + k]) - ord('0')
      data.putBits(bitLen, value, [0, 4, 7, 10][digits])
      i += digits
    of 2:
      if rest >= 2:
        data.putBits(bitLen, Alphanumeric.find(text[i]) * 45 + Alphanumeric.find(text[i + 1]), 11)
        i += 2
      else:
        data.putBits(bitLen, Alphanumeric.find(text[i]), 6)
        i += 1
    else:
      data.putBits(bitLen, ord(text[i]), 8)
      i += 1
  # The terminator and the bits up to a byte are zeros, which `data` holds.
  var pad = 0xEC
  for k in (min(bitLen + 4, capacity * 8) + 7) div 8 ..< capacity:
    data[k] = pad.uint8
    pad = pad xor 0xFD

  # Error correction per block, data and ECC interleaved block by block.
  let
    blocks = Blocks[version - 1].int
    ecc = EccPerBlock[version - 1].int
    raw = rawCodewords(version)
    shortBlocks = blocks - raw mod blocks
    shortData = raw div blocks - ecc
  var divisor = newSeq[int](ecc)
  divisor[^1] = 1
  var root = 1
  for _ in 0 ..< ecc:
    for j in 0 ..< ecc:
      divisor[j] = gfMul(divisor[j], root)
      if j + 1 < ecc: divisor[j] = divisor[j] xor divisor[j + 1]
    root = gfMul(root, 2)
  var codewords = newSeq[uint8](raw)
  var offset = 0
  for b in 0 ..< blocks:
    var remainder = newSeq[int](ecc)
    for k in 0 ..< shortData + ord(b >= shortBlocks):
      let value = data[offset + k].int
      codewords[if k < shortData: k * blocks + b else: shortData * blocks + b - shortBlocks] = value.uint8
      let factor = value xor remainder[0]
      for j in 0 ..< ecc:
        remainder[j] = (if j + 1 < ecc: remainder[j + 1] else: 0) xor gfMul(divisor[j], factor)
    for j in 0 ..< ecc: codewords[capacity + j * blocks + b] = remainder[j].uint8
    offset += shortData + ord(b >= shortBlocks)

  # Function patterns: timing, finders with their separators, alignment.
  let n = version * 4 + 17
  result = QrCode(size: n, cells: newSeq[uint8](n * n))
  for k in 0 ..< n:
    result.put(6, k, k mod 2 == 0)
    result.put(k, 6, k mod 2 == 0)
  for (cx, cy) in [(3, 3), (n - 4, 3), (3, n - 4)]:
    for dy in -4 .. 4:
      for dx in -4 .. 4:
        if cx + dx in 0 ..< n and cy + dy in 0 ..< n:
          let ring = max(abs(dx), abs(dy))
          result.put(cx + dx, cy + dy, ring != 2 and ring != 4)
  if version > 1:
    let count = version div 7 + 2
    let step = if version == 32: 26 else: (version * 4 + count * 2 + 1) div (count * 2 - 2) * 2
    var positions = newSeq[int](count)
    positions[0] = 6
    for k in 1 ..< count: positions[k] = n - 7 - (count - 1 - k) * step
    for a in 0 ..< count:
      for b in 0 ..< count:
        if (a == 0 and b == 0) or (a == 0 and b == count - 1) or (a == count - 1 and b == 0): continue
        for dy in -2 .. 2:
          for dx in -2 .. 2:
            result.put(positions[a] + dx, positions[b] + dy, max(abs(dx), abs(dy)) != 1)
  result.drawInfo(0, 0)
  result.put(8, n - 8, true)

  # Data in two-module columns, zigzagging up and down from the right.
  var bit = 0
  var right = n - 1
  while right >= 1:
    if right == 6: right = 5
    for vert in 0 ..< n:
      for j in 0 .. 1:
        let x = right - j
        let y = if ((right + 1) and 2) == 0: n - 1 - vert else: vert
        if result.cells[y * n + x] < 2 and bit < raw * 8:
          result.cells[y * n + x] = (codewords[bit shr 3] shr (7 - (bit and 7))) and 1
          inc bit
    right -= 2

  var best = 0
  var bestPenalty = high(int)
  for mask in 0 .. 7:
    result.applyMask(mask)
    let score = result.penalty()
    if score < bestPenalty:
      best = mask
      bestPenalty = score
    result.applyMask(mask)
  result.applyMask(best)
  var format = 8 or best # level L is 01
  for _ in 0 ..< 10: format = (format shl 1) xor ((format shr 9) * 0x537)
  format = (((8 or best) shl 10) or format) xor 0x5412
  var versionBits = version
  for _ in 0 ..< 12: versionBits = (versionBits shl 1) xor ((versionBits shr 11) * 0x1F25)
  result.drawInfo(format, (version shl 12) or versionBits)

proc fillRounded(image: Image, x, y, side, radius: float32, color: Color) =
  let path = newPath()
  path.roundedRect(rect(x, y, side, side), radius, radius, radius, radius)
  image.fillPath(path, color)

proc qrImage*(qr: QrCode, pixels: int, padding = 1, dark = color(0, 0, 0), light = color(1, 1, 1),
              alRad, moRad, moSep = 0.0): Image =
  ## `qr` at most `pixels` square: whole pixels per module, `padding`
  ## modules of quiet zone, the rest split around it. `alRad` rounds the
  ## finder patterns, `moRad` the modules and `moSep` spaces them, each a
  ## percentage. Colors are drawn opaque.
  let
    n = qr.size
    # Bounds for the unchecked arithmetic below; QRgen took a uint8 padding.
    pixels = clamp(pixels, 1, 1 shl 15)
    padding = clamp(padding, 0, 255)
    unit = pixels div (n + padding * 2)
    margin = pixels mod (n + padding * 2) div 2 + unit * padding
    extent = min(pixels, unit * n + (margin + 1) * 2)
    alRad = clamp(alRad, 0, 100).float32
    moRad = clamp(moRad, 0, 100).float32
    moSep = clamp(moSep, 0, 100).float32
    dark = color(dark.r, dark.g, dark.b)
    light = color(light.r, light.g, light.b)
    shaped = moRad > 0 or moSep > 0
    # float32 with QRgen's own expressions: the same bits, the same edges.
    sep: float32 = unit.float32 * 0.4 * moSep / 100
    side: float32 = unit.float32 - sep * 2
    radius: float32 = (unit.float32 / 2 - sep) * moRad / 100
    darkRgbx = dark.rgbx
  result = newImage(extent, extent)
  result.fill(light)
  for y in 0 ..< n:
    for x in 0 ..< n:
      if not qr[x, y] or ((shaped or alRad > 0) and (x < 7 or x >= n - 7) and (y < 7 or y >= n - 7) and
          not (x >= n - 7 and y >= n - 7)):
        continue
      if shaped:
        result.fillRounded((margin + x * unit).float32 + sep, (margin + y * unit).float32 + sep, side, radius, dark)
      else:
        for py in 0 ..< unit:
          for px in 0 ..< unit:
            result.unsafe[margin + x * unit + px, margin + y * unit + py] = darkRgbx
  if shaped or alRad > 0:
    let finder: float32 = 3.5 * alRad / 100
    for level in 0 .. 2:
      let r = unit.float32 * (
        if level == 0: finder
        elif finder == 0: 0'f32
        elif finder - level.float32 <= 0: 1'f32 / (level * 2).float32
        else: finder - level.float32)
      let s = ((7 - level * 2) * unit).float32
      for (fx, fy) in [(0, 0), (n - 7, 0), (0, n - 7)]:
        result.fillRounded((margin + (fx + level) * unit).float32, (margin + (fy + level) * unit).float32, s, r,
          if level == 1: light else: dark)

when defined(frameosEmbedded):
  {.pop.}
