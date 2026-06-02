import pixie
import pixie/fileformats/png
import std/httpclient
import std/json
import std/net
import std/strutils
import std/uri
import checksums/md5
import frameos/driver_context

const DEFAULT_TIMEOUT_MS = 30000

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
  var pixels = image.data
  if pixels.len == 0:
    return ""
  return encodePng(image.width, image.height, 4, pixels[0].addr, pixels.len * 4)

proc addDefaultHeader(headers: var HttpHeaders, name: string, value: string) =
  if not headers.hasKey(name):
    headers[name] = value

proc buildHeaders(self: Driver, image: Image, bodyBytes: int, hashValue: string): HttpHeaders =
  var headers = newHttpHeaders()
  for header in self.headers:
    if header.name.len > 0:
      headers.add(header.name, header.value)
  headers.addDefaultHeader("Content-Type", "image/png")
  headers.addDefaultHeader("X-FrameOS-Driver", self.name)
  headers.addDefaultHeader("X-FrameOS-Image-Hash", hashValue)
  headers.addDefaultHeader("X-FrameOS-Image-Width", $image.width)
  headers.addDefaultHeader("X-FrameOS-Image-Height", $image.height)
  headers.addDefaultHeader("X-FrameOS-Image-Bytes", $bodyBytes)
  return headers

proc isManagedPlainHttpHeader(name: string): bool =
  cmpIgnoreCase(name, "Host") == 0 or
    cmpIgnoreCase(name, "Connection") == 0 or
    cmpIgnoreCase(name, "Content-Length") == 0

proc plainHttpRequest(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
  let parsed = parseUri(url)
  if cmpIgnoreCase(parsed.scheme, "http") != 0:
    raise newException(ValueError, "plainHttpRequest only supports http URLs")
  if parsed.hostname.len == 0:
    raise newException(ValueError, "HTTP upload URL is missing a host")

  let port =
    if parsed.port.len > 0:
      Port(parseInt(parsed.port))
    else:
      Port(80)
  var path =
    if parsed.path.len > 0:
      parsed.path
    else:
      "/"
  if parsed.query.len > 0:
    path &= "?" & parsed.query

  var request = "POST " & path & " HTTP/1.1\r\n"
  request &= "Host: " & parsed.hostname
  if parsed.port.len > 0:
    request &= ":" & parsed.port
  request &= "\r\n"
  request &= "Connection: close\r\n"
  request &= "Content-Length: " & $body.len & "\r\n"
  for key, value in headers:
    if not isManagedPlainHttpHeader(key):
      request &= key & ": " & value & "\r\n"
  request &= "\r\n"
  request &= body

  var socket = newSocket()
  try:
    socket.connect(parsed.hostname, port, timeout = DEFAULT_TIMEOUT_MS)
    socket.send(request)

    var response = ""
    while true:
      let chunk = socket.recv(8192, timeout = DEFAULT_TIMEOUT_MS)
      if chunk.len == 0:
        break
      response &= chunk

    let headerEnd = response.find("\r\n\r\n")
    let responseHeaders =
      if headerEnd >= 0:
        response[0 ..< headerEnd]
      else:
        response
    result.body =
      if headerEnd >= 0 and headerEnd + 4 < response.len:
        response[(headerEnd + 4) .. ^1]
      else:
        ""

    let lines = responseHeaders.splitLines()
    if lines.len == 0:
      raise newException(ValueError, "HTTP upload response is empty")
    let statusParts = lines[0].splitWhitespace()
    if statusParts.len < 2:
      raise newException(ValueError, "HTTP upload response is missing a status code")
    result.status = parseInt(statusParts[1])
  finally:
    socket.close()

proc defaultRequest(url: string, body: string, headers: HttpHeaders): tuple[status: int, body: string] =
  if cmpIgnoreCase(parseUri(url).scheme, "http") == 0:
    return plainHttpRequest(url, body, headers)

  var client = newHttpClient(timeout = DEFAULT_TIMEOUT_MS)
  try:
    let response = client.request(url, httpMethod = HttpPost, body = body, headers = headers)
    result = (response.code.int, response.body)
  finally:
    client.close()

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
