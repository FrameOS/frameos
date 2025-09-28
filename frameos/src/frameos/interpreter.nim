import frameos/types
import frameos/values
import tables, json, os, zippy, chroma, pixie, jsony, sequtils, options, strutils
import apps/apps

var allScenesLoaded = false
var loadedScenes = initTable[SceneId, ExportedInterpretedScene]()

var globalNodeCounter = 0
var nodeMappingTable = initTable[string, NodeId]()

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

      # Wire any connected app inputs generically (output -> fieldInput/<name>)
      if self.appInputsForNodeId.hasKey(currentNodeId):
        let connected = self.appInputsForNodeId[currentNodeId]
        for (inputName, producerNodeId) in connected.pairs:
          if self.nodes.hasKey(producerNodeId):
            let v = runNode(self, producerNodeId, context, asDataNode = true)
            apps.setAppField(keyword, app, inputName, v)

      if asDataNode:
        result = apps.getApp(keyword, app, context)
      else:
        apps.runApp(keyword, app, context)

    of "source":
      raise newException(Exception, "Source nodes not implemented in interpreted scenes yet")
    of "dispatch":
      raise newException(Exception, "Dispatch nodes not implemented in interpreted scenes yet")
    of "code":
      raise newException(Exception, "Code nodes not implemented in interpreted scenes yet")
    of "event":
      raise newException(Exception, "Event nodes not implemented in interpreted scenes yet")
    of "state":
      raise newException(Exception, "State nodes not implemented in interpreted scenes yet")
    of "scene":
      raise newException(Exception, "Scene nodes not implemented in interpreted scenes yet")
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
    appInputsForNodeId: initTable[NodeId, Table[string, NodeId]]()
  )
  scene.execNode = proc(nodeId: NodeId, context: ExecutionContext) =
    discard scene.runNode(nodeId, context)
  scene.getDataNode = proc(nodeId: NodeId, context: ExecutionContext): Value =
    scene.runNode(nodeId, context, asDataNode = true)
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      scene.state[key] = persistedState[key]

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

  ## Pass 2: process edges (next/prev, app inputs, and node-field wiring)
  for edge in exportedScene.edges:
    logger.log(%*{"event": "initInterpretedEdge", "sceneId": scene.id, "edgeId": edge.id.int,
        "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
        "targetHandle": edge.targetHandle})
    scene.edges.add(edge)
    if edge.sourceHandle == "next" and edge.targetHandle == "prev":
      scene.nextNodeIds[edge.source] = edge.target
    ## value edges (app/code output -> app input)
    if edge.sourceHandle == "fieldOutput" and edge.targetHandle.startsWith("fieldInput/"):
      let fieldName = edge.targetHandle.split("/")[1]
      if not scene.appInputsForNodeId.hasKey(edge.target):
        scene.appInputsForNodeId[edge.target] = initTable[string, NodeId]()
      scene.appInputsForNodeId[edge.target][fieldName] = edge.source
      scene.logger.log(%*{"event": "initInterpretedAppInput", "sceneId": scene.id, "appNodeId": edge.target.int,
          "inputField": fieldName, "connectedNodeId": edge.source.int})
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

  logger.log(%*{"event": "initInterpretedDone", "sceneId": sceneId.string, "nodes": scene.nodes.len,
      "edges": scene.edges.len, "eventListeners": scene.eventListeners.len, "apps": scene.appsByNodeId.len})

  return scene

proc runEvent*(self: FrameScene, context: ExecutionContext) =
  var scene: InterpretedFrameScene = InterpretedFrameScene(self)
  self.logger.log(%*{"event": "runEventInterpreted", "sceneId": self.id, "contextEvent": context.event})

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
        discard scene.runNode(nextNode, context)

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
