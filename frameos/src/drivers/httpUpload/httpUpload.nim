import pixie
import pixie/fileformats/png
import std/httpclient
import std/json
import std/strutils
import checksums/md5
import frameos/driver_context
import frameos/utils/http_client

const
  DEFAULT_TIMEOUT_MS = 30000
  ## The upload is bounded end to end: DNS, connect, TLS, the PNG going out
  ## and the reply coming back all fit inside this budget.
  UPLOAD_MAX_SECONDS = 90.0
  ## The reply is only ever logged (truncated to 512 bytes), so a receiver
  ## that answers with a page is cut off here rather than buffered whole.
  UPLOAD_MAX_RESPONSE_BYTES = 256 * 1024

type
  Driver* = ref object of FrameOSDriver
    logger*: DriverLogger
    url*: string
    headers*: seq[HttpHeaderPair]
    lastHash*: string

  HttpUploadRequestFn* = proc(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] {.gcsafe.}

var requestHook*: HttpUploadRequestFn

proc init*(frameOS: DriverContext): Driver =
  let config = frameOS.frameConfig.deviceConfig
  result = Driver(
    name: "httpUpload",
    logger: frameOS.logger,
    url: config.httpUploadUrl,
    headers: config.httpUploadHeaders,
    lastHash: "",
  )

proc toPng(image: Image): string =
  var pixels = image.toContiguousSeq()
  if pixels.len == 0:
    return ""
  return encodePng(image.width, image.height, 4, pixels[0].addr, pixels.len * 4)

proc addDefaultHeader(headers: var HttpHeaders, name: string, value: string) =
  if not headers.hasKey(name):
    headers[name] = value

proc buildHeaders*(self: Driver, image: Image, bodyBytes: int, hashValue: string): HttpHeaders =
  ## Configured headers first, then the driver's own defaults where the user
  ## set nothing. Every configured header goes through the runtime client's
  ## validator: a name that is not an RFC 9110 token or a value carrying CR,
  ## LF or another control byte would otherwise become a second header on the
  ## wire. Hop-by-hop and framing headers (Host, Content-Length, Connection…)
  ## belong to the client and are dropped rather than sent twice.
  var headers = newHttpHeaders()
  for header in self.headers:
    let name = header.name.strip()
    if name.len == 0:
      continue
    if isReservedHttpHeader(name):
      continue
    validateHttpHeader(name, header.value)
    headers.add(name, header.value)
  headers.addDefaultHeader("Content-Type", "image/png")
  headers.addDefaultHeader("X-FrameOS-Driver", self.name)
  headers.addDefaultHeader("X-FrameOS-Image-Hash", hashValue)
  headers.addDefaultHeader("X-FrameOS-Image-Width", $image.width)
  headers.addDefaultHeader("X-FrameOS-Image-Height", $image.height)
  headers.addDefaultHeader("X-FrameOS-Image-Bytes", $bodyBytes)
  return headers

proc defaultRequest(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
  ## One POST on the runtime's bounded client (frameos/utils/http_client):
  ## resolve-once, connect and socket timeouts, TLS, a response cap and no
  ## redirect following — an upload target is a literal endpoint, and a
  ## 301/302 would turn the POST into a bodiless GET that "succeeds".
  let response = boundedRequest(
    url,
    httpMethod = HttpPost,
    body = body,
    headers = headers,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = UPLOAD_MAX_RESPONSE_BYTES,
    maxSeconds = UPLOAD_MAX_SECONDS,
    maxRedirects = 0,
  )
  (response.code, response.body)

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

    var headers = self.buildHeaders(image, pngData.len, hashValue)
    let requestFn = if requestHook != nil: requestHook else: defaultRequest
    let response = requestFn(self.url, pngData, headers)
    if response.status >= 200 and response.status < 300:
      self.logSuccess(response.status, hashValue)
    else:
      self.logError(response.body, response.status)
  except CatchableError as e:
    self.logError($e.msg)
