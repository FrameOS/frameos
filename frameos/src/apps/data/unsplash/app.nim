import pixie
import json
import uri
import strformat
import strutils
import lib/httpclient
import frameos/apps
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    search*: string
    orientation*: string
    saveAssets*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc init*(self: App) =
  self.appConfig.search = self.appConfig.search.strip()

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  result = renderError(if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
        if context.hasImage: context.image.height else: self.frameConfig.renderHeight(), message)

proc get*(self: App, context: ExecutionContext): Image =
  let apiKey = self.frameConfig.settings{"unsplash"}{"accessKey"}.getStr
  if apiKey == "":
    return self.error(context, "Please provide an Unsplash API key in the settings.")

  let width = if context.hasImage: context.image.width else: self.frameConfig.renderWidth()
  let height = if context.hasImage: context.image.height else: self.frameConfig.renderHeight()
  let search = self.appConfig.search
  let orientation = if self.appConfig.orientation == "auto":
                      if width > height: "portrait"
                      elif width < height: "landscape"
                      else: "squarish"
                    elif self.appConfig.orientation == "any": ""
                    else: self.appConfig.orientation

  try:
    let url = &"https://api.unsplash.com/photos/random/?orientation={encodeUrl(orientation)}&query={encodeUrl(search)}"
    if self.frameConfig.debug:
      self.log(&"API request: {url}")
    var client = newHttpClient(timeout = 60000)
    client.headers = newHttpHeaders([
        ("Authorization", "Client-ID " & apiKey),
        ("Accept-Version", "v1"),
        ("Content-Type", "application/json"),
    ])
    let response = client.request(url, httpMethod = HttpGet)
    defer: client.close()

    if response.code != Http200:
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
    var client2 = newHttpClient(timeout = 60000)
    defer: client2.close()
    let realImageUrl = &"{imageUrl}&w={width}&h={height}&fit=crop&crop=faces,edges"
    if self.frameConfig.debug:
      self.log(&"Downloading image: {realImageUrl}")
    let imageData = client2.request(realImageUrl, httpMethod = HttpGet)
    if imageData.code != Http200:
      return self.error(context, &"Error {imageData.status} fetching image")

    if self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always":
      discard self.saveAsset(&"{search} {width}x{height}", ".jpg", imageData.body, self.appConfig.saveAssets == "auto")

    result = decodeImage(imageData.body)
  except CatchableError as e:
    return self.error(context, "Error fetching image from Unsplash: " & $e.msg)

