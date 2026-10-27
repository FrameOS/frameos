## Tailwind class names, read into the styles the UI layout uses
## (`frameos/ui/layout.nim`, `docs/jsx-ui.md`).
##
## A subset of Tailwind CSS 3: flexbox and grid, sizing, spacing, positions,
## colors from its palette, borders, corners, opacity, gradients and text.
## Lengths are pixels of the image the tree is drawn into: `p-2` is 8 px, as
## in a browser at the default 16 px rem. The `sm:` .. `2xl:` breakpoints and
## `portrait:` / `landscape:` test that image's size. A class this does not
## know draws nothing, as an unknown class does in a browser.
##
## Flash is what this costs on an ESP32, so classes are read in place (no
## token is copied) against word lists kept as single strings.

import std/strutils
import pixie

type
  LenKind* = enum
    lkAuto, lkPx, lkPct

  Len* = object
    kind*: LenKind
    v*: float32

  Display* = enum
    diBlock, diFlex, diGrid, diNone

  Align* = enum
    alAuto, alStart, alCenter, alEnd, alStretch

  Justify* = enum
    juStart, juCenter, juEnd, juBetween, juAround, juEvenly

  Fit* = enum
    fitFill, fitContain, fitCover

  Box* = object
    ## What an element's classes say about its own box. Not inherited.
    display*: Display
    col*: bool          ## flex-col; a block lays its children out as a column
    wrap*, absolute*: bool
    items*, self*: Align
    justify*: Justify
    grow*, shrink*: float32
    basis*, w*, h*, minW*, minH*, maxW*, maxH*: Len
    pad*: array[4, float32] ## top, right, bottom, left
    margin*: array[4, Len]
    inset*: array[4, Len]
    gapX*, gapY*: float32
    bg*: ColorRGBA
    gradient*: int      ## 0 none, else 1..8: t, tr, r, br, b, bl, l, tl
    gradFrom*, gradVia*, gradTo*: ColorRGBA
    hasVia*, hasTo*: bool
    border*: array[4, float32]
    borderColor*: ColorRGBA
    radius*: array[4, float32] ## top-left, top-right, bottom-right, bottom-left
    opacity*: float32
    cols*, span*: int
    aspect*: float32
    fit*: Fit

  Text* = object
    ## The text style. Inherited: a child starts from its parent's.
    color*: ColorRGBA
    size*: float32
    lineHeight*: float32 ## px, from the `text-*` size
    leading*: float32    ## `leading-*`, which wins over it: < 0 unset
    leadingPx*: bool     ## leading is px, else a multiple of the size
    weight*: int
    italic*, underline*, strike*, nowrap*: bool
    align*: HorizontalAlignment
    textCase*: TextCase
    family*: int         ## fontFamilies index: 0 the default face
    lines*: int          ## line-clamp / truncate: 0 is no clamp

  Head = enum
    hFlex = "flex", hInline = "inline", hGrid = "grid", hBlock = "block",
    hContents = "contents", hHidden = "hidden", hItems = "items", hSelf = "self",
    hJustify = "justify", hGrow = "grow", hShrink = "shrink", hBasis = "basis",
    hAbsolute = "absolute", hFixed = "fixed", hRelative = "relative",
    hStatic = "static", hGap = "gap", hSpace = "space", hW = "w", hH = "h",
    hSize = "size", hMin = "min", hMax = "max", hInset = "inset", hTop = "top",
    hRight = "right", hBottom = "bottom", hLeft = "left", hCol = "col",
    hRounded = "rounded", hBorder = "border", hBg = "bg", hFrom = "from",
    hVia = "via", hTo = "to", hOpacity = "opacity", hText = "text",
    hFont = "font", hLeading = "leading", hLine = "line", hItalic = "italic",
    hNot = "not", hUnderline = "underline", hNo = "no",
    hUppercase = "uppercase", hLowercase = "lowercase",
    hCapitalize = "capitalize", hNormal = "normal", hTruncate = "truncate",
    hWhitespace = "whitespace", hObject = "object", hAspect = "aspect"

proc words(T: typedesc[enum]): string {.compileTime.} =
  for value in T:
    result.add $value & " "

