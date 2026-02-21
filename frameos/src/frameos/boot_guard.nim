import json, os

const
  BOOT_GUARD_STATE_PATH* = "./state/boot_guard.json"
  BOOT_GUARD_CRASH_LIMIT* = 3
  BOOT_GUARD_FALLBACK_SCENE_ID* = "system/index"

proc ensureBootGuardStateDir() =
  createDir(parentDir(BOOT_GUARD_STATE_PATH))

proc loadBootCrashCount*(): int =
  try:
    let data = parseJson(readFile(BOOT_GUARD_STATE_PATH))
    return max(0, data{"crashesWithoutRender"}.getInt())
  except JsonParsingError, IOError:
    return 0

proc writeBootCrashCount(crashCount: int) =
  ensureBootGuardStateDir()
  writeFile(BOOT_GUARD_STATE_PATH, $(%*{"crashesWithoutRender": max(0, crashCount)}))

proc registerBootCrash*(): int =
  result = loadBootCrashCount() + 1
  writeBootCrashCount(result)

proc clearBootCrashCount*() =
  if loadBootCrashCount() == 0:
    return
  writeBootCrashCount(0)

proc shouldUseFallbackScene*(crashCount: int): bool =
  crashCount >= BOOT_GUARD_CRASH_LIMIT

proc shouldUseFallbackScene*(): bool =
  shouldUseFallbackScene(loadBootCrashCount())

proc bootGuardFallbackSceneId*(): string =
  BOOT_GUARD_FALLBACK_SCENE_ID

