## JSX from a JS app, read into the node tree pixie draws and the UI layout
## lays out (`docs/jsx-ui.md`).
##
## The prelude's `__frameosJsx` makes plain `{type, props}` objects (and
## calls function components on the spot), so what an app returns is a tree
## of those. It is read here straight off the JS objects: no markup is
## written in JS and none is parsed in Nim. `<svg>` trees go to pixie as they
## are; anything else is a UI the layout turns into one (`ui/layout.nim`).

import std/tables
import pixie
import pixie/fileformats/svg
import frameos/js_runtime/burrito
from frameos/js_runtime/jsx_native import signalRecords
import frameos/events_gen
import frameos/ui/theme

proc JS_AtomToCString(ctx: ptr JSContext, atom: JSAtom): cstring {.importc, header: "quickjs/quickjs.h".}

const
  # SVG's own camelCase names; every other camelCase prop (strokeWidth) is
  # the kebab-cased attribute (stroke-width), as React writes them.
  keepCamel = ["viewBox", "gradientUnits", "gradientTransform", "preserveAspectRatio"]
  MaxNodes = 20_000
  MaxDepth = 64
  SceneYieldTag = SceneYieldId

{.push raises: [].}

type
  JsxKept = object
    id: int
    node: SvgNode
    firstHandler, handlers, nodes: int
    used: bool
    path: seq[int32] ## where its node is in the tree read last (children indexes from the root)

  JsxMemo* = object
    ## The nodes of elements memo() made (the prelude's), by the number the
    ## walker gave each: memo returns the same element object while its props
    ## are the same, and its nodes are taken back without reading it.
    kept: seq[JsxKept]
    nextId: int
    sawScene*: bool ## a `<Scene>` or `<yield />` has been read: its UI's layout is searched for them
    sawUrl*: bool ## an `<img src="https://…">` has been read: its UI's layout is searched for them
    handlers*: int ## the handlers (onClick, ...) of the last UI read: they live in its interpreter

  JsxReader = object
    ctx: ptr JSContext
    images: ptr Table[int, Image]
    nodes: int
    handlers: JSValue  # this render's onClick, onLongPress, ... functions
    handlerCount: int
    previous: JSValue  # the last render's, for the handlers of kept nodes
    memo: ptr JsxMemo
    keptCursor: int  # where in memo.kept the next memo()'d element is looked for
    curPath: seq[int32] # the path of the node whose children are being read
    topIndex: int32     # the top node's index in its parent (-1: it is the root)
    track: bool         # paths kept: an app with a signal() record (signalRecords), else nobody splices

proc attrName(name: string): string =
  if name == "className":
    return "class"
  if name in keepCamel:
    return name
  for c in name:
    if c in {'A' .. 'Z'}:
      result.add '-'
      result.add chr(ord(c) + 32)
    else:
      result.add c

proc prop(ctx: ptr JSContext, v: JSValueConst, name: cstring): JSValue {.inline.} =
  JS_GetPropertyStr(ctx, v, name)

proc int32Of(ctx: ptr JSContext, v: JSValueConst): int =
  var value: int32
  if JS_ToInt32(ctx, addr value, v) == 0: value.int else: 0

proc stringProp(ctx: ptr JSContext, v: JSValueConst, name: cstring, value: var string): bool =
  ## Property `name` of `v` when it is a string.
  let prop = ctx.prop(v, name)
  result = jsIsString(prop)
  if result:
    value = toNimString(ctx, prop)
  JS_FreeValue(ctx, prop)

proc jsxTag*(ctx: ptr JSContext, v: JSValueConst): string =
  ## The tag of a JSX element (an object with a string `type` and an object
  ## `props`), or "" for any other value.
  if not jsIsObject(v) or JS_IsArray(ctx, v) != 0 or not ctx.stringProp(v, "type", result):
    return ""
  let props = ctx.prop(v, "props")
  if not jsIsObject(props):
    result = ""
  JS_FreeValue(ctx, props)

proc imageOf(r: JsxReader, v: JSValueConst): Image =
  ## The picture an image ref names: what `frameos.loadAssetImage` returns,
  ## or `frameos.fetchImage`'s result holding one as `image`.
  let
    ctx = r.ctx
    inner = ctx.prop(v, "image")
    target = if jsIsObject(inner): inner else: v
  var kind: string
  if ctx.stringProp(target, "__frameosType", kind) and kind == "imageRef" and not r.images.isNil:
    let id = ctx.prop(target, "id")
    result = r.images[].getOrDefault(ctx.int32Of(id), nil)
    JS_FreeValue(ctx, id)
  JS_FreeValue(ctx, inner)

