import std/[json, os, strutils, times]
import pixie
import ../scenes
import ../scene_switcher_linux
import ../scene_snapshot_writer
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
    {"id": "tests/switcher/a", "name": "Alpha", "settings": {"execution": "interpreted", "icon": "M12 2L2 22h20z",
      "category": "Art & galleries", "opens": "pdf"},
     "nodes": [], "edges": [], "fields": []},
  ]}
  discard updateUploadedScenesFromPayload(payload, persistPayload = false)
  let listed = linuxSceneListing()
  doAssert listed.len >= 2, $listed
  # The pushed set's order, not the alphabet's.
  doAssert listed[0] == SwitcherEntry(id: "tests/switcher/b", name: "Bravo"), $listed
  # With its icon and category (docs/scene-icons.md) and the file types it
  # opens (docs/scene-guide.md "Opening files") where it has them.
  doAssert listed[1] == SwitcherEntry(id: "tests/switcher/a", name: "Alpha", icon: "M12 2L2 22h20z",
    category: "Art & galleries", opens: "pdf"), $listed
  doAssert listingItem(listed[1]){"opens"}.getStr() == "pdf"
  doAssert listingItem(listed[0]){"opens"}.isNil
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

block the_snapshot_writer_leaves_the_small_copy_the_switcher_reads:
  # docs/scene-switcher.md "Pictures": the snapshot writer
  # (scene_snapshot_writer.nim) puts a small copy beside every snapshot, and
  # the switcher reads that, not the PNG.
  let assets = getTempDir() / "frameos-switcher-seeded-" & $epochTime().int
  let config = FrameConfig(width: 720, height: 720, assetsPath: assets)
  let snapshot = newImage(720, 720)
  snapshot.fill(rgba(0, 0, 255, 255))
  let path = sceneImagePath(assets, "tests/switcher/c")
  doAssert writeSceneSnapshot(assets, "tests/switcher/c", snapshot) > 0
  doAssert fileExists(path)
  let thumb = sceneThumbPath(assets, "tests/switcher/c")
  doAssert fileExists(thumb) and thumb.endsWith(".qoi") and "scene_thumbs" in thumb, thumb
  doAssert "scene_images" notin thumb, "never among the snapshots: " & thumb
  let small = decodeImage(readFile(thumb))
  doAssert small.width == 360 and small.height == 360, $small.width
  # The small copy, not the snapshot (made red to tell them apart, older than
  # the copy, so the copy stands).
  let red = newImage(720, 720)
  red.fill(rgba(255, 0, 0, 255))
  red.writeFile(path)
  setLastModificationTime(path, fromUnix(getTime().toUnix() - 10))
  let fromCopy = linuxSceneThumbnail(config, "tests/switcher/c", 100, 100)
  doAssert not fromCopy.isNil and fromCopy[50, 50].b > 200, "the small copy: " & $fromCopy[50, 50]
  # A snapshot newer than the copy (an older runtime's, a control plane's):
  # decoded after all.
  forgetSceneThumbnails()
  setLastModificationTime(path, fromUnix(getTime().toUnix() + 10))
  let newer = linuxSceneThumbnail(config, "tests/switcher/c", 100, 100)
  doAssert not newer.isNil and newer[50, 50].r > 200, "the newer snapshot: " & $newer[50, 50]
  removeDir(assets)

block the_runner_queues_its_snapshot_and_the_writer_writes_it:
  # scene_snapshot_writer.nim: the runner hands over the last picture's
  # pixels and goes on; the writer thread writes the snapshot and its copy.
  let assets = getTempDir() / "frameos-switcher-writer-" & $epochTime().int
  let picture = newImage(64, 48)
  picture.fill(rgba(0, 200, 0, 255))
  setLastImage(picture)
  doAssert queueSceneSnapshot(assets, "tests/switcher/queued")
  # A newer picture of the scene waits in the older one's place, if it still
  # waits; either way the last one is what ends up on disk.
  picture.fill(rgba(200, 0, 0, 255))
  setLastImage(picture)
  doAssert queueSceneSnapshot(assets, "tests/switcher/queued")
  waitSceneSnapshots()
  doAssert not snapshotPending("tests/switcher/queued")
  let written = decodeImage(readFile(sceneImagePath(assets, "tests/switcher/queued")))
  doAssert written.width == 64 and written.height == 48
  doAssert written[10, 10].r > 150 and written[10, 10].g < 50, "the newer picture: " & $written[10, 10]
  doAssert fileExists(sceneThumbPath(assets, "tests/switcher/queued"))
  removeDir(assets)

block a_render_spends_a_budget_on_decodes_and_asks_for_another:
  let assets = getTempDir() / "frameos-switcher-budget-" & $epochTime().int
  let config = FrameConfig(width: 720, height: 720, assetsPath: assets)
  let snapshot = newImage(720, 720)
  snapshot.fill(rgba(0, 255, 0, 255))
  for i in 0 ..< 3:
    let path = sceneImagePath(assets, "tests/switcher/budget" & $i)
    createDir(path.parentDir)
    snapshot.writeFile(path)
  forgetSceneThumbnails()
  # A pass whose budget is spent (it began long ago): no decode, and the
  # pass says another render is due.
  discard linuxThumbnailPass(true)
  sleep(150)
  doAssert linuxSceneThumbnail(config, "tests/switcher/budget0", 100, 100).isNil
  doAssert linuxThumbnailPass(false)
  # The next pass has time: the picture.
  discard linuxThumbnailPass(true)
  doAssert not linuxSceneThumbnail(config, "tests/switcher/budget0", 100, 100).isNil
  doAssert not linuxThumbnailPass(false)
  # Outside a pass (no budget): every picture.
  doAssert not linuxSceneThumbnail(config, "tests/switcher/budget1", 100, 100).isNil
  removeDir(assets)

block cover_fit_keeps_the_aspect:
  let wide = newImage(1920, 1080)
  wide.fill(rgba(10, 20, 30, 255))
  let fitted = coverFit(wide, 160, 120)
  doAssert fitted.width == 160 and fitted.height == 120
  doAssert fitted[80, 60] == rgba(10, 20, 30, 255).rgbx

echo "scene switcher on Linux: ok"
