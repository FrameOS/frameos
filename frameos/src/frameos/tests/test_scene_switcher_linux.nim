import std/[json, os, times]
import pixie
import ../scenes
import ../scene_switcher_linux
import ../types
import ../events_gen
import system/sceneSwitcher/scene as sceneSwitcher

# What the scene switcher shows on a Linux frame (docs/scene-switcher.md):
# the scene list `setCurrentScene {direction}` walks, with names, and each
# scene's last snapshot fitted to its tile.

block the_list_is_the_frames_scene_order_with_names:
  let payload = %*{"scenes": [
    {"id": "tests/switcher/b", "name": "Bravo", "settings": {"execution": "interpreted"},
     "nodes": [], "edges": [], "fields": []},
    {"id": "tests/switcher/a", "name": "Alpha", "settings": {"execution": "interpreted"},
     "nodes": [], "edges": [], "fields": []},
  ]}
  discard updateUploadedScenesFromPayload(payload, persistPayload = false)
  let listed = linuxSceneListing()
  doAssert listed.len >= 2, $listed
  # The pushed set's order, not the alphabet's.
  doAssert listed[0] == SwitcherEntry(id: "tests/switcher/b", name: "Bravo"), $listed
  doAssert listed[1] == SwitcherEntry(id: "tests/switcher/a", name: "Alpha"), $listed
  for entry in listed:
    doAssert entry.id != SceneSwitcherId and entry.id != "system/index", "no system scene is a tile"
  installSceneSwitcherHooks()
  doAssert not sceneSwitcherListing.isNil and not sceneSwitcherThumbnail.isNil

block a_snapshot_is_fitted_to_the_tile_and_kept_until_it_changes:
  let assets = getTempDir() / "frameos-switcher-thumbnails-" & $epochTime().int
  let config = FrameConfig(width: 800, height: 480, assetsPath: assets)
  doAssert linuxSceneThumbnail(config, "tests/switcher/a", 200, 120).isNil, "no snapshot yet: no picture"
  # A wide red snapshot with a blue middle: covered, the middle stays.
  let snapshot = newImage(800, 480)
  snapshot.fill(rgba(255, 0, 0, 255))
  snapshot.fillPath(block:
    let p = newPath()
    p.rect(300, 140, 200, 200)
    p, rgba(0, 0, 255, 255))
  let path = sceneImagePath(assets, "tests/switcher/a")
  createDir(path.parentDir)
  snapshot.writeFile(path)
  let first = linuxSceneThumbnail(config, "tests/switcher/a", 200, 200)
  doAssert not first.isNil and first.width == 200 and first.height == 200
  doAssert first[100, 100].b > 200 and first[100, 100].r < 60, "the middle of the snapshot: " & $first[100, 100]
  doAssert first[2, 100].r > 200, "the sides are cropped, not squeezed: " & $first[2, 100]
  doAssert cast[pointer](linuxSceneThumbnail(config, "tests/switcher/a", 200, 200)) == cast[pointer](first),
    "kept while the file is the same"
  # A new snapshot (the runner rewrites it every minute at most): a new picture.
  snapshot.fill(rgba(0, 255, 0, 255))
  snapshot.writeFile(path)
  setLastModificationTime(path, fromUnix(getTime().toUnix() + 5))
  let second = linuxSceneThumbnail(config, "tests/switcher/a", 200, 200)
  doAssert not second.isNil and second[100, 100].g > 200, "the new snapshot: " & $second[100, 100]
  removeDir(assets)

block cover_fit_keeps_the_aspect:
  let wide = newImage(1920, 1080)
  wide.fill(rgba(10, 20, 30, 255))
  let fitted = coverFit(wide, 160, 120)
  doAssert fitted.width == 160 and fitted.height == 120
  doAssert fitted[80, 60] == rgba(10, 20, 30, 255).rgbx

echo "scene switcher on Linux: ok"
