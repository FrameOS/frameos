import pixie
import options
import json
import strformat
import lib/httpclient
import frameos/utils/image
import frameos/config
import frameos/types

type
  AppConfig* = object
    prompt*: string
    model*: string
    style*: string
    quality*: string
    size*: string

  AppOutput* = object
    image*: Image

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:log", "message": message})

proc error*(self: App, context: ExecutionContext, message: string): AppOutput =
  self.scene.logger.log(%*{"event": &"{self.nodeId}:error", "error": message})
  result = AppOutput(image: renderError(self.frameConfig.renderWidth(), self.frameConfig.renderHeight(), message))

proc run*(self: App, context: ExecutionContext): AppOutput =
  let prompt = self.appConfig.prompt
  if prompt == "":
    return self.error(context, "No prompt provided in app config.")
  let apiKey = self.frameConfig.settings{"openAI"}{"apiKey"}.getStr
  if apiKey == "":
    return self.error(context, "Please provide an OpenAI API key in the settings.")

  var client = newHttpClient(timeout = 60000)
  client.headers = newHttpHeaders([
      ("Authorization", "Bearer " & apiKey),
      ("Content-Type", "application/json"),
  ])
  let size = if self.appConfig.size == "best for orientation":
                if self.appConfig.model == "dall-e-3":
                  if self.frameConfig.renderWidth() > self.frameConfig.renderHeight(): "1792x1024"
                  elif self.frameConfig.renderWidth() < self.frameConfig.renderHeight(): "1024x1792"
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
    defer: client.close()
    if response.code != Http200:
      try:
        let json = parseJson(response.body)
        let error = json{"error"}{"message"}.getStr(json{"error"}.getStr($json))
        return self.error(context, "Error making request " & $response.status & ": " & error)
      except:
        return self.error(context, "Error making request " & $response.status & ": " & response.body)
    let json = parseJson(response.body)
    let imageUrl = json{"data"}{0}{"url"}.getStr
    if imageUrl == "":
      return self.error(context, "No image URL returned from OpenAI.")
    var client2 = newHttpClient(timeout = 60000)
    let imageData = client2.request(imageUrl, httpMethod = HttpGet)
    defer: client2.close()
    if imageData.code != Http200:
      return self.error(context, "Error fetching image " & $imageData.status)
    result = AppOutput(image: decodeImage(imageData.body))
  except CatchableError as e:
    return self.error(context, "Error fetching image from OpenAI: " & $e.msg)
