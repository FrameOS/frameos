import std/[json, sequtils, unittest]
import pixie
import pixie/fileformats/svg
import frameos/utils/font # installs the typeface resolver text uses
import frameos/ui/layout
import frameos/ui/keyboard
import frameos/ui/events
import frameos/events_gen

# The keys (docs/jsx-ui.md "Keys"): Tab walks what there is to press, Enter
# presses what is ringed, Escape lets go; a frame's buttons are those keys.

proc el(tag, classes: string, children: varargs[SvgNode]): SvgNode =
  result = SvgNode(tag: tag)
  if classes.len > 0:
    result.attrs.add(("class", classes))
  for child in children:
    result.children.add child

proc txt(text: string): SvgNode = SvgNode(text: text)

proc on(node: SvgNode, attr, value: string): SvgNode =
  node.attrs.add((attr, value))
  node

var calls: seq[(int, string)] ## (handler, event) of every handler run

proc draw(target: UiTarget, root: SvgNode): SvgNode =
  ## A render of `root` into the target, as an app's would be.
  target.regions.setLen(0)
  target.call = proc(handler: int, name: string, event: JsonNode, hit: UiHit) =
    calls.add((handler, name))
  layout.layoutUi(root, 480, 320, target.input, target.regions, target.memo)

proc ringed(target: UiTarget): int =
  ## The handler of the element ringed, -1 for none; a field's key + 1000.
  if target.input.ring == 0:
    return -1
  for r in target.regions:
    if r.key == target.input.ring - 1:
      return (if r.field > 0: 1000 + r.field.int else: r.handlers[ueClick] - 1)
  -2

proc page(): SvgNode =
  ## Three buttons, the second a tile whose icon and name are inside it (one
  ## thing, one stop), a box with no handler, and a link.
  let tile = el("div", "flex flex-col w-[80px] h-[80px]",
    el("div", "w-[40px] h-[40px] bg-sky-500"), el("span", "", txt("Tile"))).on("on-click", "1")
  el("div", "w-full h-full flex flex-col gap-2 p-2 bg-black text-white",
    el("div", "h-[30px] bg-zinc-700", txt("First")).on("on-click", "0"),
    tile,
    el("div", "h-[30px]", txt("Nothing to press")),
    el("div", "h-[30px] bg-zinc-700", txt("Third")).on("on-click", "2"))

proc button(role, action: string): JsonNode =
  %*{"role": role, "action": action, "label": "X", "pin": 1}

