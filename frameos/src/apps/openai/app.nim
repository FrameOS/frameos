import pixie
import times
import options
import json
import strformat
import httpclient
from frameos/utils/image import scaleAndDrawImage
from frameos/types import FrameScene, FrameConfig, ExecutionContext

type
  AppConfig* = object
    prompt*: string
    model*: string
    scalingMode*: string
    cacheSeconds*: float

  App* = ref object
    nodeId*: string
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

    cacheExpiry: float
    cachedImage: Option[Image]
    cachedPrompt: string

proc init*(nodeId: string, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
    cachedImage: none(Image),
    cacheExpiry: 0.0,
    cachedPrompt: "",
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:error", "error": message})

proc run*(self: App, context: ExecutionContext) =
  let prompt = self.appConfig.prompt
  if prompt == "":
    self.error("No prompt provided in app config.")
    return
  let apiKey = self.frameConfig.settings{"openAI"}{"apiKey"}.getStr
  if apiKey == "":
    self.error("Please provide an OpenAI API key in the settings.")
    return

  var downloadedImage: Option[Image] = none(Image)
  if self.appConfig.cacheSeconds > 0 and self.cachedImage.isSome and
      self.cacheExpiry > epochTime() and self.cachedPrompt == prompt:
    downloadedImage = self.cachedImage
  else:
    var client = newHttpClient(timeout = 60000)
    client.headers = newHttpHeaders([
        ("Authorization", "Bearer " & apiKey),
        ("Content-Type", "application/json"),
    ])
    let body = %*{"prompt": prompt, "n": 1, "size": "1024x1024",
        "model": self.appConfig.model}
    try:
      let response = client.request("https://api.openai.com/v1/images/generations",
          httpMethod = HttpPost, body = $body)
      if response.code != Http200:
        self.error "Error making request " & $response.status
        return
      let json = parseJson(response.body)
      let imageUrl = json{"data"}{0}{"url"}.getStr
      if imageUrl == "":
        self.error("No image URL returned from OpenAI.")
        return
      var client2 = newHttpClient(timeout = 60000)
      let imageData = client2.request(imageUrl, httpMethod = HttpGet)
      if imageData.code != Http200:
        self.error "Error fetching image " & $imageData.status
        return

      downloadedImage = some(decodeImage(imageData.body))

    except CatchableError as e:
      self.error "Error fetching image from OpenAI: " & $e.msg

    if self.appConfig.cacheSeconds > 0:
      self.cachedImage = downloadedImage
      self.cachedPrompt = prompt
      self.cacheExpiry = epochTime() + self.appConfig.cacheSeconds

  if downloadedImage.isSome:
    let image = downloadedImage.get
    let scalingMode = self.appConfig.scalingMode
    context.image.scaleAndDrawImage(image, scalingMode)
