# frameos/src/frameos/js_runtime/runtime.nim
# A scene's own QuickJS context (the one its compiled program runs in,
# scene_compiler.nim and interpreter.nim), its budgets, and the conversions
# between Nim values and JavaScript ones that the program and the JS apps use.

import frameos/types
import frameos/values
import frameos/js_runtime/source_map
import frameos/js_runtime/burrito
import frameos/js_runtime/jsx_native
from frameos/utils/memory import deviceMemoryBytes
import lib/tz
import tables, json, strutils, locks
import chrono, times
import pixie

# -------------------------
# Internal evaluation scope
# -------------------------

type
  LazySourceMap = object
    ## A line map that may not have been built yet.
    ##
    ## It exists only to rewrite line numbers in error messages, and most
    ## runs never throw, so the map is built on the first error that needs it
    ## and cached from then on.
    built: bool
    map: SourceLineMap
    provider: proc(): SourceLineMap {.closure, gcsafe, raises: [].}

var jsSourceMapsByCtx = initTable[ptr JSContext, Table[string, LazySourceMap]]()
var tzName = ""
var sceneJsLock: Lock
# Scenes whose program is running right now (the last is the innermost: a
# scene node runs its scene inside its parent's program). After an
# out-of-memory abort, what is still here is what the abort jumped out of
# (abandonMidCallSceneJs).
var sceneJsStack: seq[InterpretedFrameScene] = @[]

template onSceneJsStack*(scene: InterpretedFrameScene, body: untyped) =
  sceneJsStack.add(scene)
  try:
    body
  finally:
    if sceneJsStack.len > 0 and sceneJsStack[^1] == scene:
      discard sceneJsStack.pop()

# Where a scene's program runs (scene_compiler.nim). A scene with code of its
# own (a code node, an inline input, a cache expression) is kept apart from
# every other scene:
#
# * Where there is room (a Pi, a board with more than 8 MB of PSRAM, an
#   ordinary browser preview) in a QuickJS runtime of its own: its own heap,
#   its scene's heap budget (shared with its JS apps), its own garbage
#   collector. One scene that runs out of memory, or whose runtime an
#   out-of-memory abort drops, takes no other scene with it. 155 KB on a
#   64-bit host.
# * On a board with 8 MB of PSRAM or less (and the preview simulating one) in
#   a context of its own, a realm with its own globals and built-ins, in the
#   runtime the programs share: what its code does to `globalThis` or
#   `Array.prototype` no other scene sees, but the heap, the budget and an
#   abort are shared. 40 KB.
#
# A scene without code runs its program, which the compiler wrote and nothing
# untrusted is in, in the shared runtime's first context: a split's wrapper
# or a scene of Nim apps costs only its program, and has no state to lose
# when that runtime is replaced. `programJsGeneration` moves when it is (an
# out-of-memory abort), and a scene in it whose `jsGeneration` is older sets
# itself up again.
const IsolatedRuntimeMinBytes = 8 * 1024 * 1024
  ## A device with more memory than this gives each scene with code a
  ## runtime of its own (an 8 MB board's PSRAM heap reports a little under).

proc isolatedSceneRuntimes*(): bool =
  let memory = deviceMemoryBytes()
  memory == 0 or memory > IsolatedRuntimeMinBytes

var programJs: QuickJS
var programJsReady = false
var programJsGeneration = 1
const ProgramsBudgetId = "frameos:scene-programs"
  ## The heap budget the programs share (the JS apps keep their scene's).
initLock(sceneJsLock)

