## Bounded HTTP helpers.
##
## Nim's stdlib HttpClient applies its `timeout` only to response reads: the
## connect, TLS-handshake and send phases block without limit, which lets a
## flaky network park the calling thread — often the render thread — for the
## full TCP retransmission window. The `bounded*` procs below speak HTTP/1.1
## over a raw socket with a connect timeout and SO_RCVTIMEO/SO_SNDTIMEO set
## before the TLS handshake, so every phase is bounded. (DNS resolution inside
## connect() remains bounded only by the system resolver.)

import std/[httpclient, net, posix, strformat, strutils, times, uri]

const
  DefaultFetchTimeoutMs* = 30000
  DefaultFetchMaxBytes* = 10 * 1024 * 1024
  DefaultFetchMaxSeconds* = 35.0
  MaxFetchRedirects = 5
  RecvChunkBytes = 65536

proc fetchHeaders(headers: HttpHeaders): HttpHeaders =
  result = newHttpHeaders()
  if headers != nil:
    for key, value in headers:
      result[key] = value
  if not result.hasKey("Accept-Encoding"):
    result["Accept-Encoding"] = "identity"

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

proc limitHttpResponse*(client: HttpClient, maxBytes: int, maxSeconds = DefaultFetchMaxSeconds) =
  client.onProgressChanged = guardFetchProgress(epochTime(), maxBytes, maxSeconds)

proc requireHttpResponseWithinLimit*(content: string, maxBytes: int) =
  if maxBytes > 0 and content.len > maxBytes:
    raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")

proc headerValue*(headers: HttpHeaders, name: string): string =
  seq[string](headers.getOrDefault(name)).join(", ").strip()

proc setSocketSendRecvTimeouts*(socket: Socket, ms: int) =
  ## Bounds everything a connect timeout does not: the TLS handshake and
  ## blocking sends/recvs, which otherwise ride TCP retransmission for many
  ## minutes when the network goes flaky mid-connection.
  var tv = Timeval(tv_sec: posix.Time(ms div 1000), tv_usec: Suseconds((ms mod 1000) * 1000))
  discard setsockopt(socket.getFd(), SOL_SOCKET, SO_RCVTIMEO, addr tv, SockLen(sizeof(tv)))
  discard setsockopt(socket.getFd(), SOL_SOCKET, SO_SNDTIMEO, addr tv, SockLen(sizeof(tv)))

type
  BoundedHttpResponse* = object
    code*: int
    status*: string
    headers*: HttpHeaders
    body*: string

  HttpResponseMetadata* = object
    contentLength*: int
    etag*: string

proc ioTimeoutMs(timeoutMs: int, deadline: float): int =
  ## Per-operation socket timeout, clamped to whatever remains of the
  ## request's overall deadline.
  if deadline <= 0:
    return timeoutMs
  let remaining = int((deadline - epochTime()) * 1000)
  if remaining <= 0:
    raise newException(IOError, "HTTP request exceeded time limit")
  min(timeoutMs, remaining)

proc recvExact(socket: Socket, n: int, timeoutMs: int, deadline: float): string =
  result = newStringOfCap(n)
  while result.len < n:
    let chunk = socket.recv(min(n - result.len, RecvChunkBytes),
                            timeout = ioTimeoutMs(timeoutMs, deadline))
    if chunk.len == 0:
      raise newException(IOError, "Connection closed mid HTTP response body")
    result.add(chunk)

proc readBoundedBody(socket: Socket, headers: HttpHeaders, timeoutMs: int,
                     deadline: float, maxBytes: int): string =
  let contentLengthValue = headerValue(headers, "Content-Length")
  if "chunked" in headerValue(headers, "Transfer-Encoding").toLowerAscii():
    while true:
      let sizeLine = socket.recvLine(timeout = ioTimeoutMs(timeoutMs, deadline))
      if sizeLine.len == 0:
        raise newException(IOError, "Connection closed mid chunked HTTP response")
      if sizeLine == "\r\n":
        continue # the CRLF that terminates the previous chunk
      let chunkSize = parseHexInt(sizeLine.split(';')[0].strip())
      if chunkSize == 0:
        # consume optional trailers until the final blank line
        while true:
          let trailer = socket.recvLine(timeout = ioTimeoutMs(timeoutMs, deadline))
          if trailer == "\r\n" or trailer.len == 0:
            break
        break
      if maxBytes > 0 and result.len + chunkSize > maxBytes:
        raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")
      result.add(recvExact(socket, chunkSize, timeoutMs, deadline))
  elif contentLengthValue.len > 0:
    let contentLength = parseInt(contentLengthValue)
    if maxBytes > 0 and contentLength > maxBytes:
      raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")
    result = recvExact(socket, contentLength, timeoutMs, deadline)
  else:
    # No length information: we always send Connection: close, so read to EOF.
    while true:
      let chunk = socket.recv(RecvChunkBytes, timeout = ioTimeoutMs(timeoutMs, deadline))
      if chunk.len == 0:
        break
      result.add(chunk)
      if maxBytes > 0 and result.len > maxBytes:
        raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")

