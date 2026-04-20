import json, pixie, times, options, strformat, strutils, locks, tables, sequtils, os
import pixie/fileformats/png
import scenes/scenes
import system/scenes as systemScenesRegistry
import frameos/types
import frameos/interpreter
import frameos/js_runtime

# Where to store the persisted states
const SCENE_STATE_JSON_FOLDER = "./state"
const UPLOADED_SCENES_JSON_PATH = &"{SCENE_STATE_JSON_FOLDER}/uploaded.json"

# All scenes that are compiled into the FrameOS binary
var sceneRegistryLock: Lock
initLock(sceneRegistryLock)
type RetiredExportedScenes = object
  generation: int
  scenes: Table[SceneId, ExportedScene]

var systemScenes*: Table[SceneId, ExportedScene] = getSystemScenes()
var compiledScenes*: Table[SceneId, ExportedScene] = getExportedScenes()
var interpretedScenes*: Table[SceneId, ExportedInterpretedScene] = getInterpretedScenes()
var uploadedScenes*: Table[SceneId, ExportedInterpretedScene] = initTable[SceneId, ExportedInterpretedScene]()
var exportedScenesGeneration = 1
var retiredExportedScenes: seq[RetiredExportedScenes] = @[]

proc buildExportedScenesTable(
    interpreted: Table[SceneId, ExportedInterpretedScene],
    uploaded: Table[SceneId, ExportedInterpretedScene]
  ): Table[SceneId, ExportedScene] =
  result = initTable[SceneId, ExportedScene]()
  for sceneId, scene in systemScenes:
    result[sceneId] = scene
  for sceneId, scene in interpreted:
    result[sceneId] = scene.ExportedScene
  for sceneId, scene in compiledScenes:
    result[sceneId] = scene
  for sceneId, scene in uploaded:
    result[sceneId] = scene.ExportedScene

for sceneId, scene in systemScenes:
  registerCompiledScene(sceneId, scene)
for sceneId, scene in compiledScenes:
  registerCompiledScene(sceneId, scene)

var exportedScenes*: Table[SceneId, ExportedScene] = buildExportedScenesTable(interpretedScenes, uploadedScenes)

proc refreshExportedScenes*() =
  withLock sceneRegistryLock:
    exportedScenes = buildExportedScenesTable(interpretedScenes, uploadedScenes)

proc currentExportedScenesGeneration*(): int =
  withLock sceneRegistryLock:
    return exportedScenesGeneration

proc hasExportedScene*(sceneId: SceneId): bool =
  withLock sceneRegistryLock:
    return exportedScenes.hasKey(sceneId)

# Snapshot exported scene refs under the registry lock so reload can swap tables safely.
proc findExportedScene*(sceneId: SceneId): Option[ExportedScene] =
  withLock sceneRegistryLock:
    if exportedScenes.hasKey(sceneId):
      return some(exportedScenes[sceneId])
  none(ExportedScene)

proc cleanupSceneRuntime*(scene: FrameScene) =
  if scene.isNil:
    return
  if scene of InterpretedFrameScene:
    let interpreted = InterpretedFrameScene(scene)
    for _, childScene in interpreted.sceneNodes:
      cleanupSceneRuntime(childScene)
    # Break common ORC/ARC cycles before closing the JS runtime.
    interpreted.execNode = nil
    interpreted.getDataNode = nil
    interpreted.appsByNodeId = initTable[NodeId, AppRoot]()
    interpreted.appInputsForNodeId = initTable[NodeId, Table[string, NodeId]]()
    interpreted.appInlineInputsForNodeId = initTable[NodeId, Table[string, string]]()
    interpreted.codeInputsForNodeId = initTable[NodeId, Table[string, NodeId]]()
    interpreted.codeInlineInputsForNodeId = initTable[NodeId, Table[string, string]]()
    interpreted.sceneNodes = initTable[NodeId, FrameScene]()
    interpreted.sceneExportByNodeId = initTable[NodeId, ExportedScene]()
    interpreted.nextNodeIds = initTable[NodeId, NodeId]()
    interpreted.eventListeners = initTable[string, seq[NodeId]]()
    interpreted.nodes = initTable[NodeId, DiagramNode]()
    interpreted.edges = @[]
    interpreted.cacheValues = initTable[NodeId, Value]()
    interpreted.cacheTimes = initTable[NodeId, float]()
    interpreted.cacheKeys = initTable[NodeId, JsonNode]()
    cleanupSceneJs(interpreted)

proc cleanupSceneTableRuntime*(scenes: Table[SceneId, FrameScene]) =
  for _, scene in scenes:
    cleanupSceneRuntime(scene)