const sceneJsPrelude* = compactJs("""
const __frameosFragment = Symbol.for("frameos.fragment");
// quickts lowers every JSX site to a call with null or a fresh object literal
// for the attributes (quickts_jsx.h), so the props object is this element's
// own: no copy. 76 bytecodes and ~15 allocations an element with the copy,
// about half without (2026-11-07).
const __frameosJsx = (type, props, ...children) => {
  const nextProps = props ?? {};
  if (children.length !== 0) {
    nextProps.children = children.length === 1 ? children[0] : children;
  }
  if (type === __frameosFragment) {
    return nextProps.children ?? null;
  }
  // A function component runs now: the tree an app returns is plain elements.
  return typeof type === "function" ? type(nextProps) : { type, props: nextProps };
};
globalThis.__frameosFragment = __frameosFragment;
globalThis.__frameosJsx = __frameosJsx;
// <Scene id="..." /> (docs/scene-layouts.md): a plain tag, read by name in
// js_runtime/jsx.nim, as <yield /> is.
globalThis.Scene = "Scene";
// memo(Component), as React's: called with props shallow-equal to its last
// call at the same place (its turn among this render's calls, or its key), it
// returns the element it made then, the same object, and the walker takes
// that element's nodes back without reading it (js_runtime/jsx.nim).
const __frameosSameProps = (a, b) => {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (!Object.is(a[k], b[k])) return false;
  return true;
};
// Two maps, swapped each render: what the last render used is what this one
// may take back, and a slot not used again (a keyed row that left the list)
// is gone with the swap. One map that only grew reached the interpreter's
// 4 MB heap cap after about a thousand renders of a list with changing keys
// (2026-11-07), on every host that keeps the interpreter between renders.
// The same two Map objects, cleared, not a new one a render: an animation
// renders thirty times a second.
globalThis.memo = (component) => {
  let render = -1, turn = 0;
  let last = new Map(), used = new Map();
  return (props) => {
    if (render !== globalThis.__frameosRender) {
      render = globalThis.__frameosRender; turn = 0;
      const spare = last; last = used; used = spare; used.clear();
    }
    const slot = props.key !== undefined ? "k" + props.key : turn++;
    const before = last.get(slot);
    if (before !== undefined && __frameosSameProps(before[0], props)) { used.set(slot, before); return before[1]; }
    const element = component(props);
    if (element !== null && typeof element === "object" && !Array.isArray(element)) element.__frameosNode = 0;
    used.set(slot, [props, element]);
    return element;
  };
};
""")

# Code nodes and inline expressions are TypeScript with JSX, whatever the
# scene calls them; the bundled QuickJS (quickts) parses both directly, and
# the scene's program around them with them.
const snippetEvalFlags* = JS_EVAL_FLAG_TYPESCRIPT or JS_EVAL_FLAG_JSX

proc registerJsSourceMap*(ctx: ptr JSContext, sourceMap: SourceLineMap) =
  if ctx == nil or sourceMap.generatedName.len == 0:
    return
  if not jsSourceMapsByCtx.hasKey(ctx):
    jsSourceMapsByCtx[ctx] = initTable[string, LazySourceMap]()
  jsSourceMapsByCtx[ctx][sourceMap.generatedName] =
    LazySourceMap(built: true, map: sourceMap)

proc registerJsSourceMapProvider*(ctx: ptr JSContext, generatedName: string,
    provider: proc(): SourceLineMap {.closure, gcsafe, raises: [].}) =
  ## Register a map that is only built if an error needs it. `provider` must
  ## stay valid for as long as the context does — in practice it closes over
  ## the runtime that holds the source and the generated code.
  if ctx == nil or generatedName.len == 0 or provider == nil:
    return
  if not jsSourceMapsByCtx.hasKey(ctx):
    jsSourceMapsByCtx[ctx] = initTable[string, LazySourceMap]()
  jsSourceMapsByCtx[ctx][generatedName] =
    LazySourceMap(built: false, provider: provider)

proc clearJsSourceMaps*(ctx: ptr JSContext) =
  if ctx != nil and jsSourceMapsByCtx.hasKey(ctx):
    jsSourceMapsByCtx.del(ctx)

proc mapJsErrorText*(ctx: ptr JSContext, text: string): string =
  result = text
  if ctx == nil or not jsSourceMapsByCtx.hasKey(ctx):
    return
  for _, entry in jsSourceMapsByCtx[ctx].mpairs:
    if not entry.built:
      # First error for this source: build the map now, once.
      if entry.provider != nil:
        entry.map = entry.provider()
      entry.built = true
    result = result.rewriteQuickJsLocations(entry.map)

proc mapJsErrorText*(text: string, sourceMap: SourceLineMap): string =
  text.rewriteQuickJsLocations(sourceMap)

