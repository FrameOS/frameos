import pixie, strformat, json
import frameos/apps
import frameos/types
import frameos/utils/image

const BASE_URL = "https://gallery.frameos.net/image"

type GalleryDownloadHook* = proc(url: string): Image

proc defaultGalleryDownload(url: string): Image =
  downloadImage(url)

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
  result = galleryDownloadHook(url)