proc publishExportedScenes(
    nextExportedScenes: Table[SceneId, ExportedScene],
    logger: Logger = nil,
    reason = "unknown"
  ) =
  if logger != nil:
    logger.log(%*{
      "event": "reload:step",
      "step": "exportedScenes:publish:start",
      "reason": reason,
      "currentGeneration": exportedScenesGeneration,
      "nextGeneration": exportedScenesGeneration + 1,
      "retiredCount": retiredExportedScenes.len,
      "nextCount": nextExportedScenes.len
    })
  retiredExportedScenes.add(RetiredExportedScenes(
    generation: exportedScenesGeneration,
    scenes: exportedScenes
  ))
  inc exportedScenesGeneration
  exportedScenes = nextExportedScenes
  if logger != nil:
    logger.log(%*{
      "event": "reload:step",
      "step": "exportedScenes:publish:done",
      "reason": reason,
      "currentGeneration": exportedScenesGeneration,
      "retiredCount": retiredExportedScenes.len,
      "exportedCount": exportedScenes.len
    })

proc reclaimRetiredExportedScenes*(
    renderedGeneration: int,
    logger: Logger = nil,
    keepGenerations = 1
  ) =
  let reclaimBeforeGeneration = renderedGeneration - keepGenerations
  if reclaimBeforeGeneration <= 0:
    return

  var reclaimed: seq[RetiredExportedScenes] = @[]
  var remainingRetiredCount = 0
  withLock sceneRegistryLock:
    var kept: seq[RetiredExportedScenes] = @[]
    for entry in retiredExportedScenes:
      if entry.generation < reclaimBeforeGeneration:
        reclaimed.add(entry)
      else:
        kept.add(entry)
    retiredExportedScenes = kept
    remainingRetiredCount = retiredExportedScenes.len

  if reclaimed.len == 0:
    return

  if logger != nil:
    logger.log(%*{
      "event": "reload:step",
      "step": "exportedScenes:reclaim:start",
      "renderedGeneration": renderedGeneration,
      "reclaimBeforeGeneration": reclaimBeforeGeneration,
      "reclaimedCount": reclaimed.len
    })
  reclaimed.setLen(0)
  if logger != nil:
    logger.log(%*{
      "event": "reload:step",
      "step": "exportedScenes:reclaim:done",
      "renderedGeneration": renderedGeneration,
      "reclaimBeforeGeneration": reclaimBeforeGeneration,
      "remainingRetiredCount": remainingRetiredCount
    })

proc reloadInterpretedScenes*(logger: Logger = nil) =
  let freshInterpreted = loadInterpretedScenesFromDisk()
  withLock sceneRegistryLock:
    replaceInterpretedScenesCache(freshInterpreted)
    interpretedScenes = freshInterpreted
    publishExportedScenes(buildExportedScenesTable(interpretedScenes, uploadedScenes), logger, "reload")

proc updateUploadedScenes*(newScenes: Table[SceneId, ExportedInterpretedScene]) =
  withLock sceneRegistryLock:
    setUploadedInterpretedScenes(newScenes)
    uploadedScenes = newScenes
    publishExportedScenes(buildExportedScenesTable(interpretedScenes, uploadedScenes), nil, "upload")


proc getSceneDisplayName*(sceneId: SceneId): Option[string] =
  withLock sceneRegistryLock:
    for (candidateId, sceneName) in scenes.sceneOptions:
      if candidateId == sceneId and sceneName.len > 0:
        return some(sceneName)
    for (candidateId, sceneName) in systemScenesRegistry.sceneOptions:
      if candidateId == sceneId and sceneName.len > 0:
        return some(sceneName)
    if interpretedScenes.hasKey(sceneId):
      let interpreted = interpretedScenes[sceneId]
      if interpreted.name.len > 0:
        return some(interpreted.name)
    if uploadedScenes.hasKey(sceneId):
      let uploaded = uploadedScenes[sceneId]
      if uploaded.name.len > 0:
        return some(uploaded.name)
    return none(string)

proc getDynamicSceneOptions*(): seq[tuple[id: SceneId, name: string]] =
  withLock sceneRegistryLock:
    for sceneId, scene in interpretedScenes:
      result.add((sceneId, if scene.name.len > 0: scene.name else: sceneId.string))
    for sceneId, scene in uploadedScenes:
      result.add((sceneId, if scene.name.len > 0: scene.name else: sceneId.string))

proc normalizeUploadedScenePayload*(sceneInputs: seq[FrameSceneInput]): seq[FrameSceneInput] =
  # Add "uploaded/" in front of every scene ID to make sure we don't conflict with existing scenes
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
  uploadedScenePayloadLock: Lock
  uploadedScenePayload {.guard: uploadedScenePayloadLock.} = ""
  uploadedStateCleanupRan = false

proc setUploadedScenePayload*(payload: string) =
  withLock uploadedScenePayloadLock:
    uploadedScenePayload = payload

