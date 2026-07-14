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
  let target = context.contextImage()
  result = galleryDownloadHook(url, self.maxImageResponseBytes(), target,
      scaledDecodeFitForFrame(self.frameConfig))
