import frameos/types
import frameos/values
import frameos/channels
import tables, json, os, zippy, chroma, pixie, jsony, sequtils, options, strutils, times
import apps/apps

import lib/burrito

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

proc env(ctx: ptr JSContext): EvalEnv =
  if evalEnvByCtx.hasKey(ctx): evalEnvByCtx[ctx] else: nil

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
  return jsUndefined(ctx)

proc jsGetArg(ctx: ptr JSContext, k: JSValue): JSValue {.nimcall.} =
  let key = toNimString(ctx, k)
  let e = env(ctx)
  if e != nil and e.args.hasKey(key):
    return valueToJS(ctx, e.args[key])
  return jsUndefined(ctx)

proc jsGetContext(ctx: ptr JSContext, k: JSValue): JSValue {.nimcall.} =
  let key = toNimString(ctx, k)
  let e = env(ctx)
  if e == nil: return jsUndefined(ctx)
  case key
  of "loopIndex":
    return nimIntToJS(ctx, e.context.loopIndex.int32)
  of "loopKey":
    return nimStringToJS(ctx, e.context.loopKey)
  of "event":
    # Return the event name as a JS string
    return nimStringToJS(ctx, e.context.event)
  else:
    return jsUndefined(ctx)

# Convert the JSON envelope we get back from JS into a Value.
proc envelopeToValue(env: JsonNode, expectedType: string): Value =
  ## env is { k: <kind>, v: <json value or missing for undefined> }
  if env.isNil or env.kind != JObject:
    # Fallback: treat whole thing as string just to be safe
    return Value(kind: fkString, s: $env)

  let kind = env{"k"}.getStr()
  var jval: JsonNode

  if kind == "undefined":
    # If the node declares an expected output type, try to use it with null;
    # otherwise, represent absence as fkNone.
    if expectedType.len > 0:
      jval = newJNull()
      return valueFromJsonByType(jval, expectedType)
    else:
      return Value(kind: fkNone)

  # value may be null, array, object, number, string, boolean, etc.
  if env.hasKey("v"):
    jval = env["v"]
  else:
    jval = newJNull()

  # If a concrete output type was declared on the node output, honor it strictly.
  if expectedType.len > 0:
    return valueFromJsonByType(jval, expectedType)

  # Otherwise, auto-detect sensibly from the JS kind + JSON node kind.
  case kind
  of "string":
    return valueFromJsonByType(jval, "string")
  of "number":
    case jval.kind
    of JInt: return valueFromJsonByType(jval, "integer")
    of JFloat: return valueFromJsonByType(jval, "float")
    else: return valueFromJsonByType(%*0, "integer") # very defensive fallback
  of "boolean":
    return valueFromJsonByType(jval, "boolean")
  of "array", "object", "null":
    # Hand off full structure directly as JSON
    return Value(kind: fkJson, j: jval)
  else:
    # Symbols/functions/etc. are not representable => none
    return Value(kind: fkNone)

proc evalWithEnv(scene: InterpretedFrameScene, context: ExecutionContext, nodeId: NodeId,
                 code: string, args: Table[string, Value], argTypes: Table[string, string],
                 outputTypes: Table[string, string], targetField: string): Value =
  echo "🔥 🔥 🔥 ", code
  echo args
  echo argTypes
  echo outputTypes
  echo targetField

  var js: QuickJS
  var installed = false

  try:
    js = newQuickJS()

    # Install per-context environment for callbacks
    let e = EvalEnv(
      scene: scene,
      context: context,
      nodeId: nodeId,
      args: args,
      argTypes: argTypes,
      outputTypes: outputTypes,
      targetField: targetField
    )
    evalEnvByCtx[js.context] = e
    installed = true

    # Register non-capturing functions (no closure => {.nimcall.})
    js.registerFunction("getState", jsGetState)
    js.registerFunction("getArg", jsGetArg)
    js.registerFunction("getContext", jsGetContext)

    # JS shims: property accessors into our callbacks
    discard js.eval("const state = new Proxy({}, { get(_, k) { return getState(k) } });")
    discard js.eval("const args  = new Proxy({}, { get(_, k) { return getArg(k) } });")
    discard js.eval("const context = new Proxy({}, { get(_, k) { return getContext(k) } });")

    # Evaluate user code once and produce a JSON "envelope"
    let envelopeJson = js.eval("""
      (() => {
        const __v = (""" & code & """);
        const __k = (__v === null) ? "null" : (Array.isArray(__v) ? "array" : typeof __v);
        const json = JSON.stringify({ k: __k, v: __v }, (key, val) => (
          typeof val === 'bigint' ? Number(val) : val
        ));
        return json === undefined ? JSON.stringify({ k: __k }) : json;
      })()
    """)
    echo "🔥 🔥 🍀 envelopeJson: "
    echo envelopeJson

    # Use the node's declared output type, if any
    var expectedType = ""
    if targetField.len > 0 and outputTypes.hasKey(targetField):
      expectedType = outputTypes[targetField]

    # Parse and convert to Value
    var parsed: JsonNode
    try:
      parsed = parseJson(envelopeJson)
    except CatchableError:
      result = Value(kind: fkString, s: envelopeJson)
      echo "🔥 🔥 🍀 result (fallback as string): ", result
      return

    result = envelopeToValue(parsed, expectedType)
    echo "🔥 🔥 🍀 result: ", result

  finally:
    # Always remove env and close QuickJS cleanly
    if installed and evalEnvByCtx.hasKey(js.context):
      evalEnvByCtx.del(js.context)
    if js.runtime != nil or js.context != nil:
      js.close()

