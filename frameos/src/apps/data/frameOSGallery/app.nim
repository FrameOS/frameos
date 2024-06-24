import pixie, strformat, json
import frameos/apps
import frameos/types
import frameos/utils/image

const BASE_URL = "https://gallery.frameos.net/image"

type
  AppConfig* = object
    category*: string
    categoryOther*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc get*(self: App, context: ExecutionContext): Image =
  let category = if self.appConfig.category == "other": self.appConfig.categoryOther else: self.appConfig.category
  self.log(%*{"category": category})
  let url = &"{BASE_URL}?category={category}"
  result = downloadImage(url)
