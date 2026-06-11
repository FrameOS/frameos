import json, os, options

const
  BOOT_GUARD_STATE_PATH* = "./state/boot_guard.json"
  BOOT_GUARD_CRASH_LIMIT* = 3
  BOOT_GUARD_SUCCESS_PERSIST_LIMIT* = 3
  BOOT_GUARD_FALLBACK_SCENE_ID* = "system/bootGuard"

type BootGuardFailureDetails* = object
  sceneId*: Option[string]
  sceneName*: Option[string]
  error*: Option[string]

# Cached crash count (-1 = not read yet). clearBootCrashCount runs on every
# successful render; without the cache that meant a file read + JSON parse
# per render cycle.
var cachedCrashCount = -1

proc ensureBootGuardStateDir() =
  createDir(parentDir(BOOT_GUARD_STATE_PATH))

proc loadBootCrashCount*(): int =
  if cachedCrashCount >= 0:
    return cachedCrashCount
  try:
    let data = parseJson(readFile(BOOT_GUARD_STATE_PATH))
    cachedCrashCount = max(0, data{"crashesWithoutRender"}.getInt())
  except JsonParsingError, IOError:
    cachedCrashCount = 0
  return cachedCrashCount

proc loadBootGuardFailureDetails*(): BootGuardFailureDetails =
  result = BootGuardFailureDetails(sceneId: none(string), sceneName: none(string), error: none(string))
  try:
    let data = parseJson(readFile(BOOT_GUARD_STATE_PATH))
    if data.hasKey("sceneId"):
      let sceneId = data{"sceneId"}.getStr()
      if sceneId.len > 0:
        result.sceneId = some(sceneId)
    if data.hasKey("sceneName"):
      let sceneName = data{"sceneName"}.getStr()
      if sceneName.len > 0:
        result.sceneName = some(sceneName)
    if data.hasKey("error"):
      let error = data{"error"}.getStr()
      if error.len > 0:
        result.error = some(error)
  except JsonParsingError, IOError:
    discard

proc writeBootGuardState(crashCount: int, failureDetails: BootGuardFailureDetails) =
  # A full disk must degrade boot-guard accounting, not crash the process:
  # this is called from the render loop, where an escaped IOError would
  # abort the runner thread and put the frame in a crash-restart loop.
  cachedCrashCount = max(0, crashCount)
  try:
    ensureBootGuardStateDir()
    var payload = %*{"crashesWithoutRender": max(0, crashCount)}
    if failureDetails.sceneId.isSome:
      payload["sceneId"] = %failureDetails.sceneId.get()
    if failureDetails.sceneName.isSome:
      payload["sceneName"] = %failureDetails.sceneName.get()
    if failureDetails.error.isSome:
      payload["error"] = %failureDetails.error.get()
    writeFile(BOOT_GUARD_STATE_PATH, $payload)
  except IOError, OSError:
    echo "Error writing boot guard state: " & getCurrentExceptionMsg()

proc writeBootCrashCount(crashCount: int) =
  writeBootGuardState(crashCount, loadBootGuardFailureDetails())

proc registerBootCrash*(): int =
  result = loadBootCrashCount() + 1
  writeBootCrashCount(result)

proc clearBootCrashCount*() =
  if loadBootCrashCount() == 0:
    return
  # Preserve the last failure context so safe mode can continue to show
  # which scene triggered the fallback across subsequent re-renders.
  writeBootCrashCount(0)

proc updateBootGuardFailureDetails*(sceneId: Option[string], sceneName: Option[string], error: Option[string]) =
  writeBootGuardState(loadBootCrashCount(), BootGuardFailureDetails(sceneId: sceneId, sceneName: sceneName, error: error))

proc shouldUseFallbackScene*(crashCount: int): bool =
  crashCount >= BOOT_GUARD_CRASH_LIMIT

proc shouldUseFallbackScene*(): bool =
  shouldUseFallbackScene(loadBootCrashCount())

proc shouldPersistBootGuardContext*(successfulScenes: int): bool =
  max(0, successfulScenes) < BOOT_GUARD_SUCCESS_PERSIST_LIMIT

proc shouldPersistBootGuardContextForScene*(sceneId: string, successfulScenes: int): bool =
  shouldPersistBootGuardContext(successfulScenes) and sceneId != BOOT_GUARD_FALLBACK_SCENE_ID

proc bootGuardFallbackSceneId*(): string =
  BOOT_GUARD_FALLBACK_SCENE_ID

proc resetBootGuardCacheForTest*() =
  cachedCrashCount = -1
