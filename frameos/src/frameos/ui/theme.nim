## Themes for the UIs built in Nim (the scene settings, the scene switcher, the
## terminal, the keyboard on the screen): what each kind of element looks like,
## by its role, from the layout around the frame's scene (its state's `theme`,
## docs/jsx-ui.md "Themes"), else each one's own look.
##
## The scenes write their elements as they always did; `role` names what one
## is. With a theme, the element's look (its colors, borders, corners, weight:
## `bg-`, `text-` colors, `border`, `rounded`, `font-` weights, `opacity-`,
## with their `active:` and `focus:` forms) gives way to the theme's for its
## role. A role is a string of classes, one box, or a list of them, a box each,
## one inside the other: a bevel is two or three boxes, as a box has one border
## color. The outermost then takes the element's place (its size and position)
## and its presses, the element itself is the innermost, with how what is in it
## is laid out (`flex`, `items-`, `justify-`, padding, gaps) and its content.
##
## Not on an ESP32: there every element keeps its own look and `role` is the
## element itself, so the scenes cost the firmware nothing for it.

import pixie/fileformats/svg
when not defined(frameosEmbedded):
  import std/[json, strutils]
  import frameos/ui/tree

when defined(frameosEmbedded):
  template role*(node: SvgNode, name: string): SvgNode = node

else:
  {.push overflowChecks: off, rangeChecks: off, boundChecks: off, raises: [].}

  var themeSource*: proc(): JsonNode {.nimcall, gcsafe, raises: [].}
    ## Set by the interpreter: the `theme` of the layout around what is drawn
    ## now, nil when there is none.

  const
    Fill = "flex flex-1 min-w-0 min-h-0"
      ## A box inside another, filling it.
    OneBox = ["page", "bar", "muted", "accent", "option", "picked", "keyboard", "terminal", "prompt"]
      ## Roles that hold other elements or are text: one box, a list's innermost.
    TextSizes = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]
    TextAligns = ["left", "center", "right", "justify", "start", "end"]
    ContentWords = ["flex", "flex-col", "flex-row", "flex-wrap", "relative", "truncate"]
    ContentHeads = ["items-", "justify-", "p-", "px-", "py-", "pt-", "pr-", "pb-", "pl-", "gap-", "leading-",
      "whitespace-", "overflow-", "line-clamp-", "tracking-"]
    LookHeads = ["bg-", "border", "rounded", "opacity-", "shadow", "ring", "font-bold", "font-semibold",
      "font-medium", "font-normal", "font-light"]

  type Part = enum
    pPlace, pContent, pLook

  proc partOf(token: string): Part =
    ## Where a class goes when its element is boxes inside each other.
    var base = token
    var depth = 0
    for i in countdown(token.high, 0):
      if token[i] == ']': inc depth
      elif token[i] == '[': dec depth
      elif token[i] == ':' and depth == 0:
        base = token[i + 1 .. ^1]
        break
    for head in LookHeads:
      if base.startsWith(head): return pLook
    if base.startsWith("text-"):
      let v = base[5 .. ^1]
      if v in TextSizes or v.startsWith("[") and not v.startsWith("[#") and not v.contains("rgb"):
        return pPlace
      if v in TextAligns:
        return pContent
      return pLook
    if base in ContentWords:
      return pContent
    for head in ContentHeads:
      if base.startsWith(head): return pContent
    pPlace

  proc join(parts: var string, token: string) =
    if token.len > 0:
      if parts.len > 0: parts.add ' '
      parts.add token

  proc role*(node: SvgNode, name: string): SvgNode =
    ## `node`, or the outermost of the boxes around it, in the theme's look
    ## for `name`; `node` as it is without one.
    result = node
    if themeSource.isNil or node.isNil or node.attrs.len == 0 or node.attrs[0][0] != "class":
      return
    let theme = themeSource()
    if theme.isNil or theme.kind != JObject:
      return
    let given = theme.getOrDefault(name)
    if given.isNil or given.kind notin {JString, JArray} or given.kind == JArray and given.len == 0:
      return
    proc text(n: JsonNode): string =
      if n.kind == JString: n.str else: ""
    var place, content: string
    for token in node.attrs[0][1].splitWhitespace():
      case partOf(token)
      of pPlace: place.join token
      of pContent: content.join token
      of pLook: discard
    # One box: the theme's look in place of its own.
    if given.kind == JString or given.len == 1 or name in OneBox or node.tag in ["span", "option"]:
      var c = place
      c.join content
      c.join text(if given.kind == JString: given else: given.elems[^1])
      node.attrs[0][1] = c
      return
    # Boxes around it, the outermost in its place and taking its presses.
    node.attrs[0][1] = Fill & " " & content & " " & text(given.elems[^1])
    result = el("div", place & " flex " & text(given.elems[0]))
    var around = result
    for i in 1 ..< given.len - 1:
      let box = el("div", Fill & " " & text(given.elems[i]))
      around.children.add box
      around = box
    around.children.add node
    var i = 1
    while i < node.attrs.len:
      if node.attrs[i][0] in ["on-click", "on-double-click", "on-long-press"]:
        result.attrs.add node.attrs[i]
        node.attrs.delete(i)
      else:
        inc i

  {.pop.}
