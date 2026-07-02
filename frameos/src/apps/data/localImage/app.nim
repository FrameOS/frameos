import json
import pixie
import options
import algorithm
import os
import strutils
import strformat
import random
import frameos/utils/image
import frameos/utils/app_images
import frameos/utils/exif
import frameos/apps
import frameos/types
import frameos/hal/entropy

let imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".qoi", ".ppm", ".svg"]

type
  AppConfig* = object
    path*: string
    order*: string
    counterStateKey*: string
    metadataStateKey*: string
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

proc isInIgnoredDir(path: string): bool =
  let normalized = path.replace('\\', '/')
  for dir in [".thumbs", ".frameos"]:
    if normalized.startsWith(dir & "/") or normalized.contains("/" & dir & "/"):
      return true
  return false

proc compareImagePaths(a, b: string): int =
  result = cmpIgnoreCase(a, b)
  if result == 0:
    result = cmp(a, b)

proc sortImagesAlphabetically(images: var seq[string]) =
  images.sort(compareImagePaths)

proc hasSameImages(a, b: seq[string]): bool =
  if a.len != b.len:
    return false

  var left = a
  var right = b
  left.sortImagesAlphabetically()
  right.sortImagesAlphabetically()
  return left == right

# Function to return all images in a folder
proc getImagesInFolder(folder: string, search: string): seq[string] =
  # if folder is a file
  if fileExists(folder):
    if isImage(folder):
      return @[""]
    return @[]
  if not dirExists(folder):
    return @[]

  let searchQuery = search.toLower()
  var images: seq[string] = @[]
  for file in walkDirRec(folder, relative = true):
    if isInIgnoredDir(file):
      continue
    if isImage(file) and (searchQuery == "" or file.toLower().contains(searchQuery)):
      images.add(file)
  return images

proc readExifHead*(path: string): string =
  ## First 256KB of a JPEG file: enough for the EXIF segment without
  ## re-reading whole multi-megabyte files.
  let lowerPath = path.toLower()
  if not (lowerPath.endsWith(".jpg") or lowerPath.endsWith(".jpeg")):
    return ""
  var file: File
  if not open(file, path):
    return ""
  defer: file.close()
  try:
    result = newString(ExifScanBytes)
    let bytesRead = file.readBuffer(addr result[0], result.len)
    result.setLen(max(bytesRead, 0))
  except CatchableError:
    result = ""

proc error*(self: App, context: ExecutionContext, message: string,
    target: Image = nil): Image =
  self.logError(message)
  if not target.isNil:
    # Reuse the canvas the consumer draws onto: an error frame must not
    # allocate a second full-size image on memory-tight devices.
    renderErrorInto(target, target.width, target.height, message)
    return target
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
    randomizeSafe()
    self.images.shuffle()
  else:
    self.images.sortImagesAlphabetically()
  if self.appConfig.order != "random" and self.appConfig.counterStateKey != "" and self.images.len > 0:
    self.counter = self.scene.state{self.appConfig.counterStateKey}.getInt() mod self.images.len

proc refreshImages(self: App) =
  let folder = if self.appConfig.path == "": self.frameConfig.assetsPath else: self.appConfig.path
  let previousImage = self.lastImage
  let newImages = getImagesInFolder(folder, self.appConfig.search)
  var nextImages = newImages
  var hasChanged = false
  self.lastPath = self.appConfig.path
  self.lastSearch = self.appConfig.search

  if self.appConfig.order == "random":
    hasChanged = not hasSameImages(newImages, self.images)
    if hasChanged:
      randomizeSafe()
      nextImages.shuffle()
    else:
      nextImages = self.images
  else:
    nextImages.sortImagesAlphabetically()
    hasChanged = nextImages != self.images

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

proc decodeBoundsForContext(self: App, context: ExecutionContext):
    tuple[maxEdge: int, maxPixels: int] =
  ## Bound decodes by what the display can actually show: the render target
  ## size with 2x pixel slack for cover-style crops. The memory budget in
  ## displayDecodeDimensions may lower this further on constrained devices.
  let
    targetWidth = max(1, self.contextImageWidth(context))
    targetHeight = max(1, self.contextImageHeight(context))
    targetPixels64 = min(targetWidth.int64 * targetHeight.int64 * 2, high(int).int64)
  (
    2 * max(targetWidth, targetHeight),
    targetPixels64.int
  )

proc get*(self: App, context: ExecutionContext): Image =
  # Consume the decode-into-canvas hint up front so every path below —
  # including error frames — can reuse the canvas instead of allocating a
  # second full-size image.
  let decodeTarget = context.decodeTargetImage
  let decodeScalingMode = context.decodeTargetScalingMode
  if not decodeTarget.isNil:
    context.decodeTargetImage = nil
    context.decodeTargetScalingMode = ""

  if self.appConfig.search != self.lastSearch or self.appConfig.path != self.lastPath:
    self.init() # re-init if the query changes

  self.refreshImages()

  if self.images.len() == 0:
    if self.appConfig.search != "":
      return self.error(context, &"No images matching the search query \"{self.appConfig.search}\" found in the folder: {self.appConfig.path}", decodeTarget)
    return self.error(context, &"No images found in the folder: {self.appConfig.path}", decodeTarget)

  let folder = if self.appConfig.path == "": self.frameConfig.assetsPath else: self.appConfig.path
  let currentIndex = self.counter
  let currentImage = self.images[currentIndex]
  var nextImage: Option[Image] = none(Image)
  let path = joinPath(folder, currentImage)
  self.log("Loading image: " & path)
  self.counter = (self.counter + 1) mod len(self.images)
  if self.appConfig.counterStateKey != "":
    self.scene.state[self.appConfig.counterStateKey] = %*(self.counter)

  # When the consumer draws this image full-frame onto the canvas, decode
  # straight into the canvas: peak memory stays at decode intermediates
  # instead of canvas + full decoded copy + compressed file.
  if not decodeTarget.isNil:
    try:
      if readImageIntoTarget(path, decodeTarget, decodeScalingMode):
        nextImage = some(decodeTarget)
    except CatchableError as e:
      return self.error(context, "An error occurred while loading the image: " & path & "\n" & e.msg, decodeTarget)

  if nextImage.isNone:
    try:
      let decodeBounds = self.decodeBoundsForContext(context)
      nextImage = some(readImageWithDisplayBounds(
        path,
        maxEdge = decodeBounds.maxEdge,
        maxPixels = decodeBounds.maxPixels
      ))
    except CatchableError as e:
      return self.error(context, "An error occurred while loading the image: " & path & "\n" & e.msg, decodeTarget)

  let image = nextImage.get()
  if self.appConfig.metadataStateKey != "":
    var metadata = %*{
      "path": path,
      "filename": currentImage,
      "index": currentIndex,
      "total": self.images.len,
      "width": image.width,
      "height": image.height
    }
    let exifMetadata = getExifMetadataFromPath(path)
    if exifMetadata.isSome:
      metadata["exif"] = exifMetadata.get()
    mergeParsedExif(metadata, readExifHead(path))
    self.scene.state[self.appConfig.metadataStateKey] = metadata

  self.lastImage = some(currentImage)
  return image
