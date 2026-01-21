import pixie
import options
import json
import httpclient
import base64
import frameos/apps
import frameos/types
import frameos/utils/image

type
  AppConfig* = object
    prompt*: string
    model*: string
    style*: string
    quality*: string
    size*: string
    saveAssets*: string
    metadataStateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  result = renderError(if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
        if context.hasImage: context.image.height else: self.frameConfig.renderHeight(), message)

proc get*(self: App, context: ExecutionContext): Image =
  let prompt = self.appConfig.prompt
  if prompt == "":
    return self.error(context, "No prompt provided in app config.")
  let apiKey = self.frameConfig.settings{"openAI"}{"apiKey"}.getStr
  if apiKey == "":
    return self.error(context, "Please provide an OpenAI API key in the settings.")

  var client = newHttpClient(timeout = 300000) # 5 min timeout
  client.headers = newHttpHeaders([
      ("Authorization", "Bearer " & apiKey),
      ("Content-Type", "application/json"),
  ])
  let imageWidth = if context.hasImage: context.image.width else: self.frameConfig.renderWidth()
  let imageHeight = if context.hasImage: context.image.height else: self.frameConfig.renderHeight()
  let defaultSize = "1024x1024"
  let dalle3Sizes = @["1024x1024", "1792x1024", "1024x1792"]
  let dalle2Sizes = @["256x256", "512x512", "1024x1024"]
  let gptImageSizes = @["1024x1024", "1536x1024", "1024x1536"]
  let size = if self.appConfig.size == "best for orientation":
               case self.appConfig.model
               of "dall-e-3":
                 if imageWidth > imageHeight: "1792x1024"
                 elif imageWidth < imageHeight: "1024x1792"
                 else: defaultSize
               of "gpt-image-1":
                 if imageWidth > imageHeight: "1536x1024"
                 elif imageWidth < imageHeight: "1024x1536"
                 else: defaultSize
               else:
                 defaultSize
             elif self.appConfig.size != "":
               case self.appConfig.model
               of "dall-e-3":
                 if self.appConfig.size in dalle3Sizes: self.appConfig.size else: defaultSize
               of "dall-e-2":
                 if self.appConfig.size in dalle2Sizes: self.appConfig.size else: defaultSize
               of "gpt-image-1":
                 if self.appConfig.size in gptImageSizes: self.appConfig.size else: defaultSize
               else:
                 defaultSize
             else:
               defaultSize
  var body = %*{
      "prompt": prompt,
      "n": 1,
      "size": size,
      "model": self.appConfig.model
    }
  if self.appConfig.model == "dall-e-3":
    if self.appConfig.style != "":
      body["style"] = %self.appConfig.style
    if self.appConfig.quality != "":
      body["quality"] = %self.appConfig.quality
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
    let imageNode = json{"data"}{0}
    let imageBase64 = imageNode{"b64_json"}.getStr
    var imageDataBody = ""
    if imageBase64 != "":
      imageDataBody = imageBase64.decode
    else:
      let imageUrl = imageNode{"url"}.getStr
      if imageUrl == "":
        return self.error(context, "No image data returned from OpenAI.")
      var client2 = newHttpClient(timeout = 60000)
      defer: client2.close()
      let imageData = client2.request(imageUrl, httpMethod = HttpGet)
      if imageData.code != Http200:
        return self.error(context, "Error fetching image " & $imageData.status)
      imageDataBody = imageData.body
    if self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always":
      discard self.saveAsset(prompt, ".jpg", imageDataBody, self.appConfig.saveAssets == "auto")
    if self.appConfig.metadataStateKey != "":
      var metadata = %*{
        "source": "openai",
        "prompt": prompt,
        "model": self.appConfig.model,
        "size": size,
      }
      self.scene.state[self.appConfig.metadataStateKey] = metadata

    result = decodeImageWithFallback(imageDataBody)
  except CatchableError as e:
    return self.error(context, "Error fetching image from OpenAI: " & $e.msg)
