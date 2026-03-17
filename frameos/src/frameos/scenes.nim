import json, pixie, times, options, strformat, strutils, locks, tables, sequtils, os, dynlib
import pixie/fileformats/png
import system/scenes as systemScenesRegistry
import frameos/channels
import frameos/types
import frameos/interpreter
when defined(testing):
  import scenes/scenes as compiledScenesRegistry

# Where to store the persisted states
const SCENE_STATE_JSON_FOLDER = "./state"
const UPLOADED_SCENES_JSON_PATH = &"{SCENE_STATE_JSON_FOLDER}/uploaded.json"
const COMPILED_SCENES_FOLDER = "./scenes"
const COMPILED_SCENE_PLUGIN_SYMBOL = "getCompiledScenePlugin"
const COMPILED_PLUGIN_RUNTIME_CHANNELS_SYMBOL = "bindCompiledPluginRuntimeChannels"

type
  CompiledScenePluginFactory = proc(): CompiledScenePlugin {.cdecl.}
  CompiledPluginRuntimeChannelsBinder = proc(hooks: ptr CompiledRuntimeHooks) {.cdecl.}
  LoadedCompiledScenes = tuple[
    defaultSceneId: Option[SceneId],
    sceneIds: seq[SceneId],
    sceneOptions: seq[tuple[id: SceneId, name: string]],
    scenes: Table[SceneId, ExportedScene],
    publicStateFields: Table[SceneId, seq[StateField]],
    persistedStateKeys: Table[SceneId, seq[string]],
  ]

var compiledSceneLoadCounter = 0

proc copyCompiledSceneLibrary(sourcePath: string): string =
  inc compiledSceneLoadCounter
  let targetPath = getTempDir() / &"frameos-scene-{compiledSceneLoadCounter}-{extractFilename(sourcePath)}"
  copyFile(sourcePath, targetPath)
  targetPath

proc removeCopiedCompiledSceneLibrary(path: string) =
  if path.len == 0:
    return
  try:
    if fileExists(path):
      removeFile(path)
  except OSError:
    discard

proc bindPluginChannels(handle: LibHandle) =
  let binder = cast[CompiledPluginRuntimeChannelsBinder](
    symAddr(handle, COMPILED_PLUGIN_RUNTIME_CHANNELS_SYMBOL)
  )
  if binder.isNil:
    return
  var runtimeHooks = getCompiledRuntimeHooks()
  binder(addr runtimeHooks)

proc loadCompiledScenePlugin(path: string): Option[CompiledScenePlugin] =
  var copiedPath = ""
  try:
    copiedPath = copyCompiledSceneLibrary(path)
    let handle = loadLib(copiedPath)
    if handle.isNil:
      echo "Warning: failed to load compiled scene plugin: ", path
      return none(CompiledScenePlugin)
    bindPluginChannels(handle)
    let factory = cast[CompiledScenePluginFactory](symAddr(handle, COMPILED_SCENE_PLUGIN_SYMBOL))
    if factory.isNil:
      echo "Warning: missing compiled scene plugin symbol in: ", path
      return none(CompiledScenePlugin)
    let plugin = factory()
    if plugin.isNil or plugin.scene.isNil:
      echo "Warning: compiled scene plugin returned no scene: ", path
      return none(CompiledScenePlugin)
    if plugin.abiVersion != COMPILED_PLUGIN_ABI_VERSION:
      echo "Warning: compiled scene plugin ABI mismatch in ", path, ": expected ", COMPILED_PLUGIN_ABI_VERSION, ", got ", plugin.abiVersion
      return none(CompiledScenePlugin)
    return some(plugin)
  except CatchableError as e:
    echo "Warning: failed to initialize compiled scene plugin ", path, ": ", e.msg
    return none(CompiledScenePlugin)
  finally:
    # Once dlopen has mapped the library we can unlink the temp copy and avoid
    # leaking one extra .so per reload cycle.
    removeCopiedCompiledSceneLibrary(copiedPath)

proc cloneStateField(field: StateField): StateField =
  if field.isNil:
    return nil
  var optionsCopy: seq[string] = @[]
  for option in field.options:
    optionsCopy.add(option & "")
  return StateField(
    name: field.name & "",
    label: field.label & "",
    fieldType: field.fieldType & "",
    value: if field.value.isNil: newJNull() else: copy(field.value),
    options: optionsCopy,
    placeholder: field.placeholder & "",
    required: field.required,
    secret: field.secret,
  )

proc cloneStateFields(fields: openArray[StateField]): seq[StateField] =
  result = @[]
  for field in fields:
    result.add(cloneStateField(field))

