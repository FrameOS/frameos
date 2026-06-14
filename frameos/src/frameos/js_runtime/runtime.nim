# frameos/src/frameos/js_runtime/runtime.nim
# Centralized JavaScript runtime helpers for interpreted scenes.
# Extracted from interpreter.nim so the JS bridge can be reused anywhere.

import frameos/types
import frameos/values
import frameos/js_runtime/source_map
import frameos/js_runtime/transpiler
import frameos/js_runtime/burrito
import lib/tz
import tables, json, strutils, locks
import chrono, times
import pixie

# -------------------------
# Internal evaluation scope
# -------------------------

type
  EvalEnv = ref object
    scene: InterpretedFrameScene
    context: ExecutionContext
    nodeId: NodeId
    args: Table[string, Value]
    argTypes: Table[string, string]
    outputTypes: Table[string, string]
    targetField: string

var jsSourceMapsByCtx = initTable[ptr JSContext, Table[string, SourceLineMap]]()
var currentEvalCtx: ptr JSContext
var currentEvalEnv: EvalEnv
var tzName = ""
var sceneJsLock: Lock
initLock(sceneJsLock)

const sceneJsPrelude* = """
const __frameosFragment = Symbol.for("frameos.fragment");
const __frameosNormalizeChildren = (children) => {
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return children;
};
const __frameosJsx = (type, props, ...children) => {
  const nextProps = props ? { ...props } : {};
  const explicitChildren = __frameosNormalizeChildren(children);
  const propChildren = Object.prototype.hasOwnProperty.call(nextProps, "children")
    ? nextProps.children
    : undefined;

  if (Object.prototype.hasOwnProperty.call(nextProps, "children")) {
    delete nextProps.children;
  }

  const normalizedChildren = explicitChildren ?? propChildren;
  if (type === __frameosFragment) {
    return normalizedChildren ?? null;
  }

  if (normalizedChildren !== undefined) {
    nextProps.children = normalizedChildren;
  }

  return { type, props: nextProps };
};
globalThis.__frameosFragment = __frameosFragment;
globalThis.__frameosJsx = __frameosJsx;
"""

# -------------------------
# Small string/JS helpers
# -------------------------

proc isJsIdentStart(c: char): bool =
  result = (c in {'a'..'z', 'A'..'Z', '_', '$'})

proc isJsIdentPart(c: char): bool =
  result = isJsIdentStart(c) or (c in {'0'..'9'})

proc toJsIdent(name: string): string =
  if name.len == 0: return "_"
  var output = newStringOfCap(name.len + 2)
  var i = 0
  for ch in name:
    if i == 0:
      if not isJsIdentStart(ch): output.add('_')
      output.add(if isJsIdentStart(ch): ch else: '_')
    else:
      output.add(if isJsIdentPart(ch): ch else: '_')
    inc i
  result = output

proc jsQuote(s: string): string =
  result = s
  result = result.replace("\\", "\\\\").replace("\"", "\\\"")
  result = result.replace("\n", "\\n").replace("\r", "\\r")

proc normalizeExpressionSnippet(source: string): string =
  ## The UI has historically saved some expression snippets with a trailing
  ## comma/semicolon. They are invalid once wrapped as an arrow expression.
  result = source.strip()
  while result.len > 0 and result[^1] in {',', ';'}:
    result.setLen(result.len - 1)
    result = result.strip()

proc getCodeSnippet(node: DiagramNode): string =
  ## Prefer codeJS, fall back to code; empty string if none.
  if node.data.hasKey("codeJS") and node.data["codeJS"].kind == JString:
    return normalizeExpressionSnippet(node.data["codeJS"].getStr())
  elif node.data.hasKey("code") and node.data["code"].kind == JString:
    return node.data["code"].getStr()
  ""

proc transpileSource*(source: string, filename: string): string =
  if source.len == 0:
    return source
  transformFrameosScript(source, filename)

proc transpileSourceWithMap*(source: string, filename: string): TransformResult =
  if source.len == 0:
    return TransformResult(code: source, sourceMap: identitySourceLineMap(source, filename, filename))
  transform(source, TransformOptions(filePath: filename, transforms: @["typescript", "jsx"]))

proc transpileModuleSource*(source: string, filename: string): string =
  if source.len == 0:
    return source
  transformFrameosModule(source, filename)

