## A deploy whose writes never reached the card leaves scenes.json.gz sized
## but empty — 21 KB of NULs. scenes.nim reads that file at module init,
## before main, so the ZippyError used to escape the fatal-startup handler
## and exit(1) before the logger, the boot guard or the error screen existed:
## a five-second restart loop with a stale panel and no way back except a new
## card (ukseraamike, 2026-09-14).
import std/[os, strutils, tables, times]
import zippy
import ../interpreter
import ../scenes
import ../types

proc withScenesFile(contents: string, suffix: string, body: proc()) =
  let path = getTempDir() / ("frameos-scene-payload-test-" & $epochTime().int64 & suffix)
  let hadEnv = existsEnv("FRAMEOS_SCENES_JSON")
  let previous = if hadEnv: getEnv("FRAMEOS_SCENES_JSON") else: ""
  writeFile(path, contents)
  putEnv("FRAMEOS_SCENES_JSON", path)
  try:
    body()
  finally:
    if fileExists(path):
      removeFile(path)
    if hadEnv:
      putEnv("FRAMEOS_SCENES_JSON", previous)
    else:
      delEnv("FRAMEOS_SCENES_JSON")
    resetInterpretedScenes()

const oneScene = """[{"id": "scene-one", "name": "One", "nodes": [], "edges": [], "fields": []}]"""

block test_corrupt_gz_payload_does_not_raise_at_module_init:
  # This is the shape of the file the incident left behind: the right size,
  # no data.
  withScenesFile(repeat('\0', 21114), ".gz", proc() =
    let scenes = loadInterpretedScenesForStartup()

    doAssert scenes.len == 0
    let reason = interpretedScenesLoadError()
    doAssert reason.len > 0
    # The panel shows this string, so it has to name the file and the fix.
    doAssert "are corrupt" in reason
    doAssert "Deploy the frame again" in reason
  )

block test_corrupt_payload_is_not_cached_so_a_redeploy_heals_the_frame:
  withScenesFile(repeat('\0', 21114), ".gz", proc() =
    doAssert loadInterpretedScenesForStartup().len == 0
    doAssert interpretedScenesLoadError().len > 0

    # What a redeploy does: the same path, now with real bytes. Nothing
    # cached the failure, so the next read picks the new file up without a
    # restart.
    writeFile(getEnv("FRAMEOS_SCENES_JSON"), compress(oneScene, dataFormat = dfGzip))

    let healed = getInterpretedScenes()
    doAssert healed.len == 1
    doAssert healed.hasKey("scene-one".SceneId)
    doAssert interpretedScenesLoadError() == ""
  )

block test_startup_reread_raises_so_the_fatal_handler_can_show_it:
  # What startFrameOS leans on: the module-init read swallows the failure, the
  # re-read raises it where main's handler turns it into an error screen, a
  # boot-guard count and a retry.
  withScenesFile(repeat('\0', 21114), ".gz", proc() =
    doAssert loadInterpretedScenesForStartup().len == 0
    doAssert interpretedScenesLoadError().len > 0

    var raised = ""
    try:
      reloadInterpretedScenes()
    except InterpretedScenesLoadError as e:
      raised = e.msg
    doAssert "are corrupt" in raised
  )

block test_good_payload_loads_and_reports_no_error:
  withScenesFile(compress(oneScene, dataFormat = dfGzip), ".gz", proc() =
    let scenes = loadInterpretedScenesForStartup()

    doAssert scenes.len == 1
    doAssert interpretedScenesLoadError() == ""
  )

block test_unparseable_plain_payload_is_reported_the_same_way:
  withScenesFile("not json at all", ".json", proc() =
    doAssert loadInterpretedScenesForStartup().len == 0
    doAssert "are corrupt" in interpretedScenesLoadError()
  )

block test_missing_payload_is_not_an_error:
  # A frame with no scenes deployed yet is empty, not broken.
  let hadEnv = existsEnv("FRAMEOS_SCENES_JSON")
  let previous = if hadEnv: getEnv("FRAMEOS_SCENES_JSON") else: ""
  putEnv("FRAMEOS_SCENES_JSON", getTempDir() / "frameos-scene-payload-test-missing.json")
  try:
    resetInterpretedScenes()
    doAssert loadInterpretedScenesForStartup().len == 0
    doAssert interpretedScenesLoadError() == ""
  finally:
    if hadEnv:
      putEnv("FRAMEOS_SCENES_JSON", previous)
    else:
      delEnv("FRAMEOS_SCENES_JSON")
    resetInterpretedScenes()
