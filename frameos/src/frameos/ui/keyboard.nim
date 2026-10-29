## The on-screen keyboard a UI's field gets when the frame has no keyboard of
## its own (`docs/jsx-ui.md` "Fields"): a US layout, drawn by the UI layout
## like any element (ui/layout.nim lays it out under the UI, which is laid
## out in what is left), its keys regions that ui/events.nim edits the field
## with. Built here as a tree of elements with Tailwind classes, the way the
## scene switcher builds its grid: no QuickJS, no second rasterizer.
##
## A page is a string, one byte a key and a newline a row; a byte below 32
## is a key that does something other than type itself (`Key`). A key's
## handler number is `KeyBase` plus that byte, so the hit test tells a key
## from an app's handler by its number alone.
##
## Flash is the budget on an ESP32: four short strings, three drawn icons,
## and classes appended in place (see the scene switcher's notes).
##
## On a round panel (frameos/panel_shape.nim) the keyboard sits higher, its
## last row where the circle is still wide enough for it, and every row is
## cut to the chord it sits on, its keys narrower where the circle is. No
## ESP32 board is round: the firmware carries the rectangle alone.

import pixie/fileformats/svg
import frameos/ui/tree
when not defined(frameosEmbedded):
  import frameos/panel_shape

{.push overflowChecks: off, rangeChecks: off, boundChecks: off, fieldChecks: off, stackTrace: off,
  lineTrace: off, raises: [].}

type
  Key* = enum
    ## The keys that are not a character, by the byte that stands for them
    ## in a page.
    kNone, kShift, kBackspace, kEnter, kLetters, kSymbols, kMore, kCapsLock

  KeyboardPage* = enum
    kpLetters, kpSymbols, kpMore, kpNumbers

const
  KeyBase* = 1 shl 20
    ## A key's handler number: KeyBase + its byte. An app's handlers are
    ## numbered from 0, never this far.
  Pages: array[KeyboardPage, string] = [
    "qwertyuiop\nasdfghjkl\n\x01zxcvbnm\x02\n\x05, .\x03",
    "1234567890\n-/:;()$&@\"\n\x06.,?!'\x02\n\x04 \x03",
    "[]{}#%^*+=\n_\\|~<>`$&@\n\x05.,?!'\x02\n\x04 \x03",
    "123-\n456.\n789\x02\n,0\x03",
  ]
  # The drawn keys, in a 24-unit box: shift's arrow, backspace and enter.
  ShiftPath = "M12 4 3.5 12.5H8V20h8v-7.5h4.5z"
  BackspacePath = "M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7zm3 4 6 6m0-6-6 6"
  EnterPath = "M20 5v6a3 3 0 0 1-3 3H5m4-4-4 4 4 4"

proc keyboardHeight*(height: int): int =
  ## How tall the keyboard is on a UI `height` px tall: four rows of keys a
  ## finger can hit, and never half of it.
  let row = clamp(height * 95 div 1000, 28, 60)
  min(4 * row + 3 * max(row div 8, 3) + 2 * max(row div 6, 4), height div 2)

proc keyboardBox*(width, height: int, round = false): (int, int) =
  ## Where the keyboard goes on a `width` x `height` UI: its top and its
  ## height. At the bottom; on a round panel with its last row four fifths of
  ## the way from the circle's centre to its rim, and the UI above it.
  let tall = keyboardHeight(height)
  result = (height - tall, tall)
  when not defined(frameosEmbedded):
    if round:
      let radius = max(min(width, height) div 2 - RoundInset, 8)
      result[0] = max(min(height div 2 + radius * 4 div 5, height) - tall, 0)

proc icon(d: string, filled: bool, size: int): SvgNode =
  var c = "shrink-0"
  c.px("size", size)
  result = SvgNode(tag: "svg", attrs: @[("viewBox", "0 0 24 24"), ("class", c)])
  result.children.add SvgNode(tag: "path", attrs: @[("d", d),
    ("fill", if filled: "currentColor" else: "none"), ("stroke", "currentColor"),
    ("stroke-width", "2"), ("stroke-linecap", "round"), ("stroke-linejoin", "round")])

proc typed*(code: int, shift: int): string =
  ## What a character key types: its own byte, a letter in capitals under
  ## shift; "" for the keys that do something else.
  if code < 32 or code > 126:
    return ""
  result = $chr(code)
  if shift > 0 and result[0] in {'a' .. 'z'}:
    result[0] = chr(code - 32)