proc addNodes(r: var JsxReader, v: JSValueConst, into: var seq[SvgNode], depth: int) =
  ## `v` as nodes appended to `into`: a string or number is text, an array
  ## its items, an element itself; null, undefined and booleans are nothing,
  ## as in React.
  let ctx = r.ctx
  if r.nodes >= MaxNodes or depth > MaxDepth or not (jsIsString(v) or jsIsNumber(v) or jsIsObject(v)):
    return
  inc r.nodes
  let myIndex = if depth == 0: r.topIndex else: into.len.int32
  if not jsIsObject(v):
    into.add SvgNode(text: toNimString(ctx, v))
    return
  if JS_IsArray(ctx, v) != 0:
    let length = ctx.prop(v, "length")
    for i in 0 ..< ctx.int32Of(length):
      let item = JS_GetPropertyUint32(ctx, v, i.uint32)
      r.addNodes(item, into, depth + 1)
      JS_FreeValue(ctx, item)
    JS_FreeValue(ctx, length)
    return
  # An element memo() made: its number, 0 before the walker gave it one.
  var memoId = -1
  if not r.memo.isNil:
    let mark = ctx.prop(v, "__frameosNode")
    if jsIsNumber(mark):
      memoId = ctx.int32Of(mark)
    JS_FreeValue(ctx, mark)
  var keptAt = -1
  if memoId > 0:
    # From where the last one was found: a tree's memo()'d elements come
    # back in the order they were kept, so a list of a hundred rows finds
    # each at the cursor (a scan of the kept entries from the start for each
    # was quadratic in the list), and a row put in or taken out costs one
    # pass over the gap. A Table here was 600 B of the ESP32's flash.
    let n = r.memo.kept.len
    for step in 0 ..< n:
      let i = (r.keptCursor + step) mod n
      if r.memo.kept[i].id == memoId:
        keptAt = i
        r.keptCursor = i + 1
        break
  if keptAt >= 0:
    # Taken back where its handlers have the numbers they had: copied
    # from the last render's list into this one's at those numbers.
    template kept: untyped = r.memo.kept[keptAt]
    if kept.firstHandler == r.handlerCount:
      for h in kept.firstHandler ..< kept.firstHandler + kept.handlers:
        discard JS_SetPropertyUint32(ctx, r.handlers, h.uint32, JS_GetPropertyUint32(ctx, r.previous, h.uint32))
      r.handlerCount += kept.handlers
      r.nodes += kept.nodes
      kept.used = true
      if r.track:
        kept.path = r.curPath
        if myIndex >= 0: kept.path.add myIndex
      into.add kept.node
      return
  let
    firstHandler = r.handlerCount
    firstNode = r.nodes
  var node = SvgNode()
  if not ctx.stringProp(v, "type", node.tag):
    return
  let props = ctx.prop(v, "props")
  if node.tag == "Scene" or node.tag == "yield":
    # A scene's props are its state, typed as JS gave them (`count={3}` is 3):
    # they are the scene's to read, not attributes of an element.
    if not r.memo.isNil:
      r.memo.sawScene = true
    var id = ""
    var json = "{}"
    if jsIsObject(props):
      discard ctx.stringProp(props, "id", id)
      let text = JS_JSONStringify(ctx, props, jsUndefined(ctx), jsUndefined(ctx))
      if jsIsString(text):
        json = toNimString(ctx, text)
      JS_FreeValue(ctx, text)
    # A handler on a <Scene> (`onPointerDown`) is the layout's, not a prop of
    # the scene (JSON leaves functions out, so it makes no copy): it runs when
    # the event reaches the scene there (interpreter.routePointer), so a
    # layout hears that a press went into one of its scenes.
    var handlers: seq[(string, string)]
    if jsIsObject(props):
      var
        tab: ptr UncheckedArray[JSPropertyEnum]
        count: uint32
      if JS_GetOwnPropertyNames(ctx, addr tab, addr count, props, (JS_GPN_STRING_MASK or JS_GPN_ENUM_ONLY).cint) == 0:
        for i in 0 ..< count.int:
          let raw = JS_AtomToCString(ctx, tab[i].atom)
          let name = $raw
          JS_FreeCString(ctx, raw)
          if name.len > 2 and name[0] == 'o' and name[1] == 'n' and name[2] in {'A' .. 'Z'}:
            let value = JS_GetProperty(ctx, props, tab[i].atom)
            if JS_IsFunction(ctx, value) != 0:
              discard JS_SetPropertyUint32(ctx, r.handlers, r.handlerCount.uint32, JS_DupValue(ctx, value))
              handlers.add((attrName(name), $r.handlerCount))
              inc r.handlerCount
            JS_FreeValue(ctx, value)
        JS_FreePropertyEnum(ctx, tab, count)
    JS_FreeValue(ctx, props)
    node.attrs = @[("id", if node.tag == "yield": SceneYieldTag else: id), ("props", json)]
    node.attrs.add handlers
    node.tag = "Scene"
    into.add node
    return
  var
    tab: ptr UncheckedArray[JSPropertyEnum]
    count: uint32
    look: string
  if jsIsObject(props) and JS_GetOwnPropertyNames(ctx, addr tab, addr count, props,
      (JS_GPN_STRING_MASK or JS_GPN_ENUM_ONLY).cint) == 0:
    for i in 0 ..< count.int:
      let raw = JS_AtomToCString(ctx, tab[i].atom)
      let value = JS_GetProperty(ctx, props, tab[i].atom)
      let name = $raw
      JS_FreeCString(ctx, raw)
      if name == "children":
        let tracked = r.track and myIndex >= 0
        if tracked: r.curPath.add myIndex
        r.addNodes(value, node.children, depth + 1)
        if tracked: r.curPath.setLen(r.curPath.len - 1)
      elif name in ["src", "href"] and jsIsObject(value):
        node.image = r.imageOf(value)
      elif name == "src" and node.tag == "img" and jsIsString(value):
        # A URL: fetched by the runtime at the size the layout gives it.
        if not r.memo.isNil:
          r.memo.sawUrl = true
        node.attrs.add(("src", toNimString(ctx, value)))
      elif JS_IsFunction(ctx, value) != 0:
        # onClick={() => ...}: kept in the app's context, the node says which.
        if name.len > 2 and name[0] == 'o' and name[1] == 'n' and name[2] in {'A' .. 'Z'}:
          discard JS_SetPropertyUint32(ctx, r.handlers, r.handlerCount.uint32, JS_DupValue(ctx, value))
          node.attrs.add((attrName(name), $r.handlerCount))
          inc r.handlerCount
      elif name == "look":
        if jsIsString(value):
          look = toNimString(ctx, value)
      elif name notin ["key", "ref"] and not jsIsNull(value) and not jsIsUndefined(value):
        # A number, a boolean or points={[1, 2, 3, 4]}: what String() makes of it
        node.attrs.add((attrName(name), toNimString(ctx, value)))
      JS_FreeValue(ctx, value)
    JS_FreePropertyEnum(ctx, tab, count)
  JS_FreeValue(ctx, props)
  if look.len > 0:
    # look="button": the desktop's look for that role of its theme where the
    # layout around the frame's scene gives one, as the UIs built in Nim take
    # it (ui/theme.nim, docs/jsx-ui.md "Themes"); its own classes where none
    # does. Not `role`, ARIA's attribute, which an app sets for its own ends.
    # theme.role reads the classes off the first attribute (swapped there, as
    # a seq insert was 230 B of the ESP32's flash).
    var at = 0
    while at < node.attrs.len and node.attrs[at][0] != "class": inc at
    if at == node.attrs.len:
      node.attrs.add(("class", ""))
    if at > 0:
      swap(node.attrs[0], node.attrs[at])
    node = node.role(look)
  into.add node
  if memoId >= 0:
    if memoId == 0:
      inc r.memo.nextId
      memoId = r.memo.nextId
      discard JS_SetPropertyStr(ctx, v, "__frameosNode", JS_NewInt32(ctx, memoId.int32))
    r.memo.kept.add JsxKept(id: memoId, node: node, firstHandler: firstHandler,
      handlers: r.handlerCount - firstHandler, nodes: r.nodes - firstNode, used: true)
    if r.track:
      r.memo.kept[^1].path = r.curPath
      if myIndex >= 0: r.memo.kept[^1].path.add myIndex