var globalNodeCounter = 0
var nodeMappingTable = initTable[string, NodeId]()
var stateFieldTypesByScene = initTable[SceneId, Table[string, string]]()
var allScenesLoaded = false
var loadedScenes = initTable[SceneId, ExportedInterpretedScene]()

# Per (sceneId -> nodeId) caches for interpreted runs
var cacheValuesByScene = initTable[SceneId, Table[NodeId, Value]]()
var cacheTimesByScene = initTable[SceneId, Table[NodeId, float]]()
var cacheKeysByScene = initTable[SceneId, Table[NodeId, JsonNode]]()     # derived from connected inputs

# ---- Helpers to read cache config from node.data["cache"] ----
proc jBoolOr(j: JsonNode, key: string, default: bool): bool =
  if j.isNil or j.kind != JObject or not j.hasKey(key): return default
  let n = j[key]
  case n.kind
  of JBool: n.getBool()
  of JString: parseBoolish(n.getStr())
  of JInt: n.getInt() != 0
  of JFloat: n.getFloat() != 0.0
  else: default

proc jFloatOr(j: JsonNode, key: string, default: float): float =
  if j.isNil or j.kind != JObject or not j.hasKey(key): return default
  let n = j[key]
  case n.kind
  of JFloat: n.getFloat()
  of JInt: n.getInt().float
  of JString:
    try: parseFloat(n.getStr())
    except CatchableError: default
  else: default

# Turn an interpreter Value into a stable JSON "key" snippet for cache-keying.
proc valueToKeyJson(v: Value): JsonNode =
  case v.kind
  of fkImage:
    # Images aren't JSON; key by dimensions (pointer identity would be fragile).
    let im = v.asImage()
    result = %* {"__image": {"w": im.width, "h": im.height}}
  of fkColor:
    result = %* v.asColor().toHtmlHex
  of fkJson:
    if v.asJson().isNil: result = %* {}
    else: result = v.asJson()
  else:
    # string/text/float/int/bool/node/scene/none
    result = valueToJson(v)

proc runEvent*(self: FrameScene, context: ExecutionContext)