proc transpileModuleSourceWithMap*(source: string, filename: string): TransformResult =
  if source.len == 0:
    return TransformResult(code: source, sourceMap: identitySourceLineMap(source, filename, filename))
  transform(source, TransformOptions(filePath: filename, transforms: @["typescript", "jsx", "imports"]))

proc registerJsSourceMap*(ctx: ptr JSContext, sourceMap: SourceLineMap) =
  if ctx == nil or sourceMap.generatedName.len == 0:
    return
  if not jsSourceMapsByCtx.hasKey(ctx):
    jsSourceMapsByCtx[ctx] = initTable[string, SourceLineMap]()
  jsSourceMapsByCtx[ctx][sourceMap.generatedName] = sourceMap

proc clearJsSourceMaps*(ctx: ptr JSContext) =
  if ctx != nil and jsSourceMapsByCtx.hasKey(ctx):
    jsSourceMapsByCtx.del(ctx)

proc mapJsErrorText*(ctx: ptr JSContext, text: string): string =
  result = text
  if ctx == nil or not jsSourceMapsByCtx.hasKey(ctx):
    return
  for _, sourceMap in jsSourceMapsByCtx[ctx]:
    result = result.rewriteQuickJsLocations(sourceMap)

proc mapJsErrorText*(text: string, sourceMap: SourceLineMap): string =
  text.rewriteQuickJsLocations(sourceMap)

proc logCompileError(
  scene: InterpretedFrameScene,
  nodeId: NodeId,
  sourceKind: string,
  sourceName: string,
  snippet: string,
  error: ref CatchableError
) =
  scene.logger.log(%*{
    "event": "interpreter:jsCompileError",
    "sceneId": scene.id.string,
    "nodeId": nodeId.int,
    "sourceKind": sourceKind,
    "sourceName": sourceName,
    "error": error.msg,
    "stacktrace": error.getStackTrace(),
    "snippet": snippet
  })

proc logCompileError(
  scene: InterpretedFrameScene,
  nodeId: NodeId,
  sourceKind: string,
  sourceName: string,
  snippet: string,
  error: ref CatchableError,
  sourceMap: SourceLineMap
) =
  scene.logger.log(%*{
    "event": "interpreter:jsCompileError",
    "sceneId": scene.id.string,
    "nodeId": nodeId.int,
    "sourceKind": sourceKind,
    "sourceName": sourceName,
    "error": error.msg.mapJsErrorText(sourceMap),
    "stacktrace": error.getStackTrace().mapJsErrorText(sourceMap),
    "snippet": snippet
  })

# -------------------------
# Build JS envelope function
# -------------------------

