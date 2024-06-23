import json
import strformat
import pixie
import options
import frameos/utils/image
import frameos/config
import frameos/types
import os, strutils
import std/random

let imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", "*.qoi", ".ppm", ".svg"]

type
  AppConfig* = object
    path*: string
    order*: string
    counterStateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig
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
  self.scene.logger.log(%*{"event": &"localImage:log", "message": message})

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.scene.logger.log(%*{"event": &"localImage:error", "error": message})
  return renderError(
    if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
    if context.hasImage: context.image.height else: self.frameConfig.renderHeight(),
    message
  )

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
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

proc get*(self: App, context: ExecutionContext): Image =
  if self.images.len == 0:
    return self.error(context, "No images found in: " & self.appConfig.path)

  var nextImage: Option[Image] = none(Image)
  let path = joinPath(self.appConfig.path, self.images[self.counter])
  self.log("Loading image: " & path)
  self.counter = (self.counter + 1) mod len(self.images)
  if self.appConfig.counterStateKey != "":
    self.scene.state[self.appConfig.counterStateKey] = %*(self.counter)

  try:
    nextImage = some(readImage(path))
  except CatchableError as e:
    return self.error(context, "An error occurred while loading the image: " & path & "\n" & e.msg)

  return nextImage.get()
