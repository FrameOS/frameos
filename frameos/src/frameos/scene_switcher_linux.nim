## What the scene switcher (system/sceneSwitcher/scene.nim) shows on a Linux
## frame: the scene list the dispatcher walks for `setCurrentScene
## {direction}` (`sceneOrderSnapshot`) with each scene's name, and each
## scene's last picture — the snapshot the runner writes on every switch and
## at most once a minute after (`render:sceneImage:saved`, scenes.nim
## `sceneImagePath`), fitted to its tile and kept until the file changes.
##
## Fast on a Pi Zero (docs/scene-switcher.md "Pictures"): a 720x720 PNG is a
## few hundred ms to decode there, and opening the switcher decoded every
## scene whose snapshot had changed since it last showed. So the picture
## kept per scene is a small one (`ThumbnailSourceSide`): the runner hands
## over the snapshot it just wrote while the pixels are in memory
## (`noteSceneSnapshot`), and writes that small copy beside it
## (`.frameos/scene_thumbs/`, QOI: a few ms to write and to read), which is
## what a restart reads instead of the snapshot. A switcher render decodes for `PassBudgetMs` at
## most and draws the rest as numbers (or their older picture), then renders
## again (`linuxThumbnailPass`), so it is up at once and fills in.
##
## Runner thread only: the kept pictures are its own (a threadvar), and the
## scene registry is read under its lock.

import std/[monotimes, os, options, tables, times]
import pixie
import frameos/types
import frameos/interpreter
import frameos/scenes
import system/sceneSwitcher/scene as sceneSwitcher

const
  ThumbnailSourceSide* = 320
    ## A kept picture is halved while its shorter side stays at least this:
    ## a 720x720 HyperPixel's snapshot is kept at 360x360, as large as its
    ## tiles get with a few scenes, a quarter of the pixels to fit.
  PassBudgetMs = 120
    ## What one switcher render spends decoding pictures before it draws the
    ## rest without and asks for another render.

type KeptThumbnail = object
  key: string     ## the snapshot file it is of: its time and size
  source: Image   ## that snapshot halved down to ThumbnailSourceSide
  fitted: Image   ## and fitted to the tile it was last asked for
  fittedW, fittedH: int

var
  keptThumbnails {.threadvar.}: Table[string, KeptThumbnail]
  passStarted {.threadvar.}: MonoTime
  passPending {.threadvar.}: bool
  passActive {.threadvar.}: bool ## within a switcher render; outside one, no budget

proc linuxSceneListing*(): seq[SwitcherEntry] {.nimcall, gcsafe.} =
  ## The frame's scenes in the control plane's order (a pushed set first,
  ## then the deployed scenes it does not name), each with its name.
  {.cast(gcsafe).}:
    for sceneId in sceneOrderSnapshot():
      if not hasExportedScene(sceneId):
        continue
      result.add SwitcherEntry(id: sceneId.string, name: getSceneDisplayName(sceneId).get(""))

proc coverFit*(source: Image, width, height: int): Image =
  ## `source` scaled to cover `width` x `height` and cropped to its middle:
  ## halved while it is twice the size or more (pixie's box filter), then
  ## drawn the rest of the way.
  var image = source
  while image.width >= width * 2 and image.height >= height * 2 and image.width >= 2 and image.height >= 2:
    image = image.minifyBy2()
  result = newImage(width, height)
  let scale = max(width.float32 / image.width.float32, height.float32 / image.height.float32)
  let offset = vec2((width.float32 - image.width.float32 * scale) / 2,
    (height.float32 - image.height.float32 * scale) / 2)
  result.draw(image, translate(offset) * scale(vec2(scale, scale)))

proc thumbnailSource*(image: Image): Image =
  ## `image` halved while its shorter side stays ThumbnailSourceSide or more:
  ## what is kept of a snapshot. The image itself when it is that small.
  result = image
  while min(result.width, result.height) >= 2 * ThumbnailSourceSide:
    result = result.minifyBy2()

proc sceneThumbPath*(assetsPath, sceneId: string): string =
  ## The small copy of a scene's snapshot: beside `scene_images`, never in
  ## it, so nothing that lists or serves snapshots sees it.
  let snapshot = sceneImagePath(assetsPath, sceneId)
  snapshot.parentDir.parentDir / "scene_thumbs" / snapshot.extractFilename.changeFileExt("qoi")