proc runNode*(self: FrameScene, nodeId: NodeId, context: ExecutionContext, asDataNode = false): Value =
  let self = InterpretedFrameScene(self)
  var currentNodeId: NodeId = nodeId
  while currentNodeId != -1.NodeId:
    if not self.nodes.hasKey(currentNodeId):
      self.logger.log(%*{"event": "interpreter:nodeNotFound", "sceneId": self.id, "nodeId": currentNodeId.int})
      break

    let currentNode = self.nodes[currentNodeId]
    let nodeType = currentNode.nodeType
    self.logger.log(%*{"event": "interpreter:runNode", "sceneId": self.id, "nodeId": currentNodeId.int,
        "nodeType": nodeType})

    case nodeType:
    of "app":
      let keyword = currentNode.data{"keyword"}.getStr()
      self.logger.log(%*{
        "event": "interpreter:runApp",
        "sceneId": self.id, "nodeId": currentNodeId.int, "keyword": keyword
      })
      if not self.appsByNodeId.hasKey(currentNodeId):
        raise newException(Exception,
          "App not initialized for node id: " & $currentNode.id & ", keyword: " & keyword)

      let app = self.appsByNodeId[currentNodeId]

      # ---- Read per-node cache config (from node.data["cache"]) ----
      var cacheEnabled = false
      var cacheInputEnabled = false
      var cacheDurationEnabled = false
      var cacheDurationSec = 0.0

      if currentNode.data.hasKey("cache") and currentNode.data["cache"].kind == JObject:
        let cc = currentNode.data["cache"]
        cacheEnabled = jBoolOr(cc, "enabled", false)
        if cacheEnabled:
          cacheInputEnabled = jBoolOr(cc, "inputEnabled", false)
          cacheDurationEnabled = jBoolOr(cc, "durationEnabled", false)
          if cacheDurationEnabled:
            cacheDurationSec = jFloatOr(cc, "duration", 0.0)

      # ---- Wire inputs AND (if enabled) build an input-key JSON alongside ----
      var builtInputKey = %*{} # JObject; only meaningful when cacheInputEnabled = true and there are inputs
      var builtAnyInput = false

      if self.appInputsForNodeId.hasKey(currentNodeId):
        let connected = self.appInputsForNodeId[currentNodeId]
        for (inputName, producerNodeId) in connected.pairs:
          if self.nodes.hasKey(producerNodeId):
            try:
              let vIn = runNode(self, producerNodeId, context, asDataNode = true)
              apps.setAppField(keyword, app, inputName, vIn)
              if cacheEnabled and cacheInputEnabled:
                builtInputKey[inputName] = valueToKeyJson(vIn)
                builtAnyInput = true
            except Exception as e:
              self.logger.log(%*{
                "event": "interpreter:setField:error",
                "sceneId": self.id,
                "nodeId": currentNodeId.int,
                "input": inputName,
                "producer": producerNodeId.int,
                "error": $e.msg,
                "stacktrace": e.getStackTrace()
              })
              # Leave field at default; still proceed.

      if self.appInlineInputsForNodeId.hasKey(currentNodeId):
        let inlineConnected = self.appInlineInputsForNodeId[currentNodeId]
        for (inputName, codeSnippet) in inlineConnected.pairs:
          try:
            let emptyArgs = initTable[string, Value]()
            let emptyArgTypes = initTable[string, string]()
            let emptyOutputs = initTable[string, string]()
            let vIn = evalWithEnv(self, context, currentNodeId, codeSnippet, emptyArgs, emptyArgTypes, emptyOutputs, inputName)
            apps.setAppField(keyword, app, inputName, vIn)
            if cacheEnabled and cacheInputEnabled:
              builtInputKey[inputName] = valueToKeyJson(vIn)
              builtAnyInput = true
          except Exception as e:
            self.logger.log(%*{
              "event": "interpreter:setField:error:inlineCode",
              "sceneId": self.id,
              "nodeId": currentNodeId.int,
              "input": inputName,
              "code": codeSnippet,
              "error": $e.msg,
              "stacktrace": e.getStackTrace()
            })

      if asDataNode and cacheEnabled:
        # Ensure scene sub-tables exist
        if not cacheValuesByScene.hasKey(self.id):
          cacheValuesByScene[self.id] = initTable[NodeId, Value]()
        if not cacheTimesByScene.hasKey(self.id):
          cacheTimesByScene[self.id] = initTable[NodeId, float]()
        if not cacheKeysByScene.hasKey(self.id):
          cacheKeysByScene[self.id] = initTable[NodeId, JsonNode]()

        var valTab = cacheValuesByScene[self.id]
        var timeTab = cacheTimesByScene[self.id]
        var keyTab = cacheKeysByScene[self.id]

        var useCached = valTab.hasKey(currentNodeId)
        if useCached and cacheDurationEnabled:
          if not timeTab.hasKey(currentNodeId):
            useCached = false
          else:
            let last = timeTab[currentNodeId]
            if epochTime() > last + cacheDurationSec:
              useCached = false

        if useCached and cacheInputEnabled and builtAnyInput:
          if not keyTab.hasKey(currentNodeId):
            useCached = false
          else:
            if keyTab[currentNodeId] != builtInputKey:
              useCached = false

        if useCached:
          self.logger.log(%*{
            "event": "interpreter:cache:hit",
            "sceneId": self.id,
            "nodeId": currentNodeId.int,
            "keyword": keyword
          })
          result = valTab[currentNodeId]
        else:
          self.logger.log(%*{
            "event": "interpreter:cache:miss",
            "sceneId": self.id,
            "nodeId": currentNodeId.int,
            "keyword": keyword
          })
          let fresh = apps.getApp(keyword, app, context)
          result = fresh
          valTab[currentNodeId] = fresh
          cacheValuesByScene[self.id] = valTab # write-back
          if cacheDurationEnabled:
            timeTab[currentNodeId] = epochTime()
            cacheTimesByScene[self.id] = timeTab
          if cacheInputEnabled and builtAnyInput:
            keyTab[currentNodeId] = builtInputKey
            cacheKeysByScene[self.id] = keyTab
      else:
        if asDataNode:
          result = apps.getApp(keyword, app, context)
        else:
          apps.runApp(keyword, app, context)

    of "source":
      raise newException(Exception, "Source nodes not implemented in interpreted scenes yet")
    of "dispatch":
      raise newException(Exception, "Dispatch nodes not implemented in interpreted scenes yet")
    of "code":
      var codeSnippet = ""
      if currentNode.data.hasKey("codeJS") and currentNode.data["codeJS"].kind == JString:
        codeSnippet = currentNode.data["codeJS"].getStr()
      elif currentNode.data.hasKey("code") and currentNode.data["code"].kind == JString:
        codeSnippet = currentNode.data["code"].getStr()

      var outputTypes = initTable[string, string]()
      var defaultOutputName = ""
      if currentNode.data.hasKey("codeOutputs") and currentNode.data["codeOutputs"].kind == JArray:
        for outputDef in currentNode.data["codeOutputs"]:
          if outputDef.kind == JObject:
            let name = outputDef{"name"}.getStr()
            let typ = outputDef{"type"}.getStr()
            if name.len > 0:
              outputTypes[name] = typ
              if defaultOutputName.len == 0:
                defaultOutputName = name

      var argTypes = initTable[string, string]()
      if currentNode.data.hasKey("codeArgs") and currentNode.data["codeArgs"].kind == JArray:
        for argDef in currentNode.data["codeArgs"]:
          if argDef.kind == JObject:
            let name = argDef{"name"}.getStr()
            let typ = argDef{"type"}.getStr()
            if name.len > 0:
              argTypes[name] = typ

      var args = initTable[string, Value]()
      var builtInputKey = %*{}
      var builtAnyInput = false

      var cacheEnabled = false
      var cacheInputEnabled = false
      var cacheDurationEnabled = false
      var cacheDurationSec = 0.0

      if currentNode.data.hasKey("cache") and currentNode.data["cache"].kind == JObject:
        let cc = currentNode.data["cache"]
        cacheEnabled = jBoolOr(cc, "enabled", false)
        if cacheEnabled:
          cacheInputEnabled = jBoolOr(cc, "inputEnabled", false)
          cacheDurationEnabled = jBoolOr(cc, "durationEnabled", false)
          if cacheDurationEnabled:
            cacheDurationSec = jFloatOr(cc, "duration", 0.0)

      if self.codeInputsForNodeId.hasKey(currentNodeId):
        echo "!!! HAD codeInputsForNodeId !!!"
        let connectedArgs = self.codeInputsForNodeId[currentNodeId]
        for (argName, producerNodeId) in connectedArgs.pairs:
          if self.nodes.hasKey(producerNodeId):
            try:
              let vIn = runNode(self, producerNodeId, context, asDataNode = true)
              args[argName] = vIn
              if not argTypes.hasKey(argName):
                argTypes[argName] = ""
              if cacheEnabled and cacheInputEnabled:
                builtInputKey[argName] = valueToKeyJson(vIn)
                builtAnyInput = true
            except Exception as e:
              self.logger.log(%*{
                "event": "interpreter:codeArg:error",
                "sceneId": self.id,
                "nodeId": currentNodeId.int,
                "arg": argName,
                "producer": producerNodeId.int,
                "error": $e.msg,
                "stacktrace": e.getStackTrace()
              })

      if self.codeInlineInputsForNodeId.hasKey(currentNodeId):
        echo "!!! HAD codeInlineInputsForNodeId !!!"
        let inlineArgs = self.codeInlineInputsForNodeId[currentNodeId]
        for (argName, snippet) in inlineArgs.pairs:
          try:
            let emptyArgs = initTable[string, Value]()
            let emptyArgTypes = initTable[string, string]()
            let emptyOutputs = initTable[string, string]()
            let vIn = evalWithEnv(self, context, currentNodeId, snippet, emptyArgs, emptyArgTypes, emptyOutputs, argName)
            args[argName] = vIn
            if not argTypes.hasKey(argName):
              argTypes[argName] = ""
            if cacheEnabled and cacheInputEnabled:
              builtInputKey[argName] = valueToKeyJson(vIn)
              builtAnyInput = true
          except Exception as e:
            self.logger.log(%*{
              "event": "interpreter:codeArg:error:inlineCode",
              "sceneId": self.id,
              "nodeId": currentNodeId.int,
              "arg": argName,
              "code": snippet,
              "error": $e.msg,
              "stacktrace": e.getStackTrace()
            })

      let targetField = if defaultOutputName.len > 0: defaultOutputName else: ""

      if asDataNode and cacheEnabled:
        # TODO: why by scene? store the cache objects on the scene itself
        if not cacheValuesByScene.hasKey(self.id):
          cacheValuesByScene[self.id] = initTable[NodeId, Value]()
        if not cacheTimesByScene.hasKey(self.id):
          cacheTimesByScene[self.id] = initTable[NodeId, float]()
        if not cacheKeysByScene.hasKey(self.id):
          cacheKeysByScene[self.id] = initTable[NodeId, JsonNode]()

        var valTab = cacheValuesByScene[self.id]
        var timeTab = cacheTimesByScene[self.id]
        var keyTab = cacheKeysByScene[self.id]

        var useCached = valTab.hasKey(currentNodeId)
        if useCached and cacheDurationEnabled:
          if not timeTab.hasKey(currentNodeId):
            useCached = false
          else:
            let last = timeTab[currentNodeId]
            if epochTime() > last + cacheDurationSec:
              useCached = false

        if useCached and cacheInputEnabled and builtAnyInput:
          if not keyTab.hasKey(currentNodeId):
            useCached = false
          else:
            if keyTab[currentNodeId] != builtInputKey:
              useCached = false

        if useCached:
          self.logger.log(%*{
            "event": "interpreter:cache:hit",
            "sceneId": self.id,
            "nodeId": currentNodeId.int,
            "nodeType": "code"
          })
          result = valTab[currentNodeId]
        else:
          self.logger.log(%*{
            "event": "interpreter:cache:miss",
            "sceneId": self.id,
            "nodeId": currentNodeId.int,
            "nodeType": "code"
          })
          let fresh = evalWithEnv(self, context, currentNodeId, codeSnippet, args, argTypes, outputTypes, targetField)
          result = fresh
          valTab[currentNodeId] = fresh
          cacheValuesByScene[self.id] = valTab
          if cacheDurationEnabled:
            timeTab[currentNodeId] = epochTime()
            cacheTimesByScene[self.id] = timeTab
          if cacheInputEnabled and builtAnyInput:
            keyTab[currentNodeId] = builtInputKey
            cacheKeysByScene[self.id] = keyTab
      else:
        let fresh = evalWithEnv(self, context, currentNodeId, codeSnippet, args, argTypes, outputTypes, targetField)
        if asDataNode:
          result = fresh
    of "event":
      raise newException(Exception, "Event nodes not implemented in interpreted scenes yet")

    of "state":
      let key = currentNode.data{"keyword"}.getStr()
      var fieldType = "string"
      if stateFieldTypesByScene.hasKey(self.id):
        let m = stateFieldTypesByScene[self.id]
        if m.hasKey(key): fieldType = m[key]
      let j =
        if self.state.hasKey(key): self.state[key]
        else: %*"" # fallback if state missing
      result = valueFromJsonByType(j, fieldType)

    of "scene":
      let childSceneId = currentNode.data{"keyword"}.getStr().SceneId
      self.logger.log(%*{
        "event": "interpreter:runScene",
        "sceneId": self.id,
        "nodeId": currentNodeId.int,
        "childSceneId": childSceneId.string
      })

      # Prefer the instance created in init; lazily create only if missing (defensive)
      if not self.sceneNodes.hasKey(currentNodeId):
        if not loadedScenes.hasKey(childSceneId):
          raise newException(Exception,
            "Scene node references unknown scene id: " & childSceneId.string)
        var persisted = %*{}
        if currentNode.data.hasKey("config") and currentNode.data["config"].kind == JObject:
          persisted = currentNode.data["config"]
        let child = loadedScenes[childSceneId].init(childSceneId, self.frameConfig, self.logger, persisted)
        self.sceneNodes[currentNodeId] = child
        # Optional: fire child's init here too, to keep behavior identical if we had to fallback
        var initCtx = ExecutionContext(scene: self.sceneNodes[currentNodeId], event: "init",
                                      payload: self.sceneNodes[currentNodeId].state, hasImage: false,
                                      loopIndex: 0, loopKey: ".")
        runEvent(self.sceneNodes[currentNodeId], initCtx)

      let childScene = self.sceneNodes[currentNodeId]

      # Apply dynamic inputs (fieldOutput -> fieldInput/<name>) into child's state before running
      if self.appInputsForNodeId.hasKey(currentNodeId):
        let connected = self.appInputsForNodeId[currentNodeId]
        for (inputName, producerNodeId) in connected.pairs:
          try:
            let v = runNode(self, producerNodeId, context, asDataNode = true)
            childScene.state[inputName] = valueToJson(v)
          except Exception as e:
            self.logger.log(%*{
              "event": "interpreter:setChildState:error",
              "parentSceneId": self.id,
              "nodeId": currentNodeId.int,
              "input": inputName,
              "producer": producerNodeId.int,
              "error": $e.msg,
              "stacktrace": e.getStackTrace()
            })

      if self.appInlineInputsForNodeId.hasKey(currentNodeId):
        let inlineConnected = self.appInlineInputsForNodeId[currentNodeId]
        for (inputName, codeSnippet) in inlineConnected.pairs:
          try:
            let emptyArgs = initTable[string, Value]()
            let emptyArgTypes = initTable[string, string]()
            let emptyOutputs = initTable[string, string]()
            let v = evalWithEnv(self, context, currentNodeId, codeSnippet, emptyArgs, emptyArgTypes, emptyOutputs, inputName)
            childScene.state[inputName] = valueToJson(v)
          except Exception as e:
            self.logger.log(%*{
              "event": "interpreter:setChildState:error:inlineCode",
              "parentSceneId": self.id,
              "nodeId": currentNodeId.int,
              "input": inputName,
              "code": codeSnippet,
              "error": $e.msg,
              "stacktrace": e.getStackTrace()
            })

      # Delegate handling of the current event to the child scene.
      runEvent(childScene, context)
    else:
      raise newException(Exception, "Unknown node type: " & nodeType)

    if self.nextNodeIds.hasKey(currentNodeId):
      currentNodeId = self.nextNodeIds[currentNodeId]
    else:
      currentNodeId = -1.NodeId