proc jsxNode*(ctx: ptr JSContext, v: JSValueConst, images: ptr Table[int, Image],
    holder: JSValueConst, memo: ptr JsxMemo = nil, drawing = false): SvgNode =
  ## The JSX element `v` (see jsxTag) as a node tree. Image refs in `src` or
  ## `href` are looked up in `images`. Handler props (`onClick`) become the
  ## `handlers` of `holder` (the app's entry in the prelude's
  ## `__frameosApps`: the apps of a scene share one context), numbered in
  ## the attributes (`on-click="3"`), until the next tree replaces them.
  ## `drawing`: what `frameos.draw` paints into a canvas, whose handlers mean
  ## nothing and must not replace the UI's.
  var
    reader = JsxReader(ctx: ctx, images: images, handlers: JS_NewArray(ctx), memo: memo, topIndex: -1,
      track: signalRecords() > 0,
      previous: if jsIsObject(holder): ctx.prop(holder, "handlers") else: jsUndefined(ctx))
    nodes: seq[SvgNode]
  if not memo.isNil:
    for kept in memo.kept.mitems:
      kept.used = false
  reader.addNodes(v, nodes, 0)
  if not memo.isNil and not drawing:
    memo.handlers = reader.handlerCount
  if not memo.isNil:
    # What this render's tree no longer holds is let go.
    var i = 0
    while i < memo.kept.len:
      if memo.kept[i].used: inc i
      else: memo.kept.del(i)
  JS_FreeValue(ctx, reader.previous)
  if drawing or not jsIsObject(holder):
    JS_FreeValue(ctx, reader.handlers)
  else:
    discard JS_SetPropertyStr(ctx, holder, "handlers", reader.handlers)
  if nodes.len > 0: nodes[0] else: SvgNode(tag: "svg")