# Convert Nim JsonNode -> JSValue (objects/arrays included).
proc jsonToJS*(ctx: ptr JSContext, j: JsonNode): JSValue =
  if j.isNil: return jsNull(ctx)
  case j.kind
  of JNull: return jsNull(ctx)
  of JBool: return nimBoolToJS(ctx, j.getBool())
  of JInt:
    let v = j.getInt()
    if v >= low(int32).int64 and v <= high(int32).int64:
      return nimIntToJS(ctx, v.int32)
    else:
      return nimFloatToJS(ctx, v.float64) # QuickJS has no public int64 binding here
  of JFloat: return nimFloatToJS(ctx, j.getFloat())
  of JString: return nimStringToJS(ctx, j.getStr())
  of JObject:
    let obj = JS_NewObject(ctx)
    for k in j.keys:
      let child = jsonToJS(ctx, j[k]) # consumed by SetProperty
      discard JS_SetPropertyStr(ctx, obj, k.cstring, child)
    return obj
  of JArray:
    let arr = JS_NewArray(ctx)
    var idx: uint32 = 0
    for el in j.elems:
      let child = jsonToJS(ctx, el) # consumed by SetPropertyUint32
      discard JS_SetPropertyUint32(ctx, arr, idx, child)
      inc idx
    return arr

proc valueToJS*(ctx: ptr JSContext, v: Value): JSValue =
  case v.kind
  of fkString, fkText:
    return nimStringToJS(ctx, v.s)
  of fkSpool:
    # JS is opaque by design (docs/value-pipeline.md, non-goals): a spooled
    # body crossing into QuickJS has to become a real JS string, so it
    # materializes here. That is the tier floor doing its job, not a leak —
    # but it does mean routing a multi-MB feed through a code node costs what
    # it always did.
    return nimStringToJS(ctx, v.sp.materialize())
  of fkFloat:
    return nimFloatToJS(ctx, v.f)
  of fkInteger:
    if v.i >= low(int32).int64 and v.i <= high(int32).int64:
      return nimIntToJS(ctx, v.i.int32)
    return nimFloatToJS(ctx, v.i.float64)
  of fkBoolean:
    return nimBoolToJS(ctx, v.b)
  of fkColor:
    return nimStringToJS(ctx, v.col.toHtmlHex)
  of fkJson:
    return jsonToJS(ctx, v.j)
  of fkNode:
    return nimIntToJS(ctx, v.nId.int32)
  of fkScene:
    return nimStringToJS(ctx, v.sId.string)
  of fkImage, fkImageSpool, fkNone:
    return jsNull(ctx)

# -------------------------
# Chrono proxies exposed to JS
# -------------------------

proc jsChronoParseTs(ctx: ptr JSContext, fmt: JSValue, text: JSValue): JSValue {.nimcall.} =
  let fmtStr = toNimString(ctx, fmt)
  let txtStr = toNimString(ctx, text)
  try:
    let ts = chrono.parseTs(fmtStr, txtStr) # chrono timestamp
    return nimFloatToJS(ctx, ts.float64)
  except CatchableError as e:
    raise newException(ValueError, "parseTs failed: " & e.msg)

proc setJsTimeZone*(name: string) =
  ## Fallback zone for `format` when the JS call has no scene behind it (a
  ## bare context outside a render). Whenever a scene is evaluating, its
  ## frameConfig.timeZone wins — see jsTimeZone.
  tzName = name.strip()

proc jsTimeZone(ctx: ptr JSContext): string =
  ## The zone `format(ts, fmt)` renders in: the frame's configured zone.
  ##
  ## frameConfig.timeZone is the one value every platform keeps current —
  ## frame.json (or /etc/localtime) on a Pi, the cloud/console zone pushed
  ## every render pass on an ESP32, the preview's zone in wasm. The previous
  ## fallback, detectSystemTimeZone(), reads /etc/localtime, which does not
  ## exist on an ESP32: every `format()` there rendered UTC no matter what
  ## zone the frame had, so a word clock in Brussels ran two hours behind
  ## while the Nim-side clock apps (which read frameConfig) were right.
  ## Chrono treats a zone it has no data for as UTC, so a name whose slice
  ## has not arrived yet degrades to what the old code did, never an error.
  if sceneJsStack.len > 0 and sceneJsStack[^1].frameConfig != nil:
    let configured = sceneJsStack[^1].frameConfig.timeZone.strip()
    if configured.len > 0:
      return configured
  if tzName.len == 0:
    tzName = detectSystemTimeZone()
  tzName

proc jsChronoFormat(ctx: ptr JSContext, tsVal: JSValue, fmt: JSValue): JSValue {.nimcall.} =
  let ts = toNimFloat(ctx, tsVal).Timestamp
  let fmtStr = toNimString(ctx, fmt)
  let zone = jsTimeZone(ctx)
  try:
    let output = format(ts, fmtStr, tzName = zone)
    return nimStringToJS(ctx, output)
  except CatchableError as e:
    raise newException(ValueError, "format failed: " & e.msg)

