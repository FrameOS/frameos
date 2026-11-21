import std/[json, sequtils, unittest]
import pixie
import pixie/fileformats/svg
import frameos/utils/font # installs the typeface resolver text uses
import frameos/ui/layout
import frameos/ui/keyboard
import frameos/ui/events

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
