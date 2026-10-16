## Where a scene may read and write files on the frame.
##
## The frame's assets folder (`assetsPath`, `/srv/assets` by default) is a
## shared resource: uploaded photos, fonts, what other scenes saved. A scene
## the owner wrote gets all of it, as it always did. A scene from the public
## scene store is anyone's code, whichever control plane installed it
## (`InterpretedFrameScene.storeOrigin`, the same provenance bit the
## shell-apps gate in spawn_guard.nim keys on), and it gets a subtree of its
## own, `<assets>/scenes/<sceneId>/`, and nothing else: not other scenes'
## files, not the fonts, not `.frameos/scene_images`, not a path elsewhere on
## disk through `localImage.path`.
##
## `js.assetSandbox` in frame.json picks the rule:
##
##   "store"  (default) store-origin scenes are confined, the owner's are not
##   "scene"  every scene is confined to its own subtree
##   "frame"  nothing is confined (the pre-2026.10.16 behavior)
##
## Every consumer of a scene-supplied path — the JS asset API, `saveAsset`,
## the `data/localImage` app — resolves it through here, so there is one
## containment check (lexical, then against the real path so a planted
## symlink is not a way out) and one answer to "which folder is this scene's".
##
## The browser preview is the author's own machine with the author's own
## files in it: nothing to protect from a scene there, so "store" confines
## nothing in the wasm build. "scene" still does, for whoever asks for it.

import std/[os, strutils]

import frameos/types

const
  AssetSandboxModes* = ["store", "scene", "frame"]
  DefaultAssetSandbox* = "store"
  DefaultAssetsPath = "/srv/assets"

proc sceneIsStoreOrigin*(scene: FrameScene): bool =
  ## The scene came from the public scene store (`origin.storeSceneId` is
  ## set). Compiled/legacy scenes are not InterpretedFrameScene: never store.
  scene != nil and scene of InterpretedFrameScene and InterpretedFrameScene(scene).storeOrigin

proc frameAssetsRoot*(frameConfig: FrameConfig): string =
  ## The frame-wide assets folder, without a trailing slash.
  result = if frameConfig == nil or frameConfig.assetsPath == "": DefaultAssetsPath
           else: frameConfig.assetsPath
  result.removeSuffix('/')
  if result.len == 0:
    result = DefaultAssetsPath

proc assetSandboxMode*(frameConfig: FrameConfig): string =
  if frameConfig == nil or frameConfig.js == nil or frameConfig.js.assetSandbox notin AssetSandboxModes:
    return DefaultAssetSandbox
  frameConfig.js.assetSandbox

proc sceneAssetsConfined*(frameConfig: FrameConfig, scene: FrameScene): bool =
  ## Whether this scene is held to its own subtree of the assets folder.
  case assetSandboxMode(frameConfig)
  of "frame": false
  of "scene": true
  else:
    when defined(frameosWasm):
      false
    else:
      sceneIsStoreOrigin(scene)

proc sceneSubtreeName*(sceneId: string): string =
  ## Scene ids come from the diagram and can carry slashes ("tests/js").
  ## Flatten them so one scene cannot address another's subtree by name.
  for ch in sceneId:
    result.add(if ch in {'a'..'z', 'A'..'Z', '0'..'9', '-', '_'}: ch else: '_')

proc sceneAssetsRoot*(frameConfig: FrameConfig, scene: FrameScene): string =
  ## The folder a scene's relative asset paths resolve against: the frame-wide
  ## folder, or `<assets>/scenes/<sceneId>` when the scene is confined. A
  ## confined scene with no id (should not happen) stays in the frame-wide
  ## folder rather than in a `scenes/` folder every such scene would share.
  result = frameAssetsRoot(frameConfig)
  if sceneAssetsConfined(frameConfig, scene):
    let sceneId = if scene == nil: "" else: scene.id.string
    if sceneId.len > 0:
      result = result / "scenes" / sceneSubtreeName(sceneId)

proc containsPathTraversal*(relPath: string): bool =
  ## True when any path *segment* is "..". A substring test would also reject
  ## innocent names like "backup..old.json".
  for segment in relPath.split({'/', '\\'}):
    if segment == "..":
      return true
  return false

proc isInsideRoot(path, root: string): bool {.inline.} =
  path == root or path.startsWith(root & "/")

proc realPathIsInsideRoot(full, root: string): bool =
  ## Containment once symlinks are followed. Resolves the deepest ancestor
  ## that exists: the target itself may legitimately not exist yet (a write),
  ## but everything leading to it must still be inside the root. Nothing
  ## exists to be a symlink until the root does, so an absent root passes.
  when defined(frameosEmbedded):
    true
  else:
    if not dirExists(root):
      return true
    try:
      let realRoot = expandFilename(root)
      var probe = full
      while not fileExists(probe) and not dirExists(probe):
        let parent = probe.parentDir()
        if parent == probe or parent.len < root.len:
          break
        probe = parent
      if fileExists(probe) or dirExists(probe):
        let realProbe = expandFilename(probe)
        return isInsideRoot(realProbe, realRoot)
      true
    except CatchableError:
      false

proc resolveAssetPathUnder*(root, relPath: string): string =
  ## Absolute path for a scene-supplied relative path inside `root`, or ""
  ## when the path is empty, absolute, or escapes the root lexically or
  ## through a symlink. `root` is as `sceneAssetsRoot` returns it.
  if relPath.len == 0 or relPath.startsWith("/") or relPath.isAbsolute() or
      containsPathTraversal(relPath):
    return ""
  let full = normalizedPath(root / relPath)
  if not isInsideRoot(full, root):
    return ""
  if not realPathIsInsideRoot(full, root):
    return ""
  full

proc resolveSceneAssetPath*(frameConfig: FrameConfig, scene: FrameScene, relPath: string): string =
  ## `resolveAssetPathUnder` against the scene's own root.
  resolveAssetPathUnder(sceneAssetsRoot(frameConfig, scene), relPath)

proc resolveSceneLocalPath*(frameConfig: FrameConfig, scene: FrameScene, path: string):
    tuple[path: string, refusal: string] =
  ## A path a scene names on the frame's disk (the `data/localImage` app's
  ## `path` field: a file or a folder, absolute or relative). For a scene
  ## that is not confined the path is taken as written, an empty path meaning
  ## the frame-wide assets folder, as before. For a confined scene an empty
  ## or relative path resolves inside the scene's subtree, an absolute path
  ## is accepted only when it already points into that subtree, and anything
  ## else comes back with a refusal naming the folder the scene may use.
  let root = sceneAssetsRoot(frameConfig, scene)
  if not sceneAssetsConfined(frameConfig, scene):
    let open = if path.len == 0: root else: path
    return (open, "")
  var relative = path.strip()
  if relative.isAbsolute() or relative.startsWith("/"):
    let full = normalizedPath(relative)
    if not isInsideRoot(full, root):
      return ("", "this scene comes from the scene store and may only read its own assets folder, " &
        root & ": " & path)
    relative = if full == root: "" else: full[(root.len + 1)..^1]
  if relative.len == 0:
    return (root, "")
  let full = resolveAssetPathUnder(root, relative)
  if full.len > 0:
    return (full, "")
  ("", "this scene comes from the scene store and may only read its own assets folder, " &
    root & ": " & path)