proc ensureConfig*(scene: InterpretedFrameScene, node: DiagramNode): JsonNode =
  ## Make sure node.data["config"] exists and is an object; return it.
  if node.data.isNil:
    node.data = %*{}
  if not node.data.hasKey("config") or node.data["config"].kind != JObject:
    node.data["config"] = %*{}
  node.data["config"]

proc setNodeFieldFromEdge*(scene: InterpretedFrameScene, edge: DiagramEdge) =
  ## Map edges of the form:
  ##   sourceHandle: "field/<fieldName>[idx][idx]..."
  ##   targetHandle: "prev"
  ## into node.config["<fieldName>[idx][idx]"] = target NodeId (int).
  if not edge.sourceHandle.startsWith("field/"): return
  if edge.targetHandle != "prev": return
  if not scene.nodes.hasKey(edge.source): return
  let fieldPath = edge.sourceHandle.substr("field/".len) # keep full path inc. [i][j]
  scene.ensureConfig(scene.nodes[edge.source])[fieldPath] = %(edge.target.int)

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger,
    persistedState: JsonNode): FrameScene =
  logger.log(%*{"event": "initInterpreted", "sceneId": sceneId.string})

  let exportedScene = loadedScenes[sceneId]
  if exportedScene == nil:
    raise newException(Exception, "Scene not found: " & sceneId.string)

  let scene = InterpretedFrameScene(
    id: sceneId,
    isRendering: false,
    frameConfig: frameConfig,
    logger: logger,
    refreshInterval: exportedScene.refreshInterval,
    backgroundColor: exportedScene.backgroundColor,
    state: %*{},
    nodes: initTable[NodeId, DiagramNode](),
    edges: @[],
    nextNodeIds: initTable[NodeId, NodeId](),
    appsByNodeId: initTable[NodeId, AppRoot](),
    eventListeners: initTable[string, seq[NodeId]](),
    appInputsForNodeId: initTable[NodeId, Table[string, NodeId]](),
    appInlineInputsForNodeId: initTable[NodeId, Table[string, string]](),
    codeInputsForNodeId: initTable[NodeId, Table[string, NodeId]](),
    codeInlineInputsForNodeId: initTable[NodeId, Table[string, string]](),
    sceneNodes: initTable[NodeId, FrameScene](),
    publicStateFields: exportedScene.publicStateFields,
    # jsByCodeNodeId: initTable[NodeId, QuickJS](),
      # jsByInlineApp: initTable[NodeId, Table[string, QuickJS]](),
      # jsByInlineCode: initTable[NodeId, Table[string, QuickJS]]()
  )
  echo "🚀 🚀 Initialized interpreted scene: ", sceneId.string
  scene.execNode = proc(nodeId: NodeId, context: ExecutionContext) =
    discard scene.runNode(nodeId, context)
  scene.getDataNode = proc(nodeId: NodeId, context: ExecutionContext): Value =
    scene.runNode(nodeId, context, asDataNode = true)
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      scene.state[key] = persistedState[key]

  var typeMap = initTable[string, string]()
  for field in exportedScene.publicStateFields:
    typeMap[field.name] = field.fieldType
    if not scene.state.hasKey(field.name) and field.value.len > 0:
      # TODO: better string to value parser - no need to go via json
      scene.state[field.name] = valueToJson(valueFromJsonByType(%*(field.value), field.fieldType))
  stateFieldTypesByScene[sceneId] = typeMap

  echo "🎯 🎯 Scene initial state: ", scene.state

  ## Pass 1: register nodes & event listeners (do not init apps yet)
  for node in exportedScene.nodes:
    scene.nodes[node.id] = node
    scene.logger.log(%*{"event": "initInterpretedNode", "sceneId": scene.id, "nodeType": node.nodeType,
        "nodeId": node.id.int})
    if node.nodeType == "event":
      let eventName = node.data{"keyword"}.getStr()
      scene.logger.log(%*{"event": "initInterpretedEvent", "sceneId": scene.id, "nodeEvent": eventName,
          "nodeId": node.id.int})
      if not scene.eventListeners.hasKey(eventName):
        scene.eventListeners[eventName] = @[]
      scene.eventListeners[eventName].add(node.id)

  echo "🎯 🎯 Scene nodes registered: ", scene.nodes.len

  ## Pass 2: process edges (next/prev, app inputs, and node-field wiring)
  for edge in exportedScene.edges:
    logger.log(%*{"event": "initInterpretedEdge", "sceneId": scene.id, "edgeId": edge.id.int,
        "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
        "targetHandle": edge.targetHandle})
    scene.edges.add(edge)
    if edge.sourceHandle == "next" and edge.targetHandle == "prev":
      scene.nextNodeIds[edge.source] = edge.target
      continue
    ## value edges (app/code output -> app input)

    if edge.sourceHandle == "fieldOutput" and edge.targetHandle.startsWith("fieldInput/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if not scene.appInputsForNodeId.hasKey(edge.target):
        scene.appInputsForNodeId[edge.target] = initTable[string, NodeId]()
      scene.appInputsForNodeId[edge.target][fieldName] = edge.source
      scene.logger.log(%*{"event": "initInterpretedAppInput", "sceneId": scene.id, "appNodeId": edge.target.int,
          "inputField": fieldName, "connectedNodeId": edge.source.int})
      continue

    if edge.sourceHandle == "stateOutput" and edge.targetHandle.startsWith("fieldInput/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if not scene.appInputsForNodeId.hasKey(edge.target):
        scene.appInputsForNodeId[edge.target] = initTable[string, NodeId]()
      scene.appInputsForNodeId[edge.target][fieldName] = edge.source
      scene.logger.log(%*{"event": "initInterpretedStateInput", "sceneId": scene.id, "appNodeId": edge.target.int,
          "inputField": fieldName, "connectedNodeId": edge.source.int})
      continue

    # TODO: these should probably be deprecated
    if edge.sourceHandle.startsWith("code/") and edge.targetHandle.startsWith("fieldInput/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if not scene.appInlineInputsForNodeId.hasKey(edge.target):
        scene.appInlineInputsForNodeId[edge.target] = initTable[string, string]()
      scene.appInlineInputsForNodeId[edge.target][fieldName] = edge.sourceHandle.substr("code/".len)
      scene.logger.log(%*{
        "event": "initInterpretedInlineInput",
        "sceneId": scene.id,
        "appNodeId": edge.target.int,
        "inputField": fieldName,
        "code": edge.sourceHandle.substr("code/".len)
      })
      continue

    if edge.targetHandle.startsWith("codeField/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if edge.sourceHandle == "fieldOutput" or edge.sourceHandle == "stateOutput":
        if not scene.codeInputsForNodeId.hasKey(edge.target):
          scene.codeInputsForNodeId[edge.target] = initTable[string, NodeId]()
        scene.codeInputsForNodeId[edge.target][fieldName] = edge.source
        scene.logger.log(%*{
          "event": "initInterpretedCodeInput",
          "sceneId": scene.id,
          "codeNodeId": edge.target.int,
          "arg": fieldName,
          "connectedNodeId": edge.source.int
        })
        continue
      elif edge.sourceHandle.startsWith("code/"):
        if not scene.codeInlineInputsForNodeId.hasKey(edge.target):
          scene.codeInlineInputsForNodeId[edge.target] = initTable[string, string]()
        scene.codeInlineInputsForNodeId[edge.target][fieldName] = edge.sourceHandle.substr("code/".len)
        scene.logger.log(%*{
          "event": "initInterpretedCodeInlineInput",
          "sceneId": scene.id,
          "codeNodeId": edge.target.int,
          "arg": fieldName,
          "code": edge.sourceHandle.substr("code/".len)
        })
        continue

    ## node-field edges (app field -> prev of target node)
    if edge.sourceHandle.startsWith("field/") and edge.targetHandle == "prev":
      scene.setNodeFieldFromEdge(edge)
      scene.logger.log(%*{
        "event": "initInterpretedAppField",
        "sceneId": scene.id,
        "appNodeId": edge.source.int,
        "fieldPath": edge.sourceHandle.substr("field/".len),
        "targetNodeId": edge.target.int
      })
      continue

    if edge.edgeType == "codeNodeEdge":
      logger.log(%*{"event": "initInterpretedEdge:codeNodeEdge:ignored", "sceneId": scene.id, "edgeId": edge.id.int,
          "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
          "targetHandle": edge.targetHandle})
      continue

    logger.log(%*{"event": "initInterpretedEdge:ignored", "sceneId": scene.id, "edgeId": edge.id.int,
        "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
        "targetHandle": edge.targetHandle})

  ## Pass 3: initialize apps AFTER we've wired fields via edges
  for node in exportedScene.nodes:
    if node.nodeType == "app":
      let keyword = node.data{"keyword"}.getStr()
      scene.logger.log(%*{
        "event": "initInterpretedApp",
        "sceneId": scene.id,
        "nodeType": node.nodeType,
        "nodeId": node.id.int,
        "appKeyword": keyword,
        "configKeys": (if node.data.hasKey("config") and node.data["config"].kind == JObject:
        node.data["config"].keys.toSeq()
      else:
        @[])
      })
      scene.appsByNodeId[node.id] = initApp(keyword, node, scene)

    elif node.nodeType == "scene":
      let childSceneId = node.data{"keyword"}.getStr().SceneId
      if not loadedScenes.hasKey(childSceneId):
        raise newException(Exception,
          "Scene node references unknown scene id: " & childSceneId.string)

      # Use node.data.config as the initial state for the child scene (mirrors compiled behavior)
      var persisted = %*{}
      if node.data.hasKey("config") and node.data["config"].kind == JObject:
        persisted = node.data["config"]

      let exportedChild = loadedScenes[childSceneId]
      let child = exportedChild.init(childSceneId, frameConfig, logger, persisted)
      scene.sceneNodes[node.id] = child
      scene.logger.log(%*{
        "event": "initInterpretedChildScene",
        "parentSceneId": scene.id,
        "nodeId": node.id.int,
        "childSceneId": childSceneId.string
      })

      # Fire child's init event once (compiled scenes do this inside their init)
      var initCtx = ExecutionContext(
        scene: child,
        event: "init",
        payload: child.state,
        hasImage: false,
        loopIndex: 0,
        loopKey: "."
      )
      runEvent(child, initCtx)

  echo "🎯 🎯 Scene apps initialized: ", scene.appsByNodeId.len

  logger.log(%*{"event": "initInterpretedDone", "sceneId": sceneId.string, "nodes": scene.nodes.len,
      "edges": scene.edges.len, "eventListeners": scene.eventListeners.len, "apps": scene.appsByNodeId.len})

  return scene

proc runEvent*(self: FrameScene, context: ExecutionContext) =
  var scene: InterpretedFrameScene = InterpretedFrameScene(self)
  self.logger.log(%*{"event": "runEventInterpreted", "sceneId": self.id, "contextEvent": context.event})

  case context.event:
  of "setSceneState":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      let payload = context.payload["state"]
      for field in scene.publicStateFields:
        let key = field.name
        if payload.hasKey(key) and payload[key] != self.state{key}:
          self.state[key] = copy(payload[key])
    if context.payload.hasKey("render"):
      sendEvent("render", %*{})
  of "setCurrentScene":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      let payload = context.payload["state"]
      for field in scene.publicStateFields:
        let key = field.name
        if payload.hasKey(key) and payload[key] != self.state{key}:
          self.state[key] = copy(payload[key])
  else: discard

  if scene.eventListeners.hasKey(context.event):
    self.logger.log(%*{"event": "runEventInterpreted1", "sceneId": self.id, "contextEvent": context.event})
    for nodeId in scene.eventListeners[context.event]:
      self.logger.log(%*{"event": "runEventInterpreted2", "sceneId": self.id, "contextEvent": context.event,
          "nodeId": nodeId.int})
      let nextNode = if scene.nextNodeIds.hasKey(nodeId): scene.nextNodeIds[nodeId] else: -1.NodeId
      if nextNode != 0.NodeId and nextNode != -1.NodeId:
        self.logger.log(%*{"event": "runEventInterpreted3", "sceneId": self.id, "contextEvent": context.event,
            "nodeId": nodeId.int, "nextNode": nextNode.int})
        self.logger.log(%*{"event": "runEventInterpreted:node", "sceneId": self.id, "nodeId": nextNode.int})
        try:
          discard scene.runNode(nextNode, context)
        except Exception as e:
          self.logger.log(%*{
            "event": "runEventInterpreted:error",
            "sceneId": self.id,
            "contextEvent": context.event,
            "nodeId": nextNode.int,
            "error": $e.msg,
            "stacktrace": e.getStackTrace()
          })

proc render*(self: FrameScene, context: ExecutionContext): Image =
  var scene: InterpretedFrameScene = InterpretedFrameScene(self)
  self.logger.log(%*{
    "event": "renderInterpreted",
    "sceneId": self.id,
    "width": self.frameConfig.width,
    "height": self.frameConfig.height
  })

  if not context.hasImage or context.image.isNil:
    context.image = newImage(self.frameConfig.width, self.frameConfig.height)
    context.hasImage = true

  context.image.fill(scene.backgroundColor)
  runEvent(self, context)
  result = context.image

proc renameHook*(v: var DiagramNode, fieldName: var string) =
  if fieldName == "type":
    fieldName = "nodeType"

proc renameHook*(v: var DiagramEdge, fieldName: var string) =
  if fieldName == "type":
    fieldName = "edgeType"

proc renameHook*(v: var StateField, fieldName: var string) =
  if fieldName == "type":
    fieldName = "fieldType"

proc parseHook*(s: string, i: var int, v: var NodeId) =
  var str: string
  parseHook(s, i, str)
  if nodeMappingTable.hasKey(str):
    v = nodeMappingTable[str]
    return
  globalNodeCounter += 1
  nodeMappingTable[str] = NodeId(globalNodeCounter)
  v = NodeId(globalNodeCounter)

proc parseHook*(s: string, i: var int, v: var SceneId) =
  var tmp: string
  parseHook(s, i, tmp)
  v = SceneId(tmp)

proc parseHook*(s: string, i: var int, v: var Color) =
  var tmp: string
  parseHook(s, i, tmp)
  v = parseHtmlColor(tmp)

proc parseInterpretedScenes*(data: string): void =
  if data == "":
    return
  let scenes = data.fromJson(seq[FrameSceneInput])
  for scene in scenes:
    try:
      echo "Loading interpreted scene: ", scene.id
      let refreshInterval = if scene.settings != nil: scene.settings.refreshInterval else: 300.0
      let backgroundColor = if scene.settings != nil: scene.settings.backgroundColor else: parseHtmlColor("#000000")
      let exported = ExportedInterpretedScene(
        nodes: scene.nodes,
        edges: scene.edges,
        publicStateFields: scene.fields,
        persistedStateKeys: scene.fields.mapIt(it.name),
        init: init,
        render: render,
        runEvent: runEvent,
        refreshInterval: refreshInterval,
        backgroundColor: backgroundColor
      )
      loadedScenes[scene.id] = exported
    except Exception as e:
      echo "Warning: Failed to load interpreted scene: ", e.msg

proc getInterpretedScenes*(): Table[SceneId, ExportedInterpretedScene] =
  if allScenesLoaded:
    return loadedScenes

  let file = getEnv("FRAMEOS_SCENES_JSON")
  if file != "":
    if file.endsWith(".gz") and fileExists(file):
      parseInterpretedScenes(uncompress(readFile(file)))
    elif fileExists(file):
      parseInterpretedScenes(readFile(file))

  elif fileExists("./scenes.json.gz"):
    parseInterpretedScenes(uncompress(readFile("./scenes.json.gz")))

  elif fileExists("./scenes.json"):
    parseInterpretedScenes(readFile("./scenes.json"))

  allScenesLoaded = true

  return loadedScenes