proc buildEnvelopeFunctionWithMap(code: string, argNames: seq[string], fnName: string, filename: string): tuple[code: string, sourceMap: SourceLineMap] =
  ## Create a named function returning a BigInt-safe JSON envelope.
  var decls = newSeq[string]()
  for rawName in argNames:
    let lc = rawName.toLowerAscii
    if lc in ["state", "args", "context", "console", "getargor",
          "parsets", "format", "now"]:
      continue
    let ident = toJsIdent(rawName)
    decls.add("const " & ident & " = __args[\"" & jsQuote(rawName) & "\"];")

  var mapLines: seq[int] = @[0]
  var mapSegments: seq[SourceMapSegment] = @[]
  template addGeneratedLine(line: string, sourceLine: int = 0) =
    if result.code.len > 0:
      result.code.add("\n")
    result.code.add(line)
    mapLines.add(sourceLine)

  addGeneratedLine("function " & fnName & "() {")
  addGeneratedLine("  \"use strict\";")
  for decl in decls:
    addGeneratedLine("  " & decl)
  addGeneratedLine("  try {")

  let sourceLines = code.splitLines()
  if sourceLines.len == 0:
    addGeneratedLine("    const __v = ((state, args, context) => ())(__state, __args, __context);")
  else:
    for index, line in sourceLines:
      let sourceLine = index + 1
      if index == 0 and index == sourceLines.high:
        let prefix = "    const __v = ((state, args, context) => ("
        addGeneratedLine(prefix & line & "))(__state, __args, __context);", sourceLine)
        mapSegments.add(SourceMapSegment(generatedLine: mapLines.len - 1, generatedColumn: prefix.len + 1, sourceLine: sourceLine, sourceColumn: 1))
      elif index == 0:
        let prefix = "    const __v = ((state, args, context) => ("
        addGeneratedLine(prefix & line, sourceLine)
        mapSegments.add(SourceMapSegment(generatedLine: mapLines.len - 1, generatedColumn: prefix.len + 1, sourceLine: sourceLine, sourceColumn: 1))
      elif index == sourceLines.high:
        addGeneratedLine(line & "))(__state, __args, __context);", sourceLine)
        mapSegments.add(SourceMapSegment(generatedLine: mapLines.len - 1, generatedColumn: 1, sourceLine: sourceLine, sourceColumn: 1))
      else:
        addGeneratedLine(line, sourceLine)
        mapSegments.add(SourceMapSegment(generatedLine: mapLines.len - 1, generatedColumn: 1, sourceLine: sourceLine, sourceColumn: 1))
  addGeneratedLine("    const __k = (__v === null) ? \"null\" : (Array.isArray(__v) ? \"array\" : typeof __v);")
  addGeneratedLine("    const json = (typeof __v === 'undefined')")
  addGeneratedLine("      ? JSON.stringify({ k: __k })")
  addGeneratedLine("      : JSON.stringify({ k: __k, v: __v }, __jsReplacer);")
  addGeneratedLine("    return json;")
  addGeneratedLine("  } catch (e) {")
  addGeneratedLine("    const msg = (e && e.stack) ? e.stack : String(e);")
  addGeneratedLine("    return JSON.stringify({ k: \"error\", v: { message: String(e && e.message || e), stack: msg } });")
  addGeneratedLine("  }")
  addGeneratedLine("}")

  result.sourceMap = SourceLineMap(
    generatedName: filename,
    sourceName: filename,
    generatedToSourceLine: mapLines,
    segments: mapSegments
  )

proc buildEnvelopeFunction(code: string, argNames: seq[string], fnName: string): string =
  buildEnvelopeFunctionWithMap(code, argNames, fnName, "<frameos>").code

# -------------------------
# QuickJS bridge utilities
# -------------------------

proc env(ctx: ptr JSContext): EvalEnv =
  if currentEvalCtx == ctx: currentEvalEnv else: nil

# Return an object sentinel to represent "undefined" without using JS_UNDEFINED across the C boundary.
proc jsUndefSentinel(ctx: ptr JSContext): JSValue {.inline.} =
  let obj = JS_NewObject(ctx)
  discard JS_SetPropertyStr(ctx, obj, "__frameosUndef", nimBoolToJS(ctx, true))
  return obj

proc jsLog(ctx: ptr JSContext, level: JSValue, payloadJson: JSValue): JSValue {.nimcall.} =
  ## level: "log" | "warn" | "error"; payloadJson: a JSON string created in JS
  let lvl = toNimString(ctx, level)
  let payloadStr = toNimString(ctx, payloadJson)
  var argsJ: JsonNode
  try:
    argsJ = if payloadStr.len > 0: parseJson(payloadStr) else: %* []
  except CatchableError:
    argsJ = %* payloadStr

  let e = env(ctx)
  if e != nil:
    e.scene.logger.log(%*{
      "event": "interpreter:jsConsole",
      "level": lvl,
      "sceneId": e.scene.id.string,
      "nodeId": e.nodeId.int,
      "args": argsJ
    })
  return jsUndefSentinel(ctx)

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
  of fkImage, fkNone:
    return jsNull(ctx)

proc jsGetState(ctx: ptr JSContext, k: JSValue): JSValue {.nimcall.} =
  let key = toNimString(ctx, k)
  let e = env(ctx)
  if e != nil and e.scene.state.hasKey(key):
    return jsonToJS(ctx, e.scene.state[key])
  return jsUndefSentinel(ctx)

proc jsGetArg(ctx: ptr JSContext, k: JSValue): JSValue {.nimcall.} =
  let key = toNimString(ctx, k)
  let e = env(ctx)
  if e != nil and e.args.hasKey(key):
    return valueToJS(ctx, e.args[key])
  return jsUndefSentinel(ctx)