proc jsChronoNow(ctx: ptr JSContext): JSValue {.nimcall.} =
  try:
    let ts = epochTime()
    return nimFloatToJS(ctx, ts)
  except CatchableError as e:
    raise newException(ValueError, "now failed: " & e.msg)

proc stringifyJsValue*(ctx: ptr JSContext, val: JSValueConst): string =
  let globalObj = JS_GetGlobalObject(ctx)
  defer: JS_FreeValue(ctx, globalObj)

  let stringifyFn = JS_GetPropertyStr(ctx, globalObj, "__frameosStringify")
  defer: JS_FreeValue(ctx, stringifyFn)

  if JS_IsFunction(ctx, stringifyFn) != 0:
    var argv: array[1, JSValueConst]
    argv[0] = val
    let strVal = JS_Call(ctx, stringifyFn, globalObj, 1.cint, addr argv[0])
    defer: JS_FreeValue(ctx, strVal)
    if JS_IsException(strVal) == 0:
      return toNimString(ctx, strVal)

  let fallback = JS_JSONStringify(ctx, val, jsUndefined(ctx), jsUndefined(ctx))
  defer: JS_FreeValue(ctx, fallback)
  if JS_IsException(fallback) == 0:
    return toNimString(ctx, fallback)
  return "null"

proc jsValueToJson*(ctx: ptr JSContext, val: JSValueConst): JsonNode =
  if jsIsUndefined(val) or jsIsNull(val):
    return newJNull()
  if jsIsBool(val):
    return %*toNimBool(ctx, val)
  if jsIsNumber(val):
    let f = toNimFloat(ctx, val)
    if f >= low(int64).float64 and f <= high(int64).float64:
      let i = f.int64
      if i.float64 == f:
        return %*i
    return %*f
  if jsIsBigInt(ctx, val):
    try:
      return %*toNimInt64Ext(ctx, val)
    except CatchableError:
      return %*toNimString(ctx, val)
  if jsIsString(val):
    return %*toNimString(ctx, val)

  let jsonText = stringifyJsValue(ctx, val)
  try:
    return parseJson(jsonText)
  except CatchableError:
    return %*jsonText

proc jsValueToValue*(ctx: ptr JSContext, val: JSValueConst, expectedType: string = ""): Value =
  if expectedType.len > 0:
    if jsIsUndefined(val) or jsIsNull(val):
      return valueFromJsonByType(newJNull(), expectedType)
    case expectedType
    of "float":
      if jsIsNumber(val):
        return VFloat(toNimFloat(ctx, val))
    of "integer":
      if jsIsNumber(val):
        return VInt(toNimFloat(ctx, val).int64)
    of "boolean":
      if jsIsBool(val):
        return VBool(toNimBool(ctx, val))
    of "string":
      if jsIsString(val):
        return VString(toNimString(ctx, val))
    of "text":
      if jsIsString(val):
        return VText(toNimString(ctx, val))
    of "json":
      return VJson(jsValueToJson(ctx, val))
    else:
      discard
    return valueFromJsonByType(jsValueToJson(ctx, val), expectedType)

  if jsIsUndefined(val):
    return Value(kind: fkNone)
  if jsIsNull(val):
    return Value(kind: fkJson, j: newJNull())
  if jsIsBool(val):
    return Value(kind: fkBoolean, b: toNimBool(ctx, val))
  if jsIsNumber(val):
    let f = toNimFloat(ctx, val)
    if f >= low(int64).float64 and f <= high(int64).float64:
      let i = f.int64
      if i.float64 == f:
        return Value(kind: fkInteger, i: i)
    return Value(kind: fkFloat, f: f)
  if jsIsBigInt(ctx, val):
    try:
      return Value(kind: fkInteger, i: toNimInt64Ext(ctx, val))
    except CatchableError:
      return Value(kind: fkString, s: toNimString(ctx, val))
  if jsIsString(val):
    return Value(kind: fkString, s: toNimString(ctx, val))

  return Value(kind: fkJson, j: jsValueToJson(ctx, val))

