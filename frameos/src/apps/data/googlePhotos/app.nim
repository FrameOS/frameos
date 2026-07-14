import pixie
import json
import random
import sets
import strformat
import strutils
import times
import frameos/apps
import frameos/types
import frameos/utils/app_images
import frameos/utils/http_client
import frameos/utils/image
import frameos/hal/entropy

const
  photoUrlHost* = "https://lh3.googleusercontent.com/"
  minPhotoPathLength = 60
  albumUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
  photoPathChars = {'a'..'z', 'A'..'Z', '0'..'9', '-', '_', '/', '=', '.', '\\'}

type
  AppConfig* = object
    shareUrl*: string
    mode*: string
    counterStateKey*: string
    fitMode*: string
    metadataStateKey*: string
    saveAssets*: string
    cacheAlbumSeconds*: int

  App* = ref object of AppRoot
    appConfig*: AppConfig
    photoUrls*: seq[string]
    albumFetchedAt*: float
    lastShareUrl*: string
    counter*: int

proc extractPhotoUrls*(html: string): seq[string] =
  ## Pull googleusercontent photo base URLs out of a shared album page.
  ## URLs appear both raw and JSON-escaped (= for '='); size suffixes
  ## after '=' are stripped so callers can append their own.
  var seen = initHashSet[string]()
  var searchFrom = 0
  while true:
    let start = html.find(photoUrlHost, searchFrom)
    if start < 0:
      break
    var idx = start + photoUrlHost.len
    while idx < html.len and html[idx] in photoPathChars:
      inc idx
    searchFrom = idx
    var path = html[start + photoUrlHost.len ..< idx]
    while path.endsWith("\\"):
      path.setLen(path.len - 1)
    path = path.replace("\\u003d", "=").replace("\\u0026", "&").replace("\\/", "/")
    let suffixStart = path.find('=')
    if suffixStart >= 0:
      path.setLen(suffixStart)
    if path.len <= minPhotoPathLength:
      continue
    if not (path.startsWith("pw/") or path.contains("AF1Qip")):
      continue
    let url = photoUrlHost & path
    if url notin seen:
      seen.incl(url)
      result.add(url)

proc sizedPhotoUrl*(baseUrl: string, width, height: int, fitMode: string): string =
  let suffix = if fitMode == "contain": "-no" else: "-c"
  baseUrl & "=w" & $width & "-h" & $height & suffix

proc wrapIndex*(counter, count: int): int =
  if count <= 0:
    return 0
  ((counter mod count) + count) mod count

proc init*(self: App) =
  self.appConfig.shareUrl = self.appConfig.shareUrl.strip()
  self.appConfig.counterStateKey = self.appConfig.counterStateKey.strip()
  self.appConfig.metadataStateKey = self.appConfig.metadataStateKey.strip()
  if self.appConfig.cacheAlbumSeconds <= 0:
    self.appConfig.cacheAlbumSeconds = 3600
  if self.appConfig.mode == "random":
    randomizeSafe()
  elif self.appConfig.counterStateKey != "":
    self.counter = self.scene.state{self.appConfig.counterStateKey}.getInt()

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  result = renderError(self.contextImageWidth(context), self.contextImageHeight(context), message)

proc albumStale(self: App): bool =
  self.photoUrls.len == 0 or
    self.appConfig.shareUrl != self.lastShareUrl or
    epochTime() - self.albumFetchedAt >= self.appConfig.cacheAlbumSeconds.float

proc refreshAlbum(self: App) =
  if self.frameConfig.debug:
    self.log(&"Fetching shared album: {self.appConfig.shareUrl}")
  let response = boundedRequestWithHeaders(
    self.appConfig.shareUrl,
    headers = @[
      (name: "User-Agent", value: albumUserAgent),
      (name: "Accept", value: "text/html"),
    ],
    timeoutMs = 60000,
    maxBytes = self.maxHttpResponseBytes(),
    maxSeconds = 60
  )
  if response.code != 200:
    raise newException(IOError, "Error " & $response.status & " while fetching the shared album page.")
  let photoUrls = extractPhotoUrls(response.body)
  if photoUrls.len == 0:
    raise newException(IOError,
      "No photos found on the shared album page. Make sure the link is a public share link and the album is not empty.")
  self.photoUrls = photoUrls
  self.albumFetchedAt = epochTime()
  self.lastShareUrl = self.appConfig.shareUrl
  if self.frameConfig.debug:
    self.log(&"Found {photoUrls.len} photos in the shared album")

proc get*(self: App, context: ExecutionContext): Image =
  let width = self.contextImageWidth(context)
  let height = self.contextImageHeight(context)
  let shareUrl = self.appConfig.shareUrl
  if shareUrl == "":
    return self.error(context, "Please provide a Google Photos shared album link.")
  if not shareUrl.startsWith("http://") and not shareUrl.startsWith("https://"):
    return self.error(context, "Invalid shared album link: " & shareUrl)

  try:
    if self.albumStale():
      try:
        self.refreshAlbum()
      except CatchableError as e:
        if self.photoUrls.len > 0 and shareUrl == self.lastShareUrl:
          self.logError("Error refreshing the shared album, reusing the cached photo list: " & e.msg)
        else:
          return self.error(context, "Error loading the shared album: " & e.msg)

    let count = self.photoUrls.len
    var index = 0
    if self.appConfig.mode == "sequential":
      index = wrapIndex(self.counter, count)
      self.counter = wrapIndex(index + 1, count)
      if self.appConfig.counterStateKey != "":
        self.scene.state[self.appConfig.counterStateKey] = %*(self.counter)
    else:
      index = rand(count - 1)

    let imageUrl = sizedPhotoUrl(self.photoUrls[index], width, height, self.appConfig.fitMode)
    if self.frameConfig.debug:
      self.log(&"Downloading image: {imageUrl}")
    let (downloadedImage, imageData) = self.downloadImageWithDataForContext(
      context,
      imageUrl,
      maxBytes = self.maxImageResponseBytes(),
      fallbackWidth = width,
      fallbackHeight = height
    )

    if self.appConfig.metadataStateKey != "":
      self.scene.state[self.appConfig.metadataStateKey] = %*{
        "source": "googlePhotos",
        "index": index,
        "count": count,
        "imageUrl": imageUrl
      }

    if imageData.len > 0 and (self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always"):
      discard self.saveAsset(&"google-photos {index} {width}x{height}", ".jpg", imageData,
          self.appConfig.saveAssets == "auto")

    result = downloadedImage
  except CatchableError as e:
    return self.error(context, "Error fetching image from Google Photos: " & $e.msg)