proc jsGetContext(ctx: ptr JSContext, k: JSValue): JSValue {.nimcall.} =
  let key = toNimString(ctx, k)
  let e = env(ctx)
  if e == nil: return jsUndefSentinel(ctx)
  case key
  of "loopIndex":
    return nimIntToJS(ctx, e.context.loopIndex.int32)
  of "loopKey":
    return nimStringToJS(ctx, e.context.loopKey)
  of "event":
    return nimStringToJS(ctx, e.context.event)
  of "payload":
    if e.context.payload.isNil:
      return jsNull(ctx)
    else:
      return jsonToJS(ctx, e.context.payload)
  of "hasImage":
    return nimBoolToJS(ctx, e.context.hasImage)
  else:
    return jsUndefSentinel(ctx)

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

proc jsChronoFormat(ctx: ptr JSContext, tsVal: JSValue, fmt: JSValue): JSValue {.nimcall.} =
  let ts = toNimFloat(ctx, tsVal).Timestamp
  let fmtStr = toNimString(ctx, fmt)
  if tzName.len == 0:
    tzName = detectSystemTimeZone()
  try:
    let output = format(ts, fmtStr, tzName = tzName)
    return nimStringToJS(ctx, output)
  except CatchableError as e:
    raise newException(ValueError, "format failed: " & e.msg)

proc jsChronoNow(ctx: ptr JSContext): JSValue {.nimcall.} =
  try:
    let ts = epochTime()
    return nimFloatToJS(ctx, ts)
  except CatchableError as e:
    raise newException(ValueError, "now failed: " & e.msg)

# -------------------------
# Envelope <-> Value
# -------------------------

proc envelopeToValue(env: JsonNode, expectedType: string): Value =
  if env.isNil or env.kind != JObject:
    return Value(kind: fkString, s: $env)

  let kind = env{"k"}.getStr()
  var jval: JsonNode

  if kind == "undefined":
    if expectedType.len > 0:
      return valueFromJsonByType(newJNull(), expectedType)
    return Value(kind: fkNone)

  jval = (if env.hasKey("v"): env["v"] else: newJNull())

  if expectedType.len > 0:
    return valueFromJsonByType(jval, expectedType)

  case kind
  of "string":
    return valueFromJsonByType(jval, "string")
  of "number":
    case jval.kind
    of JInt: return valueFromJsonByType(jval, "integer")
    of JFloat: return valueFromJsonByType(jval, "float")
    else: return valueFromJsonByType(%*0, "integer")
  of "boolean":
    return valueFromJsonByType(jval, "boolean")
  of "bigint":
    var s = ""
    if jval.kind == JObject and jval.hasKey("__bigint"):
      s = jval["__bigint"].getStr()
    # Try to fit into int64; otherwise, return as string
    try:
      let maybe = parseBiggestInt(s) # int64 in-range or throws
      return Value(kind: fkInteger, i: maybe.int64)
    except CatchableError:
      return Value(kind: fkString, s: s)
  of "array", "object", "null":
    return Value(kind: fkJson, j: jval)
  else:
    return Value(kind: fkNone)

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

proc mappedJsExceptionDetails*(ctx: ptr JSContext): tuple[message: string, stack: string] =
  result = jsExceptionDetails(ctx)
  result.message = mapJsErrorText(ctx, result.message)
  result.stack = mapJsErrorText(ctx, result.stack)

proc callGlobalFunction*(ctx: ptr JSContext, fnName: string, args: openArray[JSValueConst] = []): JSValue =
  let globalObj = JS_GetGlobalObject(ctx)
  defer: JS_FreeValue(ctx, globalObj)
  let fn = JS_GetPropertyStr(ctx, globalObj, fnName.cstring)
  defer: JS_FreeValue(ctx, fn)
  if args.len == 0:
    return JS_Call(ctx, fn, globalObj, 0.cint, nil)
  var argv = newSeq[JSValueConst](args.len)
  for i, arg in args:
    argv[i] = arg
  return JS_Call(ctx, fn, globalObj, args.len.cint, addr argv[0])

# -------------------------
# Scene JS context
# -------------------------

