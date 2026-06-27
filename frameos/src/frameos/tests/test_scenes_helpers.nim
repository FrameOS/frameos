import std/[json, os, strutils, unittest]

import ../scenes
import ../types

suite "Scene helper functions":
  test "sanitize path string normalizes unsafe values":
    check sanitizePathString("scene/main") == "scene_main"
    check sanitizePathString("__..Scene Name..__") == "Scene_Name"
    check sanitizePathString("..") == "untitled"

    let longName = "a".repeat(150)
    check sanitizePathString(longName).len == 120

  test "scene image helpers strip uploaded runtime prefixes":
    let assetsRoot = getTempDir() / "frameos-scene-image-helper-test"
    if dirExists(assetsRoot):
      removeDir(assetsRoot)

    let saved = saveSceneImagePng(assetsRoot, "uploaded/example/scene", "scene-image-bytes")
    check saved.sceneId == "example/scene"
    check saved.path == sceneImagePath(assetsRoot, "example/scene")
    check sceneImageExists(assetsRoot, "uploaded/example/scene".SceneId)
    check readFile(saved.path) == "scene-image-bytes"

    removeDir(assetsRoot)

  test "normalize uploaded payload prefixes scene ids and internal references":
    let payload = @[
      FrameSceneInput(
        id: "main".SceneId,
        name: "Main",
        nodes: @[
          DiagramNode(id: 1.NodeId, nodeType: "scene", data: %*{"keyword": "child"}),
          DiagramNode(
            id: 2.NodeId,
            nodeType: "dispatch",
            data: %*{"keyword": "setCurrentScene", "config": {"sceneId": "child"}}
          ),
          DiagramNode(
            id: 3.NodeId,
            nodeType: "dispatch",
            data: %*{"keyword": "setCurrentScene", "config": {"sceneId": "outside"}}
          ),
          DiagramNode(id: 4.NodeId, nodeType: "scene", data: %*{"keyword": "outside"}),
        ],
      ),
      FrameSceneInput(
        id: "child".SceneId,
        name: "Child",
        nodes: @[],
      ),
    ]

    let normalized = normalizeUploadedScenePayload(payload)
    check normalized.len == 2
    check normalized[0].id == "uploaded/main".SceneId
    check normalized[1].id == "uploaded/child".SceneId

    check normalized[0].nodes[0].data["keyword"].getStr() == "uploaded/child"
    check normalized[0].nodes[1].data["config"]["sceneId"].getStr() == "uploaded/child"
    check normalized[0].nodes[2].data["config"]["sceneId"].getStr() == "outside"
    check normalized[0].nodes[3].data["keyword"].getStr() == "outside"