proc singleBoundedRequest(url: string, httpMethod: HttpMethod, body: string,
                          headers: HttpHeaders, timeoutMs: int, maxBytes: int,
                          deadline: float): BoundedHttpResponse =
  let parsed = parseUri(url)
  let isSsl = parsed.scheme.toLowerAscii() == "https"
  let port =
    if parsed.port.len > 0: Port(parseInt(parsed.port))
    elif isSsl: Port(443)
    else: Port(80)

  var sslContext: SslContext = nil
  var socket = newSocket()
  try:
    socket.connect(parsed.hostname, port, timeout = ioTimeoutMs(timeoutMs, deadline))
    socket.setSocketSendRecvTimeouts(ioTimeoutMs(timeoutMs, deadline))
    if isSsl:
      sslContext = newContext()
      sslContext.wrapConnectedSocket(socket, handshakeAsClient, parsed.hostname)

    var path = if parsed.path.len > 0: parsed.path else: "/"
    if parsed.query.len > 0:
      path &= "?" & parsed.query
    var requestHeaders = fetchHeaders(headers)
    if not requestHeaders.hasKey("Host"):
      requestHeaders["Host"] =
        if parsed.port.len > 0: parsed.hostname & ":" & parsed.port else: parsed.hostname
    requestHeaders["Connection"] = "close"
    if body.len > 0 or httpMethod in {HttpPost, HttpPut, HttpPatch}:
      requestHeaders["Content-Length"] = $body.len

    var request = $httpMethod & " " & path & " HTTP/1.1\r\n"
    for key, value in requestHeaders:
      request &= key & ": " & value & "\r\n"
    request &= "\r\n"
    socket.send(request & body)

    # Read the status line and headers, skipping any 1xx interim responses.
    while true:
      let statusLine = socket.recvLine(timeout = ioTimeoutMs(timeoutMs, deadline))
      if statusLine.len == 0:
        raise newException(IOError, "Connection closed before HTTP status line")
      let parts = statusLine.splitWhitespace(maxsplit = 2)
      if parts.len < 2 or not parts[0].startsWith("HTTP/"):
        raise newException(IOError, "Invalid HTTP status line: " & statusLine)
      result.code = parseInt(parts[1])
      result.status = (if parts.len > 2: parts[1] & " " & parts[2] else: parts[1])
      result.headers = newHttpHeaders()
      while true:
        let line = socket.recvLine(timeout = ioTimeoutMs(timeoutMs, deadline))
        if line == "\r\n" or line.len == 0:
          break
        let colon = line.find(':')
        if colon > 0:
          result.headers.add(line[0 ..< colon].strip(), line[colon + 1 .. ^1].strip())
      if result.code div 100 != 1:
        break

    if httpMethod != HttpHead and result.code notin [204, 304]:
      result.body = readBoundedBody(socket, result.headers, timeoutMs, deadline, maxBytes)
  finally:
    socket.close()
    if sslContext != nil:
      sslContext.destroyContext()

proc boundedRequest*(
    url: string,
    httpMethod = HttpGet,
    body = "",
    headers: HttpHeaders = nil,
    timeoutMs = DefaultFetchTimeoutMs,
    maxBytes = DefaultFetchMaxBytes,
    maxSeconds = DefaultFetchMaxSeconds
  ): BoundedHttpResponse =
  ## HTTP request with every phase bounded; follows up to 5 redirects.
  validateHttpUrl(url)
  let deadline = if maxSeconds > 0: epochTime() + maxSeconds else: 0.0
  var currentUrl = url
  var currentMethod = httpMethod
  var currentBody = body
  for _ in 0 .. MaxFetchRedirects:
    result = singleBoundedRequest(currentUrl, currentMethod, currentBody, headers,
                                  timeoutMs, maxBytes, deadline)
    if result.code notin [301, 302, 303, 307, 308]:
      return result
    let location = headerValue(result.headers, "Location")
    if location.len == 0:
      return result
    currentUrl = $combine(parseUri(currentUrl), parseUri(location))
    validateHttpUrl(currentUrl)
    if result.code in [301, 302, 303] and currentMethod notin {HttpGet, HttpHead}:
      currentMethod = HttpGet
      currentBody = ""
  raise newException(HttpRequestError, &"Too many HTTP redirects fetching {url}")

proc boundedHeadMetadata*(
    url: string,
    headers: HttpHeaders = nil,
    timeoutMs = DefaultFetchTimeoutMs,
    maxBytes = DefaultFetchMaxBytes,
    maxSeconds = DefaultFetchMaxSeconds
  ): HttpResponseMetadata =
  let response = boundedRequest(url, HttpHead, "", headers, timeoutMs, maxBytes, maxSeconds)
  if response.code >= 400:
    raise newException(HttpRequestError, response.status)
  let contentLengthValue = headerValue(response.headers, "Content-Length")
  result = HttpResponseMetadata(
    contentLength: (if contentLengthValue.len > 0: parseInt(contentLengthValue) else: -1),
    etag: headerValue(response.headers, "etag")
  )
  if maxBytes > 0 and result.contentLength > maxBytes:
    raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")

proc boundedRequestContent*(
    url: string,
    httpMethod = HttpGet,
    body = "",
    headers: HttpHeaders = nil,
    timeoutMs = DefaultFetchTimeoutMs,
    maxBytes = DefaultFetchMaxBytes,
    maxSeconds = DefaultFetchMaxSeconds
  ): string =
  let response = boundedRequest(url, httpMethod, body, headers, timeoutMs, maxBytes, maxSeconds)
  if response.code >= 400:
    raise newException(HttpRequestError, response.status)
  result = response.body

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
