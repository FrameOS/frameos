import pixie, strformat, json
import frameos/apps
import frameos/types
import frameos/utils/image

const BASE_URL = "https://gallery.frameos.net/image"

type GalleryDownloadHook* = proc(url: string, maxBytes: int, proxyBaseUrl: string, target: Image): Image

proc defaultGalleryDownload(url: string, maxBytes: int, proxyBaseUrl: string, target: Image): Image =
  when defined(frameosEmbedded):
    if not target.isNil:
      return downloadImageInto(url, target, maxBytes = maxBytes, proxyBaseUrl = proxyBaseUrl)
  downloadImage(url, maxBytes = maxBytes, proxyBaseUrl = proxyBaseUrl)

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
  when defined(frameosEmbedded):
    discard self.refreshEmbeddedServiceSettings()
  let category = self.appConfig.resolvedCategory()
  self.log(%*{"category": category})
  let url = galleryUrl(category)
  let target = if context.hasImage: context.image else: nil
  result = galleryDownloadHook(url, self.maxImageResponseBytes(), self.embeddedMediaProxyBaseUrl(), target)
