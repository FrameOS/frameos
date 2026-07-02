import pixie
import options
import json
import base64
import strutils
import frameos/apps
import frameos/types
import frameos/utils/app_images
import frameos/utils/http_client
import frameos/utils/image

when defined(frameosEmbedded):
  import pixie/fileformats/jpeg

type
  AppConfig* = object
    prompt*: string
    model*: string
    style*: string
    quality*: string
    size*: string
    outputFormat*: string
    outputCompression*: int
    saveAssets*: string
    metadataStateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  result = renderError(self.contextImageWidth(context), self.contextImageHeight(context), message)

when defined(frameosEmbedded):
  proc bestEmbeddedGptImage2Size(width, height: int): string =
    if width > height:
      "1024x640"
    elif width < height:
      "640x1024"
    else:
      "1024x1024"

proc isGptImageModel(model: string): bool =
  model.startsWith("gpt-image-")

proc get*(self: App, context: ExecutionContext): Image =
  let prompt = self.appConfig.prompt
  if prompt == "":
    return self.error(context, "No prompt provided in app config.")
  self.ensureEmbeddedServiceSettings()
  let apiKey = self.frameConfig.settings{"openAI"}{"apiKey"}.getStr
  if apiKey == "":
    return self.error(context, "Please provide an OpenAI API key in the settings.")

  let imageWidth = self.contextImageWidth(context)
  let imageHeight = self.contextImageHeight(context)
  let defaultSize = "1024x1024"
  let dalle3Sizes = @["1024x1024", "1792x1024", "1024x1792"]
  let dalle2Sizes = @["256x256", "512x512", "1024x1024"]
  let gptImageSizes = @["1024x1024", "1536x1024", "1024x1536"]
  let gptImage2Sizes = @["1024x640", "640x1024", "1024x1024", "1536x1024", "1024x1536"]
  let size = if self.appConfig.size == "best for orientation":
               case self.appConfig.model
               of "dall-e-3":
                 if imageWidth > imageHeight: "1792x1024"
                 elif imageWidth < imageHeight: "1024x1792"
                 else: defaultSize
               of "gpt-image-2":
                 when defined(frameosEmbedded):
                   bestEmbeddedGptImage2Size(imageWidth, imageHeight)
                 else:
                   if imageWidth > imageHeight: "1536x1024"
                   elif imageWidth < imageHeight: "1024x1536"
                   else: defaultSize
               of "gpt-image-1", "gpt-image-1.5":
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
               of "gpt-image-2":
                 if self.appConfig.size in gptImage2Sizes: self.appConfig.size else: defaultSize
               of "gpt-image-1", "gpt-image-1.5":
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
  elif isGptImageModel(self.appConfig.model):
    if self.appConfig.quality in ["low", "medium", "high", "auto"]:
      body["quality"] = %self.appConfig.quality
    when defined(frameosEmbedded):
      body["quality"] = %"low"
      var outputFormat = self.appConfig.outputFormat
      if outputFormat == "" or outputFormat == "auto":
        outputFormat = "jpeg"
      if outputFormat in ["jpeg", "png", "webp"]:
        body["output_format"] = %outputFormat
      if outputFormat in ["jpeg", "webp"]:
        let compression = if self.appConfig.outputCompression > 0: self.appConfig.outputCompression else: 50
        body["output_compression"] = %min(max(compression, 0), 100)
    else:
      if self.appConfig.outputFormat in ["jpeg", "png", "webp"]:
        body["output_format"] = %self.appConfig.outputFormat
      if self.appConfig.outputFormat in ["jpeg", "webp"] and self.appConfig.outputCompression > 0:
        body["output_compression"] = %min(max(self.appConfig.outputCompression, 0), 100)
  try:
    var revisedPrompt = ""
    var imageDataBody = ""
    block requestScope:
      let response = boundedRequestWithHeaders(
        "https://api.openai.com/v1/images/generations",
        httpMethod = "POST",
        body = $body,
        headers = @[
          (name: "Authorization", value: "Bearer " & apiKey),
          (name: "Content-Type", value: "application/json"),
        ],
        timeoutMs = 300000,
        maxBytes = self.maxHttpResponseBytes(),
        maxSeconds = 300
      )
      if response.code != 200:
        try:
          let json = parseJson(response.body)
          let error = json{"error"}{"message"}.getStr(json{"error"}.getStr($json))
          return self.error(context, "Error making request " & $response.status & ": " & error)
        except:
          return self.error(context, "Error making request " & $response.status & ": " & response.body)
      let json = parseJson(response.body)
      let imageNode = json{"data"}{0}
      revisedPrompt = imageNode{"revised_prompt"}.getStr
      let imageBase64 = imageNode{"b64_json"}.getStr
      if imageBase64 != "":
        imageDataBody = imageBase64.decode
      else:
        let imageUrl = imageNode{"url"}.getStr
        if imageUrl == "":
          return self.error(context, "No image data returned from OpenAI.")
        let (downloadedImage, downloadedData) = self.downloadImageWithDataForContext(
          context,
          imageUrl,
          maxBytes = self.maxImageResponseBytes(),
          fallbackWidth = imageWidth,
          fallbackHeight = imageHeight
        )
        imageDataBody = downloadedData
        if self.appConfig.metadataStateKey != "":
          var metadata = %*{
            "source": "openai",
            "prompt": prompt,
            "generatedPrompt": if revisedPrompt != "": revisedPrompt else: prompt,
            "model": self.appConfig.model,
            "size": size,
          }
          if revisedPrompt != "":
            metadata["revisedPrompt"] = %revisedPrompt
          self.scene.state[self.appConfig.metadataStateKey] = metadata
        if imageDataBody.len > 0 and (self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always"):
          discard self.saveAsset(prompt, ".jpg", imageDataBody, self.appConfig.saveAssets == "auto")
        return downloadedImage
    if imageDataBody.len > 0 and (self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always"):
      discard self.saveAsset(prompt, ".jpg", imageDataBody, self.appConfig.saveAssets == "auto")
    if self.appConfig.metadataStateKey != "":
      var metadata = %*{
        "source": "openai",
        "prompt": prompt,
        "generatedPrompt": if revisedPrompt != "": revisedPrompt else: prompt,
        "model": self.appConfig.model,
        "size": size,
      }
      if revisedPrompt != "":
        metadata["revisedPrompt"] = %revisedPrompt
      self.scene.state[self.appConfig.metadataStateKey] = metadata

    when defined(frameosEmbedded):
      if imageDataBody.len <= 0:
        return self.error(context, "No image data returned from OpenAI.")
      GC_fullCollect()
      let bytes = cast[ptr UncheckedArray[uint8]](unsafeAddr imageDataBody[0])
      if imageDataBody.len > 2 and bytes[0] == 0xFF'u8 and bytes[1] == 0xD8'u8:
        let target = context.contextImage()
        if not target.isNil:
          when compiles(decodeJpegScaledInto(imageDataBody, target)):
            decodeJpegScaledInto(imageDataBody, target)
            result = target
          else:
            result = decodeImageWithFallback(unsafeAddr imageDataBody[0], imageDataBody.len, target)
        else:
          when compiles(decodeJpegScaled(imageDataBody, imageWidth, imageHeight)):
            result = decodeJpegScaled(
              imageDataBody,
              imageWidth,
              imageHeight
            )
          else:
            result = decodeImageWithFallback(unsafeAddr imageDataBody[0], imageDataBody.len)
      else:
        result = decodeImageWithFallback(unsafeAddr imageDataBody[0], imageDataBody.len)
    else:
      result = decodeImageWithDisplayBounds(imageDataBody)
  except CatchableError as e:
    return self.error(context, "Error fetching image from OpenAI: " & $e.msg)
