import frameos/types
import frameos/values
import frameos/js_runtime
import frameos/channels
import tables, json, os, zippy, chroma, pixie, jsony, sequtils, options, strutils, times
import apps/apps

const TRACING = false

proc evalInline(scene: InterpretedFrameScene,
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
# Cache utilities
# -------------------------

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

proc readCacheConfig(node: DiagramNode): tuple[enabled, inputEnabled, durationEnabled: bool, durationSec: float] =
  var enabled = false
  var inputEnabled = false
  var durationEnabled = false
  var durationSec = 0.0
  if node.data.hasKey("cache") and node.data["cache"].kind == JObject:
    let cc = node.data["cache"]
    enabled = jBoolOr(cc, "enabled", false)
    if enabled:
      inputEnabled = jBoolOr(cc, "inputEnabled", false)
      durationEnabled = jBoolOr(cc, "durationEnabled", false)
      if durationEnabled:
        durationSec = jFloatOr(cc, "duration", 0.0)
  (enabled, inputEnabled, durationEnabled, durationSec)

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

proc withCache(scene: InterpretedFrameScene,
               nodeId: NodeId,
               cacheEnabled, cacheInputEnabled, cacheDurationEnabled: bool, cacheDurationSec: float,
               builtAnyInput: bool, builtInputKey: JsonNode,
               extraLog: JsonNode,
               compute: proc (): Value): Value =
  ## Generic cache handler shared by app/code data nodes.
  if not cacheEnabled:
    return compute()

  var useCached = scene.cacheValues.hasKey(nodeId)

  if useCached and cacheDurationEnabled:
    if not scene.cacheTimes.hasKey(nodeId):
      useCached = false
    else:
      let last = scene.cacheTimes[nodeId]
      if epochTime() > last + cacheDurationSec:
        useCached = false

  if useCached and cacheInputEnabled and builtAnyInput:
    if not scene.cacheKeys.hasKey(nodeId):
      useCached = false
    else:
      if scene.cacheKeys[nodeId] != builtInputKey:
        useCached = false

  if useCached:
    var payload = %*{
      "event": "interpreter:cache:hit",
      "sceneId": scene.id.string,
      "nodeId": nodeId.int
    }
    if extraLog.kind == JObject:
      for k in extraLog.keys: payload[k] = extraLog[k]
    if TRACING:
      scene.logger.log(payload)
    return scene.cacheValues[nodeId]

  # Miss -> compute and write-back
  var payload = %*{
    "event": "interpreter:cache:miss",
    "sceneId": scene.id.string,
    "nodeId": nodeId.int
  }
  if extraLog.kind == JObject:
    for k in extraLog.keys: payload[k] = extraLog[k]
  if TRACING:
    scene.logger.log(payload)

  let fresh = compute()
  scene.cacheValues[nodeId] = fresh
  if cacheDurationEnabled:
    scene.cacheTimes[nodeId] = epochTime()
  if cacheInputEnabled and builtAnyInput:
    scene.cacheKeys[nodeId] = builtInputKey
  fresh

# -------------------------
# Global registries/state
# -------------------------

var globalNodeCounter = 0
var nodeMappingTable = initTable[string, NodeId]()
var stateFieldTypesByScene = initTable[SceneId, Table[string, string]]()
var allScenesLoaded = false
var loadedScenes = initTable[SceneId, ExportedInterpretedScene]()
var uploadedScenes = initTable[SceneId, ExportedInterpretedScene]()

proc resetInterpretedScenes*() =
  allScenesLoaded = false
  loadedScenes = initTable[SceneId, ExportedInterpretedScene]()
var compiledSceneExports = initTable[SceneId, ExportedScene]()

proc registerCompiledScene*(sceneId: SceneId, exported: ExportedScene) =
  compiledSceneExports[sceneId] = exported

proc setUploadedInterpretedScenes*(scenes: Table[SceneId, ExportedInterpretedScene]) =
  uploadedScenes = scenes

proc getUploadedInterpretedScenes*(): Table[SceneId, ExportedInterpretedScene] =
  uploadedScenes

# -------------------------
# Forward decl
# -------------------------

proc runEvent*(self: FrameScene, context: ExecutionContext)

# -------------------------
# Core node runner
# -------------------------

proc runNode*(self: FrameScene, nodeId: NodeId, context: ExecutionContext, asDataNode = false): Value =
  let self = InterpretedFrameScene(self)
  var currentNodeId: NodeId = nodeId

  # Safety: cycle detection + hop budget
  var visited = initTable[NodeId, bool]()
  var hops = 0
  const maxHops = 1000

  while currentNodeId != -1.NodeId:
    inc hops
    if hops > maxHops:
      self.logger.log(%*{
        "event": "interpreter:graph:hopLimit",
        "sceneId": self.id.string,
        "startNodeId": nodeId.int,
        "atNodeId": currentNodeId.int,
        "limit": maxHops
      })
      break
    if visited.hasKey(currentNodeId):
      self.logger.log(%*{
        "event": "interpreter:graph:cycle",
        "sceneId": self.id.string,
        "startNodeId": nodeId.int,
        "atNodeId": currentNodeId.int
      })
      break
    visited[currentNodeId] = true

    if not self.nodes.hasKey(currentNodeId):
      self.logger.log(%*{"event": "interpreter:nodeNotFound", "sceneId": self.id, "nodeId": currentNodeId.int})
      break

    let currentNode = self.nodes[currentNodeId]
    let nodeType = currentNode.nodeType
    if TRACING:
      self.logger.log(%*{"event": "interpreter:runNode", "sceneId": self.id, "nodeId": currentNodeId.int,
        "nodeType": nodeType})
    case nodeType:
    of "app":
      let keyword = currentNode.data{"keyword"}.getStr()
      if TRACING:
        self.logger.log(%*{
          "event": "interpreter:runApp",
          "sceneId": self.id, "nodeId": currentNodeId.int, "keyword": keyword
        })
      if not self.appsByNodeId.hasKey(currentNodeId):
        raise newException(Exception,
          "App not initialized for node id: " & $currentNode.id & ", keyword: " & keyword)

      let app = self.appsByNodeId[currentNodeId]

      # ---- Read per-node cache config ----
      let (cacheEnabled, cacheInputEnabled, cacheDurationEnabled, cacheDurationSec) = readCacheConfig(currentNode)

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
            let vIn = evalInline(self, context, currentNodeId,
                                 inputName, codeSnippet,
                                 self.appInlineFuncNameByNodeArg, compileAppInlineFn,
                                 inputName)
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
        result = withCache(self, currentNodeId,
                           cacheEnabled, cacheInputEnabled, cacheDurationEnabled, cacheDurationSec,
                           builtAnyInput, builtInputKey,
                           %*{"keyword": keyword}):
          (proc (): Value =
            apps.getApp(keyword, app, context)
          )
      else:
        if asDataNode:
          result = apps.getApp(keyword, app, context)
        else:
          apps.runApp(keyword, app, context)

    of "source":
      raise newException(Exception, "Source nodes are not implemented for interpreted scenes")
    of "dispatch":
      let eventName = currentNode.data{"keyword"}.getStr()
      if TRACING:
        self.logger.log(%*{
          "event": "interpreter:dispatch:run",
          "sceneId": self.id,
          "nodeId": currentNodeId.int,
          "eventName": eventName
        })

      var payload =
        if currentNode.data.hasKey("config") and currentNode.data["config"].kind == JObject:
          copy(currentNode.data["config"])
        else:
          %*{}

      if payload.isNil or payload.kind != JObject:
        payload = %*{}

      if self.appInputsForNodeId.hasKey(currentNodeId):
        let connected = self.appInputsForNodeId[currentNodeId]
        for (inputName, producerNodeId) in connected.pairs:
          if self.nodes.hasKey(producerNodeId):
            try:
              let vIn = runNode(self, producerNodeId, context, asDataNode = true)
              payload[inputName] = valueToJson(vIn)
            except Exception as e:
              self.logger.log(%*{
                "event": "interpreter:dispatch:setField:error",
                "sceneId": self.id,
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
            let vIn = evalInline(self, context, currentNodeId,
                                 inputName, codeSnippet,
                                 self.appInlineFuncNameByNodeArg, compileAppInlineFn,
                                 inputName)
            payload[inputName] = valueToJson(vIn)
          except Exception as e:
            self.logger.log(%*{
              "event": "interpreter:dispatch:setField:error:inlineCode",
              "sceneId": self.id,
              "nodeId": currentNodeId.int,
              "input": inputName,
              "code": codeSnippet,
              "error": $e.msg,
              "stacktrace": e.getStackTrace()
            })

      var finalPayload = payload
      if eventName == "setSceneState":
        var statePayload = %*{}
        var rootPayload = %*{}
        var typeMap = initTable[string, string]()
        if stateFieldTypesByScene.hasKey(self.id):
          typeMap = stateFieldTypesByScene[self.id]
        for key in payload.keys:
          let valueNode = payload[key]
          if typeMap.hasKey(key):
            let typedValue = valueFromJsonByType(valueNode, typeMap[key])
            statePayload[key] = valueToJson(typedValue)
          else:
            if key == "render":
              let typedValue = valueFromJsonByType(valueNode, "boolean")
              rootPayload[key] = valueToJson(typedValue)
            else:
              statePayload[key] = copy(valueNode)
        if statePayload.len > 0:
          rootPayload["state"] = statePayload
        finalPayload = rootPayload

      if TRACING:
        self.logger.log(%*{
          "event": "interpreter:dispatch:send",
          "sceneId": self.id,
          "nodeId": currentNodeId.int,
          "eventName": eventName,
          "payload": finalPayload
        })
      sendEvent(eventName, finalPayload)
      if asDataNode:
        result = VJson(copy(finalPayload))
    of "code":
      # Parse outputs (types and default target)
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

      # Parse arg types
      var argTypes = initTable[string, string]()
      if currentNode.data.hasKey("codeArgs") and currentNode.data["codeArgs"].kind == JArray:
        for argDef in currentNode.data["codeArgs"]:
          if argDef.kind == JObject:
            let name = argDef{"name"}.getStr()
            let typ = argDef{"type"}.getStr()
            if name.len > 0:
              argTypes[name] = typ

      # Build args (connected + inline); also build cache input key if enabled
      var args = initTable[string, Value]()
      var builtInputKey = %*{}
      var builtAnyInput = false

      let (cacheEnabled, cacheInputEnabled, cacheDurationEnabled, cacheDurationSec) = readCacheConfig(currentNode)

      if self.codeInputsForNodeId.hasKey(currentNodeId):
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
        let inlineArgs = self.codeInlineInputsForNodeId[currentNodeId]
        for (argName, snippet) in inlineArgs.pairs:
          try:
            let vIn = evalInline(self, context, currentNodeId,
                                 argName, snippet,
                                 self.codeInlineFuncNameByNodeArg, compileCodeInlineFn,
                                 argName)
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

      # Compute (with optional caching)
      let computeFresh = proc (): Value =
        var fnName = getOrCompileCodeFn(self, currentNode)
        callCompiledFn(self, context, currentNodeId, fnName, args, argTypes, outputTypes, targetField)

      if asDataNode and cacheEnabled:
        result = withCache(self, currentNodeId,
                           cacheEnabled, cacheInputEnabled, cacheDurationEnabled, cacheDurationSec,
                           builtAnyInput, builtInputKey,
                           %*{"nodeType": "code"},
                           computeFresh)
      else:
        let fresh = computeFresh()
        if jBoolOr(currentNode.data, "logOutput", false):
          logCodeNodeOutput(FrameScene(self), currentNodeId, fresh)
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
      if TRACING:
        self.logger.log(%*{
          "event": "interpreter:runScene",
          "sceneId": self.id,
          "nodeId": currentNodeId.int,
          "childSceneId": childSceneId.string
        })

      var exportedChild: ExportedScene
      var needsInitEvent = false

      if self.sceneExportByNodeId.hasKey(currentNodeId):
        exportedChild = self.sceneExportByNodeId[currentNodeId]
      else:
        if loadedScenes.hasKey(childSceneId):
          let interpretedExport = loadedScenes[childSceneId]
          exportedChild = ExportedScene(interpretedExport)
          needsInitEvent = true
        elif compiledSceneExports.hasKey(childSceneId):
          exportedChild = compiledSceneExports[childSceneId]
        elif uploadedScenes.hasKey(childSceneId):
          # uploaded scene id-s start with "uploaded/"
          # we should implement isloated scopes/applications later, but this will do for now
          let interpretedExport = uploadedScenes[childSceneId]
          exportedChild = ExportedScene(interpretedExport)
          needsInitEvent = true
        else:
          raise newException(Exception,
            "Scene node references unknown scene id: " & childSceneId.string)
        self.sceneExportByNodeId[currentNodeId] = exportedChild

      if not self.sceneNodes.hasKey(currentNodeId):
        var persisted = %*{}
        if currentNode.data.hasKey("config") and currentNode.data["config"].kind == JObject:
          persisted = currentNode.data["config"]
        let child = exportedChild.init(childSceneId, self.frameConfig, self.logger, persisted)
        self.sceneNodes[currentNodeId] = child
        if needsInitEvent:
          var initCtx = ExecutionContext(scene: child, event: "init",
                                        payload: child.state, hasImage: false,
                                        loopIndex: 0, loopKey: ".")
          exportedChild.runEvent(child, initCtx)

      let childScene = self.sceneNodes[currentNodeId]

      if not self.sceneExportByNodeId.hasKey(currentNodeId):
        self.sceneExportByNodeId[currentNodeId] = exportedChild

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
            let v = evalInline(self, context, currentNodeId,
                               inputName, codeSnippet,
                               self.appInlineFuncNameByNodeArg, compileAppInlineFn,
                               inputName)
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
      exportedChild = self.sceneExportByNodeId[currentNodeId]
      exportedChild.runEvent(childScene, context)
    else:
      raise newException(Exception, "Unknown node type: " & nodeType)

    if self.nextNodeIds.hasKey(currentNodeId):
      currentNodeId = self.nextNodeIds[currentNodeId]
    else:
      currentNodeId = -1.NodeId


# -------------------------
# Scene wiring helpers
# -------------------------

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

# -------------------------
# Scene lifecycle
# -------------------------

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger,
    persistedState: JsonNode): FrameScene =
  if TRACING:
    logger.log(%*{"event": "initInterpreted", "sceneId": sceneId.string})

  var exportedScene: ExportedInterpretedScene
  if loadedScenes.hasKey(sceneId):
    exportedScene = loadedScenes[sceneId]
  elif uploadedScenes.hasKey(sceneId):
    exportedScene = uploadedScenes[sceneId]
  else:
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
    sceneExportByNodeId: initTable[NodeId, ExportedScene](),
    publicStateFields: exportedScene.publicStateFields,
    jsReady: false,
    jsFuncNameByNode: initTable[NodeId, string](),
    codeInlineFuncNameByNodeArg: initTable[NodeId, Table[string, string]](),
    appInlineFuncNameByNodeArg: initTable[NodeId, Table[string, string]](),
    cacheValues: initTable[NodeId, Value](),
    cacheTimes: initTable[NodeId, float](),
    cacheKeys: initTable[NodeId, JsonNode](),
  )
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
    if not scene.state.hasKey(field.name) and not field.value.isNil and field.value.kind != JNull:
      if field.value.kind == JString and field.value.getStr().len == 0:
        continue
      scene.state[field.name] = valueToJson(valueFromJsonByType(field.value, field.fieldType))
  stateFieldTypesByScene[sceneId] = typeMap

  ## Pass 1: register nodes & event listeners (do not init apps yet)
  for node in exportedScene.nodes:
    scene.nodes[node.id] = node
    if TRACING:
      scene.logger.log(%*{"event": "initInterpretedNode", "sceneId": scene.id, "nodeType": node.nodeType,
          "nodeId": node.id.int})
    if node.nodeType == "event":
      let eventName = node.data{"keyword"}.getStr()
      if TRACING:
        scene.logger.log(%*{"event": "initInterpretedEvent", "sceneId": scene.id, "nodeEvent": eventName,
            "nodeId": node.id.int})
      if not scene.eventListeners.hasKey(eventName):
        scene.eventListeners[eventName] = @[]
      scene.eventListeners[eventName].add(node.id)

  ## Pass 2: process edges (next/prev, app inputs, and node-field wiring)
  for edge in exportedScene.edges:
    if TRACING:
      scene.logger.log(%*{"event": "initInterpretedEdge", "sceneId": scene.id, "edgeId": edge.id.int,
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
      if TRACING:
        scene.logger.log(%*{"event": "initInterpretedAppInput", "sceneId": scene.id, "appNodeId": edge.target.int,
            "inputField": fieldName, "connectedNodeId": edge.source.int})
      continue

    if edge.sourceHandle == "stateOutput" and edge.targetHandle.startsWith("fieldInput/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if not scene.appInputsForNodeId.hasKey(edge.target):
        scene.appInputsForNodeId[edge.target] = initTable[string, NodeId]()
      scene.appInputsForNodeId[edge.target][fieldName] = edge.source
      if TRACING:
        scene.logger.log(%*{"event": "initInterpretedStateInput", "sceneId": scene.id, "appNodeId": edge.target.int,
            "inputField": fieldName, "connectedNodeId": edge.source.int})
      continue

    # TODO: these should probably be deprecated
    if edge.sourceHandle.startsWith("code/") and edge.targetHandle.startsWith("fieldInput/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if not scene.appInlineInputsForNodeId.hasKey(edge.target):
        scene.appInlineInputsForNodeId[edge.target] = initTable[string, string]()
      scene.appInlineInputsForNodeId[edge.target][fieldName] = edge.sourceHandle.substr("code/".len)
      if TRACING:
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
        if TRACING:
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
        if TRACING:
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
      if TRACING:
        scene.logger.log(%*{
          "event": "initInterpretedAppField",
          "sceneId": scene.id,
          "appNodeId": edge.source.int,
          "fieldPath": edge.sourceHandle.substr("field/".len),
          "targetNodeId": edge.target.int
        })
      continue

    if edge.edgeType == "codeNodeEdge":
      if TRACING:
        logger.log(%*{"event": "initInterpretedEdge:codeNodeEdge:ignored", "sceneId": scene.id, "edgeId": edge.id.int,
            "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
            "targetHandle": edge.targetHandle})
      continue

    logger.log(%*{"event": "initInterpretedEdge:ignored", "sceneId": scene.id, "edgeId": edge.id.int,
        "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
        "targetHandle": edge.targetHandle})

  ## Ensure one JS context per scene and precompile functions
  ensureSceneJs(scene)

  # Precompile functions for inline app/scene inputs (for all nodes that have them)
  for nodeId, inlineMap in scene.appInlineInputsForNodeId:
    for inputName, snippet in inlineMap.pairs:
      compileAppInlineFn(scene, nodeId, inputName, snippet)

  # Precompile functions for code nodes and their inline args
  for node in exportedScene.nodes:
    if node.nodeType == "code":
      compileCodeFn(scene, node)
      if scene.codeInlineInputsForNodeId.hasKey(node.id):
        for argName, snippet in scene.codeInlineInputsForNodeId[node.id].pairs:
          compileCodeInlineFn(scene, node.id, argName, snippet)

  ## Pass 3: initialize apps AFTER we've wired fields via edges
  for node in exportedScene.nodes:
    if node.nodeType == "app":
      let keyword = node.data{"keyword"}.getStr()
      if TRACING:
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
      var exportedChild: ExportedScene
      var isInterpretedChild = false

      if loadedScenes.hasKey(childSceneId):
        let interpretedExport = loadedScenes[childSceneId]
        exportedChild = ExportedScene(interpretedExport)
        isInterpretedChild = true
      elif compiledSceneExports.hasKey(childSceneId):
        exportedChild = compiledSceneExports[childSceneId]
      elif uploadedScenes.hasKey(childSceneId):
        let interpretedExport = uploadedScenes[childSceneId]
        exportedChild = ExportedScene(interpretedExport)
        isInterpretedChild = true
      else:
        raise newException(Exception,
          "Scene node references unknown scene id: " & childSceneId.string)

      # Use node.data.config as the initial state for the child scene (mirrors compiled behavior)
      var persisted = %*{}
      if node.data.hasKey("config") and node.data["config"].kind == JObject:
        persisted = node.data["config"]

      let child = exportedChild.init(childSceneId, frameConfig, logger, persisted)
      scene.sceneNodes[node.id] = child
      scene.sceneExportByNodeId[node.id] = exportedChild
      scene.logger.log(%*{
        "event": "initChildScene",
        "parentSceneId": scene.id,
        "nodeId": node.id.int,
        "childSceneId": childSceneId.string,
        "execution": if isInterpretedChild: "interpreted" else: "compiled"
      })

      if isInterpretedChild:
        # Fire child's init event once (compiled scenes do this inside their init)
        var initCtx = ExecutionContext(
          scene: child,
          event: "init",
          payload: child.state,
          hasImage: false,
          loopIndex: 0,
          loopKey: "."
        )
        exportedChild.runEvent(child, initCtx)


  logger.log(%*{"event": "initInterpretedDone", "sceneId": sceneId.string, "nodes": scene.nodes.len,
      "edges": scene.edges.len, "eventListeners": scene.eventListeners.len, "apps": scene.appsByNodeId.len})

  return scene

# -------------------------
# Events / rendering
# -------------------------

proc applyPublicStateFromPayload(scene: InterpretedFrameScene, payload: JsonNode) =
  if payload.isNil or payload.kind != JObject: return
  for field in scene.publicStateFields:
    let key = field.name
    if payload.hasKey(key) and payload[key] != scene.state{key}:
      scene.state[key] = copy(payload[key])

proc runEvent*(self: FrameScene, context: ExecutionContext) =
  var scene: InterpretedFrameScene = InterpretedFrameScene(self)
  self.logger.log(%*{"event": "runEventInterpreted", "sceneId": self.id, "contextEvent": context.event})

  case context.event:
  of "setSceneState":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      applyPublicStateFromPayload(scene, context.payload["state"])
    if context.payload.hasKey("render"):
      sendEvent("render", %*{})
  of "setCurrentScene":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      applyPublicStateFromPayload(scene, context.payload["state"])
  of "render":
    if not context.hasImage or context.image.isNil:
      context.image = newImage(self.frameConfig.width, self.frameConfig.height)
      context.hasImage = true
    context.image.fill(scene.backgroundColor)
  else:
    discard

  if scene.eventListeners.hasKey(context.event):
    for nodeId in scene.eventListeners[context.event]:
      let nextNode = if scene.nextNodeIds.hasKey(nodeId): scene.nextNodeIds[nodeId] else: -1.NodeId
      if nextNode != 0.NodeId and nextNode != -1.NodeId:
        if context.event == "button":
          if scene.nodes.hasKey(nodeId):
            let node = scene.nodes[nodeId]
            if not node.data.isNil and node.data.hasKey("label"):
              let buttonFilter = strip(node.data["label"].getStr())
              if buttonFilter.len > 0:
                if context.payload.isNil or context.payload.kind != JObject:
                  continue
                if not context.payload.hasKey("label") or context.payload["label"].getStr() != buttonFilter:
                  continue
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
  if TRACING:
    self.logger.log(%*{
      "event": "renderInterpreted",
      "sceneId": self.id,
      "width": self.frameConfig.width,
      "height": self.frameConfig.height
    })
  runEvent(self, context)
  result = context.image

# -------------------------
# Serialization hooks
# -------------------------

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

proc dumpHook*(s: var string, v: Color) =
  s.add('"')
  s.add(toHtmlHex(v))
  s.add('"')

# -------------------------
# Scene registry (loader)
# -------------------------

proc buildInterpretedSceneExport(scene: FrameSceneInput): ExportedInterpretedScene =
  let refreshInterval = if scene.settings != nil: scene.settings.refreshInterval else: 300.0
  let backgroundColor = if scene.settings != nil: scene.settings.backgroundColor else: parseHtmlColor("#000000")
  ExportedInterpretedScene(
    name: scene.name,
    nodes: scene.nodes,
    edges: scene.edges,
    publicStateFields: scene.fields,
    persistedStateKeys: scene.fields.mapIt(it.name),
    init: init,
    render: render,
    runEvent: runEvent,
    refreshInterval: if refreshInterval > 0.0: refreshInterval else: 300.0,
    backgroundColor: backgroundColor
  )

proc parseInterpretedSceneInputs*(data: string): seq[FrameSceneInput] =
  if data == "":
    return @[]
  data.fromJson(seq[FrameSceneInput])

proc buildInterpretedScenes*(scenes: seq[FrameSceneInput]): Table[SceneId, ExportedInterpretedScene] =
  result = initTable[SceneId, ExportedInterpretedScene]()
  for scene in scenes:
    result[scene.id] = buildInterpretedSceneExport(scene)

proc parseInterpretedScenes*(data: string): void =
  let scenes = parseInterpretedSceneInputs(data)
  if scenes.len == 0:
    return
  for scene in scenes:
    try:
      loadedScenes[scene.id] = buildInterpretedSceneExport(scene)
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
