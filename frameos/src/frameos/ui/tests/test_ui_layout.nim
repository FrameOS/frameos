import std/[strutils, unittest]
import pixie
import pixie/fileformats/svg
import frameos/utils/font # installs the typeface resolver text uses
import frameos/ui/tailwind
import frameos/ui/layout

# The UI layout: Tailwind classes read, boxes placed the way a browser places
# them for the subset it supports, and the SVG that comes out drawn by pixie.

proc el(tag, classes: string, children: varargs[SvgNode]): SvgNode =
  result = SvgNode(tag: tag)
  if classes.len > 0:
    result.attrs.add(("class", classes))
  for child in children:
    result.children.add child

proc txt(text: string): SvgNode = SvgNode(text: text)

proc rects(svg: SvgNode): seq[(int, int, int, int, string)] =
  ## Every background the layout drew: x, y, width, height, fill.
  for node in svg.children:
    if node.tag == "rect":
      result.add((parseInt(node.attr("x")), parseInt(node.attr("y")),
        parseInt(node.attr("width")), parseInt(node.attr("height")), node.attr("fill")))

proc geom(r: (int, int, int, int, string)): (int, int, int, int) = (r[0], r[1], r[2], r[3])

proc classes(s: string, w = 800'f32, h = 480'f32): (Box, Text) =
  var
    box = initBox()
    text = initText()
  box.applyClasses(text, s, w, h)
  (box, text)

