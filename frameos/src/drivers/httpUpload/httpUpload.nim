import pixie
import pixie/fileformats/png
import std/httpclient
import std/json
import std/strutils
import std/uri
import checksums/md5
import frameos/types

const DEFAULT_TIMEOUT_MS = 30000

type
  Driver* = ref object of FrameOSDriver
    frameOS*: FrameOS
    logger*: Logger
    url*: string
    headers*: seq[HttpHeaderPair]
    lastHash*: string

proc init*(frameOS: FrameOS): Driver =
  let config = frameOS.frameConfig.deviceConfig
  result = Driver(
    name: "httpUpload",
    frameOS: frameOS,
    logger: frameOS.logger,
    url: config.httpUploadUrl,
    headers: config.httpUploadHeaders,
    lastHash: "",
  )

proc toPng(image: Image): string =
  var pixels = image.data
  if pixels.len == 0:
    return ""
  return encodePng(image.width, image.height, 4, pixels[0].addr, pixels.len * 4)

proc buildHeaders(self: Driver, hashValue: string): HttpHeaders =
  var headers = newHttpHeaders()
  for header in self.headers:
    if header.name.len > 0:
      headers.add(header.name, header.value)
  return headers

proc logSuccess(self: Driver, status: int, hashValue: string) =
  self.logger.log(%*{
    "event": "driver:httpUpload",
    "status": status,
    "method": "POST",
    "url": self.url,
    "hash": hashValue,
  })

proc logError(self: Driver, message: string, status: int = 0) =
  let truncated = if message.len > 512: message[0 ..< 512] & "…" else: message
  var payload = %*{
    "event": "driver:httpUpload:error",
    "error": truncated,
    "url": self.url,
  }
  if status != 0:
    payload["status"] = %*status
  self.logger.log(payload)

proc render*(self: Driver, image: Image) =
  if self.url.len == 0:
    return
  try:
    let pngData = toPng(image)
    if pngData.len == 0:
      return
    let hashValue = $getMD5(pngData)
    if hashValue == self.lastHash:
      return
    self.lastHash = hashValue

    var client = newHttpClient(timeout = DEFAULT_TIMEOUT_MS)
    try:
      var headers = self.buildHeaders(hashValue)
      if not headers.hasKey("Content-Type"):
        headers["Content-Type"] = "image/png"
      let response = client.request(self.url, httpMethod = HttpPost, body = pngData, headers = headers)
      if response.code.int >= 200 and response.code.int < 300:
        self.logSuccess(response.code.int, hashValue)
      else:
        self.logError(response.body, response.code.int)
    finally:
      client.close()
  except CatchableError as e:
    self.logError($e.msg)
