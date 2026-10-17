## Which folder a scene may touch (asset_scope.nim): the scene's own
## `settings.assetAccess` decides, under the frame's `js.assetSandbox` ceiling.

import std/[os, strutils, times, unittest]

import frameos/asset_scope
import frameos/types

proc config(assetsPath: string, sandbox = ""): FrameConfig =
  result = FrameConfig(width: 8, height: 6, assetsPath: assetsPath)
  if sandbox.len > 0:
    result.js = JsRuntimeConfig(assetSandbox: sandbox)

proc scene(access: string, id = "photos/one", storeOrigin = false): FrameScene =
  InterpretedFrameScene(id: id.SceneId, assetAccess: access, storeOrigin: storeOrigin)

suite "asset scope":
  var root = ""

  setup:
    root = getTempDir() / ("frameos-asset-scope-" & $epochTime().int64)
    createDir(root)

  teardown:
    removeDir(root)

  test "the scene's setting decides on a default frame":
    # No `js` block at all (an older frame.json, a backend-written one).
    let plain = config(root)
    check assetSandboxMode(plain) == "frame"
    check sceneAssetAccess(plain, scene("")) == "auto"
    check sceneAssetAccess(plain, scene("auto")) == "auto"
    check sceneAssetAccess(plain, scene("cache-home-only")) == "cache-home-only"
    check sceneAssetAccess(plain, scene("all-assets")) == "all-assets"
    check sceneAssetAccess(plain, scene("all-files")) == "all-files"
    check sceneAssetAccess(plain, scene(" all-assets ")) == "all-assets"
    # A value this runtime does not know (a newer editor's) runs as "auto".
    check sceneAssetAccess(plain, scene("bogus")) == "auto"
    check sceneAssetsConfined(plain, scene("cache-home-only"))
    for access in ["", "auto", "all-assets", "all-files", "bogus"]:
      check not sceneAssetsConfined(plain, scene(access))
      check sceneAssetsRoot(plain, scene(access)) == root
    check sceneAssetsRoot(plain, scene("cache-home-only")) == root / "scenes" / "photos_one"

  test "provenance confines nothing":
    # A scene from the store with no setting runs as the owner's would.
    let plain = config(root)
    check sceneAssetAccess(plain, scene("", storeOrigin = true)) == "auto"
    check not sceneAssetsConfined(plain, scene("", storeOrigin = true))
    check sceneAssetsRoot(plain, scene("", storeOrigin = true)) == root

  test "compiled scenes and no scene run as auto":
    let plain = config(root)
    check sceneAssetAccess(plain, FrameScene(id: "legacy".SceneId)) == "auto"
    check sceneAssetAccess(plain, nil) == "auto"
    check sceneAssetAccess(nil, scene("all-assets")) == "all-assets"
    check not sceneAssetsConfined(plain, nil)
    check sceneAssetsRoot(nil, nil) == "/srv/assets"

  test "a \"scene\" frame confines every scene whatever it asks for":
    let strict = config(root, "scene")
    check assetSandboxMode(strict) == "scene"
    for access in ["", "auto", "cache-home-only", "all-assets", "all-files", "bogus"]:
      check sceneAssetAccess(strict, scene(access)) == "cache-home-only"
      check sceneAssetsConfined(strict, scene(access))
      check sceneAssetsRoot(strict, scene(access)) == root / "scenes" / "photos_one"
    check sceneAssetsConfined(strict, FrameScene(id: "legacy".SceneId))
    check sceneAssetsRoot(strict, FrameScene(id: "legacy".SceneId)) == root / "scenes" / "legacy"
    # A confined scene with no id stays in the frame-wide folder.
    check sceneAssetsRoot(strict, nil) == root

  test "\"frame\" and unknown frame modes leave it to the scene":
    check assetSandboxMode(config(root, "frame")) == "frame"
    check assetSandboxMode(config(root, "bogus")) == "frame"
    check assetSandboxMode(config(root, "store")) == "frame"
    check not sceneAssetsConfined(config(root, "bogus"), scene("all-files"))
    check sceneAssetsConfined(config(root, "frame"), scene("cache-home-only"))

  test "the frame-wide root defaults and drops its trailing slash":
    check frameAssetsRoot(nil) == "/srv/assets"
    check frameAssetsRoot(FrameConfig()) == "/srv/assets"
    check frameAssetsRoot(FrameConfig(assetsPath: "/mnt/photos/")) == "/mnt/photos"

  test "relative asset paths stay inside the scene's root":
    let cfg = config(root)
    let home = scene("cache-home-only")
    let sceneRoot = root / "scenes" / "photos_one"
    check resolveSceneAssetPath(cfg, home, "cache/a.json") == sceneRoot / "cache" / "a.json"
    check resolveSceneAssetPath(cfg, home, "backup..old.json") == sceneRoot / "backup..old.json"
    check resolveSceneAssetPath(cfg, home, "") == ""
    check resolveSceneAssetPath(cfg, home, "../shared.txt") == ""
    check resolveSceneAssetPath(cfg, home, "a/../../shared.txt") == ""
    check resolveSceneAssetPath(cfg, home, "/etc/passwd") == ""
    check resolveSceneAssetPath(cfg, home, root / "shared.txt") == ""
    # Every other value resolves against the frame-wide folder, and is held
    # to it the same way.
    for access in ["", "all-assets", "all-files"]:
      check resolveSceneAssetPath(cfg, scene(access), "shared.txt") == root / "shared.txt"
      check resolveSceneAssetPath(cfg, scene(access), "../outside.txt") == ""
      check resolveSceneAssetPath(cfg, scene(access), "/etc/passwd") == ""

  test "a symlink planted inside the subtree is not a way out":
    let cfg = config(root)
    let home = scene("cache-home-only")
    let sceneRoot = root / "scenes" / "photos_one"
    createDir(sceneRoot)
    let outside = root / "outside"
    createDir(outside)
    writeFile(outside / "secret.txt", "top secret")
    createSymlink(outside, sceneRoot / "escape")
    check resolveSceneAssetPath(cfg, home, "escape/secret.txt") == ""
    check resolveSceneAssetPath(cfg, home, "escape/new.txt") == ""
    # The same link as an absolute localImage path inside the subtree.
    let (resolved, refusal) = resolveSceneLocalPath(cfg, home, sceneRoot / "escape" / "secret.txt")
    check resolved == ""
    check refusal.len > 0

  test "a local path for a \"cache-home-only\" scene is held to its subtree":
    let cfg = config(root)
    let home = scene("cache-home-only")
    let sceneRoot = root / "scenes" / "photos_one"
    # Empty and relative resolve inside the subtree.
    check resolveSceneLocalPath(cfg, home, "") == (sceneRoot, "")
    check resolveSceneLocalPath(cfg, home, "photos") == (sceneRoot / "photos", "")
    check resolveSceneLocalPath(cfg, home, "photos/one.jpg") == (sceneRoot / "photos" / "one.jpg", "")
    # Absolute is fine when it already points into the subtree...
    check resolveSceneLocalPath(cfg, home, sceneRoot) == (sceneRoot, "")
    check resolveSceneLocalPath(cfg, home, sceneRoot & "/") == (sceneRoot, "")
    check resolveSceneLocalPath(cfg, home, sceneRoot / "photos") == (sceneRoot / "photos", "")
    # ...and refused anywhere else, naming the setting and the folder.
    for path in [root, root / "photos", "/etc", "/srv/assets", "../..", "photos/../../shared"]:
      let (resolved, refusal) = resolveSceneLocalPath(cfg, home, path)
      check resolved == ""
      check refusal.contains(sceneRoot)
      check refusal.contains("\"cache-home-only\"")
      check not refusal.contains("store")

  test "a local path for an \"all-assets\" scene is held to the assets folder":
    let cfg = config(root)
    let assets = scene("all-assets")
    check resolveSceneLocalPath(cfg, assets, "") == (root, "")
    check resolveSceneLocalPath(cfg, assets, "photos") == (root / "photos", "")
    check resolveSceneLocalPath(cfg, assets, root) == (root, "")
    check resolveSceneLocalPath(cfg, assets, root / "photos" / "one.jpg") == (root / "photos" / "one.jpg", "")
    check resolveSceneLocalPath(cfg, assets, root / "scenes" / "other") == (root / "scenes" / "other", "")
    for path in ["/etc", "/media/usb/photos", root & "-sibling", root / ".." / "x", "../..", "photos/../../x"]:
      let (resolved, refusal) = resolveSceneLocalPath(cfg, assets, path)
      check resolved == ""
      check refusal.contains("\"all-assets\"")
      check refusal.contains(root)
    # A symlink inside the assets folder pointing out of it.
    let outside = getTempDir() / ("frameos-asset-scope-out-" & $epochTime().int64)
    createDir(outside)
    defer: removeDir(outside)
    createSymlink(outside, root / "escape")
    check resolveSceneLocalPath(cfg, assets, "escape").path == ""
    check resolveSceneLocalPath(cfg, assets, root / "escape").path == ""

  test "a local path for an \"auto\" or \"all-files\" scene is taken as written":
    let cfg = config(root)
    for access in ["", "auto", "all-files", "bogus"]:
      check resolveSceneLocalPath(cfg, scene(access), "") == (root, "")
      check resolveSceneLocalPath(cfg, scene(access), "/media/usb/photos") == ("/media/usb/photos", "")
    check resolveSceneLocalPath(cfg, FrameScene(id: "legacy".SceneId), "/mnt/x") == ("/mnt/x", "")
    # A store scene with no setting too.
    check resolveSceneLocalPath(cfg, scene("", storeOrigin = true), "/media/usb") == ("/media/usb", "")
    # A "scene" frame holds even "all-files" to its subtree.
    let (resolved, refusal) = resolveSceneLocalPath(config(root, "scene"), scene("all-files"), "/media/usb")
    check resolved == ""
    check refusal.contains(root / "scenes" / "photos_one")

  test "scene ids are flattened to one folder name":
    check sceneSubtreeName("tests/js") == "tests_js"
    check sceneSubtreeName("../x") == "___x"
    check sceneSubtreeName("Scene-1_a") == "Scene-1_a"

  test "normalizedAssetAccess":
    for value in AssetAccessValues:
      check normalizedAssetAccess(value) == value
    check normalizedAssetAccess("") == "auto"
    check normalizedAssetAccess("ALL-FILES") == "auto"
