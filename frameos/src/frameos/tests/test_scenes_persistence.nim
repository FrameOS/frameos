import std/[json, options, os, unittest]

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
