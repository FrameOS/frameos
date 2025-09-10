import json, pixie, times, options, strformat, strutils, locks, tables
import pixie/fileformats/png
import scenes/scenes
import scenes/interpreted
import system/scenes
import frameos/types

# Where to store the persisted states
const SCENE_STATE_JSON_FOLDER = "./state"

# All scenes that are compiled into the FrameOS binary
var systemScenes*: Table[SceneId, ExportedScene] = getSystemScenes()
var compiledScenes*: Table[SceneId, ExportedScene] = getExportedScenes()
var interpretedScenes*: Table[SceneId, ExportedInterpretedScene] = getInterpretedScenes()

var exportedScenes*: Table[SceneId, ExportedScene] = initTable[SceneId, ExportedScene]()
for sceneId, scene in systemScenes:
  exportedScenes[sceneId] = scene
for sceneId, scene in interpretedScenes:
  exportedScenes[sceneId] = scene.ExportedScene
for sceneId, scene in compiledScenes:
  exportedScenes[sceneId] = scene

var
  lastImageLock: Lock
  lastImage {.guard: lastImageLock.} = newImage(1, 1)
  lastImagePresent = false
  lastPublicStatesLock: Lock
  lastPublicStates {.guard: lastPublicStatesLock.} = %*{}
  lastPublicSceneId {.guard: lastPublicStatesLock.} = "".SceneId
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

proc getLastPublicState*(): (SceneId, JsonNode, seq[StateField]) =
  {.gcsafe.}: # It's fine: state is copied and .publicStateFields don't change
    var state = %*{}
    withLock lastPublicStatesLock:
      if lastPublicStates.hasKey(lastPublicSceneId.string):
        state = lastPublicStates[lastPublicSceneId.string].copy()
      return (lastPublicSceneId, state, exportedScenes[lastPublicSceneId].publicStateFields)

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
    if len(systemScenes) > 0:
      for key in keys(systemScenes):
        return key
  return "".SceneId