proc jsExceptionDetails*(ctx: ptr JSContext): tuple[message: string, stack: string] =
  let exception = JS_GetException(ctx)
  defer: JS_FreeValue(ctx, exception)
  if jsIsObject(exception):
    let messageVal = JS_GetPropertyStr(ctx, exception, "message")
    defer: JS_FreeValue(ctx, messageVal)
    let stackVal = JS_GetPropertyStr(ctx, exception, "stack")
    defer: JS_FreeValue(ctx, stackVal)
    result.message = toNimString(ctx, messageVal)
    result.stack = toNimString(ctx, stackVal)
  else:
    result.message = toNimString(ctx, exception)
    result.stack = result.message
  if result.message.len == 0:
    result.message = "JavaScript error"
  # An interrupted script reports a bare "InternalError: interrupted", which
  # tells nobody why the scene died. Name the real cause — and which of the
  # two clocks (interpreter time, or the run's wall-clock deadline) ran out.
  let trip = takeContextDeadlineTrip(ctx)
  if trip.budgetMs > 0:
    result.message = deadlineTripMessage(trip.budgetMs, trip.wallClock)
    result.stack = result.message
  else:
    # `out of memory` is the scene's shared ceiling, not the device's; say so.
    result.message = describeJsError(result.message)

proc mappedJsExceptionDetails*(ctx: ptr JSContext): tuple[message: string, stack: string] =
  result = jsExceptionDetails(ctx)
  result.message = mapJsErrorText(ctx, result.message)
  result.stack = mapJsErrorText(ctx, result.stack)

proc callGlobalFunction*(ctx: ptr JSContext, fnName: string, args: openArray[JSValueConst] = []): JSValue =
  ## Every scene-authored function — code nodes, inline expressions and JS app
  ## init/get/run — enters the interpreter here, so this is where the
  ## execution-time budget gets armed. Callers read the exception normally; a
  ## budget overrun surfaces through jsExceptionDetails below.
  withContextDeadline(ctx):
    let globalObj = JS_GetGlobalObject(ctx)
    defer: JS_FreeValue(ctx, globalObj)
    let fn = JS_GetPropertyStr(ctx, globalObj, fnName.cstring)
    defer: JS_FreeValue(ctx, fn)
    if args.len == 0:
      result = JS_Call(ctx, fn, globalObj, 0.cint, nil)
    else:
      var argv = newSeq[JSValueConst](args.len)
      for i, arg in args:
        argv[i] = arg
      result = JS_Call(ctx, fn, globalObj, args.len.cint, addr argv[0])

# ---- per-scene heap budgets ------------------------------------------------
# One JsHeapBudget per scene id, shared by the scene's own context and by the
# runtime of every JS app node in it (app_runtime.ensureReady). QuickJS's
# memory limit is per runtime, so before this a scene with N JS nodes could
# hold N × 256 MB; now the N runtimes draw on one ceiling. Budgets are raw
# memory the allocator callbacks read on the C stack and are kept for the
# process lifetime — a few dozen 16-byte records at most — so a runtime that
# outlives a scene reload (evicted and rebuilt, or torn down late) never
# dereferences a freed budget.
var
  sceneHeapBudgets = initTable[string, ptr JsHeapBudget]()
  sceneHeapBudgetsLock: Lock

initLock(sceneHeapBudgetsLock)

proc sceneHeapBudgetFor*(sceneId: string, limitBytes: int): ptr JsHeapBudget =
  ## The scene's budget, created on first use; the limit follows the latest
  ## frame.json on every call so a config reload applies to new runtimes.
  {.gcsafe.}:
    withLock sceneHeapBudgetsLock:
      if sceneHeapBudgets.hasKey(sceneId):
        result = sceneHeapBudgets[sceneId]
      else:
        result = cast[ptr JsHeapBudget](alloc0(sizeof(JsHeapBudget)))
        sceneHeapBudgets[sceneId] = result
      result.limitBytes = max(0, limitBytes).csize_t

proc sceneHeapBudgetUsedBytes*(sceneId: string): int =
  ## Bytes the scene's runtimes currently hold, as the allocator accounts them.
  {.gcsafe.}:
    withLock sceneHeapBudgetsLock:
      if sceneHeapBudgets.hasKey(sceneId):
        return sceneHeapBudgets[sceneId].usedBytes.int
  0

proc sceneJsHeapLimitBytes*(frameConfig: FrameConfig): int =
  ## The scene-wide ceiling: frame.json's js.memoryLimitMb (0 = unlimited) or
  ## the build target's default.
  if frameConfig != nil and frameConfig.js != nil and frameConfig.js.memoryLimitMb >= 0:
    return frameConfig.js.memoryLimitMb * 1024 * 1024
  DefaultJsSceneHeapBytes

