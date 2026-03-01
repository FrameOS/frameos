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

proc ensureBootGuardStateDir() =
  createDir(parentDir(BOOT_GUARD_STATE_PATH))

proc loadBootCrashCount*(): int =
  try:
    let data = parseJson(readFile(BOOT_GUARD_STATE_PATH))
    return max(0, data{"crashesWithoutRender"}.getInt())
  except JsonParsingError, IOError:
    return 0

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
  ensureBootGuardStateDir()
  var payload = %*{"crashesWithoutRender": max(0, crashCount)}
  if failureDetails.sceneId.isSome:
    payload["sceneId"] = %failureDetails.sceneId.get()
  if failureDetails.sceneName.isSome:
    payload["sceneName"] = %failureDetails.sceneName.get()
  if failureDetails.error.isSome:
    payload["error"] = %failureDetails.error.get()
  writeFile(BOOT_GUARD_STATE_PATH, $payload)

proc writeBootCrashCount(crashCount: int) =
  writeBootGuardState(crashCount, loadBootGuardFailureDetails())

proc registerBootCrash*(): int =
  result = loadBootCrashCount() + 1
  writeBootCrashCount(result)

proc clearBootCrashCount*() =
  if loadBootCrashCount() == 0:
    return
  writeBootGuardState(0, BootGuardFailureDetails(sceneId: none(string), sceneName: none(string), error: none(string)))

proc updateBootGuardFailureDetails*(sceneId: Option[string], sceneName: Option[string], error: Option[string]) =
  writeBootGuardState(loadBootCrashCount(), BootGuardFailureDetails(sceneId: sceneId, sceneName: sceneName, error: error))

proc shouldUseFallbackScene*(crashCount: int): bool =
  crashCount >= BOOT_GUARD_CRASH_LIMIT

proc shouldUseFallbackScene*(): bool =
  shouldUseFallbackScene(loadBootCrashCount())

proc shouldPersistBootGuardContext*(successfulScenes: int): bool =
  max(0, successfulScenes) < BOOT_GUARD_SUCCESS_PERSIST_LIMIT

proc bootGuardFallbackSceneId*(): string =
  BOOT_GUARD_FALLBACK_SCENE_ID