proc ensureSceneJs*(scene: InterpretedFrameScene) =
  withLock sceneJsLock:
    if scene.jsReady: return
    scene.js = newQuickJS()
    # Register bridge functions ONCE per scene/context
    scene.js.registerFunction("getState", jsGetState)
    scene.js.registerFunction("getArg", jsGetArg)
    scene.js.registerFunction("getContext", jsGetContext)
    scene.js.registerFunction("jsLog", jsLog)
    scene.js.registerFunction("parseTs", jsChronoParseTs)
    scene.js.registerFunction("format", jsChronoFormat)
    scene.js.registerFunction("now", jsChronoNow)
    discard scene.js.eval("""
    "use strict";
    const __jsReplacer = (k, v) =>
      (typeof v === 'bigint') ? { __bigint: v.toString() }
      : (v === undefined ? null : v);
    globalThis.__frameosStringify = (v) => JSON.stringify(v, __jsReplacer);
    const console = {
      log: (...a) => jsLog("log", JSON.stringify(a, __jsReplacer)),
      warn: (...a) => jsLog("warn", JSON.stringify(a, __jsReplacer)),
      error: (...a) => jsLog("error", JSON.stringify(a, __jsReplacer)),
    };
    const __frameosUnwrap = (v) => (v && v.__frameosUndef === true) ? undefined : v;
    const __state   = new Proxy({}, { get(_, k) { return (typeof k === 'string') ? __frameosUnwrap(getState(k))   : undefined; } });
    const __args    = new Proxy({}, { get(_, k) { return (typeof k === 'string') ? __frameosUnwrap(getArg(k))     : undefined; } });
    const __context = new Proxy({}, { get(_, k) { return (typeof k === 'string') ? __frameosUnwrap(getContext(k)) : undefined; } });
    """ & sceneJsPrelude)
    # Initialize registries
    scene.jsFuncNameByNode = initTable[NodeId, string]()
    scene.codeInlineFuncNameByNodeArg = initTable[NodeId, Table[string, string]]()
    scene.appInlineFuncNameByNodeArg = initTable[NodeId, Table[string, string]]()
    scene.jsReady = true

# -------------------------
# Code function naming
# -------------------------

proc uniqueCodeFnName(scene: InterpretedFrameScene, nodeId: NodeId): string =
  "__frameos_code_" & $(nodeId.int)

proc uniqueCodeInlineFnName(scene: InterpretedFrameScene, nodeId: NodeId, argName: string): string =
  "__frameos_code_inline_" & $(nodeId.int) & "_" & toJsIdent(argName)

proc uniqueAppInlineFnName(scene: InterpretedFrameScene, nodeId: NodeId, fieldName: string): string =
  "__frameos_app_inline_" & $(nodeId.int) & "_" & toJsIdent(fieldName)

# -------------------------
# Compile code & inline snippets
# -------------------------

type
  InlineNameProc* = proc (scene: InterpretedFrameScene, nodeId: NodeId, fieldOrArg: string): string
  InlineCompileProc* = proc (scene: InterpretedFrameScene, nodeId: NodeId, name: string, snippet: string)

proc compileInlineFn(scene: InterpretedFrameScene,
                     nodeId: NodeId,
                     name: string,
                     snippet: string,
                     mappingRef: var Table[NodeId, Table[string, string]],
                     nameBuilder: InlineNameProc) =
  ensureSceneJs(scene)
  let fnName = nameBuilder(scene, nodeId, name)
  let filename = "<frameos:inline:" & $nodeId.int & ":" & name & ">"
  var sourceMap = buildEnvelopeFunctionWithMap(snippet, @[], fnName, filename).sourceMap
  try:
    let envelope = buildEnvelopeFunctionWithMap(snippet, @[], fnName, filename)
    let transformed = transpileSourceWithMap(envelope.code, filename)
    sourceMap = composeSourceLineMaps(transformed.sourceMap, envelope.sourceMap).withGeneratedName(filename)
    withLock sceneJsLock:
      discard scene.js.eval(transformed.code, filename)
      registerJsSourceMap(scene.js.context, sourceMap)
  except CatchableError as e:
    logCompileError(scene, nodeId, "inline", name, snippet, e, sourceMap)
    raise
  if not mappingRef.hasKey(nodeId):
    mappingRef[nodeId] = initTable[string, string]()
  mappingRef[nodeId][name] = fnName

proc compileCodeInlineFn*(scene: InterpretedFrameScene, nodeId: NodeId, argName: string, snippet: string) =
  compileInlineFn(scene, nodeId, argName, snippet, scene.codeInlineFuncNameByNodeArg, uniqueCodeInlineFnName)

