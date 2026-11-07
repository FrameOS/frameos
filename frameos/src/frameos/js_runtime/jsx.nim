## JSX from a JS app, read into the node tree pixie draws and the UI layout
## lays out (`docs/jsx-ui.md`).
##
## The prelude's `__frameosJsx` makes plain `{type, props}` objects (and
## calls function components on the spot), so what an app returns is a tree
## of those. It is read here straight off the JS objects: no markup is
## written in JS and none is parsed in Nim. `<svg>` trees go to pixie as they
## are; anything else is a UI the layout turns into one (`ui/layout.nim`).
##
## Blocks (`docs/quickts.md` "Blocks"): an app's sources are parsed with
## quickts' block lowering, and an element `__frameosBlock` made carries its
## node of the site's template and the site's values. The template is read
## here once, by identity (`CNode`: tags, attribute names already converted,
## static values already strings), and the element is built from it and the
## values alone, without listing its props. Where the walk meets such an
## element, the node it built last render is taken back when every value is
## the same as then (`JsxBlockKept`): a handler that is a new closure each
## render is put under the number it had, without walking the element again.

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
  MaxLeaves = 4096   # the values one kept element compares, at most
  MaxTemplates = 1024  # compiled template nodes kept; past it, all are let go

{.emit: """/*TYPESECTION*/
#include <string.h>
#include "quickjs/quickjs.h"
""".}

{.emit: """
/* Strict equality of two values that are not objects, as `===` reads them. */
static int frameos_jsx_same_value(JSContext *ctx, JSValueConst a, JSValueConst b) {
  if (JS_IsNumber(a) && JS_IsNumber(b)) {
    double x, y;
    if (JS_ToFloat64(ctx, &x, a) || JS_ToFloat64(ctx, &y, b)) return 0;
    return x == y;
  }
  if (JS_IsString(a) && JS_IsString(b)) {
    if (JS_VALUE_GET_PTR(a) == JS_VALUE_GET_PTR(b)) return 1;
    size_t la, lb;
    const char *sa = JS_ToCStringLen(ctx, &la, a);
    const char *sb = sa ? JS_ToCStringLen(ctx, &lb, b) : NULL;
    int same = sa && sb && la == lb && memcmp(sa, sb, la) == 0;
    if (sa) JS_FreeCString(ctx, sa);
    if (sb) JS_FreeCString(ctx, sb);
    return same;
  }
  if (JS_VALUE_GET_TAG(a) != JS_VALUE_GET_TAG(b)) return 0;
  if (JS_IsBool(a)) return JS_VALUE_GET_BOOL(a) == JS_VALUE_GET_BOOL(b);
  if (JS_IsNull(a) || JS_IsUndefined(a)) return 1;
  return JS_VALUE_GET_PTR(a) == JS_VALUE_GET_PTR(b); /* a symbol, a BigInt */
}
""".}

proc frameosJsxSameValue(ctx: ptr JSContext, a, b: JSValueConst): cint {.importc: "frameos_jsx_same_value", nodecl.}

proc jsPtr(v: JSValueConst): pointer =
  {.emit: "`result` = JS_VALUE_GET_PTR(`v`);".}

proc jsNegativeInt(v: JSValueConst): int =
  ## The hole a template value names (-1 - i for the i-th), -1 for a static one.
  {.emit: "`result` = (JS_VALUE_GET_TAG(`v`) == JS_TAG_INT && JS_VALUE_GET_INT(`v`) < 0) ? -1 - JS_VALUE_GET_INT(`v`) : -1;".}

{.push raises: [].}

