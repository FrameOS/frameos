import pixie
import strformat
import strutils
import httpclient
import frameos/apps
import frameos/types
import frameos/utils/image
import nre
import times
import random

type
  AppConfig* = object
    mode*: string
    submode*: string
    saveAssets*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc init*(self: App) =
  randomize()
  self.appConfig.mode = self.appConfig.mode.strip()
  self.appConfig.submode = self.appConfig.submode.strip()

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  result = renderError(if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
        if context.hasImage: context.image.height else: self.frameConfig.renderHeight(), message)

proc getImageUrlFromFilePage(client: HttpClient, fileUrl: string): string =
  # Fetch the file page and extract the original file URL
  let response = client.request(fileUrl, httpMethod = HttpGet)
  if response.code != Http200:
    raise newException(CatchableError, &"Error fetching file page: {response.status}")
  
  let body = response.body
  # Look for <a href="...">Original file</a>
  let m = body.match(re"""<a href="([^"]+)"[^>]*>Original file</a>""")
  if m.isSome:
    let href = m.get.captures[0]
    result = if href.startsWith("http"): href else: "https:" & href
  else:
    raise newException(CatchableError, "Could not find original file link")

proc getPotdInfo(client: HttpClient, year: int, month: int, day: int): tuple[url: string, description: string] =
  let url = &"https://commons.wikimedia.org/wiki/Template:Potd/{year}-{month:02d}"
  let response = client.request(url, httpMethod = HttpGet)
  if response.code != Http200:
    raise newException(CatchableError, &"Error fetching POTD template: {response.status}")
  
  let body = response.body
  # Find the div with id="day"
  let divPattern = &"id=\"{day}\""
  let divStart = body.find(divPattern)
  if divStart == -1:
    raise newException(CatchableError, &"No POTD for {year}-{month:02d}-{day:02d}")
  
  # Find the end of the div, assuming it's the next </div>
  let divEnd = body.find("</div>", divStart)
  if divEnd == -1:
    raise newException(CatchableError, "Malformed HTML")
  
  let divContent = body[divStart..divEnd]
  
  # Extract href
  let mHref = divContent.match(re"""<a href="([^"]+)" class="mw-file-description">""")
  if mHref.isNone:
    raise newException(CatchableError, "No image link found")
  let href = mHref.get.captures[0]
  let fileUrl = "https://commons.wikimedia.org" & href
  
  # Extract description
  let mDesc = divContent.match(re"""<div class="description en">([^<]*)</div>""")
  let description = if mDesc.isSome: mDesc.get.captures[0] else: ""
  
  result = (fileUrl, description)

proc getRandomImage(client: HttpClient): tuple[url: string, description: string] =
  # Fetch random file page
  let url = "https://commons.wikimedia.org/wiki/Special:Random/File"
  let response = client.request(url, httpMethod = HttpGet)
  if response.code != Http200:
    raise newException(CatchableError, &"Error fetching random file: {response.status}")
  
  let body = response.body
  # Extract href
  let mHref = body.match(re"""<a href="([^"]+)"[^>]*>Original file</a>""")
  if mHref.isNone:
    raise newException(CatchableError, "Could not find original file link")
  
  let href = mHref.get.captures[0]
  let imageUrl = if href.startsWith("http"): href else: "https:" & href
  
  # For description, from title
  let mTitle = body.match(re"""<title>([^<]+)</title>""")
  let description = if mTitle.isSome: mTitle.get.captures[0] else: ""
  
  result = (imageUrl, description)

proc get*(self: App, context: ExecutionContext): Image =
  let width = if context.hasImage: context.image.width else: self.frameConfig.renderWidth()
  let height = if context.hasImage: context.image.height else: self.frameConfig.renderHeight()

  try:
    var client = newHttpClient(timeout = 60000)
    defer: client.close()
    
    var imageUrl: string
    var description: string
    
    if self.appConfig.mode == "random":
      (imageUrl, description) = getRandomImage(client)
    else:
      # potd mode
      let now = now()
      var year, month, day: int
      case self.appConfig.submode:
      of "day":
        year = now.year
        month = now.month.int
        day = now.monthday.int
      of "onthisday":
        year = rand(2008..now.year)
        month = now.month.int
        day = now.monthday.int
      of "month":
        year = now.year
        month = now.month.int
        day = rand(1..31)
      of "random":
        year = rand(2008..now.year)
        month = rand(1..12)
        day = rand(1..31)
      else:
        return self.error(context, "Invalid submode")
      
      var retries = 0
      while retries < 5:
        try:
          let (fileUrl, desc) = getPotdInfo(client, year, month, day)
          description = desc
          imageUrl = getImageUrlFromFilePage(client, fileUrl)
          break
        except:
          if self.appConfig.submode == "random":
            # Retry with new random date
            year = rand(2008..now.year)
            month = rand(1..12)
            day = rand(1..31)
            retries += 1
          else:
            raise
    
    if self.frameConfig.debug:
      self.log(&"Image URL: {imageUrl}")
    
    # Download the image
    let imageResponse = client.request(imageUrl, httpMethod = HttpGet)
    if imageResponse.code != Http200:
      return self.error(context, &"Error fetching image: {imageResponse.status}")
    
    if self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always":
      discard self.saveAsset(&"wikicommons {width}x{height}", ".jpg", imageResponse.body, self.appConfig.saveAssets == "auto")
    
    result = decodeImage(imageResponse.body)
  except CatchableError as e:
    return self.error(context, "Error fetching image from Wikimedia Commons: " & $e.msg)
