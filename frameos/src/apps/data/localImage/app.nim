import json
import pixie
import options
import os
import strutils
import strformat
import random
import frameos/utils/image
import frameos/apps
import frameos/types

let imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".qoi", ".ppm", ".svg"]

type
  AppConfig* = object
    path*: string
    order*: string
    counterStateKey*: string
    search*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig
    lastSearch*: string
    lastPath*: string
    images: seq[string]
    counter: int
    lastImage*: Option[string]

# Function to check if a file is an image
proc isImage(file: string): bool =
  for ext in imageExtensions:
    if file.toLower().endsWith(ext):
      return true
  return false

# Function to return all images in a folder
proc getImagesInFolder(folder: string, search: string): seq[string] =
  # if folder is a file
  if fileExists(folder):
    if isImage(folder):
      return @[""]
    return @[]

  let searchQuery = search.toLower()
  var images: seq[string] = @[]
  for file in walkDirRec(folder, relative = true):
    if isImage(file) and (searchQuery == "" or file.toLower().contains(searchQuery)):
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
  let folder = if self.appConfig.path == "": self.frameConfig.assetsPath else: self.appConfig.path
  self.images = getImagesInFolder(folder, self.appConfig.search)
  self.lastPath = self.appConfig.path
  self.lastSearch = self.appConfig.search
  self.counter = 0
  self.lastImage = none(string)
  if self.appConfig.search != "":
    self.log("Search query: " & self.appConfig.search)
  self.log("Found " & $self.images.len & " images in the folder: " & folder)
  if self.appConfig.order == "random":
    randomize()
    self.images.shuffle()
  elif self.appConfig.counterStateKey != "" and self.images.len > 0:
    self.counter = self.scene.state{self.appConfig.counterStateKey}.getInt() mod self.images.len

proc refreshImages(self: App) =
  let folder = if self.appConfig.path == "": self.frameConfig.assetsPath else: self.appConfig.path
  let previousImage = self.lastImage
  let newImages = getImagesInFolder(folder, self.appConfig.search)
  let hasChanged = newImages != self.images
  var nextImages = newImages
  self.lastPath = self.appConfig.path
  self.lastSearch = self.appConfig.search

  if self.appConfig.order == "random":
    randomize()
    if hasChanged:
      nextImages.shuffle()
    else:
      nextImages = self.images

  self.images = nextImages

  if self.images.len == 0:
    return

  if previousImage.isSome:
    let lastIndex = self.images.find(previousImage.get())
    if lastIndex >= 0:
      self.counter = (lastIndex + 1) mod self.images.len
    elif self.counter >= self.images.len:
      self.counter = self.counter mod self.images.len
  elif self.counter >= self.images.len:
    self.counter = self.counter mod self.images.len

proc get*(self: App, context: ExecutionContext): Image =
  if self.appConfig.search != self.lastSearch or self.appConfig.path != self.lastPath:
    self.init()

  self.refreshImages()

  if self.images.len() == 0:
    if self.appConfig.search != "":
      return self.error(context, &"No images matching the search query \"{self.appConfig.search}\" found in the folder: {self.appConfig.path}")
    return self.error(context, &"No images found in the folder: {self.appConfig.path}")

  let folder = if self.appConfig.path == "": self.frameConfig.assetsPath else: self.appConfig.path
  let currentImage = self.images[self.counter]
  var nextImage: Option[Image] = none(Image)
  let path = joinPath(folder, currentImage)
  self.log("Loading image: " & path)
  self.counter = (self.counter + 1) mod len(self.images)
  if self.appConfig.counterStateKey != "":
    self.scene.state[self.appConfig.counterStateKey] = %*(self.counter)

  try:
    nextImage = some(readImage(path))
  except CatchableError as e:
    return self.error(context, "An error occurred while loading the image: " & path & "\n" & e.msg)

  self.lastImage = some(currentImage)
  return nextImage.get()
