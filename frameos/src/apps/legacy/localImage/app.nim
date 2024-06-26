import json
import strformat
import pixie
import times
import options
import frameos/utils/image
import frameos/types
import os, strutils
import std/random

let imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", "*.qoi", ".ppm", ".svg"]

type
  AppConfig* = object
    path*: string
    order*: string
    scalingMode*: string
    seconds*: float
    counterStateKey*: string

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig
    lastExpiry: float
    lastImage: Option[Image]
    cachedUrl: string
    images: seq[string]
    counter: int

# Function to check if a file is an image
proc isImage(file: string): bool =
  for ext in imageExtensions:
    if file.endsWith(ext):
      return true
  return false

# Function to return all images in a folder
proc getImagesInFolder(folder: string): seq[string] =
  # if folder is a file
  if fileExists(folder):
    if isImage(folder):
      return @[""]
    return @[]

  var images: seq[string] = @[]
  for file in walkDirRec(folder, relative = true):
    if isImage(file):
      images.add(file)
  return images

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:error", "error": message})

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
    lastImage: none(Image),
    lastExpiry: 0.0,
    images: getImagesInFolder(appConfig.path),
    counter: 0
  )
  result.log("Found " & $result.images.len & " images in the folder: " & appConfig.path)
  result.log(result.images.join(", "))
  if appConfig.order == "random":
    randomize()
    result.images.shuffle()
  elif appConfig.counterStateKey != "":
    result.counter = scene.state{appConfig.counterStateKey}.getInt() mod result.images.len

proc run*(self: App, context: ExecutionContext) =
  if self.images.len == 0:
    context.image.draw(
      renderError(context.image.width, context.image.height, "No images found in: " & self.appConfig.path)
    )
    self.error "No images found in: " & self.appConfig.path
    return

  var nextImage: Option[Image] = none(Image)
  if self.appConfig.seconds > 0 and self.lastImage.isSome and self.lastExpiry > epochTime():
    nextImage = self.lastImage
  else:
    let path = joinPath(self.appConfig.path, self.images[self.counter])
    self.log("Loading image: " & path)
    self.counter = (self.counter + 1) mod len(self.images)
    if self.appConfig.counterStateKey != "":
      self.scene.state[self.appConfig.counterStateKey] = %*(self.counter)

    try:
      nextImage = some(readImage(path))
      if self.appConfig.seconds > 0:
        self.lastImage = nextImage
        self.lastExpiry = epochTime() + self.appConfig.seconds
    except CatchableError as e:
      nextImage = some(renderError(context.image.width, context.image.height,
          "An error occurred while loading the image: " & path & "\n" & e.msg))
      self.error "An error occurred while loading the image: " & path & "\n" & e.msg

  context.image.scaleAndDrawImage(nextImage.get(), self.appConfig.scalingMode)