type
  CPartKind = enum cpText, cpNode, cpHole
  CPart = object
    ## An attribute (name, attr set) or a child of a template node.
    kind: CPartKind
    name: string  ## an attribute as written: the rules below read it
    attr: string  ## the same as an SVG attribute (attrName)
    text: string  ## cpText: what String() makes of the static value
    node: CNode   ## cpNode: a child element
    hole: int     ## cpHole

  CNode = ref object
    ## One node of a template, read once (see the module's doc). Only the
    ## shapes the walk builds from: a node with a spread, a name twice, a
    ## `children` attribute or an element as an attribute's value (all rare)
    ## is read off its props instead, as the factory's elements are.
    tag: string
    tagHole: int  ## >= 0: the tag is that hole (a component, or a tag in a variable)
    fragment: bool
    failed: bool  ## a template not built from: remembered, not read again
    attrs: seq[CPart]
    children: seq[CPart]

  TemplateSlot = object
    key: pointer
    node: CNode

  LeafKind = enum lkValue, lkFunction, lkSite, lkArray, lkIdentity, lkImage
  Leaf = object
    kind: LeafKind
    value: JSValue  ## owned: lkValue, lkSite (the template node), lkIdentity
    count: int      ## lkArray
    image: Image    ## lkImage: what src={ref} draws (a ref can outlive its picture)

  JsxBlockKept = object
    site: pointer  ## the template node, kept alive by leaves[0]
    leaves: seq[Leaf]
    comparable: bool
    node: SvgNode
    firstHandler, handlers, nodes: int
    handlerLeaf: seq[int]  ## per handler: which of the element's functions it is, -1 none
    span: int  ## the kept elements inside this one, right after it
    taken: bool

  JsxKept = object
    id: int
    node: SvgNode
    firstHandler, handlers, nodes: int
    used: bool

  JsxMemo* = object
    ## What one UI's walk keeps between renders. The nodes of elements memo()
    ## made (the prelude's), by the number the walker gave each: memo returns
    ## the same element object while its props are the same, and its nodes
    ## are taken back without reading it. The nodes of elements blocks made,
    ## with the values they were made of, and the compiled templates. It holds
    ## the interpreter's values: releaseJsxMemo before the context goes.
    kept: seq[JsxKept]
    nextId: int
    blocks: seq[JsxBlockKept]  ## the last render's elements made by blocks, in walk order
    templates: seq[TemplateSlot]  ## open addressing by the template node's pointer
    templateCount: int
    templateValues: seq[JSValue]  ## what keeps the compiled templates' pointers valid

  JsxReader = object
    ctx: ptr JSContext
    images: ptr Table[int, Image]
    nodes: int
    handlers: JSValue  # this render's onClick, onLongPress, ... functions
    handlerCount: int
    handlersBefore: JSValue  # the last render's, for the handlers of kept nodes
    memo: ptr JsxMemo
    keptCursor: int  # where in memo.kept the next memo()'d element is looked for
    reuse: bool  # memo()'d elements and blocks taken back (not for frameos.draw)
    blocks: seq[JsxBlockKept]  # this render's, in walk order
    blockCursor: int  # where in memo.blocks the next element is looked for
    handlerPtrs: seq[pointer]  # this render's handler functions, by number

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
  # A block's element: its props are made only if something reads them.
  let site = ctx.prop(v, "__frameosSite")
  let lazy = jsIsObject(site)
  JS_FreeValue(ctx, site)
  if lazy:
    return
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

proc addNodes(r: var JsxReader, v: JSValueConst, into: var seq[SvgNode], depth: int)

proc addHandler(r: var JsxReader, node: SvgNode, name: string, value: JSValueConst) =
  ## onClick={() => ...}: kept in the app's context, the node says which.
  discard JS_SetPropertyUint32(r.ctx, r.handlers, r.handlerCount.uint32, JS_DupValue(r.ctx, value))
  r.handlerPtrs.add jsPtr(value)
  node.attrs.add((attrName(name), $r.handlerCount))
  inc r.handlerCount

proc isHandlerName(name: string): bool {.inline.} =
  name.len > 2 and name[0] == 'o' and name[1] == 'n' and name[2] in {'A' .. 'Z'}