suite "the keys":
  setup:
    calls.setLen(0)
    forgetTypedKeys()

  test "Tab walks every element there is to press, one stop each, around past either end":
    let target = uiTarget("keys", 1)
    discard target.draw(page())
    check uiListens("keys", "keyDown") and uiListens("keys", "button")
    check target.ringed == -1
    check uiKeys(["keys"], "Tab")
    check target.ringed == 0
    check uiKeys(["keys"], "Tab")
    check target.ringed == 1 # the tile: its icon and name are no stops of their own
    check uiKeys(["keys"], "Tab")
    check target.ringed == 2
    check uiKeys(["keys"], "Tab")
    check target.ringed == 0 # around
    check uiKeys(["keys"], "Tab", back = true)
    check target.ringed == 2
    # Many in a row before any render: each one counts, from where the last left it.
    for _ in 1 .. 4:
      discard uiKeys(["keys"], "Tab")
    check target.ringed == 0
    forgetUiTarget("keys", 1)

  test "Enter presses what is ringed, Escape takes the ring away, a tap too":
    let target = uiTarget("keys", 1)
    discard target.draw(page())
    check not uiKeys(["keys"], "Enter") # nothing ringed: nothing to press
    discard uiKeys(["keys"], "Tab")
    discard uiKeys(["keys"], "Tab")
    check uiKeys(["keys"], "Enter")
    check calls == @[(1, "tap")]
    check uiKeys(["keys"], "Escape")
    check target.ringed == -1
    check not uiKeys(["keys"], "Escape")
    discard uiKeys(["keys"], "Tab")
    let r = target.regions[0]
    discard dispatchUiEvent("keys", "tap", %*{"x": r.x + 1, "y": r.y + 1, "pointerId": 1})
    check target.input.ring == 0
    forgetUiTarget("keys", 1)

  test "the ring is drawn, unless the element's focus: classes draw it":
    let target = uiTarget("keys", 1)
    discard target.draw(page())
    discard uiKeys(["keys"], "Tab")
    var svg = target.draw(page())
    check svg.children.anyIt(it.tag == "rect" and it.attrs.anyIt(it[0] == "stroke"))
    let styled = el("div", "w-full h-full", el("div", "h-[30px] focus:bg-sky-500", txt("A")).on("on-click", "0"))
    svg = target.draw(styled)
    check target.ringed == 0
    check not svg.children.anyIt(it.tag == "rect" and it.attrs.anyIt(it[0] == "stroke"))
    # Gone from the next render: the keys start over.
    discard target.draw(el("div", "w-full h-full", txt("Nothing")))
    check target.input.ring == 0
    forgetUiTarget("keys", 1)

  test "a frame's buttons: next and prev are Tab, the green key Enter, a double press twice":
    let target = uiTarget("keys", 1)
    discard target.draw(page())
    check uiButtonKeys(["keys"], button("next", "press"))
    check target.ringed == 0
    check uiButtonKeys(["keys"], button("next", "doublePress"))
    check target.ringed == 2
    check uiButtonKeys(["keys"], button("prev", "press"))
    check target.ringed == 1
    check uiButtonKeys(["keys"], button("refresh", "press"))
    check calls == @[(1, "tap")]
    check uiButtonKeys(["keys"], button("primary", "doublePress"))
    check calls == @[(1, "tap"), (1, "tap"), (1, "tap")]
    # A long press is the frame's event map's (walk the scenes, talk).
    check not uiButtonKeys(["keys"], button("next", "longPress"))
    check target.ringed == 1
    check uiButtonKeys(["keys"], button("back", "press"))
    check target.ringed == -1
    # A menu key is a way out, as on a remote: Escape, never Enter.
    discard uiButtonKeys(["keys"], button("next", "press"))
    check uiButtonKeys(["keys"], button("menu", "press"))
    check target.ringed == -1
    check calls == @[(1, "tap"), (1, "tap"), (1, "tap")]
    # The reTerminal's green key is its primary key.
    check buttonRoleForLabel("REFRESH") == "primary"
    forgetUiTarget("keys", 1)

  test "a board its plane renders keeps the ring from one pull to the next":
    # Each pull is a new process (docs/server-rendering.md "Kept between
    # pulls"): without the ring, every next started over from the top.
    let target = uiTarget("keys", 1)
    discard target.draw(page())
    discard uiButtonKeys(["keys"], button("next", "doublePress"))
    let kept = lastingUiInput()
    forgetUiTarget("keys", 1)
    check restoreLastingUiInput(kept) == 1
    let again = uiTarget("keys", 1)
    discard again.draw(page())
    check again.ringed == 1
    check uiButtonKeys(["keys"], button("next", "press"))
    check again.ringed == 2
    forgetUiTarget("keys", 1)

  test "a UI with nothing to press does not hear keys or buttons":
    let target = uiTarget("still", 1)
    discard target.draw(el("div", "w-full h-full", txt("12:30")))
    check not uiListens("still", "button")
    check not uiListens("still", "keyDown")
    check not uiButtonKeys(["still"], button("next", "press"))
    forgetUiTarget("still", 1)

  test "the scene's UI and its layout's are one walk with one ring":
    let scene = uiTarget("scene", 1)
    let chrome = uiTarget("layout", 1)
    discard scene.draw(el("div", "w-full h-full", el("div", "h-[30px]", txt("In")).on("on-click", "5")))
    discard chrome.draw(el("div", "w-full h-full", el("div", "h-[30px]", txt("Start")).on("on-click", "9")))
    check uiKeys(["scene", "layout"], "Tab")
    check scene.ringed == 5 and chrome.ringed == -1
    check uiKeys(["scene", "layout"], "Tab")
    check scene.ringed == -1 and chrome.ringed == 9
    check uiKeys(["scene", "layout"], "Enter")
    check calls == @[(9, "tap")]
    check uiKeys(["scene", "layout"], "Tab")
    check scene.ringed == 5 and chrome.ringed == -1
    forgetUiTarget("scene", 1)
    forgetUiTarget("layout", 1)