proc keyboardTree*(width, height: int, page: KeyboardPage, shift: int, paper: bool,
    round = false, top = 0, canvasHeight = 0): SvgNode =
  ## The keyboard for a `width` x `height` box: `page`'s keys, letters in
  ## capitals while `shift` is 1 (the next letter) or 2 (caps lock). On an
  ## LCD dark keys that light while pressed; on e-paper outlined keys and no
  ## press to show, since a refresh to show one costs seconds. `round`: the
  ## box is `top` px down a round `width` x `canvasHeight` panel, and each
  ## row stays inside its circle, on no band of its own.
  let
    pad = max(height div 40, 4)
    gap = max(height div 36, 3)
    rows = 4
    rowH = (height - 2 * pad - (rows - 1) * gap) div rows
    cols = if page == kpNumbers: 4 else: 10
    unit = min((width - 2 * pad - (cols - 1) * gap) div cols,
      if page == kpNumbers: rowH * 5 div 2 else: rowH * 3 div 2)
    size = clamp(rowH * 9 div 20, 10, 28)
    text = Pages[page]
  var c = "flex flex-col items-center"
  c.px("p", pad)
  c.px("gap", gap)
  c.px("text", size)
  if round: c.add(if paper: " text-black" else: " text-white")
  elif paper: c.add " bg-white text-black border-t-2 border-black"
  else: c.add " bg-zinc-900 text-white"
  # `move`, not a plain `c`: Nim 2.2.4 passes the plain one to a sink
  # without clearing it, and the next `c = ...` in the loop frees what the
  # node holds.
  result = el("div", move c)
  # A tap between the keys is the keyboard's too: the nearest key (ui/events.nim),
  # and the field keeps the keyboard.
  result.attrs.add(("on-click", $KeyBase))
  var
    row: SvgNode
    rowUnit = unit
    rowIndex = 0
  for i in -1 ..< text.len:
    if i < 0 or text[i] == '\n':
      c = "flex justify-center"
      c.px("gap", gap)
      c.px("h", rowH)
      rowUnit = unit
      var across = 0
      when not defined(frameosEmbedded):
        if round:
          # As wide as the circle is at the row's edge farther from its
          # centre, and the row's keys in units that fit there: a character
          # one, enter two, the others one and a half, space at least three.
          let
            radius = max(min(width, canvasHeight) div 2 - RoundInset, 8)
            y0 = top + pad + rowIndex * (rowH + gap) - canvasHeight div 2
          across = min(max(2 * chordHalf(radius, max(abs(y0), abs(y0 + rowH))) - 4, 8), width - 2 * pad)
          var
            halves = 0
            keys = 0
          for j in i + 1 ..< text.len:
            if text[j] == '\n': break
            inc keys
            let code = ord(text[j])
            halves += (if text[j] == ' ': 6 elif code == ord(kEnter): 4
              elif code < 32 and page != kpNumbers: 3 else: 2)
          rowUnit = max(min(unit, (across - (keys - 1) * gap) * 2 div max(halves, 1)), 8)
      if across > 0: c.px("w", across)
      else: c.add " w-full"
      inc rowIndex
      row = el("div", move c)
      result.children.add row
      continue
    let
      ch = text[i]
      code = ord(ch)
      lit = code == ord(kShift) and shift > 0
    # Its width: a character one unit, space what is left, enter two, the
    # other keys one and a half (one on the number pad).
    c = "flex items-center justify-center rounded-md"
    if ch == ' ': c.add " grow"
    elif code == ord(kEnter): c.px("w", rowUnit * 2)
    elif code < 32 and page != kpNumbers: c.px("w", rowUnit * 3 div 2)
    else: c.px("w", rowUnit)
    if paper:
      c.add " border-2 border-black"
      if lit: c.add " bg-black text-white"
    else:
      c.add(if code < 32: " bg-zinc-700" else: " bg-zinc-600")
      if lit: c.add " bg-zinc-100 text-zinc-900"
      c.add " active:bg-zinc-400"
    var label: SvgNode
    if code == ord(kShift): label = icon(ShiftPath, lit, size)
    elif code == ord(kBackspace): label = icon(BackspacePath, false, size)
    elif code == ord(kEnter): label = icon(EnterPath, false, size)
    elif code < 32:
      var t = "font-bold"
      t.px("text", size * 3 div 4)
      label = el("div", move t, SvgNode(text: if code == ord(kSymbols): "123" elif code == ord(kMore): "#+=" else: "ABC"))
    elif ch != ' ':
      label = SvgNode(text: typed(code, shift))
    let key = el("div", move c, label)
    key.attrs.add(("on-click", $(KeyBase + code)))
    if code == ord(kShift):
      # Shift tapped twice: caps lock, until shift again.
      key.attrs.add(("on-double-click", $(KeyBase + ord(kCapsLock))))
    row.children.add key

{.pop.}