proc getUploadedScenePayload*(): JsonNode =
  withLock uploadedScenePayloadLock:
    if uploadedScenePayload.len == 0:
      return %*[]
    return parseJson(uploadedScenePayload)

proc pruneUploadedPublicStates*(keepSceneIds: seq[SceneId], mainSceneId: Option[SceneId]) =
  var keepLookup = initTable[string, bool]()
  for sceneId in keepSceneIds:
    keepLookup[sceneId.string] = true
  withLock lastPublicStatesLock:
    for sceneKey in lastPublicStates.keys.toSeq():
      if sceneKey.startsWith("uploaded/") and not keepLookup.hasKey(sceneKey):
        lastPublicStates.delete(sceneKey)
    for sceneId in lastPublicStateUpdates.keys.toSeq():
      if sceneId.string.startsWith("uploaded/") and not keepLookup.hasKey(sceneId.string):
        lastPublicStateUpdates.del(sceneId)
    if lastPublicSceneId.string.startsWith("uploaded/") and not keepLookup.hasKey(lastPublicSceneId.string):
      if mainSceneId.isSome:
        lastPublicSceneId = mainSceneId.get()
      else:
        lastPublicSceneId = "".SceneId

proc sanitizePathString*(s: string): string =
  var sanitized = newStringOfCap(s.len)
  for ch in s:
    if ch.isAlphaNumeric or ch in ['-', '_', '.']:
      sanitized.add(ch)
    else:
      sanitized.add('_')

  var collapsed = newStringOfCap(sanitized.len)
  var lastWasUnderscore = false
  for ch in sanitized:
    if ch == '_':
      if not lastWasUnderscore:
        collapsed.add(ch)
      lastWasUnderscore = true
    else:
      collapsed.add(ch)
      lastWasUnderscore = false

  var trimmed = collapsed.strip(chars = {'_', '.'})
  if trimmed.len == 0:
    return "untitled"
  if trimmed.len > 120:
    trimmed = trimmed[0 ..< 120]
  return trimmed

proc removePersistedState*(sceneId: SceneId) =
  if lastPersistedStates.hasKey(sceneId.string):
    lastPersistedStates.delete(sceneId.string)
  let statePath = &"{SCENE_STATE_JSON_FOLDER}/scene-{sanitizePathString(sceneId.string)}.json"
  try:
    if fileExists(statePath):
      removeFile(statePath)
  except OSError:
    discard

proc updateUploadedScenesFromPayload*(
    payload: JsonNode,
    persistPayload: bool = true
  ): tuple[mainScene: Option[SceneId], sceneIds: seq[SceneId]] =
  var scenePayload: JsonNode
  if payload.kind == JObject and payload.hasKey("scenes") and payload["scenes"].kind == JArray:
    scenePayload = payload["scenes"]
  else:
    return (none(SceneId), @[])

  # nim json -> jsony -> FrameSceneInput
  # clunky but works...
  let payloadString = $scenePayload
  let rawSceneInputs = parseInterpretedSceneInputs(payloadString)
  var uploadedIdMap = initTable[SceneId, SceneId]()
  for scene in rawSceneInputs:
    uploadedIdMap[scene.id] = SceneId("uploaded/" & scene.id.string)

  let sceneInputs = normalizeUploadedScenePayload(rawSceneInputs)
  if sceneInputs.len == 0:
    return (none(SceneId), @[])

  let newScenes = buildInterpretedScenes(sceneInputs)
  var oldUploaded = initTable[SceneId, ExportedInterpretedScene]()
  withLock sceneRegistryLock:
    oldUploaded = uploadedScenes
  updateUploadedScenes(newScenes)
  setUploadedScenePayload(payloadString)
  for sceneId in oldUploaded.keys:
    if sceneId.string.startsWith("uploaded/") and not newScenes.hasKey(sceneId):
      removePersistedState(sceneId)
  if persistPayload:
    writeFile(UPLOADED_SCENES_JSON_PATH, $payload)

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
  pruneUploadedPublicStates(sceneIds, some(mainSceneId))
  return (some(mainSceneId), sceneIds & oldSceneIds)

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
  {.gcsafe.}:
    var sceneId = "".SceneId
    var state = %*{}
    var lastUpdate = 0.0
    withLock lastPublicStatesLock:
      sceneId = lastPublicSceneId
      if lastPublicStates.hasKey(sceneId.string):
        state = lastPublicStates[sceneId.string].copy()
      if lastPublicStateUpdates.hasKey(sceneId):
        lastUpdate = lastPublicStateUpdates[sceneId]
    let sceneExport = findExportedScene(sceneId)
    let publicStateFields =
      if sceneExport.isSome:
        sceneExport.get().publicStateFields
      else:
        @[]
    return (sceneId, state, publicStateFields, lastUpdate)