proc compileAppInlineFn*(scene: InterpretedFrameScene, nodeId: NodeId, fieldName: string, snippet: string) =
  compileInlineFn(scene, nodeId, fieldName, snippet, scene.appInlineFuncNameByNodeArg, uniqueAppInlineFnName)

proc compileCodeFn*(scene: InterpretedFrameScene, node: DiagramNode) =
  ensureSceneJs(scene)

  # Gather code snippet
  let codeSnippet = getCodeSnippet(node)

  # Compute a *superset* of possible arg names so bare-ident args get local consts.
  var argNames: seq[string] = @[]
  if node.data.hasKey("codeArgs") and node.data["codeArgs"].kind == JArray:
    for argDef in node.data["codeArgs"]:
      if argDef.kind == JObject:
        let nm = argDef{"name"}.getStr()
        if nm.len > 0 and nm notin argNames: argNames.add(nm)

  if scene.codeInputsForNodeId.hasKey(node.id):
    for k, _ in scene.codeInputsForNodeId[node.id]:
      if k notin argNames: argNames.add(k)

  if scene.codeInlineInputsForNodeId.hasKey(node.id):
    for k, _ in scene.codeInlineInputsForNodeId[node.id]:
      if k notin argNames: argNames.add(k)

  let fnName = uniqueCodeFnName(scene, node.id)
  let filename = "<frameos:code:" & $node.id.int & ">"
  var sourceMap = buildEnvelopeFunctionWithMap(codeSnippet, argNames, fnName, filename).sourceMap
  try:
    let envelope = buildEnvelopeFunctionWithMap(codeSnippet, argNames, fnName, filename)
    let transformed = transpileSourceWithMap(envelope.code, filename)
    sourceMap = composeSourceLineMaps(transformed.sourceMap, envelope.sourceMap).withGeneratedName(filename)
    withLock sceneJsLock:
      discard scene.js.eval(transformed.code, filename)
      registerJsSourceMap(scene.js.context, sourceMap)
  except CatchableError as e:
    logCompileError(scene, node.id, "code", "codeJS", codeSnippet, e, sourceMap)
    raise
  scene.jsFuncNameByNode[node.id] = fnName

proc getOrCompileCodeFn*(scene: InterpretedFrameScene, node: DiagramNode): string =
  if scene.jsFuncNameByNode.hasKey(node.id):
    return scene.jsFuncNameByNode[node.id]
  compileCodeFn(scene, node)
  scene.jsFuncNameByNode[node.id]

# -------------------------
# Call compiled JS function
# -------------------------

proc callCompiledFn*(scene: InterpretedFrameScene,
                     context: ExecutionContext,
                     nodeId: NodeId,
                     fnName: string,
                     args: Table[string, Value],
                     argTypes: Table[string, string],
                     outputTypes: Table[string, string],
                     targetField: string): Value =
  ## Set EvalEnv for this scene context, call fnName(), parse envelope, coerce.
  var expectedType = ""
  if targetField.len > 0 and outputTypes.hasKey(targetField):
    expectedType = outputTypes[targetField]

  let e = EvalEnv(
    scene: scene,
    context: context,
    nodeId: nodeId,
    args: args,
    argTypes: argTypes,
    outputTypes: outputTypes,
    targetField: targetField
  )

  var envelopeJson = ""
  withLock sceneJsLock:
    currentEvalCtx = scene.js.context
    currentEvalEnv = e
    try:
      envelopeJson = scene.js.eval(fnName & "()")
    finally:
      if currentEvalCtx == scene.js.context:
        currentEvalCtx = nil
        currentEvalEnv = nil

  var parsed: JsonNode
  try:
    parsed = parseJson(envelopeJson)
  except CatchableError:
    return Value(kind: fkString, s: envelopeJson)

  let kind = parsed{"k"}.getStr()
  if kind == "error":
    let message = mapJsErrorText(scene.js.context, parsed{"v"}{"message"}.getStr())
    let stack = mapJsErrorText(scene.js.context, parsed{"v"}{"stack"}.getStr())
    scene.logger.log(%*{
      "event": "interpreter:jsError",
      "sceneId": scene.id.string,
      "nodeId": nodeId.int,
      "message": message,
      "stack": stack
    })
    if expectedType.len > 0:
      if expectedType == "string": return Value(kind: fkString, s: "")
      return valueFromJsonByType(newJNull(), expectedType)
    return Value(kind: fkNone)

  return envelopeToValue(parsed, expectedType)

