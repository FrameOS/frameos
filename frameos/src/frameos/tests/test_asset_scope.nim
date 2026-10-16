## Which folder a scene may touch (asset_scope.nim): the owner's scenes share
## the frame's assets folder, a store-origin scene gets a subtree of its own.

import std/[json, os, strutils, times, unittest]

import frameos/asset_scope
import frameos/types

proc config(assetsPath: string, sandbox = ""): FrameConfig =
  result = FrameConfig(width: 8, height: 6, assetsPath: assetsPath)
  if sandbox.len > 0:
    result.js = JsRuntimeConfig(assetSandbox: sandbox)

proc storeScene(): FrameScene =
  InterpretedFrameScene(id: "store/photos".SceneId, storeOrigin: true)

proc ownScene(): FrameScene =
  InterpretedFrameScene(id: "own".SceneId, storeOrigin: false)

suite "asset scope":
  var root = ""

  setup:
    root = getTempDir() / ("frameos-asset-scope-" & $epochTime().int64)
    createDir(root)

  teardown:
    removeDir(root)

  test "the default confines store-origin scenes and nothing else":
    # No `js` block at all (an older frame.json, a backend-written one): the
    # default applies.
    let plain = config(root)
    check assetSandboxMode(plain) == "store"
    check sceneAssetsConfined(plain, storeScene())
    check not sceneAssetsConfined(plain, ownScene())
    # Compiled/legacy scenes and no scene at all: never confined.
    check not sceneAssetsConfined(plain, FrameScene(id: "legacy".SceneId))
    check not sceneAssetsConfined(plain, nil)
    check sceneAssetsRoot(plain, storeScene()) == root / "scenes" / "store_photos"
    check sceneAssetsRoot(plain, ownScene()) == root

  test "\"scene\" confines every scene, \"frame\" none":
    check sceneAssetsConfined(config(root, "scene"), ownScene())
    check sceneAssetsRoot(config(root, "scene"), ownScene()) == root / "scenes" / "own"
    check not sceneAssetsConfined(config(root, "frame"), storeScene())
    check sceneAssetsRoot(config(root, "frame"), storeScene()) == root
    # An unknown value is not a way to switch the sandbox off.
    check assetSandboxMode(config(root, "bogus")) == "store"
    check sceneAssetsConfined(config(root, "bogus"), storeScene())

  test "the frame-wide root defaults and drops its trailing slash":
    check frameAssetsRoot(nil) == "/srv/assets"
    check frameAssetsRoot(FrameConfig()) == "/srv/assets"
    check frameAssetsRoot(FrameConfig(assetsPath: "/mnt/photos/")) == "/mnt/photos"

  test "relative asset paths stay inside the scene's root":
    let cfg = config(root)
    let scene = storeScene()
    let sceneRoot = root / "scenes" / "store_photos"
    check resolveSceneAssetPath(cfg, scene, "cache/a.json") == sceneRoot / "cache" / "a.json"
    check resolveSceneAssetPath(cfg, scene, "backup..old.json") == sceneRoot / "backup..old.json"
    check resolveSceneAssetPath(cfg, scene, "") == ""
    check resolveSceneAssetPath(cfg, scene, "../shared.txt") == ""
    check resolveSceneAssetPath(cfg, scene, "a/../../shared.txt") == ""
    check resolveSceneAssetPath(cfg, scene, "/etc/passwd") == ""
    check resolveSceneAssetPath(cfg, scene, root / "shared.txt") == ""
    # The owner's scene resolves against the frame-wide folder.
    check resolveSceneAssetPath(cfg, ownScene(), "shared.txt") == root / "shared.txt"

  test "a symlink planted inside the subtree is not a way out":
    let cfg = config(root)
    let scene = storeScene()
    let sceneRoot = root / "scenes" / "store_photos"
    createDir(sceneRoot)
    let outside = root / "outside"
    createDir(outside)
    writeFile(outside / "secret.txt", "top secret")
    createSymlink(outside, sceneRoot / "escape")
    check resolveSceneAssetPath(cfg, scene, "escape/secret.txt") == ""
    check resolveSceneAssetPath(cfg, scene, "escape/new.txt") == ""

  test "a local path for a store scene is held to its subtree":
    let cfg = config(root)
    let scene = storeScene()
    let sceneRoot = root / "scenes" / "store_photos"
    # Empty and relative resolve inside the subtree.
    check resolveSceneLocalPath(cfg, scene, "") == (sceneRoot, "")
    check resolveSceneLocalPath(cfg, scene, "photos") == (sceneRoot / "photos", "")
    check resolveSceneLocalPath(cfg, scene, "photos/one.jpg") == (sceneRoot / "photos" / "one.jpg", "")
    # Absolute is fine when it already points into the subtree...
    check resolveSceneLocalPath(cfg, scene, sceneRoot) == (sceneRoot, "")
    check resolveSceneLocalPath(cfg, scene, sceneRoot & "/") == (sceneRoot, "")
    check resolveSceneLocalPath(cfg, scene, sceneRoot / "photos") == (sceneRoot / "photos", "")
    # ...and refused anywhere else, naming the folder the scene may use.
    for path in [root, root / "photos", "/etc", "/srv/assets", "../..", "photos/../../shared"]:
      let (resolved, refusal) = resolveSceneLocalPath(cfg, scene, path)
      check resolved == ""
      check refusal.contains(sceneRoot)
      check refusal.contains("scene store")

  test "a local path for the owner's scene is taken as written":
    let cfg = config(root)
    check resolveSceneLocalPath(cfg, ownScene(), "") == (root, "")
    check resolveSceneLocalPath(cfg, ownScene(), "/media/usb/photos") == ("/media/usb/photos", "")
    check resolveSceneLocalPath(cfg, FrameScene(id: "legacy".SceneId), "/mnt/x") == ("/mnt/x", "")
    # `frame` mode: a store scene too.
    check resolveSceneLocalPath(config(root, "frame"), storeScene(), "/media/usb") == ("/media/usb", "")

  test "scene ids are flattened to one folder name":
    check sceneSubtreeName("tests/js") == "tests_js"
    check sceneSubtreeName("../x") == "___x"
    check sceneSubtreeName("Scene-1_a") == "Scene-1_a"
