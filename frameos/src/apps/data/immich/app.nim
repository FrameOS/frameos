import pixie
import json
import random
import strformat
import strutils
import times
import uri
import frameos/apps
import frameos/types
import frameos/hal/entropy
import frameos/utils/app_images
import frameos/utils/http_client
import frameos/utils/image

const RequestTimeoutMs = 30000

type
  AppConfig* = object
    mode*: string
    albumId*: string
    personId*: string
    metadataStateKey*: string
    saveAssets*: string
    previewSize*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc init*(self: App) =
  self.appConfig.mode = self.appConfig.mode.strip()
  if self.appConfig.mode == "":
    self.appConfig.mode = "random"
  self.appConfig.albumId = self.appConfig.albumId.strip()
  self.appConfig.personId = self.appConfig.personId.strip()
  self.appConfig.metadataStateKey = self.appConfig.metadataStateKey.strip()
  if self.appConfig.previewSize != "fullsize":
    self.appConfig.previewSize = "preview"

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  result = renderError(self.contextImageWidth(context), self.contextImageHeight(context), message)

proc normalizeServerUrl*(url: string): string =
  result = url.strip()
  while result.endsWith("/"):
    result.removeSuffix("/")

proc searchRandomUrl*(serverUrl: string): string =
  &"{serverUrl}/api/search/random"

proc legacyRandomUrl*(serverUrl: string): string =
  # Older servers without POST /api/search/random can't filter server-side;
  # ask for a batch so client-side filtering has image candidates
  &"{serverUrl}/api/assets/random?count=20"

proc albumUrl*(serverUrl: string, albumId: string): string =
  &"{serverUrl}/api/albums/{encodeUrl(albumId)}"

proc memoriesUrl*(serverUrl: string, isoDate: string): string =
  &"{serverUrl}/api/memories?for={encodeUrl(isoDate)}"

proc assetDownloadUrl*(serverUrl: string, assetId: string, previewSize: string): string =
  if previewSize == "fullsize":
    &"{serverUrl}/api/assets/{encodeUrl(assetId)}/original"
  else:
    &"{serverUrl}/api/assets/{encodeUrl(assetId)}/thumbnail?size=preview"

proc todayIso*(): string =
  # Frame-local date: local date D at 00:00:00Z falls inside Immich's UTC
  # day-D window, matching the web client's local-date semantics
  now().format("yyyy-MM-dd") & "T00:00:00.000Z"

proc randomSearchBody*(albumId = "", personId = "", isFavorite = false): JsonNode =
  result = %*{"size": 1, "type": "IMAGE", "withExif": true, "withPeople": true}
  if albumId != "":
    result["albumIds"] = %[albumId]
  if personId != "":
    result["personIds"] = %[personId]
  if isFavorite:
    result["isFavorite"] = %true

proc imageAssets*(assets: JsonNode): seq[JsonNode] =
  if assets != nil and assets.kind == JArray:
    for asset in assets:
      if asset.kind == JObject and asset{"type"}.getStr == "IMAGE":
        result.add(asset)

proc memoriesImageAssets*(memories: JsonNode): seq[JsonNode] =
  if memories != nil and memories.kind == JArray:
    for memory in memories:
      if memory.kind == JObject:
        result.add(imageAssets(memory{"assets"}))

proc pickRandomAsset*(assets: seq[JsonNode]): JsonNode =
  if assets.len == 0:
    return nil
  randomizeSafe()
  assets[rand(assets.len - 1)]

proc assetMetadata*(asset: JsonNode): JsonNode =
  result = %*{
    "source": "immich",
    "id": asset{"id"}.getStr,
    "originalFileName": asset{"originalFileName"}.getStr
  }
  let exif = asset{"exifInfo"}
  if exif != nil and exif.kind == JObject:
    for key in ["make", "model", "fNumber", "exposureTime", "iso", "focalLength", "dateTimeOriginal"]:
      if exif.hasKey(key) and exif[key].kind != JNull:
        result[key] = copy(exif[key])
  let people = asset{"people"}
  if people != nil and people.kind == JArray:
    var names: seq[string] = @[]
    for person in people:
      let name = person{"name"}.getStr
      if name != "":
        names.add(name)
    if names.len > 0:
      result["people"] = %names

proc assetFileExtension*(asset: JsonNode, previewSize: string): string =
  if previewSize == "fullsize":
    let name = asset{"originalFileName"}.getStr
    let dotIndex = name.rfind('.')
    if dotIndex > 0 and dotIndex < name.len - 1:
      return name[dotIndex..^1].toLowerAscii()
  ".jpg"

proc assetBaseName*(asset: JsonNode): string =
  result = asset{"originalFileName"}.getStr
  let dotIndex = result.rfind('.')
  if dotIndex > 0:
    result = result[0..<dotIndex]
  if result == "":
    result = asset{"id"}.getStr("immich")

proc httpErrorMessage*(response: BoundedHttpResponse): string =
  result = "HTTP " & $response.status
  try:
    let json = parseJson(response.body)
    let message = json{"message"}
    if message != nil and message.kind == JString and message.getStr != "":
      result.add(": " & message.getStr)
    elif message != nil and message.kind == JArray and message.len > 0:
      result.add(": " & message[0].getStr($message[0]))
    elif json{"error"}.getStr != "":
      result.add(": " & json{"error"}.getStr)
  except CatchableError:
    if response.body.len > 0 and response.body.len < 300:
      result.add(": " & response.body)