proc getAllPublicStates*(): (SceneId, JsonNode) =
  {.gcsafe.}: # It's fine: state is copied and .publicStateFields don't change
    withLock lastPublicStatesLock:
      return (lastPublicSceneId, lastPublicStates.copy())

proc setLastPublicSceneId*(sceneId: SceneId) =
  if not hasExportedScene(sceneId):
    raise newException(ValueError, "Scene not exported: " & sceneId.string)
  withLock lastPublicStatesLock:
    lastPublicSceneId = sceneId

proc updateLastPublicState*(self: FrameScene) =
  let sceneExport = findExportedScene(self.id)
  if sceneExport.isNone:
    return
  withLock lastPublicStatesLock:
    if not lastPublicStates.hasKey(self.id.string):
      lastPublicStates[self.id.string] = %*{}
    let lastSceneState = lastPublicStates[self.id.string]
    for field in sceneExport.get().publicStateFields:
      let key = field.name
      if self.state.hasKey(key) and self.state[key] != lastSceneState{key}:
        lastSceneState[key] = copy(self.state[key])
    lastPublicStateUpdates[self.id] = epochTime()
  self.lastPublicStateUpdate = epochTime()

proc setPersistedStateFromPayload*(sceneId: SceneId, payload: JsonNode) =
  if payload.isNil or payload.kind != JObject:
    return
  if not lastPersistedStates.hasKey(sceneId.string):
    lastPersistedStates[sceneId.string] = %*{}
  let persistedState = lastPersistedStates[sceneId.string]
  for key in payload.keys:
    persistedState[key] = copy(payload[key])
  writeFile(&"{SCENE_STATE_JSON_FOLDER}/scene-{sanitizePathString(sceneId.string)}.json", $persistedState)

proc cleanupOrphanedUploadedStateFiles*() =
  if uploadedStateCleanupRan:
    return
  uploadedStateCleanupRan = true
  var keepFiles = initTable[string, bool]()
  try:
    if fileExists(UPLOADED_SCENES_JSON_PATH):
      let uploadedPayload = parseJson(readFile(UPLOADED_SCENES_JSON_PATH))
      let (_, sceneIds) = updateUploadedScenesFromPayload(uploadedPayload, false)
      for sceneId in sceneIds:
        let filename = &"scene-{sanitizePathString(sceneId.string)}.json"
        keepFiles[filename] = true
  except JsonParsingError, IOError:
    discard
  for filePath in walkFiles(&"{SCENE_STATE_JSON_FOLDER}/scene-uploaded_*.json"):
    try:
      if not keepFiles.hasKey(splitFile(filePath).name & ".json"):
        removeFile(filePath)
    except OSError:
      discard

when defined(testing):
  proc setUploadedStateCleanupRanForTest*(value: bool) =
    uploadedStateCleanupRan = value

  proc retiredExportedScenesCountForTest*(): int =
    withLock sceneRegistryLock:
      return retiredExportedScenes.len

  proc resetRetiredExportedScenesForTest*() =
    withLock sceneRegistryLock:
      exportedScenesGeneration = 1
      retiredExportedScenes = @[]

proc updateLastPersistedState*(self: FrameScene) =
  let sceneExport = findExportedScene(self.id)
  if sceneExport.isNone:
    return
  var hasChanges = false
  if not lastPersistedStates.hasKey(self.id.string):
    lastPersistedStates[self.id.string] = %*{}
  let persistedState = lastPersistedStates[self.id.string]
  for key in sceneExport.get().persistedStateKeys:
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
    cleanupOrphanedUploadedStateFiles()
    if defaultSceneId.isSome():
      return defaultSceneId.get()
    let lastSceneId = loadLastScene()
    if lastSceneId.isSome():
      let persistedSceneId = lastSceneId.get()
      if persistedSceneId.string.startsWith("uploaded/") and not hasExportedScene(persistedSceneId):
        try:
          let uploadedPayload = parseJson(readFile(UPLOADED_SCENES_JSON_PATH))
          discard updateUploadedScenesFromPayload(uploadedPayload, false)
        except JsonParsingError, IOError:
          discard
      if hasExportedScene(persistedSceneId):
        return persistedSceneId
    withLock sceneRegistryLock:
      if len(compiledScenes) > 0:
        for key in keys(compiledScenes):
          return key
      if len(interpretedScenes) > 0:
        for key in keys(interpretedScenes):
          return key
      if len(compiledScenes) == 0 and len(interpretedScenes) == 0 and len(uploadedScenes) == 0:
        let indexSceneId = "system/index".SceneId
        if systemScenes.hasKey(indexSceneId):
          return indexSceneId
      if len(systemScenes) > 0:
        for key in keys(systemScenes):
          return key
  return "".SceneId