proc cloneStringSeq(values: openArray[string]): seq[string] =
  result = @[]
  for value in values:
    result.add(value & "")

proc loadCompiledScenesFromDisk(): LoadedCompiledScenes =
  result = (
    defaultSceneId: none(SceneId),
    sceneIds: @[],
    sceneOptions: @[],
    scenes: initTable[SceneId, ExportedScene](),
    publicStateFields: initTable[SceneId, seq[StateField]](),
    persistedStateKeys: initTable[SceneId, seq[string]](),
  )

  if dirExists(COMPILED_SCENES_FOLDER):
    for path in walkFiles(COMPILED_SCENES_FOLDER / "*.so"):
      let pluginOption = loadCompiledScenePlugin(path)
      if pluginOption.isNone:
        continue
      let plugin = pluginOption.get()
      let sceneId = SceneId(plugin.id.string & "")
      let sceneName = if plugin.name.len > 0: plugin.name & "" else: sceneId.string
      result.sceneIds.add(sceneId)
      result.scenes[sceneId] = plugin.scene
      result.publicStateFields[sceneId] = cloneStateFields(plugin.scene.publicStateFields)
      result.persistedStateKeys[sceneId] = cloneStringSeq(plugin.scene.persistedStateKeys)
      result.sceneOptions.add((sceneId, sceneName))
      if plugin.isDefault:
        result.defaultSceneId = some(sceneId)

  when defined(testing):
    if result.scenes.len == 0:
      result.defaultSceneId = compiledScenesRegistry.defaultSceneId
      result.sceneIds = @[]
      result.sceneOptions = @[]
      for sceneOption in compiledScenesRegistry.sceneOptions:
        result.sceneOptions.add(sceneOption)
      result.scenes = compiledScenesRegistry.getExportedScenes()
      for sceneOption in result.sceneOptions:
        result.sceneIds.add(sceneOption.id)
      for sceneId, scene in result.scenes:
        result.publicStateFields[sceneId] = cloneStateFields(scene.publicStateFields)
        result.persistedStateKeys[sceneId] = cloneStringSeq(scene.persistedStateKeys)

# All scenes that are compiled into the FrameOS binary
var sceneRegistryLock: Lock
initLock(sceneRegistryLock)
var systemScenes*: Table[SceneId, ExportedScene] = getSystemScenes()
var defaultSceneId* = none(SceneId)
var compiledSceneIds: seq[SceneId] = @[]
var compiledSceneOptions: seq[tuple[id: SceneId, name: string]] = @[]
var compiledScenePublicStateFields = initTable[SceneId, seq[StateField]]()
var compiledScenePersistedStateKeys = initTable[SceneId, seq[string]]()
var interpretedScenes*: Table[SceneId, ExportedInterpretedScene] = getInterpretedScenes()
var uploadedScenes*: Table[SceneId, ExportedInterpretedScene] = initTable[SceneId, ExportedInterpretedScene]()
when defined(testing):
  let loadedCompiledScenes = loadCompiledScenesFromDisk()
  var compiledScenesForTest = loadedCompiledScenes.scenes
  defaultSceneId = loadedCompiledScenes.defaultSceneId
  compiledSceneIds = loadedCompiledScenes.sceneIds
  compiledSceneOptions = loadedCompiledScenes.sceneOptions
  compiledScenePublicStateFields = loadedCompiledScenes.publicStateFields
  compiledScenePersistedStateKeys = loadedCompiledScenes.persistedStateKeys
var compiledScenesThreadInitialized {.threadvar.}: bool
var compiledScenesThread {.threadvar.}: Table[SceneId, ExportedScene]

var exportedScenes*: Table[SceneId, ExportedScene] = initTable[SceneId, ExportedScene]()
for sceneId, scene in systemScenes:
  exportedScenes[sceneId] = scene
for sceneId, scene in interpretedScenes:
  exportedScenes[sceneId] = scene.ExportedScene
when defined(testing):
  for sceneId, scene in compiledScenesForTest:
    exportedScenes[sceneId] = scene
for sceneId, scene in uploadedScenes:
  exportedScenes[sceneId] = scene.ExportedScene

proc hasCompiledSceneExportUnlocked(sceneId: SceneId): bool =
  when defined(testing):
    compiledScenesForTest.hasKey(sceneId)
  else:
    compiledScenesThreadInitialized and compiledScenesThread.hasKey(sceneId)

proc getCompiledSceneExportUnlocked(sceneId: SceneId): Option[ExportedScene] =
  if hasCompiledSceneExportUnlocked(sceneId):
    when defined(testing):
      return some(compiledScenesForTest[sceneId])
    else:
      return some(compiledScenesThread[sceneId])
  return none(ExportedScene)