proc sceneJsConfig*(frameConfig: FrameConfig, sceneId: string = ""): QuickJSConfig =
  ## Per-frame overrides for the interpreter ceilings. Anything left at -1 (or
  ## absent from frame.json) keeps the build target's default. With a scene id
  ## the runtime also joins that scene's shared heap budget.
  result = defaultConfig()
  if frameConfig != nil and frameConfig.js != nil:
    if frameConfig.js.executionTimeoutMs >= 0:
      result.executionTimeoutMs = frameConfig.js.executionTimeoutMs
    if frameConfig.js.memoryLimitMb >= 0:
      # The per-runtime cap follows the scene ceiling on hosts that set one;
      # embedded keeps the glue's own per-runtime cap (config default 0).
      when not defined(frameosEmbedded):
        result.memoryLimitBytes = frameConfig.js.memoryLimitMb * 1024 * 1024
    if frameConfig.js.maxStackKb >= 0:
      result.maxStackSizeBytes = frameConfig.js.maxStackKb * 1024
  if sceneId.len > 0:
    let sceneLimit = sceneJsHeapLimitBytes(frameConfig)
    if sceneLimit > 0:
      result.heapBudget = sceneHeapBudgetFor(sceneId, sceneLimit)

# -------------------------
# Scene JS context
# -------------------------

proc programJsLive(scene: InterpretedFrameScene): bool {.inline.} =
  ## The scene's context is still there to free its values in.
  scene.jsReady and (scene.jsKind == sjRuntime or
    (programJsReady and scene.jsGeneration == programJsGeneration))

proc dropProgram*(scene: InterpretedFrameScene) =
  ## The program's ways in, given back (or forgotten, when the runtime they
  ## lived in is gone): the program is evaluated again on demand.
  if scene.programReady and scene.programJsLive:
    for entry in scene.programEntries:
      JS_FreeValue(scene.js.context, entry)
  scene.programReady = false
  reset(scene.programEntries)

proc closeSceneJsLocked(scene: InterpretedFrameScene) =
  ## A scene lets go of where its program runs: its own runtime or context
  ## freed, the shared one left. Caller holds sceneJsLock. Reversible: its
  ## program is evaluated again the next time it runs.
  let live = scene.programJsLive
  dropProgram(scene)
  if live and scene.jsKind != sjShared:
    clearJsSourceMaps(scene.js.context)
    if scene.jsKind == sjRuntime:
      scene.js.runPendingJobs()
      JS_RunGC(scene.js.runtime)
      scene.js.close()
    else:
      closeContext(scene.js)
      # What its program and code held, back now and not at some later
      # allocation's GC (on an ESP32 the next scene wants the memory).
      JS_RunGC(programJs.runtime)
  scene.js = QuickJS()
  scene.jsReady = false
  scene.jsKind = sjShared

# The scene context's prelude: the replacer the conversions stringify with,
# plus sceneJsPrelude. `console`, `state`, `args` and `context` are the
# program's own (scene_compiler.nim). Loaded as bytecode from the firmware
# image when tools/prelude_bytecode.nim ran (evalScenePrelude).
const sceneContextJsPrelude* = compactJs("""
    "use strict";
    const __jsReplacer = (k, v) =>
      (typeof v === 'bigint') ? { __bigint: v.toString() }
      : (v === undefined ? null : v);
    globalThis.__frameosStringify = (v) => JSON.stringify(v, __jsReplacer);
    """ & sceneJsPrelude)


when defined(frameosPreludeBytecode):
  # The preludes as bytecode, written by tools/prelude_bytecode.nim for this
  # exact QuickJS (embedded/esp32/build_nim.sh runs it). A module from another
  # engine version or an older prelude is refused here, not on the device.
  import std/os
  import assets/prelude_bytecode
  import frameos/js_runtime/prelude_checksum
  const quickjsVersionInTree = staticRead(
    currentSourcePath().parentDir.parentDir.parentDir.parentDir / "quickjs" / "VERSION").strip()
  static:
    doAssert preludeBytecodeQuickjsVersion == quickjsVersionInTree,
      "src/assets/prelude_bytecode.nim was written for QuickJS " & preludeBytecodeQuickjsVersion &
      " and the tree has " & quickjsVersionInTree & ": rerun tools/prelude_bytecode.nim"
    doAssert scenePreludeSourceChecksum == preludeChecksum(sceneContextJsPrelude),
      "src/assets/prelude_bytecode.nim is stale (sceneContextJsPrelude changed): rerun tools/prelude_bytecode.nim"