proc snapshotKey(path: string): string =
  $getLastModificationTime(path).toUnixFloat() & ":" & $getFileSize(path)

proc forgetSceneThumbnails*() =
  ## Every kept picture let go, as at a restart (tests, benchmarks).
  keptThumbnails.clear()

proc noteSceneSnapshot*(assetsPath, sceneId: string, image: Image) =
  ## The runner wrote `sceneId`'s snapshot from `image`, which it still has
  ## in memory: the switcher's picture of it is made from that, with no
  ## decode, and its small copy written for after a restart. Called right
  ## after the write, so the key is the file's.
  if image.isNil:
    return
  try:
    let path = sceneImagePath(assetsPath, sceneId)
    if not fileExists(path):
      return
    let source = thumbnailSource(image)
    keptThumbnails[sceneId] = KeptThumbnail(key: snapshotKey(path), source: source)
    let thumb = sceneThumbPath(assetsPath, sceneId)
    try:
      createDir(thumb.parentDir)
      writeFile(thumb, encodeImage(source, QoiFormat))
    except CatchableError:
      discard # a read-only disk: the snapshot is decoded after a restart
  except CatchableError:
    keptThumbnails.del(sceneId)

proc loadSource(assetsPath, sceneId, path: string): Image =
  ## A snapshot's small copy from the disk: the one beside it when that is
  ## no older, else the snapshot itself, halved (one written by an older
  ## runtime, or put there by a control plane).
  let thumb = sceneThumbPath(assetsPath, sceneId)
  if fileExists(thumb) and getLastModificationTime(thumb) >= getLastModificationTime(path):
    try:
      return decodeImage(readFile(thumb))
    except CatchableError:
      discard
  thumbnailSource(decodeImage(readFile(path)))

proc linuxThumbnailPass*(start: bool): bool {.nimcall, gcsafe.} =
  ## A switcher render begins (`start`): its decode budget starts. Ended
  ## (not `start`): whether it left a picture out to keep within the budget,
  ## and so wants another render.
  {.cast(gcsafe).}:
    if start:
      passStarted = getMonoTime()
      passPending = false
      passActive = true
    else:
      result = passPending
      passActive = false

proc linuxSceneThumbnail*(frameConfig: FrameConfig, sceneId: string, width, height: int): Image {.nimcall, gcsafe.} =
  ## The scene's last snapshot at `width` x `height`, or nil when it has none
  ## (never shown since the card was made), it does not decode, or this
  ## render's decode budget is spent before a first picture of it (then
  ## `linuxThumbnailPass` says so). A picture of an older snapshot stands in
  ## for a newer one until the budget allows.
  {.cast(gcsafe).}:
    if width <= 0 or height <= 0:
      return nil
    let assetsPath = if frameConfig.isNil: "" else: frameConfig.assetsPath
    try:
      let path = sceneImagePath(assetsPath, sceneId)
      if not fileExists(path):
        keptThumbnails.del(sceneId)
        return nil
      let key = snapshotKey(path)
      var kept = keptThumbnails.getOrDefault(sceneId)
      if kept.source.isNil or kept.key != key:
        if passActive and (getMonoTime() - passStarted).inMilliseconds >= PassBudgetMs:
          passPending = true
          return kept.fitted # nil, or the older snapshot's
        kept.key = key
        kept.source = loadSource(assetsPath, sceneId, path)
        kept.fitted = nil
      if kept.fitted.isNil or kept.fittedW != width or kept.fittedH != height:
        kept.fitted = coverFit(kept.source, width, height)
        kept.fittedW = width
        kept.fittedH = height
      keptThumbnails[sceneId] = kept
      result = kept.fitted
    except CatchableError:
      keptThumbnails.del(sceneId)
      return nil

proc installSceneSwitcherHooks*() =
  ## On the runner thread, before its first render.
  sceneSwitcherListing = linuxSceneListing
  sceneSwitcherThumbnail = linuxSceneThumbnail
  sceneSwitcherThumbnailPass = linuxThumbnailPass
