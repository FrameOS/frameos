import json
import pixie
import options
import frameos/utils/image
import frameos/config
import frameos/types
import frameos/logger
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

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  return renderError(
    if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
    if context.hasImage: context.image.height else: self.frameConfig.renderHeight(),
    message
  )

proc init*(self: App) =
  self.images = getImagesInFolder(self.appConfig.path)
  self.counter = 0
  self.log("Found " & $self.images.len & " images in the folder: " & self.appConfig.path)
  self.log(%*{"images": self.images})
  if self.appConfig.order == "random":
    randomize()
    self.images.shuffle()
  elif self.appConfig.counterStateKey != "":
    self.counter = self.scene.state{self.appConfig.counterStateKey}.getInt() mod self.images.len

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
