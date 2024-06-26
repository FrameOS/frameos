import pixie
import times
import options
import json
import strformat
import lib/httpclient
import frameos/utils/image
import frameos/types

type
  AppConfig* = object
    prompt*: string
    model*: string
    scalingMode*: string
    cacheSeconds*: float
    style*: string
    quality*: string
    size*: string

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

    cacheExpiry: float
    cachedImage: Option[Image]
    cachedPrompt: string

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
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
    let size = if self.appConfig.size == "best for orientation":
                 if self.appConfig.model == "dall-e-3":
                   if context.image.width > context.image.height: "1792x1024"
                   elif context.image.width < context.image.height: "1024x1792"
                   else: "1024x1024"
                 else: "1024x1024"
               elif self.appConfig.size != "": self.appConfig.size
               else: "1024x1024"
    let body = %*{
        "prompt": prompt,
        "n": 1,
        "style": self.appConfig.style,
        "size": size,
        "quality": self.appConfig.quality,
        "model": self.appConfig.model
      }
    try:
      let response = client.request("https://api.openai.com/v1/images/generations",
          httpMethod = HttpPost, body = $body)
      if response.code != Http200:
        try:
          let json = parseJson(response.body)
          let error = json{"error"}{"message"}.getStr(json{"error"}.getStr($json))
          self.error("Error making request " & $response.status & ": " & error)
        except:
          self.error "Error making request " & $response.status & ": " & response.body
        return
      let json = parseJson(response.body)
      let imageUrl = json{"data"}{0}{"url"}.getStr
      if imageUrl == "":
        self.error("No image URL returned from OpenAI.")
        return
      var client2 = newHttpClient(timeout = 60000)
      try:
        let imageData = client2.request(imageUrl, httpMethod = HttpGet)
        if imageData.code != Http200:
          self.error "Error fetching image " & $imageData.status
          return

        downloadedImage = some(decodeImage(imageData.body))
      finally:
        client2.close()
    except CatchableError as e:
      self.error "Error fetching image from OpenAI: " & $e.msg
    finally:
      client.close()

    if self.appConfig.cacheSeconds > 0:
      self.cachedImage = downloadedImage
      self.cachedPrompt = prompt
      self.cacheExpiry = epochTime() + self.appConfig.cacheSeconds

  if downloadedImage.isSome:
    let image = downloadedImage.get
    let scalingMode = self.appConfig.scalingMode
    context.image.scaleAndDrawImage(image, scalingMode)
