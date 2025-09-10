import frameos/types
import tables, json, os, zippy, chroma, pixie, jsony, sequtils

var allScenesLoaded = false
var loadedScenes = initTable[SceneId, ExportedInterpretedScene]()

var globalNodeCounter = 0
var nodeMappingTable = initTable[string, NodeId]()

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger,
    persistedState: JsonNode): FrameScene =
  logger.log(%*{"event": "initInterpreted", "sceneId": sceneId.string})

  let exportedScene = loadedScenes[sceneId]
  if exportedScene == nil:
    raise newException(Exception, "Scene not found: " & sceneId.string)

  let scene = InterpretedFrameScene()
  scene.id = sceneId
  scene.frameConfig = frameConfig
  scene.logger = logger
  scene.nodes = initTable[NodeId, DiagramNode]()
  scene.edges = @[]
  scene.state = %*{}
  scene.isRendering = false
  scene.refreshInterval = exportedScene.refreshInterval
  scene.backgroundColor = exportedScene.backgroundColor
  # execNode*: proc(nodeId: NodeId, context: var ExecutionContext)

  var state = %*{}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]

  return scene

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
  result = context.image

proc runEvent*(self: FrameScene, context: var ExecutionContext) =
  self.logger.log(%*{"event": "runEventInterpreted", "sceneId": self.id})

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
      let exported = ExportedInterpretedScene()
      exported.publicStateFields = scene.fields
      exported.persistedStateKeys = scene.fields.mapIt(it.name)
      exported.init = init
      exported.render = render
      exported.runEvent = runEvent
      exported.refreshInterval = scene.settings.refreshInterval
      exported.backgroundColor = scene.settings.backgroundColor
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
