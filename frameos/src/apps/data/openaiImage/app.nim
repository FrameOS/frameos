import pixie
import options
import json
import httpclient
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

  var client = newHttpClient(timeout = 60000)
  client.headers = newHttpHeaders([
      ("Authorization", "Bearer " & apiKey),
      ("Content-Type", "application/json"),
  ])
  let imageWidth = if context.hasImage: context.image.width else: self.frameConfig.renderWidth()
  let imageHeight = if context.hasImage: context.image.height else: self.frameConfig.renderHeight()
  let size = if self.appConfig.size == "best for orientation":
                if self.appConfig.model == "dall-e-3":
                  if imageWidth > imageHeight: "1792x1024"
                  elif imageWidth < imageHeight: "1024x1792"
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
    defer: client2.close()
    let imageData = client2.request(imageUrl, httpMethod = HttpGet)
    if imageData.code != Http200:
      return self.error(context, "Error fetching image " & $imageData.status)
    if self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always":
      discard self.saveAsset(prompt, ".jpg", imageData.body, self.appConfig.saveAssets == "auto")

    result = decodeImage(imageData.body)
  except CatchableError as e:
    return self.error(context, "Error fetching image from OpenAI: " & $e.msg)
