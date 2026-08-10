import pixie, strformat, json
import frameos/apps
import frameos/types
import frameos/utils/app_images

const BASE_URL = "https://gallery.frameos.net/image"

type GalleryDownloadHook* = proc(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit): Image

proc defaultGalleryDownload(url: string, maxBytes: int, target: Image, fit: ScaledDecodeFit): Image =
  downloadImageForTarget(url, maxBytes, target, fit = fit)

var galleryDownloadHook*: GalleryDownloadHook = defaultGalleryDownload

type
  AppConfig* = object
    category*: string
    categoryOther*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc resolvedCategory*(appConfig: AppConfig): string =
  if appConfig.category == "other":
    appConfig.categoryOther
  else:
    appConfig.category

proc galleryUrl*(category: string): string =
  &"{BASE_URL}?category={category}"

proc get*(self: App, context: ExecutionContext): Image =
  let category = self.appConfig.resolvedCategory()
  self.log(%*{"category": category})
  let url = galleryUrl(category)
  # Decode straight into a consumer-sized target only when the interpreter
  # says the consumer will draw this full-frame, and with the placement it
  # asked for. Taking context.image plus the frame's scaling mode instead
  # meant a node asking for "contain" silently got the frame default.
  let (target, targetScalingMode) = context.takeDecodeTarget()
  try:
    result = galleryDownloadHook(url, self.maxImageResponseBytes(), target,
        scaledDecodeFit(targetScalingMode))
  except CatchableError as e:
    let detail = if e.msg.len > 0: e.msg else: "unknown error"
    self.logError "An error occurred while downloading the gallery image: " & detail
    result = self.renderErrorForContext(context,
        "An error occurred while downloading the gallery image.\n" & detail)
