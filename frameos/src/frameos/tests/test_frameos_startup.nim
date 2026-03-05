import std/options
import ../frameos
import ../boot_guard
import ../types

block test_startup_fallback_scene_selected_at_threshold:
  var firstSceneId = none(SceneId)

  let changed = applyBootGuardStartupFallback(firstSceneId, BOOT_GUARD_CRASH_LIMIT)

  doAssert changed
  doAssert firstSceneId.isSome
  doAssert firstSceneId.get().string == bootGuardFallbackSceneId()

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