suite "tailwind classes":
  test "spacing, sizes and fractions":
    let (box, _) = classes("p-4 px-2 mt-1 w-1/2 h-[37px] gap-x-3 gap-y-[5px]")
    check box.pad == [16'f32, 8, 16, 8]
    check box.margin[0] == px(4)
    check box.w == Len(kind: lkPct, v: 50)
    check box.h == px(37)
    check box.gapX == 12
    check box.gapY == 5

  test "colours from the palette, with opacity and in brackets":
    let (box, text) = classes("bg-red-500 text-sky-950 border-black/50")
    check box.bg == rgba(0xef, 0x44, 0x44, 255)
    check text.color == rgba(0x08, 0x2f, 0x49, 255)
    check box.borderColor == rgba(0, 0, 0, 128)
    check classes("bg-[#123456]")[0].bg == rgba(0x12, 0x34, 0x56, 255)
    check classes("text-[tomato]")[1].color == rgba(255, 99, 71, 255)

  test "text sizes come with their line height; leading wins":
    let (_, text) = classes("text-2xl font-bold italic uppercase text-center")
    check text.size == 24
    check text.lineHeight == 32
    check text.weight == 700
    check text.italic
    check text.textCase == UpperCase
    check text.align == CenterAlign
    check classes("leading-[1.2] text-xl")[1].leading == 1.2'f32
    check classes("text-[20px]")[1].size == 20

  test "breakpoints and orientation look at the image":
    check classes("p-1 md:p-2", 800, 480)[0].pad[0] == 8
    check classes("p-1 md:p-2", 600, 480)[0].pad[0] == 4
    check classes("p-1 portrait:p-3", 480, 800)[0].pad[0] == 12
    check classes("p-1 hover:p-3")[0].pad[0] == 4

  test "corners, borders, negatives, grids, clamps":
    let (box, text) = classes("rounded-t-lg border-b-2 -mt-2 grid grid-cols-3 col-span-2 line-clamp-2")
    check box.radius == [8'f32, 8, 0, 0]
    check box.border == [0'f32, 0, 2, 0]
    check box.margin[0] == px(-8)
    check box.display == diGrid
    check box.cols == 3
    check box.span == 2
    check text.lines == 2

suite "ui layout":
  test "a row with gaps, and the root fills the image":
    let svg = layoutUi(el("div", "flex gap-2 bg-black",
      el("div", "w-10 h-10 bg-red-500"),
      el("div", "w-10 h-10 bg-green-500"),
      el("div", "w-10 h-10 bg-blue-500")), 200, 100)
    let r = svg.rects
    check r[0] == (0, 0, 200, 100, "#000000")
    check r[1].geom == (0, 0, 40, 40)
    check r[2].geom == (48, 0, 40, 40)
    check r[3].geom == (96, 0, 40, 40)
    check parseSvg(svg, 200, 100).coversOpaque(200, 100)

  test "justify, align and grow":
    let r = layoutUi(el("div", "flex justify-between items-center h-full",
      el("div", "w-10 h-10 bg-red-500"),
      el("div", "w-10 h-20 bg-blue-500")), 200, 100).rects
    check r[0].geom == (0, 30, 40, 40)
    check r[1].geom == (160, 10, 40, 80)
    let g = layoutUi(el("div", "flex",
      el("div", "w-20 bg-red-500"),
      el("div", "flex-1 bg-blue-500")), 200, 100).rects
    check g[0].geom == (0, 0, 80, 100)
    check g[1].geom == (80, 0, 120, 100)

  test "flex-1 in a column with no height of its own is its content's size":
    let r = layoutUi(el("div", "", el("div", "flex flex-col gap-2",
      el("div", "flex-1 h-6 bg-red-500"), el("div", "flex-1 bg-red-500", el("div", "h-4")))), 200, 100).rects
    check r[0].geom == (0, 0, 200, 24)
    check r[1].geom == (0, 32, 200, 16)

  test "a block stacks and stretches; padding is inside the size":
    let r = layoutUi(el("div", "w-20 p-2 bg-black",
      el("div", "h-4 bg-red-500"),
      el("div", "h-6 mt-1 bg-blue-500")), 200, 100).rects
    check r[0].geom == (0, 0, 80, 100)
    check r[1].geom == (8, 8, 64, 16)
    check r[2].geom == (8, 28, 64, 24)

  test "a column centers and mx-auto centers":
    let r = layoutUi(el("div", "flex flex-col items-center",
      el("div", "w-10 h-10 bg-red-500")), 200, 100).rects
    check r[0].geom == (80, 0, 40, 40)
    let m = layoutUi(el("div", "",
      el("div", "w-10 h-10 mx-auto bg-red-500")), 200, 100).rects
    check m[0].geom == (80, 0, 40, 40)

  test "a grid and absolute children":
    let r = layoutUi(el("div", "grid grid-cols-2 gap-4 p-4 relative",
      el("div", "h-10 bg-red-500"),
      el("div", "h-12 bg-green-500"),
      el("div", "col-span-2 h-4 bg-blue-500"),
      el("div", "absolute top-2 right-2 w-4 h-4 bg-black")), 200, 100).rects
    check r[0].geom == (16, 16, 76, 40) # its own height in a taller row
    check r[1].geom == (108, 16, 76, 48)
    check r[2].geom == (16, 80, 168, 16)
    check r[3].geom == (176, 8, 16, 16)

  test "a grid sized to its content is as wide as its columns need":
    let r = layoutUi(el("div", "flex items-start",
      el("div", "grid grid-cols-3 gap-2 bg-black",
        el("div", "w-6 h-6 bg-red-500"), el("div", "w-4 h-4 bg-red-500"), el("div", "w-4 h-4 bg-red-500"))), 400, 100).rects
    check r[0].geom == (0, 0, 3 * 24 + 2 * 8, 24)
    # with more cells than one row: rows of three, whatever the room
    var cells: seq[SvgNode]
    for i in 0 ..< 7:
      cells.add el("div", "w-6 h-6 bg-red-500")
    let grid = el("div", "grid grid-cols-3 gap-2 bg-black")
    grid.children = cells
    check layoutUi(el("div", "flex items-start", grid), 400, 200).rects[0].geom ==
      (0, 0, 3 * 24 + 2 * 8, 3 * 24 + 2 * 8)

  test "flex-wrap breaks lines, and a set height spreads them":
    proc third(height: string): (int, int, int, int) =
      layoutUi(el("div", "", el("div", "flex flex-wrap gap-2 w-[100px] " & height,
        el("div", "w-10 h-4 bg-red-500"),
        el("div", "w-10 h-4 bg-red-500"),
        el("div", "w-10 h-4 bg-red-500"))), 200, 100).rects[2].geom
    check third("") == (0, 24, 40, 16)
    check third("h-[80px]") == (0, 44, 40, 16) # two lines of (80 - 8) / 2

  test "text is measured, wrapped, aligned and clamped":
    let one = layoutUi(el("div", "flex items-start",
      el("div", "bg-red-500 text-base", txt("Hello"))), 400, 100)
    let width = one.rects[0][2]
    check width in 30 .. 50 # "Hello" at 16 px in Ubuntu
    check one.rects[0][3] == 24 # one line of text-base
    check layoutUi(el("div", "flex",
      el("div", "bg-red-500", txt("Hello"))), 400, 100).rects[0][3] == 100 # stretched
    proc boxed(classes: string): int =
      layoutUi(el("div", "", el("div", "w-[60px] bg-red-500 " & classes,
        txt("one two three four five"))), 400, 100).rects[0][3]
    check boxed("") > 48 # several lines
    check boxed("line-clamp-2") == 48
    check boxed("truncate") == 24

  test "inline elements flow with the text, items in a row":
    let svg = layoutUi(el("div", "text-black",
      txt("Hi "), el("b", "text-red-500", txt("there")), txt("!")), 400, 100)
    var fills: seq[string]
    for node in svg.children:
      if node.tag == "path": fills.add node.attr("fill")
    check fills == @["#000000", "#ff0000".replace("ff0000", "ef4444"), "#000000"]

  test "a gradient fades to transparent":
    let svg = layoutUi(el("div", "bg-white", el("div", "h-full bg-gradient-to-b from-black to-transparent")), 20, 100)
    let image = newImage(parseSvg(svg, 20, 100))
    check image[10, 1].r < 10        # black at the top
    check image[10, 50].r in 100'u8 .. 160'u8
    check image[10, 98].r > 245      # the white under it at the bottom


  test "a memo keeps the text that did not change, as the same nodes":
    # A card's switch flipped: the count above is set again, the labels that
    # did not change come back as the very nodes (and paths) of the last
    # layout, so pixie's damage sees them unchanged by identity.
    proc panel(on: bool): SvgNode =
      el("div", "flex flex-col gap-2 p-2 bg-slate-900 text-white",
        el("span", "", txt(if on: "1 of 2 on" else: "0 of 2 on")),
        el("div", if on: "p-2 bg-amber-300" else: "p-2 bg-slate-700", el("span", "font-semibold", txt("Lamp"))),
        el("div", "p-2 bg-slate-700", el("span", "", txt("Heating"))))
    proc paths(svg: SvgNode): seq[SvgNode] =
      for node in svg.children:
        if node.tag == "path": result.add node
    let memo = UiMemo()
    var regions: seq[UiRegion]
    let
      first = layoutUi(panel(false), 200, 120, UiInput(), regions, memo)
      second = layoutUi(panel(true), 200, 120, UiInput(), regions, memo)
      a = first.paths
      b = second.paths
    check a.len == 3 and b.len == 3
    check b[0] != a[0]                # the count: set again
    check b[1] == a[1] and b[2] == a[2] # the labels: the same nodes
    check b[1].attr("stroke").len > 0   # bold drawn as its outline still
    # What the memo hands back draws what a layout without it draws.
    let
      got = newImage(parseSvg(second, 200, 120))
      want = newImage(parseSvg(layoutUi(panel(true), 200, 120), 200, 120))
    var same = true
    for y in 0 ..< 120:
      for x in 0 ..< 200:
        if got[x, y] != want[x, y]: same = false
    check same

  test "a tree that did not change comes back as the same nodes":
    # React's diff, without its API: the second layout of an equal tree (a
    # new walk of the same JSX) takes every node back, laid out and emitted.
    proc card(name: string, on: bool): SvgNode =
      el("div", if on: "p-2 rounded-xl bg-amber-300" else: "p-2 rounded-xl bg-slate-700",
        el("span", "font-semibold", txt(name)), el("div", "w-4 h-4 rounded-full bg-white"))
    proc panel(on: array[3, bool], extra = false): SvgNode =
      result = el("div", "flex flex-col gap-2 p-2 bg-slate-900 text-white")
      if extra:
        result.children.add el("div", "h-6 bg-red-500")
      for i, name in ["Lamp", "Heating", "Fan"]:
        result.children.add card(name, on[i])
    proc drawn(svg: SvgNode): Image = newImage(parseSvg(svg, 200, 200))
    proc samePicture(a, b: SvgNode): bool =
      let (x, y) = (drawn(a), drawn(b))
      for j in 0 ..< 200:
        for i in 0 ..< 200:
          if x[i, j] != y[i, j]: return false
      true
    let memo = UiMemo()
    var regions: seq[UiRegion]
    let
      first = layoutUi(panel([false, true, false]), 200, 200, UiInput(), regions, memo)
      again = layoutUi(panel([false, true, false]), 200, 200, UiInput(), regions, memo)
    check again.children.len == first.children.len
    var same = 0
    for i in 0 ..< again.children.len:
      if again.children[i] == first.children[i]: inc same
    check same == again.children.len
    # One card changed: its nodes are new, the others' the same objects.
    let flipped = layoutUi(panel([true, true, false]), 200, 200, UiInput(), regions, memo)
    var kept, fresh: int
    for node in flipped.children:
      if node in again.children: inc kept else: inc fresh
    check fresh > 0 and fresh < 6 and kept > 6
    check samePicture(flipped, layoutUi(panel([true, true, false]), 200, 200))
    # A box above them moves the cards down: drawn where they are now.
    let moved = layoutUi(panel([true, true, false], extra = true), 200, 200, UiInput(), regions, memo)
    check samePicture(moved, layoutUi(panel([true, true, false], extra = true), 200, 200))

  test "the pointer rebuilds only what it changes":
    proc keys(memo: UiMemo, pressed: seq[int]): (SvgNode, seq[UiRegion]) =
      var regions: seq[UiRegion]
      let tree = el("div", "flex gap-2 p-2 bg-black",
        el("div", "w-10 h-10 bg-orange-500 active:bg-orange-300", txt("1")),
        el("div", "w-10 h-10 bg-orange-500 active:bg-orange-300", txt("2")))
      (layoutUi(tree, 120, 60, UiInput(pressed: pressed), regions, memo), regions)
    let memo = UiMemo()
    let (a, regions) = keys(memo, @[])
    let (b, _) = keys(memo, @[regions[1].key])
    check b.children.len == a.children.len
    # [the root's background, key 1's box and label, key 2's]: the pressed
    # key's box is new; the other key comes back as it was.
    check b.children[1] == a.children[1] and b.children[2] == a.children[2]
    check b.children[3] != a.children[3]
    let (c, _) = keys(memo, @[])
    check c.children.len == a.children.len

  test "an icon's currentColor is never written into the app's nodes":
    let icon = el("svg", "w-4 h-4", SvgNode(tag: "path", attrs: @[("d", "M0 0h24v24z"), ("fill", "currentColor")]))
    icon.attrs.add(("viewBox", "0 0 24 24"))
    discard layoutUi(el("div", "flex text-red-500 bg-white", icon), 40, 40)
    check icon.children[0].attr("fill") == "currentColor"

  test "it draws":
    let svg = layoutUi(el("div", "flex items-center justify-center bg-slate-900",
      el("div", "w-10 h-10 rounded-full bg-red-500"),
      el("div", "w-10 h-10 border-4 border-white ml-2")), 120, 60)
    let image = newImage(parseSvg(svg, 120, 60))
    check image[1, 1] == rgbx(0x0f, 0x17, 0x2a, 255)
    check image[36, 30] == rgbx(0xef, 0x44, 0x44, 255) # the circle's middle
    check image[19, 11] == rgbx(0x0f, 0x17, 0x2a, 255) # its corner, rounded off
    check image[65, 30] == rgbx(255, 255, 255, 255)    # the border
    check image[80, 30] == rgbx(0x0f, 0x17, 0x2a, 255) # inside it
