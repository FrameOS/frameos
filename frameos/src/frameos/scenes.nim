import json, pixie, times, options, strformat, strutils, locks, tables, sequtils
import pixie/fileformats/png
import scenes/scenes
import system/scenes
import frameos/types
import frameos/interpreter

# Where to store the persisted states
const SCENE_STATE_JSON_FOLDER = "./state"

# All scenes that are compiled into the FrameOS binary
var systemScenes*: Table[SceneId, ExportedScene] = getSystemScenes()
var compiledScenes*: Table[SceneId, ExportedScene] = getExportedScenes()
var interpretedScenes*: Table[SceneId, ExportedInterpretedScene] = getInterpretedScenes()
var uploadedScenes*: Table[SceneId, ExportedInterpretedScene] = initTable[SceneId, ExportedInterpretedScene]()

var exportedScenes*: Table[SceneId, ExportedScene] = initTable[SceneId, ExportedScene]()
for sceneId, scene in systemScenes:
  exportedScenes[sceneId] = scene
  registerCompiledScene(sceneId, scene)
for sceneId, scene in interpretedScenes:
  exportedScenes[sceneId] = scene.ExportedScene
for sceneId, scene in compiledScenes:
  exportedScenes[sceneId] = scene
  registerCompiledScene(sceneId, scene)
for sceneId, scene in uploadedScenes:
  exportedScenes[sceneId] = scene.ExportedScene

proc reloadInterpretedScenes*() =
  let oldInterpreted = interpretedScenes
  resetInterpretedScenes()
  interpretedScenes = getInterpretedScenes()
  for sceneId in keys(oldInterpreted):
    if exportedScenes.hasKey(sceneId):
      exportedScenes.del(sceneId)
  for sceneId, scene in interpretedScenes:
    exportedScenes[sceneId] = scene.ExportedScene

proc updateUploadedScenes*(newScenes: Table[SceneId, ExportedInterpretedScene]) =
  let oldUploaded = getUploadedInterpretedScenes()
  for sceneId in keys(oldUploaded):
    if newScenes.hasKey(sceneId):
      continue
    if compiledScenes.hasKey(sceneId):
      exportedScenes[sceneId] = compiledScenes[sceneId]
    elif interpretedScenes.hasKey(sceneId):
      exportedScenes[sceneId] = interpretedScenes[sceneId].ExportedScene
    elif systemScenes.hasKey(sceneId):
      exportedScenes[sceneId] = systemScenes[sceneId]
    elif exportedScenes.hasKey(sceneId):
      exportedScenes.del(sceneId)
  setUploadedInterpretedScenes(newScenes)
  uploadedScenes = newScenes
  for sceneId, scene in newScenes:
    exportedScenes[sceneId] = scene.ExportedScene

proc normalizeUploadedSceneInputs*(sceneInputs: seq[FrameSceneInput]): seq[FrameSceneInput] =
  var uploadedIdMap = initTable[SceneId, SceneId]()
  for scene in sceneInputs:
    uploadedIdMap[scene.id] = SceneId("uploaded/" & scene.id.string)

  for scene in sceneInputs:
    let originalId = scene.id
    if uploadedIdMap.hasKey(originalId):
      scene.id = uploadedIdMap[originalId]
    for node in scene.nodes:
      if node.data.isNil or node.data.kind != JObject:
        continue
      if node.nodeType == "scene":
        if node.data.hasKey("keyword") and node.data["keyword"].kind == JString:
          let keywordId = SceneId(node.data["keyword"].getStr())
          if uploadedIdMap.hasKey(keywordId):
            node.data["keyword"] = %*(uploadedIdMap[keywordId].string)
      elif node.nodeType == "dispatch":
        if node.data.hasKey("keyword") and node.data["keyword"].kind == JString:
          let eventName = node.data["keyword"].getStr()
          if eventName == "setCurrentScene":
            if node.data.hasKey("config") and node.data["config"].kind == JObject:
              let config = node.data["config"]
              if config.hasKey("sceneId") and config["sceneId"].kind == JString:
                let sceneId = SceneId(config["sceneId"].getStr())
                if uploadedIdMap.hasKey(sceneId):
                  config["sceneId"] = %*(uploadedIdMap[sceneId].string)
  sceneInputs