proc hasExportedSceneUnlocked(sceneId: SceneId): bool =
  exportedScenes.hasKey(sceneId) or hasCompiledSceneExportUnlocked(sceneId)

proc getExportedSceneUnlocked(sceneId: SceneId): ExportedScene =
  let compiledScene = getCompiledSceneExportUnlocked(sceneId)
  if compiledScene.isSome:
    return compiledScene.get()
  exportedScenes[sceneId]

proc getScenePublicStateFieldsUnlocked(sceneId: SceneId): seq[StateField] =
  if compiledScenePublicStateFields.hasKey(sceneId):
    return compiledScenePublicStateFields[sceneId]
  if exportedScenes.hasKey(sceneId):
    return exportedScenes[sceneId].publicStateFields
  @[]

proc getScenePersistedStateKeysUnlocked(sceneId: SceneId): seq[string] =
  if compiledScenePersistedStateKeys.hasKey(sceneId):
    return compiledScenePersistedStateKeys[sceneId]
  if exportedScenes.hasKey(sceneId):
    return exportedScenes[sceneId].persistedStateKeys
  @[]

proc hasExportedScene*(sceneId: SceneId): bool =
  withLock sceneRegistryLock:
    result = hasExportedSceneUnlocked(sceneId)

proc getExportedScene*(sceneId: SceneId): ExportedScene =
  withLock sceneRegistryLock:
    result = getExportedSceneUnlocked(sceneId)

proc refreshCompiledSceneExports() =
  var mergedCompiledScenes = initTable[SceneId, ExportedScene]()
  for sceneId, scene in systemScenes:
    mergedCompiledScenes[sceneId] = scene
  when defined(testing):
    for sceneId, scene in compiledScenesForTest:
      mergedCompiledScenes[sceneId] = scene
  else:
    if compiledScenesThreadInitialized:
      for sceneId, scene in compiledScenesThread:
        mergedCompiledScenes[sceneId] = scene
  replaceCompiledSceneExports(mergedCompiledScenes)

refreshCompiledSceneExports()

proc reloadInterpretedScenes*() =
  withLock sceneRegistryLock:
    let oldInterpreted = interpretedScenes
    resetInterpretedScenes()
    interpretedScenes = getInterpretedScenes()
    for sceneId in keys(oldInterpreted):
      if exportedScenes.hasKey(sceneId):
        exportedScenes.del(sceneId)
    for sceneId, scene in interpretedScenes:
      exportedScenes[sceneId] = scene.ExportedScene

proc reloadCompiledScenes*() =
  withLock sceneRegistryLock:
    let loadedCompiled = loadCompiledScenesFromDisk()
    defaultSceneId = loadedCompiled.defaultSceneId
    compiledSceneIds = loadedCompiled.sceneIds
    compiledSceneOptions = loadedCompiled.sceneOptions
    compiledScenePublicStateFields = loadedCompiled.publicStateFields
    compiledScenePersistedStateKeys = loadedCompiled.persistedStateKeys
    when defined(testing):
      compiledScenesForTest = loadedCompiled.scenes
      for sceneId in compiledSceneIds:
        if compiledScenesForTest.hasKey(sceneId):
          exportedScenes[sceneId] = compiledScenesForTest[sceneId]
    else:
      compiledScenesThread = loadedCompiled.scenes
      compiledScenesThreadInitialized = true
    refreshCompiledSceneExports()

proc updateUploadedScenes*(newScenes: Table[SceneId, ExportedInterpretedScene]) =
  withLock sceneRegistryLock:
    # this is likely overkill as we prefix all uploaded scenes with "uploaded/"
    let oldUploaded = getUploadedInterpretedScenes()
    for sceneId in keys(oldUploaded):
      if newScenes.hasKey(sceneId):
        continue
      if interpretedScenes.hasKey(sceneId):
        exportedScenes[sceneId] = interpretedScenes[sceneId].ExportedScene
      elif systemScenes.hasKey(sceneId):
        exportedScenes[sceneId] = systemScenes[sceneId]
      elif exportedScenes.hasKey(sceneId):
        exportedScenes.del(sceneId)
    setUploadedInterpretedScenes(newScenes)
    uploadedScenes = newScenes
    for sceneId, scene in newScenes:
      exportedScenes[sceneId] = scene.ExportedScene

proc getCompiledSceneOptions*(): seq[tuple[id: SceneId, name: string]] =
  withLock sceneRegistryLock:
    result = @[]
    for sceneOption in compiledSceneOptions:
      result.add(sceneOption)

