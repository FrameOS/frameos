import json, jsony, pixie, times, options, strformat, strutils, locks, tables, sequtils, os
import pixie/fileformats/png
import scenes/scenes
import system/scenes
import frameos/types
import frameos/interpreter

# Where to store the persisted states
const SCENE_STATE_JSON_FOLDER = "./state"
const UPLOADED_SCENES_JSON_PATH = &"{SCENE_STATE_JSON_FOLDER}/uploaded.json"

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
  # this is likely overkill as we prefix all uploaded scenes with "uploaded/"
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
  let oldUploaded = getUploadedInterpretedScenes()
  updateUploadedScenes(newScenes)
  setUploadedScenePayload(payloadString)
  for sceneId in oldUploaded.keys:
    if sceneId.string.startsWith("uploaded/") and not newScenes.hasKey(sceneId):
      removePersistedState(sceneId)
  if persistPayload:
    var payloadToPersist: JsonNode
    if payload.kind == JArray:
      payloadToPersist = %*{"scenes": payload}
    elif payload.kind == JObject:
      payloadToPersist = payload
    else:
      payloadToPersist = %*{"scenes": %*[]}
    writeFile(UPLOADED_SCENES_JSON_PATH, $payloadToPersist)

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
    cleanupOrphanedUploadedStateFiles()
    if defaultSceneId.isSome():
      return defaultSceneId.get()
    let lastSceneId = loadLastScene()
    if lastSceneId.isSome():
      let persistedSceneId = lastSceneId.get()
      if persistedSceneId.string.startsWith("uploaded/") and not exportedScenes.hasKey(persistedSceneId):
        try:
          let uploadedPayload = parseJson(readFile(UPLOADED_SCENES_JSON_PATH))
          discard updateUploadedScenesFromPayload(uploadedPayload, false)
        except JsonParsingError, IOError:
          discard
      if exportedScenes.hasKey(persistedSceneId):
        return persistedSceneId
    # This array never changes and is read only
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