suite "the keys turn pages":
  setup:
    calls.setLen(0)
    forgetTypedKeys()

  proc news(): SvgNode =
    ## A bar to press above a list of twenty rows that scrolls (40 px each, 260 px
    ## of them showing: rows 0 to 5 whole, row 6 cut off) and one below: the
    ## Hacker News sample's page between its header and a layout's chrome.
    var rows: seq[SvgNode]
    for i in 0 ..< 20:
      rows.add el("div", "h-[40px] shrink-0", txt("Story " & $i)).on("on-click", $(10 + i))
    el("div", "w-full h-full flex flex-col bg-black text-white",
      el("div", "h-[30px] shrink-0", txt("new")).on("on-click", "1"),
      el("div", "flex-1 min-h-0 overflow-y-auto", rows),
      el("div", "h-[30px] shrink-0", txt("More")).on("on-click", "2"))

  proc scrollTop(target: UiTarget): float32 =
    for r in target.regions:
      if r.scrollY > 0:
        return target.input.scrolled(r.key)[1]

  proc next(target: UiTarget, root: SvgNode, back = false) =
    ## A frame's next (prev) button, and the render after it.
    check uiButtonKeys(["news"], button(if back: "prev" else: "next", "press"))
    discard target.draw(root)

  test "next walks the rows it shows, then turns the page, and goes on past the list at its end":
    let target = uiTarget("news", 1)
    let root = news()
    discard target.draw(root)
    target.next(root)
    check target.ringed == 1 # the bar above the list
    for i in 0 .. 5:
      target.next(root)
      check target.ringed == 10 + i
    check target.scrollTop == 0 # every row so far showed whole
    # Row 6 is cut off at the bottom: a page (260 px less an eighth) instead
    # of the 30 px that would show it, and the ring on the first row of the
    # new page below row 5.
    target.next(root)
    check target.scrollTop == 228
    check target.ringed == 16
    for i in 7 .. 11:
      target.next(root)
      check target.ringed == 10 + i
    target.next(root)
    check target.scrollTop == 456 and target.ringed == 22
    for i in 13 .. 16:
      target.next(root)
      check target.ringed == 10 + i
    target.next(root)
    check target.scrollTop == 540 # the end of the list: less than a page
    check target.ringed == 27
    target.next(root)
    target.next(root)
    check target.ringed == 29
    # At its end the list lets the ring go on, to the bar below it.
    target.next(root)
    check target.ringed == 2
    # Prev mirrors it: back up the rows, a page up when the one before is cut off.
    target.next(root, back = true)
    check target.ringed == 29
    for i in countdown(18, 14):
      target.next(root, back = true)
      check target.ringed == 10 + i # rows 18 to 14 show whole
    check target.scrollTop == 540
    target.next(root, back = true)
    check target.scrollTop == 312
    check target.ringed == 23 # row 13, the last on the new page above row 14
    forgetUiTarget("news", 1)

  test "presses that come before the page is drawn go on from where the ring lands":
    let target = uiTarget("news", 1)
    let root = news()
    discard target.draw(root)
    for _ in 1 .. 7:
      discard uiButtonKeys(["news"], button("next", "press"))
    check target.ringed == 15
    # A double press: the page turns, and the second press is one row on.
    check uiButtonKeys(["news"], button("next", "doublePress"))
    discard target.draw(root)
    check target.scrollTop == 228
    check target.ringed == 17
    forgetUiTarget("news", 1)

  test "a keyboard's Tab walks on: no pages":
    let target = uiTarget("news", 1)
    let root = news()
    discard target.draw(root)
    for _ in 1 .. 7:
      check uiTypedKeys(["news"], %*{"key": "Tab", "code": "Tab"})
      discard target.draw(root)
    check target.ringed == 15
    check uiTypedKeys(["news"], %*{"key": "Tab", "code": "Tab"})
    discard target.draw(root)
    check target.ringed == 16 # cut off: brought into sight by what it needs
    check target.scrollTop > 0 and target.scrollTop < 228
    forgetUiTarget("news", 1)

  test "a box that scrolls with nothing to press in it is a stop, its pages turned to its end":
    let target = uiTarget("text", 1)
    var lines: seq[SvgNode]
    for i in 0 ..< 30:
      lines.add el("div", "h-[20px] shrink-0", txt("Line " & $i))
    let root = el("div", "w-full h-full flex flex-col bg-black text-white",
      el("div", "flex-1 min-h-0 overflow-y-auto", lines),
      el("div", "h-[40px] shrink-0", txt("Done")).on("on-click", "3"))
    discard target.draw(root)
    check uiListens("text", "button")
    check uiButtonKeys(["text"], button("next", "press"))
    discard target.draw(root)
    var box = -1
    for r in target.regions:
      if r.scrollY > 0: box = r.key
    check target.input.ring == box + 1 # the box itself
    var tops: seq[float32]
    for _ in 1 .. 2:
      check uiButtonKeys(["text"], button("next", "press"))
      discard target.draw(root)
      check target.input.ring == box + 1
      tops.add target.scrollTop
    check tops == @[245'f32, 320] # a page (280 less an eighth), then the rest
    check uiButtonKeys(["text"], button("next", "press"))
    discard target.draw(root)
    check target.input.ring != box + 1 and target.ringed == 3 # at its end, on to Done
    forgetUiTarget("text", 1)

suite "the keys and fields":
  setup:
    calls.setLen(0)
    forgetTypedKeys()

  proc form(): SvgNode =
    let name = el("input", "w-[200px] h-[30px] bg-white text-black").on("value", "Ann").on("on-change", "3")
    let note = el("input", "w-[200px] h-[30px] bg-white text-black").on("value", "").on("on-change", "4")
    el("div", "w-full h-full flex flex-col gap-2 bg-black",
      name, note, el("div", "h-[30px]", txt("Save")).on("on-click", "6"))

  test "a keyboard's Tab gives a field the keys at once, and goes on past it":
    let target = uiTarget("form", 1)
    discard target.draw(form())
    check uiTypedKeys(["form"], %*{"key": "Tab", "code": "Tab"})
    check target.input.focus > 0 and target.input.focus == target.input.ring
    check not target.input.keyboard # typed on: no keyboard on the screen
    check not uiTypedKeys(["form"], %*{"key": "Enter", "code": "Enter"}) # the field's own Enter
    check uiTypedKeys(["form"], %*{"key": "Tab", "code": "Tab"})
    discard target.draw(form())
    check uiTypedKeys(["form"], %*{"key": "Tab", "code": "Tab"})
    check target.input.focus == 0 and target.ringed == 6
    check uiTypedKeys(["form"], %*{"key": "Tab", "code": "Tab", "shift": true})
    check target.input.focus > 0
    check not uiTypedKeys(["form"], %*{"key": "Tab", "code": "Tab", "ctrl": true})
    forgetUiTarget("form", 1)

  test "a frame's button rings a field, Enter gives it the keyboard, Escape takes it back":
    let target = uiTarget("form", 1)
    discard target.draw(form())
    check uiButtonKeys(["form"], button("next", "press"))
    check target.input.focus == 0 and target.ringed == 1001
    check uiButtonKeys(["form"], button("refresh", "press"))
    check target.input.focus > 0 and target.input.keyboard
    check uiButtonKeys(["form"], button("back", "press"))
    check target.input.focus == 0 and target.ringed == 1001
    check uiButtonKeys(["form"], button("back", "press"))
    check target.input.ring == 0
    forgetUiTarget("form", 1)

  test "the on-screen keyboard's Tab goes to the next field, held to the one before":
    let target = uiTarget("form", 1)
    discard target.draw(form())
    check uiButtonKeys(["form"], button("next", "press"))
    check uiButtonKeys(["form"], button("primary", "press"))
    let first = target.input.focus
    discard target.draw(form())
    var tab: UiRegion
    for r in target.regions:
      if r.handlers[ueClick] - 1 == KeyBase + ord(kTab): tab = r
    check tab.w > 0
    check dispatchUiEvent("form", "tap", %*{"x": tab.x + 2, "y": tab.y + 2, "pointerId": 1})
    check target.input.focus > 0 and target.input.focus != first and target.input.keyboard
    discard target.draw(form())
    for r in target.regions:
      if r.handlers[ueClick] - 1 == KeyBase + ord(kTab): tab = r
    check dispatchUiEvent("form", "longPress", %*{"x": tab.x + 2, "y": tab.y + 2, "pointerId": 1})
    check target.input.focus == first
    forgetUiTarget("form", 1)

  test "a <select>: Enter opens its list, Tab walks the options, Enter picks one":
    let target = uiTarget("pick", 1)
    var options: seq[SvgNode]
    for i in 0 ..< 3:
      options.add el("option", "", txt("Option " & $i)).on("value", "o" & $i)
    let box = el("select", "w-[200px] h-[30px] bg-zinc-800", options).on("value", "o0").on("on-change", "7")
    let root = el("div", "w-full h-full bg-black text-white", box)
    discard target.draw(root)
    check uiButtonKeys(["pick"], button("next", "press"))
    check target.ringed == 1004
    check uiButtonKeys(["pick"], button("refresh", "press"))
    check target.input.open > 0
    discard target.draw(root)
    check uiButtonKeys(["pick"], button("next", "doublePress"))
    check uiButtonKeys(["pick"], button("refresh", "press"))
    check target.input.open == 0
    check calls == @[(7, "change")]
    discard target.draw(root)
    check target.ringed == 1004 # back on the select
    forgetUiTarget("pick", 1)