# -------------------------
# Inline evaluation helper (generic)
# -------------------------

proc evalInline*(scene: InterpretedFrameScene,
                 context: ExecutionContext,
                 nodeId: NodeId,
                 name: string,
                 snippet: string,
                 mapping: var Table[NodeId, Table[string, string]],
                 ensureCompiled: InlineCompileProc,
                 targetField: string): Value =
  let emptyArgs = initTable[string, Value]()
  let emptyArgTypes = initTable[string, string]()
  let emptyOutputs = initTable[string, string]()
  var fnName = ""
  if mapping.hasKey(nodeId) and mapping[nodeId].hasKey(name):
    fnName = mapping[nodeId][name]
  else:
    ensureCompiled(scene, nodeId, name, snippet)
    fnName = mapping[nodeId][name]
  callCompiledFn(scene, context, nodeId, fnName, emptyArgs, emptyArgTypes, emptyOutputs, targetField)

# -------------------------
# Public convenience: eval a raw snippet from anywhere
# -------------------------

var anonCounter = 0

proc evalSnippet*(
  scene: InterpretedFrameScene,
  context: ExecutionContext,
  nodeId: NodeId,
  code: string,
  expectedType: string = "",
  argNames: seq[string] = @[],
  args: Table[string, Value] = initTable[string, Value](),
  argTypes: Table[string, string] = initTable[string, string](),
  outputTypes: Table[string, string] = initTable[string, string]()
): Value =
  ## One-shot helper: ensure JS, compile `code` into a unique function, call it, coerce to `expectedType` if given.
  ensureSceneJs(scene)
  inc anonCounter
  let fnName = "__frameos_eval_" & $(nodeId.int) & "_" & $anonCounter
  let filename = "<frameos:eval:" & $nodeId.int & ":" & $anonCounter & ">"
  var sourceMap = buildEnvelopeFunctionWithMap(code, argNames, fnName, filename).sourceMap
  try:
    let envelope = buildEnvelopeFunctionWithMap(code, argNames, fnName, filename)
    let transformed = transpileSourceWithMap(envelope.code, filename)
    sourceMap = composeSourceLineMaps(transformed.sourceMap, envelope.sourceMap).withGeneratedName(filename)
    withLock sceneJsLock:
      discard scene.js.eval(transformed.code, filename)
      registerJsSourceMap(scene.js.context, sourceMap)
  except CatchableError as e:
    logCompileError(scene, nodeId, "eval", fnName, code, e, sourceMap)
    raise

  var outs = outputTypes
  var targetField = ""
  if expectedType.len > 0:
    targetField = "__expected"
    outs[targetField] = expectedType

  callCompiledFn(scene, context, nodeId, fnName, args, argTypes, outs, targetField)

proc toJsIdentForTest*(name: string): string =
  toJsIdent(name)

proc jsQuoteForTest*(s: string): string =
  jsQuote(s)

proc envelopeToValueForTest*(env: JsonNode, expectedType: string = ""): Value =
  envelopeToValue(env, expectedType)

proc transpileSourceForTest*(source: string, filename: string = "<test>"): string =
  transpileSource(source, filename)

proc cleanupCompilerJs*() =
  discard

proc cleanupSceneJs*(scene: InterpretedFrameScene) =
  withLock sceneJsLock:
    if not scene.jsReady:
      return
    if scene.js.context != nil and currentEvalCtx == scene.js.context:
      currentEvalCtx = nil
      currentEvalEnv = nil
    if scene.js.context != nil:
      clearJsSourceMaps(scene.js.context)
    if scene.js.runtime != nil:
      scene.js.runPendingJobs()
      JS_RunGC(scene.js.runtime)
    scene.js.close()
    scene.jsReady = false
    scene.jsFuncNameByNode = initTable[NodeId, string]()
    scene.codeInlineFuncNameByNodeArg = initTable[NodeId, Table[string, string]]()
    scene.appInlineFuncNameByNodeArg = initTable[NodeId, Table[string, string]]()
