import std/[json, options, os, tables, unittest]

import ../interpreter
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

proc persistedPath(sceneId: SceneId): string =
  "state/scene-" & sanitizePathString(sceneId.string) & ".json"

suite "scene persistence helpers":
  let sceneFile = "state/scene.json"
  let uploadedFile = "state/uploaded.json"
  let sceneFileBackup = backupFile(sceneFile)
  let uploadedFileBackup = backupFile(uploadedFile)

  setup:
    if not dirExists("state"):
      createDir("state")

  teardown:
    restoreFile(sceneFile, sceneFileBackup)
    restoreFile(uploadedFile, uploadedFileBackup)

  test "setPersistedStateFromPayload merges and writes state":
    let sceneId = "test/persist-merge".SceneId
    let path = persistedPath(sceneId)
    if fileExists(path):
      removeFile(path)

    setPersistedStateFromPayload(sceneId, %*{"count": 1, "name": "alpha"})
    setPersistedStateFromPayload(sceneId, %*{"enabled": true})

    check fileExists(path)
    let persisted = loadPersistedState(sceneId)
    check persisted["count"].getInt() == 1
    check persisted["name"].getStr() == "alpha"
    check persisted["enabled"].getBool()

  test "interpreted scenes persist only fields marked for disk":
    let sceneInputs = parseInterpretedSceneInputs($(%*[
      {
        "id": "test/persist-flags",
        "name": "Persistence flags",
        "nodes": [],
        "edges": [],
        "fields": [
          {"name": "diskField", "type": "string", "persist": "disk"},
          {"name": "memoryField", "type": "string", "persist": "memory"},
          {"name": "defaultField", "type": "string"}
        ],
        "settings": {"backgroundColor": "#000000", "refreshInterval": 300.0}
      }
    ]))
    let interpreted = buildInterpretedScenes(sceneInputs)
    let exported = interpreted["test/persist-flags".SceneId]

    check exported.persistedStateKeys == @["diskField"]

  test "updateLastPersistedState removes stale keys when fields stop persisting":
    let sceneId = "uploaded/persist-prune".SceneId
    let path = persistedPath(sceneId)
    let uploadedBackupTable = uploadedScenes
    try:
      if fileExists(path):
        removeFile(path)
      writeFile(path, $(%*{"stale": "old"}))
      discard loadPersistedState(sceneId)

      var uploadedOnly = initTable[SceneId, ExportedInterpretedScene]()
      uploadedOnly[sceneId] = ExportedInterpretedScene(
        name: "Persist Prune",
        publicStateFields: @[],
        persistedStateKeys: @[],
      )
      updateUploadedScenes(uploadedOnly)

      let scene = FrameScene(id: sceneId, state: %*{"stale": "new"})
      scene.updateLastPersistedState()

      check not fileExists(path)
    finally:
      updateUploadedScenes(uploadedBackupTable)
      removePersistedState(sceneId)

  test "load functions safely handle missing and invalid files":
    let missingSceneId = "test/persist-missing".SceneId
    let missingPath = persistedPath(missingSceneId)
    if fileExists(missingPath):
      removeFile(missingPath)

    check loadPersistedState(missingSceneId).kind == JObject
    check loadPersistedState(missingSceneId).len == 0

    writeFile(missingPath, "{invalid json")
    check loadPersistedState(missingSceneId).len == 0

    if fileExists(sceneFile):
      removeFile(sceneFile)
    check loadLastScene().isNone()

    writeFile(sceneFile, "not-json")
    check loadLastScene().isNone()

    writeFile(sceneFile, $(%*{"sceneId": "system/index"}))
    check loadLastScene().isSome()

  test "getFirstSceneId falls back when persisted uploaded scene is missing":
    let missingUploaded = "uploaded/does-not-exist".SceneId
    writeFile(sceneFile, $(%*{"sceneId": missingUploaded.string}))

    let first = getFirstSceneId()
    check first != missingUploaded
    check first.string.len > 0

  test "uploaded payloads record their runtime origin":
    # hub_client stamps source=cloud on the set_scenes verb; a local admin
    # upload carries no source. The stamp keys the post-demotion LAN deny.
    let scenes = %*[{
      "id": "origin-test", "name": "Origin",
      "nodes": [{"id": "1", "type": "app", "data": {"keyword": "data/clock"}}],
      "edges": [],
    }]
    var hookFired = 0
    uploadedScenesChangedHook = proc() {.gcsafe.} = inc hookFired
    defer: uploadedScenesChangedHook = nil

    let (cloudMain, _) = updateUploadedScenesFromPayload(
      %*{"scenes": scenes, "source": "cloud"}, persistPayload = true)
    check cloudMain.isSome
    check cloudUploadedScenesResident()
    check hookFired == 1
    # The stamp survives in the persisted payload (what a reboot rehydrates).
    check parseJson(readFile(uploadedFile)){"source"}.getStr("") == "cloud"

    let (localMain, _) = updateUploadedScenesFromPayload(
      %*{"scenes": scenes}, persistPayload = false)
    check localMain.isSome
    check not cloudUploadedScenesResident()
    check hookFired == 2

  test "store-origin scenes are tracked regardless of who uploaded them":
    # The LAN deny keys on provenance too: a scene stamped with a store id by
    # the cloud is anyone's code, whether the payload came over the provider
    # link ("cloud") or from a backend deploy / local upload (no source).
    let storeScenes = %*[{
      "id": "store-test", "name": "Store scene",
      "origin": {"href": "https://scenes.frameos.net/s/x", "storeSceneId": "11111111-2222-3333-4444-555555555555"},
      "nodes": [], "edges": [],
    }]
    let (storeMain, _) = updateUploadedScenesFromPayload(
      %*{"scenes": storeScenes}, persistPayload = false)
    check storeMain.isSome
    check storeOriginScenesResident()
    check not cloudUploadedScenesResident()

    let ownScenes = %*[{
      "id": "own-test", "name": "Own scene",
      "origin": {"href": "https://scenes.frameos.net/s/x"},
      "nodes": [], "edges": [],
    }]
    let (ownMain, _) = updateUploadedScenesFromPayload(
      %*{"scenes": ownScenes}, persistPayload = false)
    check ownMain.isSome
    check not storeOriginScenesResident()
    check scenePayloadHasStoreOrigin(storeScenes)
    check not scenePayloadHasStoreOrigin(ownScenes)
    check not scenePayloadHasStoreOrigin(%*{})

  test "cloud-origin payloads are re-checked for refused apps at load time":
    # The verb dispatcher refuses these at transport time; the load-time
    # re-check covers payloads edited on disk or persisted before a keyword
    # joined the list. Local payloads with the same app still load.
    let scenes = %*[{
      "id": "refused-test", "name": "Refused",
      "nodes": [{"id": "1", "type": "app",
                 "data": {"keyword": "data/chromiumScreenshot"}}],
      "edges": [],
    }]
    let (cloudMain, cloudIds) = updateUploadedScenesFromPayload(
      %*{"scenes": scenes, "source": "cloud"}, persistPayload = false)
    check cloudMain.isNone
    check cloudIds.len == 0
    check not cloudUploadedScenesResident()

    let (localMain, _) = updateUploadedScenesFromPayload(
      %*{"scenes": scenes}, persistPayload = false)
    check localMain.isSome
