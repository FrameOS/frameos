import std/[options, os, oserrors, strutils]
import ../frameos
import ../boot_guard
import ../types
when not defined(windows):
  import posix

proc addressInUseErrorCode(): OSErrorCode =
  when defined(windows):
    OSErrorCode(10048)
  else:
    OSErrorCode(EADDRINUSE)

proc withConfigFile(content: string, body: proc(configPath: string)) =
  let tempPath = getTempDir() / "frameos-startup-test-config.json"
  let hadEnv = existsEnv("FRAMEOS_CONFIG")
  let previous = if hadEnv: getEnv("FRAMEOS_CONFIG") else: ""

  writeFile(tempPath, content)
  putEnv("FRAMEOS_CONFIG", tempPath)

  try:
    body(tempPath)
  finally:
    if fileExists(tempPath):
      removeFile(tempPath)
    if hadEnv:
      putEnv("FRAMEOS_CONFIG", previous)
    else:
      delEnv("FRAMEOS_CONFIG")

block test_startup_fallback_scene_selected_at_threshold:
  var firstSceneId = none(SceneId)

  let changed = applyBootGuardStartupFallback(firstSceneId, BOOT_GUARD_CRASH_LIMIT)

  doAssert changed
  doAssert firstSceneId.isSome
  doAssert firstSceneId.get().string == bootGuardFallbackSceneId()

block test_address_in_use_error_is_formatted_without_stack_trace:
  withConfigFile("""{
    "frameHost": "localhost",
    "framePort": 9123,
    "httpsProxy": {
      "enable": false,
      "port": 8443,
      "exposeOnlyPort": false
    },
    "serverHost": "localhost",
    "serverPort": 8989,
    "serverApiKey": "test-api-key",
    "width": 800,
    "height": 480,
    "metricsInterval": 60.0,
    "rotate": 0,
    "debug": true,
    "scalingMode": "cover",
    "timeZone": "UTC",
    "settings": {},
    "schedule": {}
  }""") do (configPath: string):
    let fatalError = describeFatalStartupError(newOSError(addressInUseErrorCode()))

    doAssert fatalError.showStackTrace == false
    doAssert "0.0.0.0:9123" in fatalError.message
    doAssert configPath in fatalError.message

block test_other_errors_keep_stack_trace_output:
  let fatalError = describeFatalStartupError(newException(IOError, "boom"))

  doAssert fatalError.showStackTrace
  doAssert fatalError.message == "FrameOS fatal: boom"

block test_startup_fallback_scene_not_selected_below_threshold:
  var firstSceneId = none(SceneId)

  let changed = applyBootGuardStartupFallback(firstSceneId, BOOT_GUARD_CRASH_LIMIT - 1)

  doAssert not changed
  doAssert firstSceneId.isNone

block test_startup_fallback_overrides_existing_scene:
  var firstSceneId = some("system/wifiHotspot".SceneId)

  let changed = applyBootGuardStartupFallback(firstSceneId, BOOT_GUARD_CRASH_LIMIT)

  doAssert changed
  doAssert firstSceneId.isSome
  doAssert firstSceneId.get().string == bootGuardFallbackSceneId()

block test_fatal_retry_action_safe_mode_quits:
  let action = fatalStartupRetryAction(ErrorBehaviorConfig(mode: "safe_mode"), 100, 100)

  doAssert action.quitProcess
  doAssert not action.showError

block test_fatal_retry_action_show_error_retries:
  let action = fatalStartupRetryAction(ErrorBehaviorConfig(mode: "show_error_retry", retrySeconds: 42), 100, 100)

  doAssert not action.quitProcess
  doAssert action.showError
  doAssert action.retrySeconds == 42

block test_fatal_retry_action_silent_retry_window:
  let behavior = ErrorBehaviorConfig(
    mode: "silent_retry",
    silentRetrySeconds: 7,
    silentRetryForever: false,
    silentWindowMinutes: 2,
    showErrorRetrySeconds: 60,
  )

  let silentAction = fatalStartupRetryAction(behavior, 100, 219)
  doAssert not silentAction.quitProcess
  doAssert not silentAction.showError
  doAssert silentAction.retrySeconds == 7

  let visibleAction = fatalStartupRetryAction(behavior, 100, 220)
  doAssert not visibleAction.quitProcess
  doAssert visibleAction.showError
  doAssert visibleAction.retrySeconds == 60

block test_fatal_retry_action_silent_retry_forever:
  let behavior = ErrorBehaviorConfig(
    mode: "silent_retry",
    silentRetrySeconds: 9,
    silentRetryForever: true,
    silentWindowMinutes: 1,
    showErrorRetrySeconds: 60,
  )

  let action = fatalStartupRetryAction(behavior, 100, 10000)
  doAssert not action.quitProcess
  doAssert not action.showError
  doAssert action.retrySeconds == 9
