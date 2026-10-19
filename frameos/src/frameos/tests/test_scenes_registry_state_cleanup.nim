import std/[json, options, os, tables, unittest]

import ../scenes
import ../types

type FileBackup = object
  exists: bool
  content: string

proc backupFile(path: string): FileBackup =
  if fileExists(path):
    FileBackup(exists: true, content: readFile(path))
  else:
    FileBackup(exists: false, content: "")

proc restoreFile(path: string, backup: FileBackup) =
  if backup.exists:
    writeFile(path, backup.content)
  elif fileExists(path):
    removeFile(path)

proc testInterpreted(name: string): ExportedInterpretedScene =
  ExportedInterpretedScene(
    name: name,
    publicStateFields: @[
      StateField(name: "value")
    ],
    persistedStateKeys: @[],
  )

suite "scene registry and cleanup helpers":
  let uploadedStatePath = "state/uploaded.json"
  let uploadedBackup = backupFile(uploadedStatePath)
  let legacyKeepPath = "state/scene-uploaded_keep.json"
  let legacyOrphanPath = "state/scene-uploaded_orphan.json"
  let keepPath = "state/scene-keep.json"
  let legacyKeepBackup = backupFile(legacyKeepPath)
  let legacyOrphanBackup = backupFile(legacyOrphanPath)
  let keepBackup = backupFile(keepPath)

  let interpretedBackup = interpretedScenes
  let uploadedBackupTable = uploadedScenes

  setup:
    if not dirExists("state"):
      createDir("state")

    interpretedScenes = interpretedBackup
    uploadedScenes = uploadedBackupTable
    refreshExportedScenes()
    resetRetiredExportedScenesForTest()
    setUploadedScenesLoadedForTest(false)

    for path in [legacyKeepPath, legacyOrphanPath, keepPath]:
      if fileExists(path):
        removeFile(path)

  teardown:
    interpretedScenes = interpretedBackup
    uploadedScenes = uploadedBackupTable
    refreshExportedScenes()
    resetRetiredExportedScenesForTest()

    restoreFile(uploadedStatePath, uploadedBackup)
    restoreFile(legacyKeepPath, legacyKeepBackup)
    restoreFile(legacyOrphanPath, legacyOrphanBackup)
    restoreFile(keepPath, keepBackup)

  test "getSceneDisplayName resolves compiled, system, interpreted and uploaded names":
    let interpretedId = "test/interpreted-name".SceneId
    interpretedScenes[interpretedId] = testInterpreted("Interpreted Name")
    refreshExportedScenes()

    let sharedId = "test/shared-name".SceneId
    interpretedScenes[sharedId] = testInterpreted("Deployed Name")
    refreshExportedScenes()

    var uploadedOnly = initTable[SceneId, ExportedInterpretedScene]()
    let uploadedId = "test-name".SceneId
    uploadedOnly[uploadedId] = testInterpreted("Uploaded Name")
    uploadedOnly[sharedId] = testInterpreted("Uploaded Copy")
    updateUploadedScenes(uploadedOnly)

    check getSceneDisplayName("default".SceneId).get() == "Default Scene"
    check getSceneDisplayName("system/index".SceneId).get() == "Index"
    check getSceneDisplayName(interpretedId).get() == "Interpreted Name"
    check getSceneDisplayName(uploadedId).get() == "Uploaded Name"
    # An uploaded scene stands in for the deployed one with its id.
    check getSceneDisplayName(sharedId).get() == "Uploaded Copy"
    check getSceneDisplayName("missing/scene".SceneId).isNone()

  test "dynamic options include interpreted and uploaded scenes with fallback names":
    interpretedScenes = initTable[SceneId, ExportedInterpretedScene]()
    interpretedScenes["test/with-name".SceneId] = testInterpreted("Friendly Name")
    interpretedScenes["test/no-name".SceneId] = testInterpreted("")
    refreshExportedScenes()

    var uploadedOnly = initTable[SceneId, ExportedInterpretedScene]()
    uploadedOnly["up/with-name".SceneId] = testInterpreted("Uploaded Friendly")
    uploadedOnly["up/no-name".SceneId] = testInterpreted("")
    uploadedOnly["test/with-name".SceneId] = testInterpreted("Uploaded Copy")
    updateUploadedScenes(uploadedOnly)

    let options = getDynamicSceneOptions()
    var namesById = initTable[string, string]()
    for entry in options:
      check not namesById.hasKey(entry.id.string)
      namesById[entry.id.string] = entry.name

    check namesById.len == 4
    check namesById["test/with-name"] == "Uploaded Copy"
    check namesById["test/no-name"] == "test/no-name"
    check namesById["up/with-name"] == "Uploaded Friendly"
    check namesById["up/no-name"] == "up/no-name"
    check dynamicSceneCount() == 4

  test "prunePublicStates drops the scenes the frame no longer holds and hands over the current one":
    var uploadedOnly = initTable[SceneId, ExportedInterpretedScene]()
    uploadedOnly["keep".SceneId] = testInterpreted("Keep")
    uploadedOnly["remove".SceneId] = testInterpreted("Remove")
    updateUploadedScenes(uploadedOnly)

    let keepScene = FrameScene(id: "keep".SceneId, state: %*{"value": 1})
    let removeScene = FrameScene(id: "remove".SceneId, state: %*{"value": 2})
    keepScene.updateLastPublicState()
    removeScene.updateLastPublicState()
    setLastPublicSceneId("remove".SceneId)

    prunePublicStates(@["remove".SceneId], "keep".SceneId)

    let (currentScene, allStates) = getAllPublicStates()
    check currentScene == "keep".SceneId
    check allStates.hasKey("keep")
    check not allStates.hasKey("remove")

  test "an older runtime's uploaded state moves to the scene's own file at boot":
    # Before 2026.10.18 an uploaded scene ran as "uploaded/<id>" and kept its
    # state in scene-uploaded_<id>.json.
    writeFile(legacyKeepPath, "{\"state\":1}")
    writeFile(legacyOrphanPath, "{\"state\":2}")
    writeFile(uploadedStatePath, $(%*{
      "sceneId": "keep",
      "scenes": [
        {
          "id": "keep",
          "name": "Keep",
          "nodes": [],
          "edges": [],
          "fields": [],
          "settings": {"backgroundColor": "#ffffff", "refreshInterval": 0.0}
        }
      ]
    }))

    loadUploadedScenes()

    check readFile(keepPath) == "{\"state\":1}"
    check not fileExists(legacyKeepPath)
    check not fileExists(legacyOrphanPath)
    check hasExportedScene("keep".SceneId)

  test "reclaimRetiredExportedScenes keeps one previous generation":
    var uploadedOne = initTable[SceneId, ExportedInterpretedScene]()
    uploadedOne["one".SceneId] = testInterpreted("One")
    updateUploadedScenes(uploadedOne)

    var uploadedTwo = initTable[SceneId, ExportedInterpretedScene]()
    uploadedTwo["two".SceneId] = testInterpreted("Two")
    updateUploadedScenes(uploadedTwo)

    check retiredExportedScenesCountForTest() == 2

    reclaimRetiredExportedScenes(currentExportedScenesGeneration(), keepGenerations = 1)

    check retiredExportedScenesCountForTest() == 1