proc updateUploadedScenesFromPayload*(
    payload: JsonNode
  ): tuple[mainScene: Option[SceneId], sceneIds: seq[SceneId]] =
  var scenePayload: JsonNode
  if payload.kind == JArray:
    scenePayload = payload
  elif payload.kind == JObject and payload.hasKey("scenes"):
    if payload["scenes"].kind == JArray:
      scenePayload = payload["scenes"]
    elif payload["scenes"].kind == JObject:
      scenePayload = %* [payload["scenes"]]
    else:
      return (none(SceneId), @[])
  elif payload.kind == JObject and payload.hasKey("scene") and payload["scene"].kind == JObject:
    scenePayload = %* [payload["scene"]]
  elif payload.kind == JObject:
    scenePayload = %* [payload]
  else:
    return (none(SceneId), @[])

  let rawSceneInputs = parseInterpretedSceneInputs($scenePayload)
  var uploadedIdMap = initTable[SceneId, SceneId]()
  for scene in rawSceneInputs:
    uploadedIdMap[scene.id] = SceneId("uploaded/" & scene.id.string)

  let sceneInputs = normalizeUploadedSceneInputs(rawSceneInputs)
  if sceneInputs.len == 0:
    return (none(SceneId), @[])

  let newScenes = buildInterpretedScenes(sceneInputs)
  let oldUploaded = getUploadedInterpretedScenes()
  updateUploadedScenes(newScenes)

  let sceneIds = sceneInputs.mapIt(it.id)
  let oldSceneIds = oldUploaded.keys.toSeq()
  var mainSceneId = sceneInputs[0].id
  if payload.kind == JObject and payload.hasKey("sceneId") and payload["sceneId"].kind == JString:
    let requestedId = SceneId(payload["sceneId"].getStr())
    if uploadedIdMap.hasKey(requestedId):
      mainSceneId = uploadedIdMap[requestedId]
    else:
      for scene in sceneInputs:
        if scene.id == requestedId:
          mainSceneId = requestedId
          break
  return (some(mainSceneId), sceneIds & oldSceneIds)

var
  lastImageLock: Lock
  lastImage {.guard: lastImageLock.} = newImage(1, 1)
  lastImagePresent = false
  lastPublicStatesLock: Lock
  lastPublicStates {.guard: lastPublicStatesLock.} = %*{}
  lastPublicSceneId {.guard: lastPublicStatesLock.} = "".SceneId
  lastPublicStateUpdates {.guard: lastPublicStatesLock.} = initTable[SceneId, float]()
  lastPersistedStates = %*{}
  lastPersistedSceneId: Option[SceneId] = none(SceneId)

proc setLastImage*(image: Image) =
  withLock lastImageLock:
    lastImage = copy(image)
    lastImagePresent = true

proc getLastImagePng*(): string =
  if not lastImagePresent:
    raise newException(Exception, "No image rendered yet")
  var copy: seq[ColorRGBX]
  var width, height: int
  withLock lastImageLock:
    copy = lastImage.data
    width = lastImage.width
    height = lastImage.height
  return encodePng(width, height, 4, copy[0].addr, copy.len * 4)

proc getLastPublicState*(): (SceneId, JsonNode, seq[StateField], float) =
  {.gcsafe.}: # It's fine: state is copied and .publicStateFields don't change
    var state = %*{}
    var lastUpdate = 0.0
    withLock lastPublicStatesLock:
      if lastPublicStates.hasKey(lastPublicSceneId.string):
        state = lastPublicStates[lastPublicSceneId.string].copy()
      if lastPublicStateUpdates.hasKey(lastPublicSceneId):
        lastUpdate = lastPublicStateUpdates[lastPublicSceneId]
      return (lastPublicSceneId, state, exportedScenes[lastPublicSceneId].publicStateFields, lastUpdate)

