import pixie
import std/[httpclient, json, options, random, sequtils, strformat, strutils, times, uri]
import frameos/apps
import frameos/types
import frameos/utils/http_client
import frameos/utils/image

const
  CommonsApiUrl = "https://commons.wikimedia.org/w/api.php"
  CommonsUserAgent = "FrameOS Wikimedia Commons app (https://github.com/FrameOS/frameos)"
  MaxCommonsResponseBytes = 2 * 1024 * 1024
  MaxCommonsImageBytes = 20 * 1024 * 1024
  FirstPotdYear = 2008

type
  AppConfig* = object
    mode*: string
    submode*: string
    saveAssets*: string
    metadataStateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

  CommonsDate = object
    year: int
    month: int
    day: int

  CommonsImage = object
    title: string
    imageUrl: string
    pageUrl: string
    description: string
    author: string
    license: string
    mime: string

proc init*(self: App) =
  randomize()
  self.appConfig.mode = self.appConfig.mode.strip()
  self.appConfig.submode = self.appConfig.submode.strip()
  self.appConfig.metadataStateKey = self.appConfig.metadataStateKey.strip()

proc error*(self: App, context: ExecutionContext, message: string): Image =
  self.logError(message)
  result = renderError(if context.hasImage: context.image.width else: self.frameConfig.renderWidth(),
        if context.hasImage: context.image.height else: self.frameConfig.renderHeight(), message)

proc commonsHeaders(): HttpHeaders =
  newHttpHeaders([
    ("Accept", "application/json"),
    ("User-Agent", CommonsUserAgent),
  ])

proc queryString(params: openArray[(string, string)]): string =
  params.mapIt(encodeUrl(it[0]) & "=" & encodeUrl(it[1])).join("&")

proc fetchCommonsJson(params: openArray[(string, string)]): JsonNode =
  var allParams = @[
    ("format", "json"),
    ("formatversion", "2")
  ]
  allParams.add(params)
  let body = boundedGetContent(
    CommonsApiUrl & "?" & queryString(allParams),
    headers = commonsHeaders(),
    timeoutMs = 60000,
    maxBytes = MaxCommonsResponseBytes,
    maxSeconds = 60
  )
  result = parseJson(body)
  if result.hasKey("error"):
    let message = result["error"]{"info"}.getStr($result["error"])
    raise newException(CatchableError, "Wikimedia Commons API error: " & message)

proc isLeapYear(year: int): bool =
  (year mod 4 == 0 and year mod 100 != 0) or year mod 400 == 0

proc daysInMonth(year: int, month: int): int =
  case month
  of 1, 3, 5, 7, 8, 10, 12: 31
  of 4, 6, 9, 11: 30
  of 2: (if isLeapYear(year): 29 else: 28)
  else: 0

proc todayDate(): CommonsDate =
  let current = now()
  CommonsDate(year: current.year, month: current.month.int, day: current.monthday.int)

proc dateString(date: CommonsDate): string =
  &"{date.year}-{date.month:02d}-{date.day:02d}"

proc randomPreviousDate(today: CommonsDate): CommonsDate =
  let year = rand(FirstPotdYear..today.year)
  let maxMonth = if year == today.year: today.month else: 12
  let month = rand(1..maxMonth)
  var maxDay = daysInMonth(year, month)
  if year == today.year and month == today.month:
    maxDay = min(maxDay, today.day)
  CommonsDate(year: year, month: month, day: rand(1..maxDay))

proc randomOnThisDay(today: CommonsDate): CommonsDate =
  let maxYear = max(FirstPotdYear, today.year - 1)
  for _ in 0 ..< 100:
    let year = rand(FirstPotdYear..maxYear)
    if today.day <= daysInMonth(year, today.month):
      return CommonsDate(year: year, month: today.month, day: today.day)
  raise newException(CatchableError, "No previous Wikimedia Commons picture of the day exists for this date.")

proc stripHtml(value: string): string =
  var inTag = false
  for ch in value:
    case ch
    of '<':
      inTag = true
    of '>':
      inTag = false
    else:
      if not inTag:
        result.add(ch)
  result = result.replace("&quot;", "\"")
  result = result.replace("&amp;", "&")
  result = result.replace("&#039;", "'")
  result = result.replace("&apos;", "'")
  result = result.replace("&lt;", "<")
  result = result.replace("&gt;", ">")
  result = result.strip()

proc metadataValue(imageInfo: JsonNode, key: string): string =
  let metadata = imageInfo{"extmetadata"}
  if metadata.kind == JObject and metadata.hasKey(key):
    return metadata[key]{"value"}.getStr().stripHtml()
  ""