proc getSceneDisplayName*(sceneId: SceneId): Option[string] =
  withLock sceneRegistryLock:
    for (candidateId, sceneName) in compiledSceneOptions:
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
  let oldUploaded = getUploadedInterpretedScenes()
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
  {.gcsafe.}: # It's fine: state is copied and .publicStateFields don't change
    var state = %*{}
    var lastUpdate = 0.0
    var sceneId = "".SceneId
    withLock lastPublicStatesLock:
      sceneId = lastPublicSceneId
      if lastPublicStates.hasKey(sceneId.string):
        state = lastPublicStates[sceneId.string].copy()
      if lastPublicStateUpdates.hasKey(sceneId):
        lastUpdate = lastPublicStateUpdates[sceneId]
    var publicStateFields: seq[StateField] = @[]
    withLock sceneRegistryLock:
      publicStateFields = getScenePublicStateFieldsUnlocked(sceneId)
    return (sceneId, state, publicStateFields, lastUpdate)

proc getAllPublicStates*(): (SceneId, JsonNode) =
  {.gcsafe.}: # It's fine: state is copied and .publicStateFields don't change
    withLock lastPublicStatesLock:
      return (lastPublicSceneId, lastPublicStates.copy())

proc setLastPublicSceneId*(sceneId: SceneId) =
  var sceneExists = false
  withLock sceneRegistryLock:
    sceneExists = hasExportedSceneUnlocked(sceneId)
  if not sceneExists:
    raise newException(ValueError, "Scene not exported: " & sceneId.string)
  withLock lastPublicStatesLock:
    lastPublicSceneId = sceneId

proc updateLastPublicState*(self: FrameScene) =
  # Do not export systemScenes, as we use this to know where to come back to
  var publicStateFields: seq[StateField] = @[]
  var sceneExists = false
  withLock sceneRegistryLock:
    sceneExists = hasExportedSceneUnlocked(self.id)
    if sceneExists:
      publicStateFields = getScenePublicStateFieldsUnlocked(self.id)
  if not sceneExists:
    return
  withLock lastPublicStatesLock:
    if not lastPublicStates.hasKey(self.id.string):
      lastPublicStates[self.id.string] = %*{}
    let lastSceneState = lastPublicStates[self.id.string]
    for field in publicStateFields:
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
  proc getCompiledSceneLoadCounterForTest*(): int =
    compiledSceneLoadCounter

  proc tryLoadCompiledScenePluginForTest*(path: string): bool =
    loadCompiledScenePlugin(path).isSome

  proc setUploadedStateCleanupRanForTest*(value: bool) =
    uploadedStateCleanupRan = value

proc updateLastPersistedState*(self: FrameScene) =
  var persistedStateKeys: seq[string] = @[]
  var sceneExists = false
  withLock sceneRegistryLock:
    sceneExists = hasExportedSceneUnlocked(self.id)
    if sceneExists:
      persistedStateKeys = getScenePersistedStateKeysUnlocked(self.id)
  if not sceneExists:
    return
  var hasChanges = false
  if not lastPersistedStates.hasKey(self.id.string):
    lastPersistedStates[self.id.string] = %*{}
  let persistedState = lastPersistedStates[self.id.string]
  for key in persistedStateKeys:
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
    withLock sceneRegistryLock:
      if defaultSceneId.isSome():
        return defaultSceneId.get()
    let lastSceneId = loadLastScene()
    if lastSceneId.isSome():
      let persistedSceneId = lastSceneId.get()
      var persistedSceneExists = false
      withLock sceneRegistryLock:
        persistedSceneExists = hasExportedSceneUnlocked(persistedSceneId)
      if persistedSceneId.string.startsWith("uploaded/") and not persistedSceneExists:
        try:
          let uploadedPayload = parseJson(readFile(UPLOADED_SCENES_JSON_PATH))
          discard updateUploadedScenesFromPayload(uploadedPayload, false)
        except JsonParsingError, IOError:
          discard
      withLock sceneRegistryLock:
        if hasExportedSceneUnlocked(persistedSceneId):
          return persistedSceneId
    withLock sceneRegistryLock:
      if compiledSceneIds.len > 0:
        return compiledSceneIds[0]
      if len(interpretedScenes) > 0:
        for key in keys(interpretedScenes):
          return key
      if compiledSceneIds.len == 0 and len(interpretedScenes) == 0 and len(uploadedScenes) == 0:
        let indexSceneId = "system/index".SceneId
        if systemScenes.hasKey(indexSceneId):
          return indexSceneId
      if len(systemScenes) > 0:
        for key in keys(systemScenes):
          return key
  return "".SceneId
