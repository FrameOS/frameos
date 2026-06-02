import std/[httpclient, strformat, strutils, times, uri]

const
  DefaultFetchTimeoutMs* = 30000
  DefaultFetchMaxBytes* = 10 * 1024 * 1024
  DefaultFetchMaxSeconds* = 35.0

proc fetchHeaders(headers: HttpHeaders): HttpHeaders =
  result = newHttpHeaders()
  if headers != nil:
    for key, value in headers:
      result[key] = value
  if not result.hasKey("Accept-Encoding"):
    result["Accept-Encoding"] = "identity"
  if not result.hasKey("Connection"):
    result["Connection"] = "close"

proc guardFetchProgress(startedAt: float, maxBytes: int, maxSeconds: float):
    proc(total, progress, speed: BiggestInt) {.closure, gcsafe.} =
  result = proc(total, progress, speed: BiggestInt) {.closure, gcsafe.} =
    if maxBytes > 0 and (total > maxBytes.BiggestInt or progress > maxBytes.BiggestInt):
      raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")
    if maxSeconds > 0 and epochTime() > startedAt + maxSeconds:
      raise newException(IOError, &"HTTP response exceeded {maxSeconds} seconds")

proc validateHttpUrl(url: string) =
  let parsed = parseUri(url)
  let scheme = parsed.scheme.toLowerAscii()
  if scheme notin ["http", "https"] or parsed.hostname.len == 0:
    raise newException(ValueError, &"Invalid HTTP URL: {url}")

proc newClientForUrl(url: string, timeoutMs: int): HttpClient =
  if parseUri(url).scheme.toLowerAscii() == "http":
    newHttpClient(timeout = timeoutMs, sslContext = nil)
  else:
    newHttpClient(timeout = timeoutMs)

proc limitHttpResponse*(client: HttpClient, maxBytes: int, maxSeconds = DefaultFetchMaxSeconds) =
  client.onProgressChanged = guardFetchProgress(epochTime(), maxBytes, maxSeconds)

proc requireHttpResponseWithinLimit*(content: string, maxBytes: int) =
  if maxBytes > 0 and content.len > maxBytes:
    raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")

proc headerValue*(headers: HttpHeaders, name: string): string =
  seq[string](headers.getOrDefault(name)).join(", ").strip()

type HttpResponseMetadata* = object
  contentLength*: int
  etag*: string

proc boundedHeadMetadata*(
    url: string,
    headers: HttpHeaders = nil,
    timeoutMs = DefaultFetchTimeoutMs,
    maxBytes = DefaultFetchMaxBytes,
    maxSeconds = DefaultFetchMaxSeconds
  ): HttpResponseMetadata =
  validateHttpUrl(url)
  var client = newClientForUrl(url, timeoutMs)
  try:
    client.headers = fetchHeaders(headers)
    client.onProgressChanged = guardFetchProgress(epochTime(), maxBytes, maxSeconds)
    let response = client.request(url, httpMethod = HttpHead)
    if response.code.is4xx or response.code.is5xx:
      raise newException(HttpRequestError, response.status)
    result = HttpResponseMetadata(
      contentLength: response.contentLength(),
      etag: headerValue(response.headers, "etag")
    )
    if maxBytes > 0 and result.contentLength > maxBytes:
      raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")
  finally:
    client.close()

proc boundedRequestContent*(
    url: string,
    httpMethod = HttpGet,
    body = "",
    headers: HttpHeaders = nil,
    timeoutMs = DefaultFetchTimeoutMs,
    maxBytes = DefaultFetchMaxBytes,
    maxSeconds = DefaultFetchMaxSeconds
  ): string =
  validateHttpUrl(url)
  var client = newClientForUrl(url, timeoutMs)
  try:
    client.headers = fetchHeaders(headers)
    client.onProgressChanged = guardFetchProgress(epochTime(), maxBytes, maxSeconds)
    let response = client.request(url, httpMethod = httpMethod, body = body)
    if response.code.is4xx or response.code.is5xx:
      raise newException(HttpRequestError, response.status)
    if maxBytes > 0 and response.contentLength() > maxBytes:
      raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")
    let responseBody = response.body
    if maxBytes > 0 and responseBody.len > maxBytes:
      raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")
    result = responseBody
  finally:
    client.close()

proc boundedGetContent*(
    url: string,
    headers: HttpHeaders = nil,
    timeoutMs = DefaultFetchTimeoutMs,
    maxBytes = DefaultFetchMaxBytes,
    maxSeconds = DefaultFetchMaxSeconds
  ): string =
  boundedRequestContent(
    url,
    httpMethod = HttpGet,
    headers = headers,
    timeoutMs = timeoutMs,
    maxBytes = maxBytes,
    maxSeconds = maxSeconds
  )

proc boundedPostContent*(
    url: string,
    body = "",
    headers: HttpHeaders = nil,
    timeoutMs = DefaultFetchTimeoutMs,
    maxBytes = DefaultFetchMaxBytes,
    maxSeconds = DefaultFetchMaxSeconds
  ): string =
  boundedRequestContent(
    url,
    httpMethod = HttpPost,
    body = body,
    headers = headers,
    timeoutMs = timeoutMs,
    maxBytes = maxBytes,
    maxSeconds = maxSeconds
  )
