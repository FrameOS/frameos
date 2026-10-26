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

proc JS_AtomToCString(ctx: ptr JSContext, atom: JSAtom): cstring {.importc, header: "quickjs/quickjs.h".}

const
  # SVG's own camelCase names; every other camelCase prop (strokeWidth) is
  # the kebab-cased attribute (stroke-width), as React writes them.
  keepCamel = ["viewBox", "gradientUnits", "gradientTransform", "preserveAspectRatio"]
  MaxNodes = 20_000
  MaxDepth = 64

{.push raises: [].}

type
  JsxKept = object
    id: int
    node: SvgNode
    firstHandler, handlers, nodes: int
    used: bool

  JsxMemo* = object
    ## The nodes of elements memo() made (the prelude's), by the number the
    ## walker gave each: memo returns the same element object while its props
    ## are the same, and its nodes are taken back without reading it.
    kept: seq[JsxKept]
    nextId: int

  JsxReader = object
    ctx: ptr JSContext
    images: ptr Table[int, Image]
    nodes: int
    handlers: JSValue  # this render's onClick, onLongPress, ... functions
    handlerCount: int
    previous: JSValue  # the last render's, for the handlers of kept nodes
    memo: ptr JsxMemo

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
  if memoId > 0:
    for kept in r.memo.kept.mitems:
      # Taken back where its handlers have the numbers they had: copied
      # from the last render's list into this one's at those numbers.
      if kept.id == memoId and kept.firstHandler == r.handlerCount:
        for h in kept.firstHandler ..< kept.firstHandler + kept.handlers:
          discard JS_SetPropertyUint32(ctx, r.handlers, h.uint32, JS_GetPropertyUint32(ctx, r.previous, h.uint32))
        r.handlerCount += kept.handlers
        r.nodes += kept.nodes
        kept.used = true
        into.add kept.node
        return
  let
    firstHandler = r.handlerCount
    firstNode = r.nodes
  let node = SvgNode()
  if not ctx.stringProp(v, "type", node.tag):
    return
  let props = ctx.prop(v, "props")
  var
    tab: ptr UncheckedArray[JSPropertyEnum]
    count: uint32
  if jsIsObject(props) and JS_GetOwnPropertyNames(ctx, addr tab, addr count, props,
      (JS_GPN_STRING_MASK or JS_GPN_ENUM_ONLY).cint) == 0:
    for i in 0 ..< count.int:
      let raw = JS_AtomToCString(ctx, tab[i].atom)
      let value = JS_GetProperty(ctx, props, tab[i].atom)
      let name = $raw
      JS_FreeCString(ctx, raw)
      if name == "children":
        r.addNodes(value, node.children, depth + 1)
      elif name in ["src", "href"] and jsIsObject(value):
        node.image = r.imageOf(value)
      elif JS_IsFunction(ctx, value) != 0:
        # onClick={() => ...}: kept in the app's context, the node says which.
        if name.len > 2 and name[0] == 'o' and name[1] == 'n' and name[2] in {'A' .. 'Z'}:
          discard JS_SetPropertyUint32(ctx, r.handlers, r.handlerCount.uint32, JS_DupValue(ctx, value))
          node.attrs.add((attrName(name), $r.handlerCount))
          inc r.handlerCount
      elif name notin ["key", "ref"] and not jsIsNull(value) and not jsIsUndefined(value):
        # A number, a boolean or points={[1, 2, 3, 4]}: what String() makes of it
        node.attrs.add((attrName(name), toNimString(ctx, value)))
      JS_FreeValue(ctx, value)
    JS_FreePropertyEnum(ctx, tab, count)
  JS_FreeValue(ctx, props)
  into.add node
  if memoId >= 0:
    if memoId == 0:
      inc r.memo.nextId
      memoId = r.memo.nextId
      discard JS_SetPropertyStr(ctx, v, "__frameosNode", JS_NewInt32(ctx, memoId.int32))
    r.memo.kept.add JsxKept(id: memoId, node: node, firstHandler: firstHandler,
      handlers: r.handlerCount - firstHandler, nodes: r.nodes - firstNode, used: true)

proc jsxNode*(ctx: ptr JSContext, v: JSValueConst, images: ptr Table[int, Image],
    memo: ptr JsxMemo = nil, drawing = false): SvgNode =
  ## The JSX element `v` (see jsxTag) as a node tree. Image refs in `src` or
  ## `href` are looked up in `images`. Handler props (`onClick`) become the
  ## global `__frameosHandlers` of this render, numbered in the attributes
  ## (`on-click="3"`), until the next tree replaces them. `drawing`: what
  ## `frameos.draw` paints into a canvas, whose handlers mean nothing and
  ## must not replace the UI's.
  let global = JS_GetGlobalObject(ctx)
  var
    reader = JsxReader(ctx: ctx, images: images, handlers: JS_NewArray(ctx), memo: memo,
      previous: ctx.prop(global, "__frameosHandlers"))
    nodes: seq[SvgNode]
  if not memo.isNil:
    for kept in memo.kept.mitems:
      kept.used = false
  reader.addNodes(v, nodes, 0)
  if not memo.isNil:
    # What this render's tree no longer holds is let go.
    var i = 0
    while i < memo.kept.len:
      if memo.kept[i].used: inc i
      else: memo.kept.del(i)
  JS_FreeValue(ctx, reader.previous)
  if drawing:
    JS_FreeValue(ctx, reader.handlers)
  else:
    discard JS_SetPropertyStr(ctx, global, "__frameosHandlers", reader.handlers)
  JS_FreeValue(ctx, global)
  if nodes.len > 0: nodes[0] else: SvgNode(tag: "svg")

{.pop.}