proc addProp(r: var JsxReader, node: SvgNode, name, attr: string, value: JSValueConst, depth: int) =
  ## One prop of an element, by the rules a prop has always been read by;
  ## `attr` is attrName(name), when the caller has it.
  let ctx = r.ctx
  if name == "children":
    r.addNodes(value, node.children, depth + 1)
  elif name in ["src", "href"] and jsIsObject(value):
    node.image = r.imageOf(value)
  elif JS_IsFunction(ctx, value) != 0:
    if isHandlerName(name):
      r.addHandler(node, name, value)
  elif name notin ["key", "ref"] and not jsIsNull(value) and not jsIsUndefined(value):
    # A number, a boolean or points={[1, 2, 3, 4]}: what String() makes of it
    let key = if attr.len > 0: attr else: attrName(name)
    node.attrs.add((key, toNimString(ctx, value)))

proc plainNode(r: var JsxReader, v: JSValueConst, depth: int): SvgNode =
  ## An element read off its props: one the factory made, not a block.
  let ctx = r.ctx
  let node = SvgNode()
  if not ctx.stringProp(v, "type", node.tag):
    return nil
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
      r.addProp(node, name, "", value, depth)
      JS_FreeValue(ctx, value)
    JS_FreePropertyEnum(ctx, tab, count)
  JS_FreeValue(ctx, props)
  node

# --- templates --------------------------------------------------------------

proc arrayLength(ctx: ptr JSContext, v: JSValueConst): int =
  let length = ctx.prop(v, "length")
  result = ctx.int32Of(length)
  JS_FreeValue(ctx, length)