proc evalScenePrelude(js: QuickJS) =
  ## The prelude into a fresh context: the bytecode built into the image when
  ## there is one (a load, not a compile), else the source. Not both: the
  ## source in the image as a fallback was 10 KB of the ESP32's flash for a
  ## load the checks above make sure of (an engine that refuses it raises).
  when defined(frameosPreludeBytecode):
    discard js.evalBytecode(scenePreludeBytecode.toOpenArrayByte(0, scenePreludeBytecode.high))
  else:
    discard js.eval(sceneContextJsPrelude)

proc setUpSceneContext(js: var QuickJS) =
  ## What every program's context has: the time helpers scene code calls by
  ## name, the prelude, the JSX factory in C (jsx_native.nim).
  js.registerFunction("parseTs", jsChronoParseTs)
  js.registerFunction("format", jsChronoFormat)
  js.registerFunction("now", jsChronoNow)
  evalScenePrelude(js)
  discard js.installNativeJsx()

proc ensureSceneJs*(scene: InterpretedFrameScene) =
  ## Where the scene's program runs (see above), set up on first use, its
  ## ceilings following frame.json's `js`.
  withLock sceneJsLock:
    if programJsReady:
      programJs.applyLimits(sceneJsConfig(scene.frameConfig, ProgramsBudgetId))
    if scene.programJsLive:
      if scene.jsKind == sjRuntime:
        scene.js.applyLimits(sceneJsConfig(scene.frameConfig, scene.id.string))
      return
    # What it had was in a runtime that is gone.
    scene.programReady = false
    reset(scene.programEntries)
    let hasCode = not scene.program.isNil and scene.program.snippets.len > 0
    if hasCode and isolatedSceneRuntimes():
      scene.js = newQuickJS(sceneJsConfig(scene.frameConfig, scene.id.string))
      setUpSceneContext(scene.js)
      scene.jsKind = sjRuntime
    else:
      if not programJsReady:
        programJs = newQuickJS(sceneJsConfig(scene.frameConfig, ProgramsBudgetId))
        setUpSceneContext(programJs)
        programJsReady = true
      if hasCode:
        scene.js = newContextIn(programJs)
        setUpSceneContext(scene.js)
        scene.jsKind = sjRealm
      else:
        scene.js = programJs
        scene.jsKind = sjShared
      scene.jsGeneration = programJsGeneration
    scene.jsReady = true

proc sceneJsLockFreeForTest*(): bool =
  result = tryAcquire(sceneJsLock)
  if result:
    release(sceneJsLock)

proc cleanupSceneJs*(scene: InterpretedFrameScene) =
  withLock sceneJsLock:
    closeSceneJsLocked(scene)

proc abandonMidCallSceneJs*(): tuple[count, bytes: int] =
  ## After an out-of-memory abort (single_scene_host.recoverAbortedRun): drop
  ## where the programs the abort jumped out of were running, as
  ## app_runtime.abandonMidCallJsAppRuntimes does for JS apps, and let go of
  ## sceneJsLock should the abort have left it taken: tryAcquire fails on a
  ## lock this task holds (it is not recursive) and takes a free one, so
  ## either way it is held once here and released once. A scene with a
  ## runtime of its own loses only that; the shared runtime goes with every
  ## scene in it, each setting itself up again on its next run.
  discard tryAcquire(sceneJsLock)
  release(sceneJsLock)
  var shared = false
  for scene in sceneJsStack:
    if scene.isNil or not scene.programJsLive:
      continue
    if scene.jsKind == sjRuntime:
      clearJsSourceMaps(scene.js.context)
      result.bytes += scene.js.abandon()
      inc result.count
    else:
      shared = true
      if scene.jsKind == sjRealm:
        clearJsSourceMaps(scene.js.context)
    scene.programReady = false # its values went with the runtime
    reset(scene.programEntries)
    scene.js = QuickJS()
    scene.jsReady = false
    scene.jsKind = sjShared
  if shared and programJsReady:
    clearJsSourceMaps(programJs.context)
    result.bytes += programJs.abandon()
    inc result.count
    programJsReady = false
    inc programJsGeneration
  sceneJsStack.setLen(0)