proc splicedAt(n: SvgNode, path: seq[int32], at: int, repl: SvgNode): SvgNode =
  ## `n` with the node at `path` (from `at`) replaced by `repl`: the nodes on
  ## the way copied, every other node the same object, which the layout and
  ## pixie take for unchanged.
  if at >= path.len:
    return repl
  let i = path[at].int
  if n.isNil or i < 0 or i >= n.children.len:
    return nil
  let child = splicedAt(n.children[i], path, at + 1, repl)
  if child.isNil:
    return nil
  result = SvgNode(tag: n.tag, text: n.text, attrs: n.attrs, children: n.children, image: n.image,
    path: n.path, offset: n.offset)
  result.children[i] = child

proc jsxSplice*(ctx: ptr JSContext, root: SvgNode, oldId: int, element: JSValueConst,
    images: ptr Table[int, Image], holder: JSValueConst, memo: ptr JsxMemo): SvgNode =
  ## `element`, a memo()'d component's new element (a signal it read was set),
  ## read where the element numbered `oldId` was in `root`, its handlers at
  ## the numbers the old one's had: the new root. nil when it cannot be (the
  ## old one is not in the tree, or its handlers changed in number): a whole
  ## get() then.
  if memo.isNil or not jsIsObject(holder):
    return nil
  var at = -1
  for i in 0 ..< memo.kept.len:
    if memo.kept[i].id == oldId:
      at = i
      break
  if at < 0:
    return nil
  let old = memo.kept[at]
  let handlers = ctx.prop(holder, "handlers")
  if not jsIsObject(handlers):
    JS_FreeValue(ctx, handlers)
    return nil
  var reader = JsxReader(ctx: ctx, images: images, handlers: handlers, memo: memo,
    previous: JS_DupValue(ctx, handlers), handlerCount: old.firstHandler, track: true,
    topIndex: (if old.path.len > 0: old.path[^1] else: -1'i32))
  if old.path.len > 0:
    reader.curPath = old.path[0 ..< old.path.len - 1]
  reader.keptCursor = at
  var nodes: seq[SvgNode]
  reader.addNodes(element, nodes, 0)
  JS_FreeValue(ctx, reader.previous)
  JS_FreeValue(ctx, handlers)
  if nodes.len != 1 or reader.handlerCount - old.firstHandler != old.handlers:
    return nil
  # The old element's entry goes (the new one has its own), and so do those
  # of the memo()'d elements around it: what they hold is the old element.
  var kept = 0
  for i in 0 ..< memo.kept.len:
    var around = memo.kept[i].id == oldId or memo.kept[i].path.len < old.path.len
    if around and memo.kept[i].id != oldId:
      for j in 0 ..< memo.kept[i].path.len:
        if memo.kept[i].path[j] != old.path[j]:
          around = false
          break
    if not around:
      if kept != i: memo.kept[kept] = move memo.kept[i]
      inc kept
  memo.kept.setLen(kept)
  splicedAt(root, old.path, 0, nodes[0])

proc jsxSplicePairs*(ctx: ptr JSContext, root: SvgNode, pairs: JSValueConst,
    images: ptr Table[int, Image], holder: JSValueConst, memo: ptr JsxMemo): SvgNode =
  ## What the prelude's __frameosPartial returned, [old number, element, ...],
  ## spliced into `root` one by one (jsxSplice); nil when it is no list or
  ## one of them cannot be.
  if JS_IsArray(ctx, pairs) == 0:
    return nil
  result = root
  let length = ctx.int32Of(ctx.prop(pairs, "length"))
  var k = 0
  while k + 1 < length and not result.isNil:
    let element = JS_GetPropertyUint32(ctx, pairs, (k + 1).uint32)
    let id = JS_GetPropertyUint32(ctx, pairs, k.uint32)
    result = jsxSplice(ctx, result, ctx.int32Of(id), element, images, holder, memo)
    JS_FreeValue(ctx, id)
    JS_FreeValue(ctx, element)
    k += 2

{.pop.}