proc slotOf(memo: ptr JsxMemo, key: pointer): int =
  ## Where `key` is, or the empty slot it would go in (a Table here was
  ## 1.5 KB of the ESP32's flash).
  let mask = memo.templates.len - 1
  var i = int(((cast[uint](key) shr 4) * 2654435761'u) and uint(mask))
  while memo.templates[i].key != nil and memo.templates[i].key != key:
    i = (i + 1) and mask
  i

proc findTemplate(memo: ptr JsxMemo, key: pointer): CNode =
  if memo.templates.len > 0:
    result = memo.templates[memo.slotOf(key)].node

proc putTemplate(memo: ptr JsxMemo, key: pointer, node: CNode) =
  if (memo.templateCount + 1) * 2 > memo.templates.len:
    let old = move(memo.templates)
    memo.templates = newSeq[TemplateSlot](max(64, old.len * 2))
    for slot in old:
      if slot.key != nil:
        memo.templates[memo.slotOf(slot.key)] = slot
  let i = memo.slotOf(key)
  if memo.templates[i].key == nil:
    inc memo.templateCount
  memo.templates[i] = TemplateSlot(key: key, node: node)

proc compilePart(memo: ptr JsxMemo, ctx: ptr JSContext, value: JSValueConst, depth: int,
    part: var CPart): bool

proc compileNode(memo: ptr JsxMemo, ctx: ptr JSContext, t: JSValueConst, depth: int): CNode =
  ## A template node read into a CNode (nil when it is not one the walk
  ## builds from), and every node inside it registered by its pointer.
  if depth > MaxDepth or JS_IsArray(ctx, t) == 0:
    return nil
  let known = memo.findTemplate(jsPtr(t))
  if not known.isNil:
    return if known.failed: nil else: known
  let length = arrayLength(ctx, t)
  if length < 2:
    return nil
  let cn = CNode(tagHole: -1)
  let tag = JS_GetPropertyUint32(ctx, t, 0)
  if jsIsNull(tag):
    cn.fragment = true
  elif jsIsString(tag):
    cn.tag = toNimString(ctx, tag)
  else:
    cn.tagHole = jsNegativeInt(tag)
  JS_FreeValue(ctx, tag)
  if not cn.fragment and cn.tag.len == 0 and cn.tagHole < 0:
    return nil
  var ok = true
  let attrs = JS_GetPropertyUint32(ctx, t, 1)
  if JS_IsArray(ctx, attrs) != 0:
    let count = arrayLength(ctx, attrs)
    var i = 0
    while i + 1 < count and ok:
      let name = JS_GetPropertyUint32(ctx, attrs, i.uint32)
      let value = JS_GetPropertyUint32(ctx, attrs, (i + 1).uint32)
      var a: CPart
      ok = jsIsString(name)
      if ok:
        a.name = toNimString(ctx, name)
        a.attr = attrName(a.name)
        ok = a.name != "children" and compilePart(memo, ctx, value, depth, a) and a.kind != cpNode
        for other in cn.attrs:
          if other.name == a.name:
            ok = false
      cn.attrs.add a
      JS_FreeValue(ctx, name)
      JS_FreeValue(ctx, value)
      i += 2
  elif not jsIsNull(attrs):
    ok = false
  JS_FreeValue(ctx, attrs)
  for i in 2 ..< length:
    if not ok:
      break
    let value = JS_GetPropertyUint32(ctx, t, i.uint32)
    var c: CPart
    ok = compilePart(memo, ctx, value, depth, c)
    cn.children.add c
    JS_FreeValue(ctx, value)
  if not ok:
    return nil
  memo.putTemplate(jsPtr(t), cn)
  cn

proc compilePart(memo: ptr JsxMemo, ctx: ptr JSContext, value: JSValueConst, depth: int,
    part: var CPart): bool =
  part.hole = jsNegativeInt(value)
  if part.hole >= 0:
    part.kind = cpHole
  elif JS_IsArray(ctx, value) != 0:
    part.kind = cpNode
    part.node = compileNode(memo, ctx, value, depth + 1)
    return not part.node.isNil
  else:
    part.kind = cpText
    part.text = toNimString(ctx, value)
  true

proc compiled(r: var JsxReader, site: JSValueConst): CNode =
  let memo = r.memo
  result = memo.findTemplate(jsPtr(site))
  if not result.isNil and result.failed:
    return nil
  if result.isNil:
    if memo.templateCount >= MaxTemplates:
      # Code evaluated again and again makes new templates; never a leak.
      memo.templates.setLen(0)
      memo.templateCount = 0
      for value in memo.templateValues:
        JS_FreeValue(r.ctx, value)
      memo.templateValues.setLen(0)
    result = compileNode(memo, r.ctx, site, 0)
    if result.isNil:
      memo.putTemplate(jsPtr(site), CNode(failed: true))
    memo.templateValues.add JS_DupValue(r.ctx, site)

proc holeOf(ctx: ptr JSContext, holes: JSValueConst, i: int): JSValue {.inline.} =
  JS_GetPropertyUint32(ctx, holes, i.uint32)

proc walkTemplate(r: var JsxReader, cn: CNode, holes: JSValueConst, into: var seq[SvgNode], depth: int)

proc addChildren(r: var JsxReader, cn: CNode, holes: JSValueConst, into: var seq[SvgNode], depth: int) =
  ## A node's JSX children: one child read as itself, more as the array the
  ## factory makes of them.
  let d = if cn.children.len > 1: depth + 2 else: depth + 1
  if cn.children.len > 1:
    inc r.nodes
  for c in cn.children:
    case c.kind
    of cpText:
      if r.nodes < MaxNodes and d <= MaxDepth:
        inc r.nodes
        into.add SvgNode(text: c.text)
    of cpNode:
      r.walkTemplate(c.node, holes, into, d)
    of cpHole:
      let value = holeOf(r.ctx, holes, c.hole)
      r.addNodes(value, into, d)
      JS_FreeValue(r.ctx, value)

proc walkProps(r: var JsxReader, node: SvgNode, cn: CNode, holes: JSValueConst, depth: int) =
  ## The props in the order the factory's object has them: the attributes,
  ## then the JSX children.
  for a in cn.attrs:
    if a.kind == cpText:
      if a.name notin ["key", "ref"]:
        node.attrs.add((a.attr, a.text))
    else:
      let value = holeOf(r.ctx, holes, a.hole)
      r.addProp(node, a.name, a.attr, value, depth)
      JS_FreeValue(r.ctx, value)
  if cn.children.len > 0:
    r.addChildren(cn, holes, node.children, depth)

proc walkTemplate(r: var JsxReader, cn: CNode, holes: JSValueConst, into: var seq[SvgNode], depth: int) =
  ## The nodes of one template node, with the site's values in `holes`.
  if r.nodes >= MaxNodes or depth > MaxDepth:
    return
  if cn.fragment:
    if cn.children.len > 0:
      r.addChildren(cn, holes, into, depth - 1)
    return
  var tag = cn.tag
  if cn.tagHole >= 0:
    let value = holeOf(r.ctx, holes, cn.tagHole)
    if jsIsString(value):
      tag = toNimString(r.ctx, value)
      JS_FreeValue(r.ctx, value)
    else:
      # A component: its output, which the block put in its place as
      # [output]. A tag that is neither is nothing, as the factory's.
      if JS_IsArray(r.ctx, value) != 0:
        r.addNodes(value, into, depth)
      JS_FreeValue(r.ctx, value)
      return
  inc r.nodes
  let node = SvgNode(tag: tag)
  r.walkProps(node, cn, holes, depth)
  into.add node

# --- what an element is compared by -----------------------------------------

proc release(ctx: ptr JSContext, leaves: var seq[Leaf]) =
  for leaf in leaves:
    if leaf.kind in {lkValue, lkSite, lkIdentity}:
      JS_FreeValue(ctx, leaf.value)
  leaves.setLen(0)

proc release(ctx: ptr JSContext, kept: var JsxBlockKept) =
  release(ctx, kept.leaves)

proc snapshotNode(r: var JsxReader, cn: CNode, holes: JSValueConst, leaves: var seq[Leaf],
    fns: var seq[JSValue], depth: int): bool

proc snapshotValue(r: var JsxReader, v: JSValueConst, leaves: var seq[Leaf], fns: var seq[JSValue],
    depth: int): bool =
  ## `v` as leaves; false when it cannot be compared (an element the factory
  ## made, too much). Functions are put in `fns` (borrowed).
  let ctx = r.ctx
  if leaves.len >= MaxLeaves or depth > MaxDepth:
    return false
  if not jsIsObject(v):
    leaves.add Leaf(kind: lkValue, value: JS_DupValue(ctx, v))
    return true
  if JS_IsFunction(ctx, v) != 0:
    leaves.add Leaf(kind: lkFunction)
    fns.add v
    return true
  if JS_IsArray(ctx, v) != 0:
    let n = arrayLength(ctx, v)
    leaves.add Leaf(kind: lkArray, count: n)
    for i in 0 ..< n:
      let item = JS_GetPropertyUint32(ctx, v, i.uint32)
      let ok = r.snapshotValue(item, leaves, fns, depth + 1)
      JS_FreeValue(ctx, item)
      if not ok:
        return false
    return true
  # memo()'s element: the same object is the same element, whatever it holds.
  let mark = ctx.prop(v, "__frameosNode")
  let memoized = jsIsNumber(mark)
  JS_FreeValue(ctx, mark)
  if not memoized:
    let site = ctx.prop(v, "__frameosSite")
    if jsIsObject(site):
      let cn = r.compiled(site)
      let holes = ctx.prop(v, "__frameosHoles")
      if cn.isNil or JS_IsArray(ctx, holes) == 0:
        JS_FreeValue(ctx, site)
        JS_FreeValue(ctx, holes)
        return false
      leaves.add Leaf(kind: lkSite, value: site)
      result = r.snapshotNode(cn, holes, leaves, fns, depth + 1)
      JS_FreeValue(ctx, holes)
      return
    JS_FreeValue(ctx, site)
    # Any other element (the factory's, or one whose props were read) can
    # have been changed by hand. Any other object is read only for its image
    # (handled by the caller), its `[object Object]` or nothing.
    let kind = ctx.prop(v, "type")
    let element = not jsIsUndefined(kind)
    JS_FreeValue(ctx, kind)
    if element:
      return false
  leaves.add Leaf(kind: lkIdentity, value: JS_DupValue(ctx, v))
  true

proc snapshotNode(r: var JsxReader, cn: CNode, holes: JSValueConst, leaves: var seq[Leaf],
    fns: var seq[JSValue], depth: int): bool =
  ## The values a template node's nodes are made of, in a fixed order. A
  ## component's are its output: what it was given is in what it made.
  let ctx = r.ctx
  if cn.tagHole >= 0:
    let value = holeOf(ctx, holes, cn.tagHole)
    let isTag = jsIsString(value)
    let ok = r.snapshotValue(value, leaves, fns, depth)
    JS_FreeValue(ctx, value)
    if not ok or not isTag:
      return ok
  for a in cn.attrs:
    if a.kind == cpHole:
      let value = holeOf(ctx, holes, a.hole)
      var ok: bool
      if a.name in ["src", "href"] and jsIsObject(value) and JS_IsFunction(ctx, value) == 0:
        leaves.add Leaf(kind: lkImage, image: r.imageOf(value))
        ok = true
      else:
        ok = r.snapshotValue(value, leaves, fns, depth)
      JS_FreeValue(ctx, value)
      if not ok:
        return false
  for c in cn.children:
    case c.kind
    of cpText:
      discard
    of cpNode:
      if not r.snapshotNode(c.node, holes, leaves, fns, depth + 1):
        return false
    of cpHole:
      let value = holeOf(ctx, holes, c.hole)
      let ok = r.snapshotValue(value, leaves, fns, depth)
      JS_FreeValue(ctx, value)
      if not ok:
        return false
  true

proc sameLeaves(ctx: ptr JSContext, a, b: seq[Leaf]): bool =
  if a.len != b.len:
    return false
  for i in 0 ..< a.len:
    if a[i].kind != b[i].kind:
      return false
    case a[i].kind
    of lkValue:
      if frameosJsxSameValue(ctx, a[i].value, b[i].value) == 0:
        return false
    of lkSite, lkIdentity:
      if jsPtr(a[i].value) != jsPtr(b[i].value):
        return false
    of lkArray:
      if a[i].count != b[i].count:
        return false
    of lkImage:
      if a[i].image != b[i].image:
        return false
    of lkFunction:
      discard
  true

proc blockNode(r: var JsxReader, v, site: JSValueConst, depth: int): SvgNode =
  ## An element a block made: taken back from the last render when it is
  ## made of the same values, else built from its template. nil: not a
  ## template after all (the caller reads its props).
  let ctx = r.ctx
  let cn = r.compiled(site)
  if cn.isNil or cn.fragment:
    return nil
  let holes = ctx.prop(v, "__frameosHoles")
  defer: JS_FreeValue(ctx, holes)
  if JS_IsArray(ctx, holes) == 0:
    return nil
  if cn.tagHole >= 0:
    # The element of a tag in a variable (<Tag>): never a component here,
    # which made no element of its own.
    let value = holeOf(ctx, holes, cn.tagHole)
    let isTag = jsIsString(value)
    JS_FreeValue(ctx, value)
    if not isTag:
      return nil
  if not r.reuse:
    var nodes: seq[SvgNode]
    r.walkTemplate(cn, holes, nodes, depth)
    return if nodes.len > 0: nodes[0] else: nil
  var
    leaves = @[Leaf(kind: lkSite, value: JS_DupValue(ctx, site))]
    fns: seq[JSValue]
  let comparable = r.snapshotNode(cn, holes, leaves, fns, depth)
  let previous = addr r.memo.blocks
  var at = -1
  for i in r.blockCursor ..< previous[].len:
    if not previous[i].taken and previous[i].site == jsPtr(site):
      at = i
      break
  if at >= 0:
    template kept: untyped = previous[at]
    var hit = comparable and kept.comparable and kept.firstHandler == r.handlerCount and
      at + kept.span < previous[].len and sameLeaves(ctx, kept.leaves, leaves)
    if hit:
      for i in at + 1 .. at + kept.span:
        if previous[i].taken:
          hit = false
    if hit:
      # Its handlers under the numbers they had: this render's closures
      # where the element holds them, else the last render's.
      for h in 0 ..< kept.handlers:
        let n = kept.firstHandler + h
        let k = kept.handlerLeaf[h]
        let fn = if k >= 0: JS_DupValue(ctx, fns[k]) else: JS_GetPropertyUint32(ctx, r.handlersBefore, n.uint32)
        r.handlerPtrs.add jsPtr(fn)
        discard JS_SetPropertyUint32(ctx, r.handlers, n.uint32, fn)
      r.handlerCount += kept.handlers
      r.nodes += kept.nodes
      # With the elements kept inside it, which the walk does not visit.
      let
        span = kept.span
        base = r.blocks.len
      for i in at .. at + span:
        r.blocks.add move(previous[i])
        previous[i].taken = true
      r.blockCursor = at + 1 + span
      release(ctx, leaves)
      return r.blocks[base].node
    r.blockCursor = at + 1
  let slot = r.blocks.len
  r.blocks.add JsxBlockKept()
  let
    firstHandler = r.handlerCount
    firstNode = r.nodes
  var nodes: seq[SvgNode]
  r.walkTemplate(cn, holes, nodes, depth)
  if nodes.len == 0:
    release(ctx, leaves)
    for i in slot ..< r.blocks.len:
      release(ctx, r.blocks[i])
    r.blocks.setLen(slot)
    return nil
  var handlerLeaf = newSeq[int](r.handlerCount - firstHandler)
  for h in 0 ..< handlerLeaf.len:
    handlerLeaf[h] = -1
    for k, fn in fns:
      if jsPtr(fn) == r.handlerPtrs[firstHandler + h]:
        handlerLeaf[h] = k
        break
  r.blocks[slot] = JsxBlockKept(site: jsPtr(site), leaves: move(leaves), comparable: comparable,
    node: nodes[0], firstHandler: firstHandler, handlers: r.handlerCount - firstHandler,
    nodes: r.nodes - firstNode, handlerLeaf: handlerLeaf, span: r.blocks.len - slot - 1)
  nodes[0]

proc addNodes(r: var JsxReader, v: JSValueConst, into: var seq[SvgNode], depth: int) =
  ## `v` as nodes appended to `into`: a string or number is text, an array
  ## its items, an element itself; null, undefined and booleans are nothing,
  ## as in React.
  let ctx = r.ctx
  if r.nodes >= MaxNodes or depth > MaxDepth or not (jsIsString(v) or jsIsNumber(v) or jsIsObject(v)):
    return
  if JS_IsFunction(ctx, v) != 0:
    return
  if not jsIsObject(v):
    inc r.nodes
    into.add SvgNode(text: toNimString(ctx, v))
    return
  if JS_IsArray(ctx, v) != 0:
    inc r.nodes
    let length = ctx.prop(v, "length")
    for i in 0 ..< ctx.int32Of(length):
      let item = JS_GetPropertyUint32(ctx, v, i.uint32)
      r.addNodes(item, into, depth + 1)
      JS_FreeValue(ctx, item)
    JS_FreeValue(ctx, length)
    return
  # An element memo() made: its number, 0 before the walker gave it one.
  var memoId = -1
  if r.reuse:
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
        let fn = JS_GetPropertyUint32(ctx, r.handlersBefore, h.uint32)
        r.handlerPtrs.add jsPtr(fn)
        discard JS_SetPropertyUint32(ctx, r.handlers, h.uint32, fn)
      r.handlerCount += kept.handlers
      r.nodes += kept.nodes
      kept.used = true
      into.add kept.node
      return
  let
    firstHandler = r.handlerCount
    firstNode = r.nodes
  var node: SvgNode
  let site = ctx.prop(v, "__frameosSite")
  if jsIsObject(site):
    node = r.blockNode(v, site, depth)
  JS_FreeValue(ctx, site)
  if node.isNil:
    if r.nodes >= MaxNodes:
      return
    inc r.nodes
    node = r.plainNode(v, depth)
    if node.isNil:
      return
  into.add node
  if memoId >= 0:
    if memoId == 0:
      inc r.memo.nextId
      memoId = r.memo.nextId
      discard JS_SetPropertyStr(ctx, v, "__frameosNode", JS_NewInt32(ctx, memoId.int32))
    r.memo.kept.add JsxKept(id: memoId, node: node, firstHandler: firstHandler,
      handlers: r.handlerCount - firstHandler, nodes: r.nodes - firstNode, used: true)

proc releaseJsxMemo*(memo: var JsxMemo, ctx: ptr JSContext) =
  ## What `memo` holds of `ctx`'s values, let go: before the context is.
  for kept in memo.blocks.mitems:
    release(ctx, kept)
  memo.blocks.setLen(0)
  for value in memo.templateValues:
    JS_FreeValue(ctx, value)
  memo.templateValues.setLen(0)
  memo.templates.setLen(0)
  memo.templateCount = 0
  memo.kept.setLen(0)

proc jsxNode*(ctx: ptr JSContext, v: JSValueConst, images: ptr Table[int, Image],
    memo: ptr JsxMemo = nil, drawing = false): SvgNode =
  ## The JSX element `v` (see jsxTag) as a node tree. Image refs in `src` or
  ## `href` are looked up in `images`. Handler props (`onClick`) become the
  ## global `__frameosHandlers` of this render, numbered in the attributes
  ## (`on-click="3"`), until the next tree replaces them. `drawing`: what
  ## `frameos.draw` paints into a canvas, whose handlers mean nothing and
  ## must not replace the UI's, and which takes back nothing (`memo` is then
  ## only where the templates are read).
  let global = JS_GetGlobalObject(ctx)
  var
    scratch: JsxMemo  # the templates' home for this walk, when no memo is given
    reader = JsxReader(ctx: ctx, images: images, handlers: JS_NewArray(ctx),
      memo: if memo.isNil: addr scratch else: memo,
      handlersBefore: ctx.prop(global, "__frameosHandlers"), reuse: not memo.isNil and not drawing)
    nodes: seq[SvgNode]
  if reader.reuse:
    for kept in memo.kept.mitems:
      kept.used = false
  reader.addNodes(v, nodes, 0)
  if reader.reuse:
    # What this render's tree no longer holds is let go.
    var i = 0
    while i < memo.kept.len:
      if memo.kept[i].used: inc i
      else: memo.kept.del(i)
    for kept in memo.blocks.mitems:
      if not kept.taken:
        release(ctx, kept)
    memo.blocks = move(reader.blocks)
  releaseJsxMemo(scratch, ctx)
  JS_FreeValue(ctx, reader.handlersBefore)
  if drawing:
    JS_FreeValue(ctx, reader.handlers)
  else:
    discard JS_SetPropertyStr(ctx, global, "__frameosHandlers", reader.handlers)
  JS_FreeValue(ctx, global)
  if nodes.len > 0: nodes[0] else: SvgNode(tag: "svg")

{.pop.}