proc getAllPublicStates*(): (SceneId, JsonNode) =
  {.gcsafe.}: # It's fine: state is copied and .publicStateFields don't change
    withLock lastPublicStatesLock:
      return (lastPublicSceneId, lastPublicStates.copy())

proc setLastPublicSceneId*(sceneId: SceneId) =
  withLock lastPublicStatesLock:
    if exportedScenes.hasKey(sceneId):
      lastPublicSceneId = sceneId
    else:
      raise newException(ValueError, "Scene not exported: " & sceneId.string)

proc updateLastPublicState*(self: FrameScene) =
  # Do not export systemScenes, as we use this to know where to come back to
  if not exportedScenes.hasKey(self.id):
    return
  let sceneExport = exportedScenes[self.id]
  withLock lastPublicStatesLock:
    if not lastPublicStates.hasKey(self.id.string):
      lastPublicStates[self.id.string] = %*{}
    let lastSceneState = lastPublicStates[self.id.string]
    for field in sceneExport.publicStateFields:
      let key = field.name
      if self.state.hasKey(key) and self.state[key] != lastSceneState{key}:
        lastSceneState[key] = copy(self.state[key])
    lastPublicStateUpdates[self.id] = epochTime()
  self.lastPublicStateUpdate = epochTime()

proc sanitizePathString*(s: string): string =
  return s.multiReplace(("/", "_"), ("\\", "_"), (":", "_"), ("*", "_"), ("?", "_"), ("\"", "_"), ("<", "_"), (">",
      "_"), ("|", "_"))

proc updateLastPersistedState*(self: FrameScene) =
  if not exportedScenes.hasKey(self.id):
    return
  let sceneExport = exportedScenes[self.id]
  var hasChanges = false
  if not lastPersistedStates.hasKey(self.id.string):
    lastPersistedStates[self.id.string] = %*{}
  let persistedState = lastPersistedStates[self.id.string]
  for key in sceneExport.persistedStateKeys:
    if self.state.hasKey(key) and self.state[key] != persistedState{key}:
      persistedState[key] = copy(self.state[key])
      hasChanges = true
  if hasChanges:
    writeFile(&"{SCENE_STATE_JSON_FOLDER}/scene-{sanitizePathString(self.id.string)}.json", $persistedState)
  self.lastPersistedStateUpdate = epochTime()
  if not systemScenes.hasKey(self.id):
    # Persist the sceneId to know where to come back to. Do not persist system scenes.
    if lastPersistedSceneId.isNone() or lastPersistedSceneId.get() != self.id:
      writeFile(&"{SCENE_STATE_JSON_FOLDER}/scene.json", $(%*{"sceneId": self.id.string}))
      lastPersistedSceneId = some(self.id)

proc loadPersistedState*(sceneId: SceneId): JsonNode =
  try:
    return parseJson(readFile(&"{SCENE_STATE_JSON_FOLDER}/scene-{sanitizePathString(sceneId.string)}.json"))
  except JsonParsingError, IOError:
    return %*{}

proc loadLastScene*(): Option[SceneId] =
  try:
    let json = parseJson(readFile(&"{SCENE_STATE_JSON_FOLDER}/scene.json"))
    if json.hasKey("sceneId"):
      result = some(SceneId(json["sceneId"].getStr()))
      lastPersistedSceneId = result
  except JsonParsingError, IOError:
    return none(SceneId)

proc getFirstSceneId*(): SceneId =
  {.gcsafe.}:
    if defaultSceneId.isSome():
      return defaultSceneId.get()
    let lastSceneId = loadLastScene()
    if lastSceneId.isSome() and exportedScenes.hasKey(lastSceneId.get()):
      return lastSceneId.get()
    # This array never changes and is read only
    if len(compiledScenes) > 0:
      for key in keys(compiledScenes):
        return key
    if len(interpretedScenes) > 0:
      for key in keys(interpretedScenes):
        return key
    if len(systemScenes) > 0:
      for key in keys(systemScenes):
        return key
  return "".SceneId