proc apiHeaders(apiKey: string): seq[SimpleHttpHeader] =
  @[
    (name: "x-api-key", value: apiKey),
    (name: "Accept", value: "application/json"),
    (name: "Content-Type", value: "application/json"),
  ]

proc requestJson(self: App, apiKey: string, url: string, httpMethod = "GET", body = ""): BoundedHttpResponse =
  if self.frameConfig.debug:
    self.log(&"API request: {httpMethod} {url}")
  boundedRequestWithHeaders(
    url,
    httpMethod = httpMethod,
    body = body,
    headers = apiHeaders(apiKey),
    timeoutMs = RequestTimeoutMs,
    maxBytes = self.maxHttpResponseBytes(),
    maxSeconds = 60
  )

proc fetchRandomAsset(self: App, serverUrl: string, apiKey: string, albumId = "", personId = "",
    isFavorite = false, emptyMessage = "Immich returned no image assets."): tuple[asset: JsonNode, message: string] =
  var response = self.requestJson(apiKey, searchRandomUrl(serverUrl), httpMethod = "POST",
    body = $randomSearchBody(albumId = albumId, personId = personId, isFavorite = isFavorite))
  var usedLegacyFallback = false
  if response.code == 404:
    self.log("This Immich server lacks POST /api/search/random; falling back to " &
      "/api/assets/random where album/person/favorite filters cannot be applied.")
    response = self.requestJson(apiKey, legacyRandomUrl(serverUrl))
    usedLegacyFallback = true
  if response.code != 200:
    return (nil, "Error fetching a random image from Immich: " & httpErrorMessage(response))
  var assets = imageAssets(parseJson(response.body))
  if usedLegacyFallback and isFavorite:
    var favorites: seq[JsonNode] = @[]
    for asset in assets:
      if asset{"isFavorite"}.getBool:
        favorites.add(asset)
    assets = favorites
  if assets.len == 0:
    if usedLegacyFallback:
      return (nil, "This Immich server returned no matching images from /api/assets/random.")
    return (nil, emptyMessage)
  (pickRandomAsset(assets), "")

proc get*(self: App, context: ExecutionContext): Image =
  self.ensureEmbeddedServiceSettings()
  let serverUrl = normalizeServerUrl(self.frameConfig.settings{"immich"}{"url"}.getStr)
  if serverUrl == "":
    return self.error(context, "Please provide an Immich server URL in the settings.")
  let apiKey = self.frameConfig.settings{"immich"}{"apiKey"}.getStr
  if apiKey == "":
    return self.error(context, "Please provide an Immich API key in the settings.")
  if self.appConfig.mode == "album" and self.appConfig.albumId == "":
    return self.error(context, "Please provide an album ID. It's the UUID visible in the album's URL.")

  let width = self.contextImageWidth(context)
  let height = self.contextImageHeight(context)

  try:
    var asset: JsonNode = nil
    case self.appConfig.mode
    of "album":
      # Server-side random pick: albums can be huge and the full asset list
      # would blow the response cap (and ESP32 memory)
      let (randomAsset, message) = self.fetchRandomAsset(serverUrl, apiKey,
        albumId = self.appConfig.albumId,
        emptyMessage = "This album contains no images. Double-check the album ID — it's the UUID in the album's URL.")
      if randomAsset.isNil:
        return self.error(context, message)
      asset = randomAsset
    of "memories":
      let response = self.requestJson(apiKey, memoriesUrl(serverUrl, todayIso()))
      if response.code == 200:
        let assets = memoriesImageAssets(parseJson(response.body))
        if assets.len > 0:
          asset = pickRandomAsset(assets)
      else:
        self.log("No Immich memories for today (" & httpErrorMessage(response) & "), showing a random image instead.")
      if asset.isNil:
        let (randomAsset, message) = self.fetchRandomAsset(serverUrl, apiKey)
        if randomAsset.isNil:
          return self.error(context, message)
        asset = randomAsset
    of "favorites":
      let (randomAsset, message) = self.fetchRandomAsset(serverUrl, apiKey, isFavorite = true,
        emptyMessage = "No favorite images found in Immich.")
      if randomAsset.isNil:
        return self.error(context, message)
      asset = randomAsset
    else:
      let (randomAsset, message) = self.fetchRandomAsset(serverUrl, apiKey, personId = self.appConfig.personId)
      if randomAsset.isNil:
        return self.error(context, message)
      asset = randomAsset

    let assetId = asset{"id"}.getStr
    if assetId == "":
      return self.error(context, "Immich returned an asset without an ID.")

    let downloadUrl = assetDownloadUrl(serverUrl, assetId, self.appConfig.previewSize)
    if self.frameConfig.debug:
      self.log(&"Downloading image: {downloadUrl}")
    let (downloadedImage, imageData) = self.downloadImageWithDataForContext(
      context,
      downloadUrl,
      maxBytes = self.maxImageResponseBytes(),
      headers = @[(name: "x-api-key", value: apiKey)],
      fallbackWidth = width,
      fallbackHeight = height
    )

    if self.appConfig.metadataStateKey != "":
      self.scene.state[self.appConfig.metadataStateKey] = assetMetadata(asset)

    if imageData.len > 0 and (self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always"):
      discard self.saveAsset(assetBaseName(asset), assetFileExtension(asset, self.appConfig.previewSize),
        imageData, self.appConfig.saveAssets == "auto")

    result = downloadedImage
  except CatchableError as e:
    return self.error(context, "Error fetching image from Immich: " & $e.msg)