proc imageExtension(image: CommonsImage): string =
  let urlPath = image.imageUrl.split("?")[0].toLowerAscii()
  for ext in [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"]:
    if urlPath.endsWith(ext):
      return if ext == ".jpeg": ".jpg" else: ext
  case image.mime
  of "image/jpeg": ".jpg"
  of "image/png": ".png"
  of "image/gif": ".gif"
  of "image/webp": ".webp"
  of "image/svg+xml": ".svg"
  else: ".img"

proc imageFromPage(page: JsonNode): Option[CommonsImage] =
  let info = page{"imageinfo"}{0}
  if info.kind != JObject:
    return none(CommonsImage)

  let mime = info{"mime"}.getStr()
  if not mime.startsWith("image/"):
    return none(CommonsImage)

  let imageUrl = info{"thumburl"}.getStr(info{"url"}.getStr())
  if imageUrl == "":
    return none(CommonsImage)

  let title = page{"title"}.getStr()
  let description = metadataValue(info, "ImageDescription")
  result = some(CommonsImage(
    title: title,
    imageUrl: imageUrl,
    pageUrl: info{"descriptionurl"}.getStr(),
    description: if description != "": description else: metadataValue(info, "ObjectName"),
    author: metadataValue(info, "Artist"),
    license: metadataValue(info, "LicenseShortName"),
    mime: mime
  ))

proc firstImageFromQuery(json: JsonNode): CommonsImage =
  let pages = json{"query"}{"pages"}
  if pages.kind == JArray:
    for page in pages:
      let image = imageFromPage(page)
      if image.isSome:
        return image.get()
  raise newException(CatchableError, "No supported image returned from Wikimedia Commons.")

proc fetchPotdImage(date: CommonsDate, thumbnailWidth: int): CommonsImage =
  firstImageFromQuery(fetchCommonsJson([
    ("action", "query"),
    ("generator", "images"),
    ("titles", "Template:Potd/" & date.dateString()),
    ("gimlimit", "20"),
    ("prop", "imageinfo"),
    ("iiprop", "url|mime|size|extmetadata"),
    ("iiurlwidth", $thumbnailWidth)
  ]))

proc fetchRandomImage(thumbnailWidth: int): CommonsImage =
  firstImageFromQuery(fetchCommonsJson([
    ("action", "query"),
    ("generator", "random"),
    ("grnnamespace", "6"),
    ("grnlimit", "20"),
    ("prop", "imageinfo"),
    ("iiprop", "url|mime|size|extmetadata"),
    ("iiurlwidth", $thumbnailWidth)
  ]))

proc normalizedMode(self: App): string =
  case self.appConfig.mode
  of "", "potd", "pictureOfTheDay":
    case self.appConfig.submode
    of "", "day": "pictureOfTheDay"
    of "onthisday", "onThisDay": "onThisDay"
    of "month", "random", "randomPotd", "randomPictureOfTheDay": "randomPictureOfTheDay"
    else: self.appConfig.mode
  of "random": "randomImage"
  else: self.appConfig.mode

proc fetchImageForMode(self: App, thumbnailWidth: int): CommonsImage =
  let today = todayDate()
  case self.normalizedMode()
  of "pictureOfTheDay":
    fetchPotdImage(today, thumbnailWidth)
  of "onThisDay":
    fetchPotdImage(randomOnThisDay(today), thumbnailWidth)
  of "randomPictureOfTheDay":
    var lastError = ""
    for _ in 0 ..< 10:
      try:
        return fetchPotdImage(randomPreviousDate(today), thumbnailWidth)
      except CatchableError as err:
        lastError = err.msg
    raise newException(CatchableError, "Could not find a random Wikimedia Commons picture of the day: " & lastError)
  of "randomImage":
    var lastError = ""
    for _ in 0 ..< 10:
      try:
        return fetchRandomImage(thumbnailWidth)
      except CatchableError as err:
        lastError = err.msg
    raise newException(CatchableError, "Could not find a random Wikimedia Commons image: " & lastError)
  else:
    raise newException(ValueError, "Invalid Wikimedia Commons mode: " & self.appConfig.mode)

proc get*(self: App, context: ExecutionContext): Image =
  let width = if context.hasImage: context.image.width else: self.frameConfig.renderWidth()
  let height = if context.hasImage: context.image.height else: self.frameConfig.renderHeight()

  try:
    let commonsImage = self.fetchImageForMode(max(max(width, height), 1))

    if self.frameConfig.debug:
      self.log(&"Downloading Wikimedia Commons image: {commonsImage.imageUrl}")

    let imageData = boundedGetContent(
      commonsImage.imageUrl,
      headers = newHttpHeaders([("User-Agent", CommonsUserAgent)]),
      timeoutMs = 60000,
      maxBytes = MaxCommonsImageBytes,
      maxSeconds = 60
    )

    if self.appConfig.metadataStateKey != "":
      self.scene.state[self.appConfig.metadataStateKey] = %*{
        "source": "wikimedia-commons",
        "mode": self.normalizedMode(),
        "title": commonsImage.title,
        "description": commonsImage.description,
        "author": commonsImage.author,
        "license": commonsImage.license,
        "pageUrl": commonsImage.pageUrl,
        "imageUrl": commonsImage.imageUrl,
        "mime": commonsImage.mime
      }

    if self.appConfig.saveAssets == "auto" or self.appConfig.saveAssets == "always":
      discard self.saveAsset(commonsImage.title.replace("File:", ""), commonsImage.imageExtension(),
        imageData, self.appConfig.saveAssets == "auto")

    result = decodeImageWithFallback(imageData)
  except CatchableError as e:
    return self.error(context, "Error fetching image from Wikimedia Commons: " & e.msg)
