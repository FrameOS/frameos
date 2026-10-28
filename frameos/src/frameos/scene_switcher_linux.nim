## What the scene switcher (system/sceneSwitcher/scene.nim) shows on a Linux
## frame: the scene list the dispatcher walks for `setCurrentScene
## {direction}` (`sceneOrderSnapshot`) with each scene's name, and each
## scene's last picture — the snapshot the runner writes on every switch and
## at most once a minute after (`render:sceneImage:saved`, scenes.nim
## `sceneImagePath`), fitted to its tile and kept until the file changes.
##
## Runner thread only: the kept pictures are its own (a threadvar), and the
## scene registry is read under its lock.

import std/[os, options, tables, times]
import pixie
import frameos/types
import frameos/interpreter
import frameos/scenes
import system/sceneSwitcher/scene as sceneSwitcher

type KeptThumbnail = object
  key: string
  image: Image

var keptThumbnails {.threadvar.}: Table[string, KeptThumbnail]

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

proc linuxSceneThumbnail*(frameConfig: FrameConfig, sceneId: string, width, height: int): Image {.nimcall, gcsafe.} =
  ## The scene's last snapshot at `width` x `height`, or nil when it has none
  ## (never shown since the card was made) or it does not decode.
  {.cast(gcsafe).}:
    if width <= 0 or height <= 0:
      return nil
    try:
      let path = sceneImagePath(if frameConfig.isNil: "" else: frameConfig.assetsPath, sceneId)
      if not fileExists(path):
        keptThumbnails.del(sceneId)
        return nil
      let key = $getLastModificationTime(path).toUnixFloat() & ":" & $getFileSize(path) & ":" &
        $width & "x" & $height
      if keptThumbnails.hasKey(sceneId) and keptThumbnails[sceneId].key == key:
        return keptThumbnails[sceneId].image
      result = coverFit(decodeImage(readFile(path)), width, height)
      keptThumbnails[sceneId] = KeptThumbnail(key: key, image: result)
    except CatchableError:
      keptThumbnails.del(sceneId)
      return nil

proc installSceneSwitcherHooks*() =
  ## On the runner thread, before its first render.
  sceneSwitcherListing = linuxSceneListing
  sceneSwitcherThumbnail = linuxSceneThumbnail
