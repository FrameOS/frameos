import frameos/types
import tables, json, os, zippy, chroma, pixie, jsony, sequtils
import std/monotimes
import apps/render/image/app as render_imageApp
import apps/render/gradient/app as render_gradientApp

var allScenesLoaded = false
var loadedScenes = initTable[SceneId, ExportedInterpretedScene]()

var globalNodeCounter = 0
var nodeMappingTable = initTable[string, NodeId]()

proc runNode*(self: FrameScene, nodeId: NodeId, context: var ExecutionContext) =
  let self = InterpretedFrameScene(self)
  var currentNodeId: NodeId = nodeId
  # let timer = getMonoTime()
  # if (getMonoTime() - startedAt) >= initDuration(milliseconds = int(timeoutSec * 1000)):
  # let timer = epochTime()
  # case currentNode:

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
      self.logger.log(%*{"event": "interpreter:runApp", "sceneId": self.id, "nodeId": currentNodeId.int,
          "keyword": keyword})

      if not self.appsByNodeId.hasKey(currentNodeId):
        raise newException(Exception, "App not initialized for node id: " & $currentNode.id & ", keyword: " & keyword)

      let app = render_gradientApp.App(self.appsByNodeId[currentNodeId])
      render_gradientApp.run(app, context)

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
    nextNodeIds: initTable[NodeId, NodeId]()
  )
  scene.execNode = proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context)
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      scene.state[key] = persistedState[key]

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

    elif node.nodeType == "app":
      let keyword = node.data{"keyword"}.getStr()
      var app: AppRoot
      scene.logger.log(%*{"event": "initInterpretedApp", "sceneId": scene.id, "nodeType": node.nodeType,
          "nodeId": node.id.int, "appKeyword": keyword})
      case keyword
      of "render/gradient":
        app = render_gradientApp.App(
          nodeName: node.data{"name"}.getStr(),
          nodeId: node.id,
          scene: scene.FrameScene,
          frameConfig: scene.frameConfig,
          appConfig: render_gradientApp.AppConfig(
            startColor: parseHtmlColor(node.data["config"]{"startColor"}.getStr()),
            endColor: parseHtmlColor(node.data["config"]{"endColor"}.getStr()),
            angle: node.data["config"]{"angle"}.getFloat()
          )
        )
      else:
        raise newException(Exception, "Unknown app type: " & keyword)
      scene.appsByNodeId[node.id] = app

  for edge in exportedScene.edges:
    logger.log(%*{"event": "initInterpretedEdge", "sceneId": scene.id, "edgeId": edge.id.int,
        "source": edge.source.int, "target": edge.target.int, "sourceHandle": edge.sourceHandle,
        "targetHandle": edge.targetHandle})
    if edge.sourceHandle == "next" and edge.targetHandle == "prev":
      scene.nextNodeIds[edge.source] = edge.target
    scene.edges.add(edge)

  logger.log(%*{"event": "initInterpretedDone", "sceneId": sceneId.string, "nodes": scene.nodes.len,
      "edges": scene.edges.len, "eventListeners": scene.eventListeners.len, "apps": scene.appsByNodeId.len})

  return scene

proc runEvent*(self: FrameScene, context: var ExecutionContext) =
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
        scene.runNode(nextNode, context)

proc render*(self: FrameScene, context: var ExecutionContext): Image =
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
      let exported = ExportedInterpretedScene(
        nodes: scene.nodes,
        edges: scene.edges,
        publicStateFields: scene.fields,
        persistedStateKeys: scene.fields.mapIt(it.name),
        init: init,
        render: render,
        runEvent: runEvent,
        refreshInterval: scene.settings.refreshInterval,
        backgroundColor: scene.settings.backgroundColor
      )
      loadedScenes[scene.id] = exported
    except Exception as e:
      echo "Warning: Failed to load interpreted scene: ", e.msg

proc getInterpretedScenes*(): Table[SceneId, ExportedInterpretedScene] =
  if allScenesLoaded:
    return loadedScenes

  let file = getEnv("FRAMEOS_SCENES")
  if file != "":
    parseInterpretedScenes(readFile(file))

  elif fileExists("./scenes.json.gz"):
    parseInterpretedScenes(uncompress(readFile("./scenes.json.gz")))

  elif fileExists("./scenes.json"):
    parseInterpretedScenes(readFile("./scenes.json"))

  allScenesLoaded = true

  return loadedScenes
