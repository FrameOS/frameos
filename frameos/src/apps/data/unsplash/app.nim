import pixie
import json
import uri
import strformat
import strutils
import frameos/apps
import frameos/types
import frameos/utils/app_images
import frameos/utils/http_client

type
  AppConfig* = object
    search*: string
    orientation*: string
    saveAssets*: string
    metadataStateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc init*(self: App) =
  self.appConfig.search = self.appConfig.search.strip()
  self.appConfig.metadataStateKey = self.appConfig.metadataStateKey.strip()

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  result = self.renderErrorForContext(context, message)

proc get*(self: App, context: ExecutionContext): Image =
  self.ensureEmbeddedServiceSettings()
  let apiKey = self.frameConfig.settings{"unsplash"}{"accessKey"}.getStr
  if apiKey == "":
    return self.error(context, "Please provide an Unsplash API key in the settings.")

  let width = self.contextImageWidth(context)
  let height = self.contextImageHeight(context)
  let search = self.appConfig.search
  let orientation = if self.appConfig.orientation == "auto":
                      if height > width: "portrait"
                      elif width > height: "landscape"
                      else: "squarish"
                    elif self.appConfig.orientation == "any": ""
                    else: self.appConfig.orientation

  try:
    let url = &"https://api.unsplash.com/photos/random/?orientation={encodeUrl(orientation)}&query={encodeUrl(search)}"
    if self.frameConfig.debug:
      self.log(&"API request: {url}")
    let response = boundedRequestWithHeaders(
      url,
      headers = @[
        (name: "Authorization", value: "Client-ID " & apiKey),
        (name: "Accept-Version", value: "v1"),
        (name: "Content-Type", value: "application/json"),
      ],
      timeoutMs = 60000,
      maxBytes = self.maxHttpResponseBytes(),
      maxSeconds = 60
    )

    if response.code != 200:
      try:
        let json = parseJson(response.body)
        let error = json{"error"}{"message"}.getStr(json{"error"}.getStr($json))
        return self.error(context, "Error making request " & $response.status & ": " & error)
      except:
        return self.error(context, "Error making request " & $response.status & ": " & response.body)

    let json = parseJson(response.body)
    let imageUrl = json{"urls"}{"raw"}.getStr
    if imageUrl == "":
      return self.error(context, "No image URL returned from Unsplash.")
    let realImageUrl = &"{imageUrl}&w={width}&h={height}&fit=crop&crop=faces,edges"
    if self.frameConfig.debug:
      self.log(&"Downloading image: {realImageUrl}")
    let (downloadedImage, imageData) = self.downloadImageWithDataForContext(
      context,
      realImageUrl,
      maxBytes = self.maxImageResponseBytes(),
      fallbackWidth = width,
      fallbackHeight = height
    )

    if self.appConfig.metadataStateKey != "":
      let description = json{"description"}.getStr(json{"alt_description"}.getStr(""))
      self.scene.state[self.appConfig.metadataStateKey] = %*{
        "source": "unsplash",
        "search": search,
        "orientation": orientation,
        "imageUrl": realImageUrl,
        "id": json{"id"}.getStr,
        "title": json{"slug"}.getStr(description),
        "description": description,
        "altDescription": json{"alt_description"}.getStr,
        "location": json{"location"}{"name"}.getStr,
        "createdAt": json{"created_at"}.getStr,
        "photoUrl": json{"links"}{"html"}.getStr,
        "author": json{"user"}{"name"}.getStr,
        "authorUsername": json{"user"}{"username"}.getStr,
        "authorUrl": json{"user"}{"links"}{"html"}.getStr
      }

    if imageData.len > 0 and (self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always"):
      discard self.saveAsset(&"{search} {width}x{height}", ".jpg", imageData, self.appConfig.saveAssets == "auto")

    result = downloadedImage
  except CatchableError as e:
    return self.error(context, "Error fetching image from Unsplash: " & $e.msg)
