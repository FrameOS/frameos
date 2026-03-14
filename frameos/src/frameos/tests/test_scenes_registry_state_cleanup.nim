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
  let uploadedKeepPath = "state/scene-uploaded_keep.json"
  let uploadedOrphanPath = "state/scene-uploaded_orphan.json"
  let uploadedKeepBackup = backupFile(uploadedKeepPath)
  let uploadedOrphanBackup = backupFile(uploadedOrphanPath)

  let interpretedBackup = interpretedScenes
  let uploadedBackupTable = uploadedScenes
  let exportedBackup = exportedScenes

  setup:
    if not dirExists("state"):
      createDir("state")

    interpretedScenes = interpretedBackup
    uploadedScenes = uploadedBackupTable
    exportedScenes = exportedBackup
    setUploadedStateCleanupRanForTest(false)

    if fileExists(uploadedKeepPath):
      removeFile(uploadedKeepPath)
    if fileExists(uploadedOrphanPath):
      removeFile(uploadedOrphanPath)

  teardown:
    interpretedScenes = interpretedBackup
    uploadedScenes = uploadedBackupTable
    exportedScenes = exportedBackup

    restoreFile(uploadedStatePath, uploadedBackup)
    restoreFile(uploadedKeepPath, uploadedKeepBackup)
    restoreFile(uploadedOrphanPath, uploadedOrphanBackup)

  test "getSceneDisplayName resolves compiled, system, interpreted and uploaded names":
    let interpretedId = "test/interpreted-name".SceneId
    interpretedScenes[interpretedId] = testInterpreted("Interpreted Name")

    var uploadedOnly = initTable[SceneId, ExportedInterpretedScene]()
    let uploadedId = "uploaded/test-name".SceneId
    uploadedOnly[uploadedId] = testInterpreted("Uploaded Name")
    updateUploadedScenes(uploadedOnly)

    check getSceneDisplayName("default".SceneId).get() == "Default Scene"
    check getSceneDisplayName("system/index".SceneId).get() == "Index"
    check getSceneDisplayName(interpretedId).get() == "Interpreted Name"
    check getSceneDisplayName(uploadedId).get() == "Uploaded Name"
    check getSceneDisplayName("missing/scene".SceneId).isNone()

  test "dynamic options include interpreted and uploaded scenes with fallback names":
    interpretedScenes = initTable[SceneId, ExportedInterpretedScene]()
    interpretedScenes["test/with-name".SceneId] = testInterpreted("Friendly Name")
    interpretedScenes["test/no-name".SceneId] = testInterpreted("")

    var uploadedOnly = initTable[SceneId, ExportedInterpretedScene]()
    uploadedOnly["uploaded/with-name".SceneId] = testInterpreted("Uploaded Friendly")
    uploadedOnly["uploaded/no-name".SceneId] = testInterpreted("")
    updateUploadedScenes(uploadedOnly)

    let options = getDynamicSceneOptions()
    var namesById = initTable[string, string]()
    for entry in options:
      namesById[entry.id.string] = entry.name

    check namesById["test/with-name"] == "Friendly Name"
    check namesById["test/no-name"] == "test/no-name"
    check namesById["uploaded/with-name"] == "Uploaded Friendly"
    check namesById["uploaded/no-name"] == "uploaded/no-name"

  test "pruneUploadedPublicStates drops orphan uploaded states and falls back current scene":
    interpretedScenes = initTable[SceneId, ExportedInterpretedScene]()
    var uploadedOnly = initTable[SceneId, ExportedInterpretedScene]()
    uploadedOnly["uploaded/keep".SceneId] = testInterpreted("Keep")
    uploadedOnly["uploaded/remove".SceneId] = testInterpreted("Remove")
    updateUploadedScenes(uploadedOnly)

    let keepScene = FrameScene(id: "uploaded/keep".SceneId, state: %*{"value": 1})
    let removeScene = FrameScene(id: "uploaded/remove".SceneId, state: %*{"value": 2})
    keepScene.updateLastPublicState()
    removeScene.updateLastPublicState()
    setLastPublicSceneId("uploaded/remove".SceneId)

    pruneUploadedPublicStates(@["uploaded/keep".SceneId], some("uploaded/keep".SceneId))

    let (currentScene, allStates) = getAllPublicStates()
    check currentScene == "uploaded/keep".SceneId
    check allStates.hasKey("uploaded/keep")
    check not allStates.hasKey("uploaded/remove")

  test "cleanupOrphanedUploadedStateFiles removes orphan uploaded state files":
    writeFile(uploadedKeepPath, "{\"state\":1}")
    writeFile(uploadedOrphanPath, "{\"state\":2}")
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

    cleanupOrphanedUploadedStateFiles()

    check fileExists(uploadedKeepPath)
    check not fileExists(uploadedOrphanPath)

  test "compiled scene reload removes copied temp libraries after failed load":
    let sourcePath = getTempDir() / "frameos-invalid-plugin.so"
    let copiedCounter = getCompiledSceneLoadCounterForTest() + 1
    let copiedPath = getTempDir() / ("frameos-scene-" & $copiedCounter & "-" & extractFilename(sourcePath))
    writeFile(sourcePath, "not a shared library")

    try:
      check tryLoadCompiledScenePluginForTest(sourcePath) == false
      check not fileExists(copiedPath)
    finally:
      if fileExists(sourcePath):
        removeFile(sourcePath)
