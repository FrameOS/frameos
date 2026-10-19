import std/[os, strutils, unittest]

import ../scenes
import ../types

suite "Scene helper functions":
  test "sanitize path string normalizes unsafe values":
    check sanitizePathString("scene/main") == "scene_main"
    check sanitizePathString("__..Scene Name..__") == "Scene_Name"
    check sanitizePathString("..") == "untitled"

    let longName = "a".repeat(150)
    check sanitizePathString(longName).len == 120

  test "scene image helpers store a snapshot under the scene's own id":
    let assetsRoot = getTempDir() / "frameos-scene-image-helper-test"
    if dirExists(assetsRoot):
      removeDir(assetsRoot)

    let saved = saveSceneImagePng(assetsRoot, "example/scene", "scene-image-bytes")
    check saved.sceneId == "example/scene"
    check saved.path == sceneImagePath(assetsRoot, "example/scene")
    check sceneImageExists(assetsRoot, "example/scene".SceneId)
    check readFile(saved.path) == "scene-image-bytes"

    removeDir(assetsRoot)
