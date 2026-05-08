import std/[os, json, options, strutils, unittest]
import ../../../frameos/types
import ../../../frameos/boot_guard
import ../scene as boot_guard_scene

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

proc testConfig(): FrameConfig =
  FrameConfig(
    width: 800,
    height: 480,
    rotate: 0,
    scalingMode: "contain",
    debug: true,
    saveAssets: %*false
  )

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    discard payload
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc makeScene(): boot_guard_scene.Scene =
  let config = testConfig()
  boot_guard_scene.Scene(boot_guard_scene.init("system/bootGuard".SceneId, config, testLogger(config), %*{}))

try:
  suite "system/bootGuard scene":
    test "failure details are rendered into safe mode text":
      resetBootGuardState()
      updateBootGuardFailureDetails(some("calendar/main"), some("Family Calendar"), some("render crashed"))
      let text = makeScene().buildFailureText()

      check "FrameOS Safe Mode" in text
      check "Scene name: Family Calendar" in text
      check "Scene id: calendar/main" in text
      check "Last captured error:" in text
      check "render crashed" in text

    test "missing failure fields use safe fallback copy":
      resetBootGuardState()
      updateBootGuardFailureDetails(none(string), none(string), none(string))
      let text = makeScene().buildFailureText()

      check "FrameOS Safe Mode" in text
      check "(unknown scene id)" in text
      check "No detailed crash error was captured." in text

    test "self-fallback scene id shows startup safe mode message":
      resetBootGuardState()
      updateBootGuardFailureDetails(some(BOOT_GUARD_FALLBACK_SCENE_ID), some("Boot Guard"), none(string))
      let text = makeScene().buildFailureText()

      check "switched to safe mode" in text
      check not ("Scene id:" in text)
finally:
  restoreBootGuardState()
