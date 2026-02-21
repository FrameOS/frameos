import std/[os, options]
import ../boot_guard

let bootGuardPath = BOOT_GUARD_STATE_PATH
let bootGuardDir = parentDir(bootGuardPath)
let hadExistingState = fileExists(bootGuardPath)
let existingState = if hadExistingState: readFile(bootGuardPath) else: ""

proc restoreBootGuardState() =
  if hadExistingState:
    createDir(bootGuardDir)
    writeFile(bootGuardPath, existingState)
  elif fileExists(bootGuardPath):
    removeFile(bootGuardPath)

proc resetBootGuardState() =
  if fileExists(bootGuardPath):
    removeFile(bootGuardPath)

try:
  block test_boot_guard_counting:
    resetBootGuardState()
    doAssert loadBootCrashCount() == 0
    doAssert not shouldUseFallbackScene()

    doAssert registerBootCrash() == 1
    doAssert loadBootCrashCount() == 1
    doAssert not shouldUseFallbackScene()

    doAssert registerBootCrash() == 2
    doAssert loadBootCrashCount() == 2
    doAssert not shouldUseFallbackScene()

    doAssert registerBootCrash() == 3
    doAssert loadBootCrashCount() == 3
    doAssert shouldUseFallbackScene()

    clearBootCrashCount()
    doAssert loadBootCrashCount() == 0
    doAssert not shouldUseFallbackScene()

  block test_boot_guard_failure_details:
    resetBootGuardState()
    updateBootGuardFailureDetails(some("calendar/main"), some("example crash"))
    let details = loadBootGuardFailureDetails()
    doAssert details.sceneId.isSome and details.sceneId.get() == "calendar/main"
    doAssert details.error.isSome and details.error.get() == "example crash"

  block test_boot_guard_fallback_scene_id:
    doAssert bootGuardFallbackSceneId() == "system/bootGuard"
finally:
  restoreBootGuardState()
