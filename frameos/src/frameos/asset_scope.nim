## Where a scene may read and write files on the frame.
##
## The frame's assets folder (`assetsPath`, `/srv/assets` by default) is a
## shared resource: uploaded photos, fonts, what other scenes saved. How much
## of the disk a scene may touch is part of the scene itself, the
## `settings.assetAccess` key in scenes.json, so it travels with every copy
## of the scene and anyone can read it in the JSON:
##
##   "auto"             (default, also absent or unknown) nothing confined:
##                      the frame-wide folder for the JS asset API and
##                      `saveAsset`, `localImage.path` as written
##   "cache-home-only"  the scene's own subtree, `<assets>/scenes/<sceneId>/`,
##                      for all three and nothing else
##   "all-assets"       the frame-wide folder; `localImage` may not leave it
##   "all-files"        as "auto", said out loud: `localImage` reads any path
##
## The control planes show a scene's access as tags (the declared value, or
## what they detect in the scene's content under "auto"), and installing the
## scene is the approval. This module enforces the explicit values only; an
## "auto" scene runs as it always did. Holding "auto" to what the control
## planes detected is the next step.
##
## `js.assetSandbox` in frame.json is the frame owner's ceiling: "frame"
## (default) leaves each scene to its own setting, "scene" confines every
## scene to its subtree whatever it asks for.
##
## Every consumer of a scene-supplied path — the JS asset API, `saveAsset`,
## the `data/localImage` app — resolves it through here, so there is one
## containment check (lexical, then against the real path so a planted
## symlink is not a way out) and one answer to "which folder is this scene's".

import std/[os, strutils]

import frameos/types

const
  AssetSandboxModes* = ["frame", "scene"]
  DefaultAssetSandbox* = "frame"
  AssetAccessValues* = ["auto", "cache-home-only", "all-assets", "all-files"]
  DefaultAssetAccess* = "auto"
  DefaultAssetsPath = "/srv/assets"

proc frameAssetsRoot*(frameConfig: FrameConfig): string =
  ## The frame-wide assets folder, without a trailing slash.
  result = if frameConfig == nil or frameConfig.assetsPath == "": DefaultAssetsPath
           else: frameConfig.assetsPath
  result.removeSuffix('/')
  if result.len == 0:
    result = DefaultAssetsPath

proc assetSandboxMode*(frameConfig: FrameConfig): string =
  ## The frame's `js.assetSandbox`: "frame" or "scene".
  if frameConfig == nil or frameConfig.js == nil or frameConfig.js.assetSandbox notin AssetSandboxModes:
    return DefaultAssetSandbox
  frameConfig.js.assetSandbox

proc normalizedAssetAccess*(value: string): string =
  ## A scene's `settings.assetAccess` as one of AssetAccessValues; anything
  ## else (absent, empty, a value from a newer editor) is "auto".
  let trimmed = value.strip()
  if trimmed in AssetAccessValues: trimmed else: DefaultAssetAccess

proc sceneAssetAccess*(frameConfig: FrameConfig, scene: FrameScene): string =
  ## The access this scene runs with: its declared `settings.assetAccess`,
  ## or "cache-home-only" for every scene when the frame says "scene".
  ## Compiled/legacy scenes carry no setting: "auto".
  if assetSandboxMode(frameConfig) == "scene":
    return "cache-home-only"
  if scene == nil or not (scene of InterpretedFrameScene):
    return DefaultAssetAccess
  normalizedAssetAccess(InterpretedFrameScene(scene).assetAccess)

proc sceneAssetsConfined*(frameConfig: FrameConfig, scene: FrameScene): bool =
  ## Whether this scene is held to its own subtree of the assets folder.
  sceneAssetAccess(frameConfig, scene) == "cache-home-only"

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
  ## `path` field: a file or a folder, absolute or relative).
  ##
  ## "auto" and "all-files" take the path as written, an empty path meaning
  ## the frame-wide assets folder, as before. "cache-home-only" and
  ## "all-assets" hold it to the scene's root (its subtree, or the whole
  ## assets folder): an empty or relative path resolves inside that root, an
  ## absolute path is accepted only when it already points into it, and
  ## anything else comes back with a refusal naming the setting and the
  ## folder the scene may read.
  let access = sceneAssetAccess(frameConfig, scene)
  let root = sceneAssetsRoot(frameConfig, scene)
  if access notin ["cache-home-only", "all-assets"]:
    let open = if path.len == 0: root else: path
    return (open, "")
  let refusal =
    if access == "cache-home-only":
      "this scene's asset access is \"cache-home-only\": it may only read " & root & ": " & path
    else:
      "this scene's asset access is \"all-assets\": it may only read the assets folder " & root & ": " & path
  var relative = path.strip()
  if relative.isAbsolute() or relative.startsWith("/"):
    let full = normalizedPath(relative)
    if not isInsideRoot(full, root):
      return ("", refusal)
    relative = if full == root: "" else: full[(root.len + 1)..^1]
  if relative.len == 0:
    return (root, "")
  let full = resolveAssetPathUnder(root, relative)
  if full.len > 0:
    return (full, "")
  ("", refusal)