const
  heads = words(Head)
  palette: array[22 * 11, uint32] = [
    0xf8fafc'u32, 0xf1f5f9, 0xe2e8f0, 0xcbd5e1, 0x94a3b8, 0x64748b, 0x475569, 0x334155, 0x1e293b, 0x0f172a, 0x020617, # slate
    0xf9fafb, 0xf3f4f6, 0xe5e7eb, 0xd1d5db, 0x9ca3af, 0x6b7280, 0x4b5563, 0x374151, 0x1f2937, 0x111827, 0x030712, # gray
    0xfafafa, 0xf4f4f5, 0xe4e4e7, 0xd4d4d8, 0xa1a1aa, 0x71717a, 0x52525b, 0x3f3f46, 0x27272a, 0x18181b, 0x09090b, # zinc
    0xfafafa, 0xf5f5f5, 0xe5e5e5, 0xd4d4d4, 0xa3a3a3, 0x737373, 0x525252, 0x404040, 0x262626, 0x171717, 0x0a0a0a, # neutral
    0xfafaf9, 0xf5f5f4, 0xe7e5e4, 0xd6d3d1, 0xa8a29e, 0x78716c, 0x57534e, 0x44403c, 0x292524, 0x1c1917, 0x0c0a09, # stone
    0xfef2f2, 0xfee2e2, 0xfecaca, 0xfca5a5, 0xf87171, 0xef4444, 0xdc2626, 0xb91c1c, 0x991b1b, 0x7f1d1d, 0x450a0a, # red
    0xfff7ed, 0xffedd5, 0xfed7aa, 0xfdba74, 0xfb923c, 0xf97316, 0xea580c, 0xc2410c, 0x9a3412, 0x7c2d12, 0x431407, # orange
    0xfffbeb, 0xfef3c7, 0xfde68a, 0xfcd34d, 0xfbbf24, 0xf59e0b, 0xd97706, 0xb45309, 0x92400e, 0x78350f, 0x451a03, # amber
    0xfefce8, 0xfef9c3, 0xfef08a, 0xfde047, 0xfacc15, 0xeab308, 0xca8a04, 0xa16207, 0x854d0e, 0x713f12, 0x422006, # yellow
    0xf7fee7, 0xecfccb, 0xd9f99d, 0xbef264, 0xa3e635, 0x84cc16, 0x65a30d, 0x4d7c0f, 0x3f6212, 0x365314, 0x1a2e05, # lime
    0xf0fdf4, 0xdcfce7, 0xbbf7d0, 0x86efac, 0x4ade80, 0x22c55e, 0x16a34a, 0x15803d, 0x166534, 0x14532d, 0x052e16, # green
    0xecfdf5, 0xd1fae5, 0xa7f3d0, 0x6ee7b7, 0x34d399, 0x10b981, 0x059669, 0x047857, 0x065f46, 0x064e3b, 0x022c22, # emerald
    0xf0fdfa, 0xccfbf1, 0x99f6e4, 0x5eead4, 0x2dd4bf, 0x14b8a6, 0x0d9488, 0x0f766e, 0x115e59, 0x134e4a, 0x042f2e, # teal
    0xecfeff, 0xcffafe, 0xa5f3fc, 0x67e8f9, 0x22d3ee, 0x06b6d4, 0x0891b2, 0x0e7490, 0x155e75, 0x164e63, 0x083344, # cyan
    0xf0f9ff, 0xe0f2fe, 0xbae6fd, 0x7dd3fc, 0x38bdf8, 0x0ea5e9, 0x0284c7, 0x0369a1, 0x075985, 0x0c4a6e, 0x082f49, # sky
    0xeff6ff, 0xdbeafe, 0xbfdbfe, 0x93c5fd, 0x60a5fa, 0x3b82f6, 0x2563eb, 0x1d4ed8, 0x1e40af, 0x1e3a8a, 0x172554, # blue
    0xeef2ff, 0xe0e7ff, 0xc7d2fe, 0xa5b4fc, 0x818cf8, 0x6366f1, 0x4f46e5, 0x4338ca, 0x3730a3, 0x312e81, 0x1e1b4b, # indigo
    0xf5f3ff, 0xede9fe, 0xddd6fe, 0xc4b5fd, 0xa78bfa, 0x8b5cf6, 0x7c3aed, 0x6d28d9, 0x5b21b6, 0x4c1d95, 0x2e1065, # violet
    0xfaf5ff, 0xf3e8ff, 0xe9d5ff, 0xd8b4fe, 0xc084fc, 0xa855f7, 0x9333ea, 0x7e22ce, 0x6b21a8, 0x581c87, 0x3b0764, # purple
    0xfdf4ff, 0xfae8ff, 0xf5d0fe, 0xf0abfc, 0xe879f9, 0xd946ef, 0xc026d3, 0xa21caf, 0x86198f, 0x701a75, 0x4a044e, # fuchsia
    0xfdf2f8, 0xfce7f3, 0xfbcfe8, 0xf9a8d4, 0xf472b6, 0xec4899, 0xdb2777, 0xbe185d, 0x9d174d, 0x831843, 0x500724, # pink
    0xfff1f2, 0xffe4e6, 0xfecdd3, 0xfda4af, 0xfb7185, 0xf43f5e, 0xe11d48, 0xbe123c, 0x9f1239, 0x881337, 0x4c0519, # rose
  ]
  families = "slate gray zinc neutral stone red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose "
  shades = "50 100 200 300 400 500 600 700 800 900 950 "
  # text-xs .. text-9xl: the size and the line height that comes with it
  textSizes = "xs sm base lg xl 2xl 3xl 4xl 5xl 6xl 7xl 8xl 9xl "
  textPx: array[13, array[2, uint8]] = [[12'u8, 16'u8], [14, 20], [16, 24], [18, 28],
    [20, 28], [24, 32], [30, 36], [36, 40], [48, 48], [60, 60], [72, 72], [96, 96], [128, 128]]
  widthNames = "xs sm md lg xl 2xl 3xl 4xl 5xl 6xl 7xl " # max-w-*, in rem
  widthRem = [20'u8, 24, 28, 32, 36, 42, 48, 56, 64, 72, 80]
  radiusNames = "none sm md lg xl 2xl 3xl full "
  radiusPx = [0'u16, 2, 6, 8, 12, 16, 24, 9999]
  sideNames = "x y t r b l s e "
  sideMasks = [10'u8, 5, 1, 2, 4, 8, 8, 2] # bits: top, right, bottom, left
  cornerNames = "t r b l tl tr br bl "
  cornerMasks = [3'u8, 6, 12, 9, 1, 2, 4, 8] # bits: tl, tr, br, bl
  leadingNames = "none tight snug normal relaxed loose "
  leadingRatio = [1'f32, 1.25, 1.375, 1.5, 1.625, 2]
  weightNames = "thin extralight light normal medium semibold bold extrabold black "
  alignNames = "start center end stretch baseline auto normal between around evenly "

var fontFamilies* {.threadvar.}: seq[string]
  ## Names for Text.family: the default face, the generic families, and the
  ## ones `font-[Name]` asked for (at most 16). Per thread, as layouts are.

{.push boundChecks: off, overflowChecks: off, rangeChecks: off, raises: [].}

var rootW {.threadvar.}, rootH {.threadvar.}: float32
  # the image's size, for vw, vh, screen and breakpoints

proc pick(s: string, a, b: int, list: string): int =
  ## Where s[a ..< b] is in `list` (words, each followed by a space), or -1.
  let n = b - a
  if n <= 0:
    return -1
  var
    i = 0
    index = 0
  while i < list.len:
    var j = i
    while list[j] != ' ':
      inc j
    if j - i == n and equalMem(unsafeAddr list[i], unsafeAddr s[a], n):
      return index
    inc index
    i = j + 1
  -1

proc number*(s: string, a, b: int, value: var float32): bool =
  ## A plain decimal number in s[a ..< b]: "4", "0.5", "-2". No exponents.
  var
    i = a
    whole = 0'f32
    scale = 1'f32
    neg = false
    digits = false
  if i < b and s[i] == '-':
    neg = true
    inc i
  while i < b and s[i] in {'0' .. '9'}:
    whole = whole * 10 + float32(ord(s[i]) - ord('0'))
    digits = true
    inc i
  if i < b and s[i] == '.':
    inc i
    while i < b and s[i] in {'0' .. '9'}:
      scale /= 10
      whole += float32(ord(s[i]) - ord('0')) * scale
      digits = true
      inc i
  if i != b or not digits:
    return false
  value = if neg: -whole else: whole
  true

proc px*(v: float32): Len = Len(kind: lkPx, v: v)

proc isAuto*(l: Len): bool {.inline.} = l.kind == lkAuto

proc resolve*(l: Len, base: float32): float32 =
  ## Pixels, a percentage of `base`, or -1 for auto (and for a percentage of
  ## a size that is not known, which CSS also treats as auto).
  case l.kind
  of lkPx: l.v
  of lkPct: (if base >= 0: l.v * base / 100 else: -1)
  of lkAuto: -1

proc initBox*(): Box =
  result.margin = [px(0), px(0), px(0), px(0)] # auto only when m-auto says so
  result.shrink = 1
  result.opacity = 1
  result.items = alStretch
  result.borderColor = rgba(0xe5, 0xe7, 0xeb, 255) # gray-200, Tailwind's default

proc initText*(): Text =
  result.color = rgba(0, 0, 0, 255)
  result.size = 16
  result.lineHeight = 24
  result.leading = -1
  result.weight = 400

proc bracketed(s: string, a, b: int): bool {.inline.} =
  b - a > 2 and s[a] == '[' and s[b - 1] == ']'

proc ends(s: string, a, b: int, suffix: static string): bool {.inline.} =
  b - a > suffix.len and s.continuesWith(suffix, b - suffix.len)

proc unitLength(s: string, a, b: int, l: var Len): bool =
  ## The inside of `[...]`: 12px, 12, 1.5rem, 2em, 5vw, 5vh, 50%.
  var
    v: float32
    stop = b
    factor = 1'f32
    pct = false
  if s.ends(a, b, "%"): stop = b - 1; pct = true
  elif s.ends(a, b, "px"): stop = b - 2
  elif s.ends(a, b, "rem"): stop = b - 3; factor = 16
  elif s.ends(a, b, "em"): stop = b - 2; factor = 16
  elif s.ends(a, b, "vw"): stop = b - 2; factor = rootW / 100
  elif s.ends(a, b, "vh"): stop = b - 2; factor = rootH / 100
  if not number(s, a, stop, v):
    return false
  l = if pct: Len(kind: lkPct, v: v) else: px(v * factor)
  true

proc length(s: string, a, b: int, vertical: bool, l: var Len): bool =
  ## A spacing or sizing value: the 4 px scale, px, full, screen, auto,
  ## fractions and `[...]`.
  if bracketed(s, a, b):
    return unitLength(s, a + 1, b - 1, l)
  case pick(s, a, b, "px auto fit min max full screen ")
  of 0: l = px(1)
  of 1, 2, 3, 4: l = Len()
  of 5: l = Len(kind: lkPct, v: 100)
  of 6: l = px(if vertical: rootH else: rootW)
  else:
    var slash = a
    while slash < b and s[slash] != '/':
      inc slash
    var x, y: float32
    if slash < b:
      if not number(s, a, slash, x) or not number(s, slash + 1, b, y) or y == 0:
        return false
      l = Len(kind: lkPct, v: x * 100 / y)
    elif number(s, a, b, x):
      l = px(x * 4)
    else:
      return false
  true

proc pxLength(s: string, a, b: int, v: var float32): bool =
  var l: Len
  if length(s, a, b, false, l) and l.kind == lkPx:
    v = l.v
    return true

proc color(s: string, a, b: int, c: var ColorRGBA): bool =
  ## black, white, transparent, a palette color (red-500) or `[...]` (any
  ## CSS color), each with an optional `/opacity` (red-500/50).
  var
    stop = b
    alpha = 1'f32
  if b > a and s[b - 1] != ']':
    var k = b - 1
    while k > a and s[k] != '/':
      dec k
    if k > a:
      var v: float32
      if not number(s, k + 1, b, v):
        return false
      alpha = clamp(v / 100, 0, 1)
      stop = k
  if bracketed(s, a, stop):
    try:
      c = parseHtmlColor(s[a + 1 ..< stop - 1]).rgba
    except CatchableError:
      return false
  else:
    case pick(s, a, stop, "black white transparent ")
    of 0: c = rgba(0, 0, 0, 255)
    of 1: c = rgba(255, 255, 255, 255)
    of 2: c = rgba(0, 0, 0, 0)
    else:
      var dash = stop - 1
      while dash > a and s[dash] != '-':
        dec dash
      let
        family = pick(s, a, dash, families)
        shade = pick(s, dash + 1, stop, shades)
      if family < 0 or shade < 0:
        return false
      let v = palette[family * 11 + shade]
      c = rgba(uint8(v shr 16), uint8((v shr 8) and 255), uint8(v and 255), 255)
  c.a = uint8(c.a.float32 * alpha + 0.5)
  true

proc setMasked(sides: var array[4, float32], mask: uint8, v: float32) =
  for i in 0 .. 3:
    if (mask and (1'u8 shl i)) != 0:
      sides[i] = v

proc setMasked(sides: var array[4, Len], mask: uint8, v: Len) =
  for i in 0 .. 3:
    if (mask and (1'u8 shl i)) != 0:
      sides[i] = v

proc align(index: int): Align =
  case index
  of 0: alStart
  of 1: alCenter
  of 2: alEnd
  of 3: alStretch
  of 4: alStart # baseline: start is the nearest this layout has
  else: alAuto

proc applyClass(box: var Box, text: var Text, s: string, a, b: int, neg: bool) =
  ## One class, s[a ..< b] (a leading `-` already taken off: `neg`).
  var dash = a
  while dash < b and s[dash] != '-':
    inc dash
  let r = min(dash + 1, b) # the value after the first dash
  var
    l: Len
    c: ColorRGBA
    v: float32
  # The value's own first dash: `x` in gap-x-4, `t` in rounded-t-lg.
  var subDash = r
  while subDash < b and s[subDash] != '-':
    inc subDash
  let sub = if subDash < b: subDash + 1 else: b
  template signed(x: Len): Len =
    (var y = x; (if neg: y.v = -y.v); y)
  # p-4, px-2, mt-1, m-auto: the side is the letter after p or m.
  if (s[a] == 'p' or s[a] == 'm') and dash - a <= 2 and r < b:
    var mask = 15'u8
    if dash - a == 2:
      let i = pick(s, a + 1, dash, sideNames)
      mask = if i < 0: 0'u8 else: sideMasks[i]
    if mask != 0 and length(s, r, b, false, l):
      if s[a] == 'p':
        if l.kind == lkPx: box.pad.setMasked(mask, l.v)
      else:
        box.margin.setMasked(mask, signed(l))
    return
  let head = pick(s, a, dash, heads)
  if head < 0:
    return
  case Head(head)
  of hFlex:
    if r == b:
      box.display = diFlex
    else:
      case pick(s, r, b, "row col wrap nowrap 1 auto initial none row-reverse col-reverse ")
      of 0, 8: box.col = false
      of 1, 9: box.col = true
      of 2: box.wrap = true
      of 3: box.wrap = false
      # flex-1 is `1 1 0%`: a percentage, so content-sized where the
      # container's size along the axis is not known.
      of 4: box.grow = 1; box.shrink = 1; box.basis = Len(kind: lkPct, v: 0)
      of 5: box.grow = 1; box.shrink = 1; box.basis = Len()
      of 6: box.grow = 0; box.shrink = 1
      of 7: box.grow = 0; box.shrink = 0
      else: discard
  of hInline:
    box.display = [diBlock, diFlex, diGrid][max(0, pick(s, r, b, "block flex grid "))]
  of hGrid:
    if r == b:
      box.display = diGrid
    elif s.continuesWith("cols-", r) and number(s, r + 5, b, v) and v >= 1:
      box.cols = int(min(v, 64))
  of hBlock, hContents: box.display = diBlock
  of hHidden: box.display = diNone
  of hItems: box.items = align(pick(s, r, b, alignNames))
  of hSelf: box.self = align(pick(s, r, b, alignNames))
  of hJustify:
    box.justify = [juStart, juCenter, juEnd, juStart, juStart, juStart, juStart,
      juBetween, juAround, juEvenly][max(0, pick(s, r, b, alignNames))]
  of hGrow: box.grow = if r < b and s[r] == '0': 0 else: 1
  of hShrink: box.shrink = if r < b and s[r] == '0': 0 else: 1
  of hBasis:
    if length(s, r, b, false, l): box.basis = l
  of hAbsolute, hFixed: box.absolute = true
  of hRelative, hStatic: box.absolute = false
  of hGap, hSpace:
    if subDash < b and subDash - r == 1 and s[r] in {'x', 'y'}:
      if pxLength(s, sub, b, v):
        if s[r] == 'x': box.gapX = v else: box.gapY = v
    elif Head(head) == hGap and pxLength(s, r, b, v):
      box.gapX = v
      box.gapY = v
  of hW:
    if length(s, r, b, false, l): box.w = l
  of hH:
    if length(s, r, b, true, l): box.h = l
  of hSize:
    if length(s, r, b, false, l):
      box.w = l
      box.h = l
  of hMin, hMax:
    if subDash - r != 1 or s[r] notin {'w', 'h'}:
      return
    let wide = s[r] == 'w'
    let named = pick(s, sub, b, widthNames)
    if Head(head) == hMax and wide and named >= 0:
      l = px(widthRem[named].float32 * 16)
    elif not length(s, sub, b, not wide, l):
      return
    if Head(head) == hMin:
      if wide: box.minW = l else: box.minH = l
    else:
      if wide: box.maxW = l else: box.maxH = l
  of hInset:
    if subDash - r == 1 and s[r] in {'x', 'y'}:
      if length(s, sub, b, s[r] == 'y', l):
        box.inset.setMasked(if s[r] == 'x': 10'u8 else: 5'u8, signed(l))
    elif length(s, r, b, false, l):
      box.inset.setMasked(15, signed(l))
  of hTop, hRight, hBottom, hLeft:
    if length(s, r, b, Head(head) in {hTop, hBottom}, l):
      box.inset.setMasked(1'u8 shl (head - ord(hTop)), signed(l))
  of hCol:
    if s.continuesWith("span-", r):
      if s.continuesWith("full", r + 5): box.span = 1000
      elif number(s, r + 5, b, v) and v >= 1: box.span = int(min(v, 1000))
  of hRounded:
    var
      mask = 15'u8
      size = r
    let corner = pick(s, r, if subDash < b: subDash else: b, cornerNames)
    if corner >= 0:
      mask = cornerMasks[corner]
      size = sub
    if size >= b:
      box.radius.setMasked(mask, 4'f32)
    else:
      let named = pick(s, size, b, radiusNames)
      if named >= 0:
        box.radius.setMasked(mask, radiusPx[named].float32)
      elif bracketed(s, size, b) and unitLength(s, size + 1, b - 1, l) and l.kind == lkPx:
        box.radius.setMasked(mask, l.v)
  of hBorder:
    let side = pick(s, r, if subDash < b: subDash else: b, sideNames)
    if r == b:
      box.border = [1'f32, 1, 1, 1]
    elif side >= 0:
      if sub >= b: box.border.setMasked(sideMasks[side], 1'f32)
      elif number(s, sub, b, v): box.border.setMasked(sideMasks[side], v)
    elif number(s, r, b, v):
      box.border = [v, v, v, v]
    elif bracketed(s, r, b) and unitLength(s, r + 1, b - 1, l) and l.kind == lkPx:
      box.border = [l.v, l.v, l.v, l.v]
    elif color(s, r, b, c):
      box.borderColor = c
  of hBg:
    if s.continuesWith("gradient-to-", r):
      let direction = pick(s, r + 12, b, "t tr r br b bl l tl ")
      if direction >= 0: box.gradient = direction + 1
    elif color(s, r, b, c):
      box.bg = c
  of hFrom:
    if color(s, r, b, c):
      box.gradFrom = c
      if not box.hasTo:
        box.gradTo = rgba(c.r, c.g, c.b, 0)
  of hVia:
    if color(s, r, b, c):
      box.gradVia = c
      box.hasVia = true
  of hTo:
    if color(s, r, b, c):
      box.gradTo = c
      box.hasTo = true
  of hOpacity:
    if number(s, r, b, v): box.opacity = clamp(v / 100, 0, 1)
  of hText:
    let size = pick(s, r, b, textSizes)
    let place = pick(s, r, b, "left center right justify start end nowrap wrap ")
    if size >= 0:
      text.size = textPx[size][0].float32
      text.lineHeight = textPx[size][1].float32
    elif place >= 0:
      if place >= 6: text.nowrap = place == 6
      else: text.align = [LeftAlign, CenterAlign, RightAlign, LeftAlign, LeftAlign, RightAlign][place]
    elif bracketed(s, r, b) and unitLength(s, r + 1, b - 1, l) and l.kind == lkPx:
      text.size = l.v
      text.lineHeight = l.v * 1.5
    elif color(s, r, b, c):
      text.color = c
  of hFont:
    let weight = pick(s, r, b, weightNames)
    let family = pick(s, r, b, "sans serif mono ")
    if weight >= 0:
      text.weight = (weight + 1) * 100
    elif family >= 0:
      text.family = family
    elif bracketed(s, r, b):
      # font-[Ubuntu_Mono]: spaces are written as underscores
      var name = s[r + 1 ..< b - 1]
      for ch in name.mitems:
        if ch == '_': ch = ' '
      text.family = fontFamilies.find(name)
      if text.family < 0:
        text.family = 0
        if fontFamilies.len < 16:
          fontFamilies.add name
          text.family = fontFamilies.high
  of hLeading:
    let named = pick(s, r, b, leadingNames)
    text.leadingPx = false
    if named >= 0:
      text.leading = leadingRatio[named]
    elif bracketed(s, r, b) and number(s, r + 1, b - 1, v):
      text.leading = v # leading-[1.2]: a multiple, as in CSS
    elif pxLength(s, r, b, v):
      text.leading = v
      text.leadingPx = true
  of hLine:
    if s.continuesWith("clamp-", r):
      if number(s, r + 6, b, v) and v >= 1: text.lines = int(min(v, 1000))
      else: text.lines = 0
    elif pick(s, r, b, "through ") == 0:
      text.strike = true
  of hItalic: text.italic = true
  of hNot: text.italic = false
  of hUnderline: text.underline = true
  of hNo: text.underline = false; text.strike = false
  of hUppercase: text.textCase = UpperCase
  of hLowercase: text.textCase = LowerCase
  of hCapitalize: text.textCase = TitleCase
  of hNormal: text.textCase = NormalCase
  of hTruncate: text.nowrap = true; text.lines = 1
  of hWhitespace: text.nowrap = pick(s, r, b, "nowrap ") == 0
  of hObject:
    box.fit = [fitCover, fitContain, fitFill, fitFill, fitContain][max(0,
      pick(s, r, b, "cover contain fill none scale-down "))]
  of hAspect:
    box.aspect = [1'f32, 16 / 9, 0][max(0, pick(s, r, b, "square video auto "))]

proc applyClasses*(box: var Box, text: var Text, classes: string, width, height: float32) =
  ## Applies a `className` to `box` and `text`, left to right, so a later
  ## class wins as it does when Tailwind's own order agrees. `width` x
  ## `height` is the image's size.
  rootW = width
  rootH = height
  if fontFamilies.len == 0:
    fontFamilies = @["", "serif", "monospace"]
  var i = 0
  while i < classes.len:
    while i < classes.len and classes[i] in Whitespace:
      inc i
    let start = i
    var
      colon = -1
      depth = 0
    while i < classes.len and classes[i] notin Whitespace:
      if classes[i] == '[': inc depth
      elif classes[i] == ']': dec depth
      elif classes[i] == ':' and depth == 0: colon = i
      inc i
    if i == start:
      break
    # Variants: the breakpoints and the orientation are about the image;
    # hover:, focus:, dark: and the rest never apply on a frame.
    var
      a = start
      skip = false
    while colon >= 0 and a < colon:
      var k = a
      while classes[k] != ':':
        inc k
      case pick(classes, a, k, "sm md lg xl 2xl portrait landscape ")
      of 0: skip = skip or rootW < 640
      of 1: skip = skip or rootW < 768
      of 2: skip = skip or rootW < 1024
      of 3: skip = skip or rootW < 1280
      of 4: skip = skip or rootW < 1536
      of 5: skip = skip or rootW > rootH
      of 6: skip = skip or rootW < rootH
      else: skip = true
      a = k + 1
    if skip:
      continue
    if a < i and classes[a] == '!':
      inc a
    let neg = a + 1 < i and classes[a] == '-'
    if neg:
      inc a
    if a < i:
      box.applyClass(text, classes, a, i, neg)

{.pop.}
