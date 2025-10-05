# frameos/src/frameos/js_runtime.nim
# Centralized JavaScript runtime helpers for interpreted scenes.
# Extracted from interpreter.nim so the JS bridge can be reused anywhere.

import frameos/types
import frameos/values
import lib/tz
import lib/burrito
import tables, json, strutils
import chrono, times

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

var evalEnvByCtx = initTable[ptr JSContext, EvalEnv]()
var tzName = ""

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

proc getCodeSnippet(node: DiagramNode): string =
  ## Prefer codeJS, fall back to code; empty string if none.
  if node.data.hasKey("codeJS") and node.data["codeJS"].kind == JString:
    return node.data["codeJS"].getStr()
  elif node.data.hasKey("code") and node.data["code"].kind == JString:
    return node.data["code"].getStr()
  ""

# -------------------------
# Build JS envelope function
# -------------------------

proc buildEnvelopeFunction(code: string, argNames: seq[string], fnName: string): string =
  ## Create a named function returning a BigInt-safe JSON envelope (no re-parsing each call).
  var decls = newSeq[string]()
  for rawName in argNames:
    let lc = rawName.toLowerAscii
    if lc in ["state", "args", "context", "console", "getargor",
          "parsets", "format", "now"]:
      continue
    let ident = toJsIdent(rawName)
    decls.add("const " & ident & " = __args[\"" & jsQuote(rawName) & "\"];")
  let declBlock = decls.join("\n")

  result = """
function """ & fnName & """() {
  "use strict";
  """ & declBlock & """
  try {
    const __v = ((state, args, context) => (""" & code & """))(__state, __args, __context);
    const __k = (__v === null) ? "null" : (Array.isArray(__v) ? "array" : typeof __v);
    const json = (typeof __v === 'undefined')
      ? JSON.stringify({ k: __k })
      : JSON.stringify({ k: __k, v: __v  }, __jsReplacer);
    return json;
  } catch (e) {
    const msg = (e && e.stack) ? e.stack : String(e);
    return JSON.stringify({ k: "error", v: { message: String(e && e.message || e), stack: msg } });
  }
}
"""

# -------------------------
# QuickJS bridge utilities
# -------------------------

proc env(ctx: ptr JSContext): EvalEnv =
  if evalEnvByCtx.hasKey(ctx): evalEnvByCtx[ctx] else: nil

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
proc jsonToJS(ctx: ptr JSContext, j: JsonNode): JSValue =
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

proc valueToJS(ctx: ptr JSContext, v: Value): JSValue =
  jsonToJS(ctx, valueToJson(v))

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

# -------------------------
# Scene JS context
# -------------------------

proc ensureSceneJs*(scene: InterpretedFrameScene) =
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
  const console = {
    log: (...a) => jsLog("log", JSON.stringify(a, __jsReplacer)),
    warn: (...a) => jsLog("warn", JSON.stringify(a, __jsReplacer)),
    error: (...a) => jsLog("error", JSON.stringify(a, __jsReplacer)),
  };
  const __frameosUnwrap = (v) => (v && v.__frameosUndef === true) ? undefined : v;
  const __state   = new Proxy({}, { get(_, k) { return (typeof k === 'string') ? __frameosUnwrap(getState(k))   : undefined; } });
  const __args    = new Proxy({}, { get(_, k) { return (typeof k === 'string') ? __frameosUnwrap(getArg(k))     : undefined; } });
  const __context = new Proxy({}, { get(_, k) { return (typeof k === 'string') ? __frameosUnwrap(getContext(k)) : undefined; } });
  """)
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
  let src = buildEnvelopeFunction(snippet, @[], fnName)
  discard scene.js.eval(src)
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
  let src = buildEnvelopeFunction(codeSnippet, argNames, fnName)
  discard scene.js.eval(src)
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

  evalEnvByCtx[scene.js.context] = e
  var envelopeJson = ""
  try:
    envelopeJson = scene.js.eval(fnName & "()")
  finally:
    if evalEnvByCtx.hasKey(scene.js.context):
      evalEnvByCtx.del(scene.js.context)

  var parsed: JsonNode
  try:
    parsed = parseJson(envelopeJson)
  except CatchableError:
    return Value(kind: fkString, s: envelopeJson)

  let kind = parsed{"k"}.getStr()
  if kind == "error":
    if expectedType.len > 0:
      if expectedType == "string": return Value(kind: fkString, s: "")
      return valueFromJsonByType(newJNull(), expectedType)

    scene.logger.log(%*{
      "event": "interpreter:jsError",
      "sceneId": scene.id.string,
      "nodeId": nodeId.int,
      "message": parsed{"v"}{"message"}.getStr(),
      "stack": parsed{"v"}{"stack"}.getStr()
    })
    if expectedType.len > 0:
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
  let src = buildEnvelopeFunction(code, argNames, fnName)
  discard scene.js.eval(src)

  var outs = outputTypes
  var targetField = ""
  if expectedType.len > 0:
    targetField = "__expected"
    outs[targetField] = expectedType

  callCompiledFn(scene, context, nodeId, fnName, args, argTypes, outs, targetField)
