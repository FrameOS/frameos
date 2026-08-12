## Bounded HTTP helpers.
##
## Nim's stdlib HttpClient applies its `timeout` only to response reads: the
## connect, TLS-handshake and send phases block without limit, which lets a
## flaky network park the calling thread — often the render thread — for the
## full TCP retransmission window. The `bounded*` procs below speak HTTP/1.1
## over a raw socket with a connect timeout and SO_RCVTIMEO/SO_SNDTIMEO set
## before the TLS handshake, so every phase is bounded.
##
## DNS is the one phase the socket API will not let us bound: `getAddrInfo`
## runs inside `connect` before its timeout is armed. Instead of resolving per
## connect (once per redirect hop), requests resolve once up front through a
## short-lived cache that also remembers failures, so an unreachable resolver
## stalls one request per TTL window rather than every request on every worker
## thread.
##
## The embedded (ESP32) build has no std/net; requests go through
## esp_http_client + mbedTLS on the firmware's C side instead, via the
## fos_nim_http_request hook exported by the frameos_nim glue.

const
  DefaultFetchTimeoutMs* = 30000
  DefaultFetchMaxBytes* = 10 * 1024 * 1024
  DefaultFetchMaxSeconds* = 35.0
  DefaultFetchMaxRedirects* = 5

import frameos/spool

type
  SimpleHttpHeader* = tuple[name: string, value: string]

when defined(frameosEmbedded) or defined(frameosWasm):
  import std/[strformat, strutils]

  type
    HttpRequestError* = object of IOError

    BoundedHttpResponse* = object
      code*: int
      status*: string
      body*: string

    HttpBodyChunk* = object
      ## One piece of a response body. Embedded targets download into
      ## fixed-size PSRAM chunks so no response needs one large contiguous
      ## allocation; decoders consume the chunks as segments.
      data*: pointer
      len*: int

    BoundedHttpBufferResponse* = object
      code*: int
      status*: string
      body*: pointer # Contiguous view; nil when the body spans >1 chunk
      bodyLen*: int  # Total length across all chunks (or the spill file size)
      chunks*: seq[HttpBodyChunk]
      spillPath*: string # Non-empty when the body was spilled to a temp file
                         # (SD/SPIFFS) because PSRAM could not buffer it; the
                         # chunks are then empty and bodyLen is the file size.
                         # freeHttpBufferResponse deletes the file.
      when defined(frameosEmbedded):
        rawChunks: pointer
        rawChunkCount: csize_t

    HttpResponseMetadata* = object
      contentLength*: int
      etag*: string

  proc fos_nim_http_request(httpMethod: cstring, url: cstring,
                            body: pointer, bodyLen: csize_t,
                            headers: pointer, headersLen: csize_t,
                            timeoutMs: cint, maxBytes: csize_t,
                            outStatus: ptr cint, outLen: ptr csize_t):
                            pointer {.importc: "fos_nim_http_request", cdecl.}
  proc fos_nim_http_free(p: pointer) {.importc: "fos_nim_http_free", cdecl.}

  when defined(frameosEmbedded):
    type FosNimHttpChunk {.pure.} = object
      data: pointer
      len: csize_t

    proc fos_nim_http_request_chunked_spill(httpMethod: cstring, url: cstring,
                            body: pointer, bodyLen: csize_t,
                            headers: pointer, headersLen: csize_t,
                            timeoutMs: cint, maxBytes: csize_t,
                            outStatus: ptr cint, outChunkCount: ptr csize_t,
                            outSpillPath: ptr cstring, outSpillLen: ptr csize_t):
                            ptr UncheckedArray[FosNimHttpChunk]
                            {.importc: "fos_nim_http_request_chunked_spill", cdecl.}
    proc fos_nim_http_free_chunks(chunks: pointer, count: csize_t)
                            {.importc: "fos_nim_http_free_chunks", cdecl.}
    proc c_remove(path: cstring): cint
                            {.importc: "remove", header: "<stdio.h>".}

  proc encodeSimpleHeaders(headers: seq[SimpleHttpHeader]): string =
    for header in headers:
      let name = header.name.strip()
      if name.len == 0:
        continue
      if name.contains(":") or name.contains("\r") or name.contains("\n"):
        raise newException(ValueError, "Invalid HTTP header name: " & name)
      let value = header.value.replace("\r", " ").replace("\n", " ").strip()
      result.add(name & ": " & value & "\n")

  proc requireHttpResponseWithinLimit*(content: string, maxBytes: int) =
    if maxBytes > 0 and content.len > maxBytes:
      raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")

  proc freeHttpBufferResponse*(response: var BoundedHttpBufferResponse) =
    when defined(frameosEmbedded):
      if response.spillPath.len > 0:
        # Spilled bodies are single-use temp files; remove as soon as the
        # consumer is done. Boot-time sweeps catch crash leftovers.
        discard c_remove(response.spillPath.cstring)
        response.spillPath = ""
      if response.rawChunks != nil:
        fos_nim_http_free_chunks(response.rawChunks, response.rawChunkCount)
        response.rawChunks = nil
        response.rawChunkCount = 0
        response.body = nil
        response.bodyLen = 0
        response.chunks = @[]
        return
    if response.body != nil:
      fos_nim_http_free(response.body)
      response.body = nil
      response.bodyLen = 0
      response.chunks = @[]

  proc boundedRequestBuffer*(
      url: string,
      httpMethod = "GET",
      body = "",
      timeoutMs = DefaultFetchTimeoutMs,
      maxBytes = DefaultFetchMaxBytes,
      maxSeconds = DefaultFetchMaxSeconds,
      headers: seq[SimpleHttpHeader] = @[]
    ): BoundedHttpBufferResponse =
    ## Returns the C-owned response buffer directly on embedded targets.
    ## Callers must release it with freeHttpBufferResponse once they have
    ## decoded or copied the bytes they need.
    if url.strip().len == 0:
      raise newException(ValueError, "Invalid HTTP URL: empty")
    if not (url.startsWith("http://") or url.startsWith("https://")):
      raise newException(ValueError, &"Invalid HTTP URL: {url}")
    var status: cint = 0
    let bodyPtr = if body.len > 0: unsafeAddr body[0] else: nil
    let headerBlock = encodeSimpleHeaders(headers)
    let headerPtr = if headerBlock.len > 0: unsafeAddr headerBlock[0] else: nil
    when defined(frameosEmbedded):
      var chunkCount: csize_t = 0
      var spillPath: cstring = nil
      var spillLen: csize_t = 0
      let rawChunks = fos_nim_http_request_chunked_spill(httpMethod.cstring, url.cstring,
                                     bodyPtr, body.len.csize_t,
                                     headerPtr, headerBlock.len.csize_t,
                                     timeoutMs.cint, maxBytes.csize_t,
                                     addr status, addr chunkCount,
                                     addr spillPath, addr spillLen)
      if rawChunks == nil and status == 0:
        if spillPath != nil:
          discard c_remove(spillPath)
          fos_nim_http_free(spillPath)
        raise newException(IOError, &"HTTP request failed: {url}")
      result.code = status.int
      result.status = $status
      result.rawChunks = rawChunks
      result.rawChunkCount = chunkCount
      var total = 0
      if rawChunks != nil:
        result.chunks = newSeq[HttpBodyChunk](chunkCount.int)
        for i in 0 ..< chunkCount.int:
          result.chunks[i] = HttpBodyChunk(
            data: rawChunks[i].data, len: rawChunks[i].len.int)
          total += rawChunks[i].len.int
      if spillPath != nil:
        # The whole body lives in a temp file; the chunk array is a single
        # empty placeholder. Leave `body` nil so nobody misreads it.
        result.spillPath = $spillPath
        fos_nim_http_free(spillPath)
        result.bodyLen = spillLen.int
      else:
        result.bodyLen = total
        if result.chunks.len == 1:
          result.body = result.chunks[0].data
    else:
      var outLen: csize_t = 0
      let buf = fos_nim_http_request(httpMethod.cstring, url.cstring,
                                     bodyPtr, body.len.csize_t,
                                     headerPtr, headerBlock.len.csize_t,
                                     timeoutMs.cint, maxBytes.csize_t,
                                     addr status, addr outLen)
      if buf == nil and status == 0:
        raise newException(IOError, &"HTTP request failed: {url}")
      result.code = status.int
      result.status = $status
      result.body = buf
      result.bodyLen = outLen.int
      if buf != nil:
        result.chunks = @[HttpBodyChunk(data: buf, len: outLen.int)]

  proc boundedRequest*(
      url: string,
      httpMethod = "GET",
      body = "",
      timeoutMs = DefaultFetchTimeoutMs,
      maxBytes = DefaultFetchMaxBytes,
      maxSeconds = DefaultFetchMaxSeconds,
      headers: seq[SimpleHttpHeader] = @[]
    ): BoundedHttpResponse =
    ## The C glue follows up to 5 redirects itself (the manual open/read flow
    ## bypasses esp_http_client_perform's redirect handling) and bounds every
    ## phase with its own timeout; maxSeconds is approximated by the C side's
    ## overall timeout.
    var response = boundedRequestBuffer(
      url,
      httpMethod = httpMethod,
      body = body,
      timeoutMs = timeoutMs,
      maxBytes = maxBytes,
      maxSeconds = maxSeconds,
      headers = headers
    )
    try:
      if response.spillPath.len > 0:
        # The body only exists because it did NOT fit in memory; copying it
        # into a Nim string would recreate the OOM this path avoids. Only
        # buffer-aware consumers (image decode) handle spilled bodies.
        raise newException(IOError,
          &"HTTP response ({response.bodyLen} bytes) was spilled to storage; " &
          "it is too large to load into memory")
      result.code = response.code
      result.status = response.status
      if response.bodyLen > 0:
        result.body = newString(response.bodyLen)
        var pos = 0
        for chunk in response.chunks:
          if chunk.len > 0:
            copyMem(addr result.body[pos], chunk.data, chunk.len)
            pos += chunk.len
    finally:
      response.freeHttpBufferResponse()

  proc boundedRequestContent*(
      url: string,
      httpMethod = "GET",
      body = "",
      timeoutMs = DefaultFetchTimeoutMs,
      maxBytes = DefaultFetchMaxBytes,
      maxSeconds = DefaultFetchMaxSeconds,
      headers: seq[SimpleHttpHeader] = @[]
    ): string =
    let response = boundedRequest(url, httpMethod, body, timeoutMs, maxBytes, maxSeconds, headers)
    if response.code >= 400:
      let detail = if response.body.len > 0: ": " & response.body else: ""
      raise newException(HttpRequestError, "HTTP " & response.status & detail)
    result = response.body

  proc boundedGetContent*(
      url: string,
      timeoutMs = DefaultFetchTimeoutMs,
      maxBytes = DefaultFetchMaxBytes,
      maxSeconds = DefaultFetchMaxSeconds,
      headers: seq[SimpleHttpHeader] = @[]
    ): string =
    boundedRequestContent(url, httpMethod = "GET", timeoutMs = timeoutMs,
                          maxBytes = maxBytes, maxSeconds = maxSeconds,
                          headers = headers)

  proc boundedPostContent*(
      url: string,
      body = "",
      timeoutMs = DefaultFetchTimeoutMs,
      maxBytes = DefaultFetchMaxBytes,
      maxSeconds = DefaultFetchMaxSeconds,
      headers: seq[SimpleHttpHeader] = @[]
    ): string =
    boundedRequestContent(url, httpMethod = "POST", body = body,
                          timeoutMs = timeoutMs, maxBytes = maxBytes,
                          maxSeconds = maxSeconds, headers = headers)

  proc bufferChunksToString(response: BoundedHttpBufferResponse): string =
    result = newString(response.bodyLen)
    var pos = 0
    for chunk in response.chunks:
      if chunk.len > 0:
        copyMem(addr result[pos], chunk.data, chunk.len)
        pos += chunk.len

  proc boundedGetSpool*(
      url: string,
      timeoutMs = DefaultFetchTimeoutMs,
      maxBytes = DefaultFetchMaxBytes,
      maxSeconds = DefaultFetchMaxSeconds,
      headers: seq[SimpleHttpHeader] = @[],
      spoolThresholdBytes = 0,
      spoolDir = "",
      spoolName = "body.tmp"
    ): Spool =
    ## GET whose 2xx body lands in a Spool without a whole-body copy.
    ##
    ## A body the C side already spilled to storage (PSRAM could not buffer
    ## it) is ADOPTED as the spool's backing file — the download that used to
    ## be refused outright ("too large to load into memory") now costs a
    ## window to consume. A body still sitting in PSRAM chunks is either
    ## windowed into the spool writer past the threshold or assembled into an
    ## in-memory spool below it, which is exactly what today's string path
    ## paid.
    var response = boundedRequestBuffer(
      url, httpMethod = "GET", timeoutMs = timeoutMs, maxBytes = maxBytes,
      maxSeconds = maxSeconds, headers = headers)
    try:
      if response.code >= 400:
        # Error bodies become the error message; a spilled error body (odd,
        # but possible) is not worth pulling back into memory for one.
        let detail =
          if response.spillPath.len == 0 and response.bodyLen > 0:
            ": " & bufferChunksToString(response)
          else:
            ""
        raise newException(HttpRequestError, "HTTP " & response.status & detail)
      if response.spillPath.len > 0:
        # Take ownership: the spill file IS the spool's file. Clearing
        # spillPath keeps freeHttpBufferResponse from deleting it; the spool's
        # destructor inherits that job.
        let path = response.spillPath
        response.spillPath = ""
        return newFileSpool(path, response.bodyLen)
      if spoolThresholdBytes > 0 and response.bodyLen > spoolThresholdBytes:
        var writer = initSpoolWriter(spoolThresholdBytes, spoolDir)
        for chunk in response.chunks:
          if chunk.len > 0:
            writer.add(toOpenArray(cast[ptr UncheckedArray[char]](chunk.data),
              0, chunk.len - 1), spoolName)
        return writer.finish()
      newMemorySpool(bufferChunksToString(response))
    finally:
      response.freeHttpBufferResponse()

  proc boundedRequestWithHeaders*(
      url: string,
      httpMethod = "GET",
      body = "",
      headers: seq[SimpleHttpHeader] = @[],
      timeoutMs = DefaultFetchTimeoutMs,
      maxBytes = DefaultFetchMaxBytes,
      maxSeconds = DefaultFetchMaxSeconds,
      maxRedirects = DefaultFetchMaxRedirects
    ): BoundedHttpResponse =
    ## maxRedirects is accepted for signature parity with the native build; the
    ## C glue caps redirects itself.
    discard maxRedirects
    boundedRequest(url, httpMethod = httpMethod, body = body, timeoutMs = timeoutMs,
                   maxBytes = maxBytes, maxSeconds = maxSeconds, headers = headers)

else:
  import std/[httpclient, locks, nativesockets, net, posix, strformat, strutils,
              tables, times, uri]

  const
    RecvChunkBytes = 65536
    DnsSuccessTtlSeconds = 60.0
    DnsFailureTtlSeconds = 10.0
    DnsCacheMaxEntries = 64

  type DnsCacheEntry = object
    address: string ## empty when the last resolution failed
    expiresAt: float

  var
    dnsCacheLock: Lock
    dnsCache: Table[string, DnsCacheEntry]

  initLock(dnsCacheLock)

  proc cachedAddress(host: string): tuple[hit: bool, address: string] {.gcsafe.} =
    let now = epochTime()
    {.gcsafe.}:
      withLock dnsCacheLock:
        if dnsCache.hasKey(host):
          let entry = dnsCache[host]
          if entry.expiresAt > now:
            return (true, entry.address)
          dnsCache.del(host)
    (false, "")

  proc rememberAddress(host, address: string, ttl: float) {.gcsafe.} =
    let expiresAt = epochTime() + ttl
    {.gcsafe.}:
      withLock dnsCacheLock:
        if dnsCache.len >= DnsCacheMaxEntries and not dnsCache.hasKey(host):
          # Crude bound instead of an LRU: the cache only exists to absorb
          # bursts, so a full reset costs one resolution per live host.
          dnsCache.clear()
        dnsCache[host] = DnsCacheEntry(address: address, expiresAt: expiresAt)

  proc forgetResolvedHosts*() {.gcsafe.} =
    ## Test seam, and worth calling if the resolver config ever changes.
    {.gcsafe.}:
      withLock dnsCacheLock:
        dnsCache.clear()

  # ---- private-network policy (cloud-managed frames) ------------------------
  # docs/cloud-frames.md: scenes installed by a cloud provider run *inside the
  # owner's LAN*, so on a managed frame HTTP to private/link-local addresses is
  # denied by default — otherwise a compromised account becomes an SSRF pivot
  # onto routers and IoT devices. The check sits on the one address every
  # request funnels through (literal or resolved, redirects included). The
  # policy is flipped by frameos/cloud/hub_client.nim from the cloud link
  # state; the only override is the local-admin-settable
  # `network.allowLocalNetworkAccess` in frame.json.

  var
    localNetworkPolicyLock: Lock
    localNetworkPolicyBlock = false
    localNetworkPolicyExempt: seq[string] ## lowercase "host:port" entries

  initLock(localNetworkPolicyLock)

  proc isPrivateNetworkAddress*(address: string): bool {.gcsafe.} =
    ## True for addresses a cloud-installed scene must not reach: loopback,
    ## RFC1918, link-local, CGNAT, 0.0.0.0/8, broadcast — and their IPv6
    ## equivalents (loopback/unspecified, ULA, link-local, mapped IPv4).
    ## Unparseable input classifies as private: the caller is about to hand
    ## the string to connect(), so failing closed is the only safe answer.
    var ip: IpAddress
    try:
      ip = parseIpAddress(address)
    except ValueError:
      return true
    case ip.family
    of IpAddressFamily.IPv4:
      let b = ip.address_v4
      if b[0] == 0: return true                               # 0.0.0.0/8 incl. unspecified
      if b[0] == 10: return true                              # 10/8
      if b[0] == 100 and (b[1] and 0b1100_0000'u8) == 64: return true # 100.64/10 CGNAT
      if b[0] == 127: return true                             # loopback
      if b[0] == 169 and b[1] == 254: return true             # link-local
      if b[0] == 172 and (b[1] and 0b1111_0000'u8) == 16: return true # 172.16/12
      if b[0] == 192 and b[1] == 0 and b[2] == 0: return true  # 192.0.0.0/24 IETF protocol assignments
      if b[0] == 192 and b[1] == 168: return true             # 192.168/16
      if b[0] == 198 and (b[1] and 0b1111_1110'u8) == 18: return true # 198.18/15 benchmarking
      if (b[0] and 0b1111_0000'u8) == 224: return true        # 224/4 multicast
      if b[0] >= 240: return true                             # 240/4 reserved, incl. 255.255.255.255
      false
    of IpAddressFamily.IPv6:
      let b = ip.address_v6
      # ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (the deprecated
      # IPv4-compatible form, which has no ffff marker at all): both carry an
      # IPv4 address in the low 32 bits, so classify that instead. Missing the
      # second form let ::127.0.0.1 through as "public".
      var zeroPrefix = true
      for i in 0 .. 9:
        if b[i] != 0: zeroPrefix = false
      let embedsIPv4 = zeroPrefix and
        ((b[10] == 0xff and b[11] == 0xff) or (b[10] == 0 and b[11] == 0))
      # :: and ::1 first: they are the unspecified/loopback addresses, not an
      # embedded 0.0.0.x.
      var allZero = true
      for i in 0 .. 14:
        if b[i] != 0: allZero = false
      if allZero and b[15] <= 1: return true
      if embedsIPv4:
        return isPrivateNetworkAddress($b[12] & "." & $b[13] & "." & $b[14] & "." & $b[15])
      # 64:ff9b::/96 — the well-known NAT64 prefix, another wrapper around an
      # IPv4 destination.
      if b[0] == 0 and b[1] == 0x64 and b[2] == 0xff and b[3] == 0x9b and
          b[4] == 0 and b[5] == 0 and b[6] == 0 and b[7] == 0 and
          b[8] == 0 and b[9] == 0 and b[10] == 0 and b[11] == 0:
        return isPrivateNetworkAddress($b[12] & "." & $b[13] & "." & $b[14] & "." & $b[15])
      if (b[0] and 0xfe) == 0xfc: return true                 # fc00::/7 ULA
      if b[0] == 0xfe and (b[1] and 0xc0) == 0x80: return true # fe80::/10 link-local
      if b[0] == 0xff: return true                            # ff00::/8 multicast
      false

  proc setLocalNetworkPolicy*(blockLocal: bool, exemptHostPorts: seq[string] = @[]) {.gcsafe.} =
    ## Activates/deactivates the private-network deny and replaces the exempt
    ## "host:port" list (the cloud provider's own API endpoint, which the local
    ## admin linked deliberately — possibly a dev provider on the LAN).
    {.gcsafe.}:
      withLock localNetworkPolicyLock:
        localNetworkPolicyBlock = blockLocal
        localNetworkPolicyExempt = @[]
        for entry in exemptHostPorts:
          localNetworkPolicyExempt.add(entry.toLowerAscii())

  proc localNetworkPolicySnapshot*(): tuple[active: bool, exemptHostPorts: seq[string]] {.gcsafe.} =
    {.gcsafe.}:
      withLock localNetworkPolicyLock:
        result = (localNetworkPolicyBlock, localNetworkPolicyExempt)

  proc enforceLocalNetworkPolicy(hostname: string, port: Port, address: string) {.gcsafe.} =
    {.gcsafe.}:
      var blocked = false
      withLock localNetworkPolicyLock:
        if localNetworkPolicyBlock:
          let key = hostname.toLowerAscii() & ":" & $int(port)
          if key notin localNetworkPolicyExempt and isPrivateNetworkAddress(address):
            blocked = true
      if blocked:
        raise newException(IOError,
          "local network access is blocked on cloud-managed frames (" &
          hostname & " resolves to " & address & ")")

  proc resolveHostBounded(host: string): string {.gcsafe.} =
    ## Resolve `host` to an IPv4 literal once per request instead of once per
    ## connect. `getAddrInfo` is bounded only by the system resolver, and
    ## `Socket.connect` runs it *before* arming its own timeout, so a blackholed
    ## resolver parks the calling thread — with 1-4 HTTP workers that is the
    ## whole server. Results are cached, failures included: a dead resolver then
    ## costs one stalled request per TTL window rather than one per request.
    ##
    ## AF_INET only, matching `newSocket()`'s domain — resolving anything the
    ## socket cannot connect to would only turn a DNS answer into a connect
    ## error.
    if host.len == 0:
      raise newException(ValueError, "Invalid HTTP URL: empty host")
    if host.isIpAddress():
      return host
    let cached = cachedAddress(host)
    if cached.hit:
      if cached.address.len == 0:
        raise newException(IOError, &"Could not resolve {host} (cached failure)")
      return cached.address

    var info: ptr AddrInfo = nil
    try:
      info = getAddrInfo(host, Port(0), AF_INET)
    except OSError as err:
      rememberAddress(host, "", DnsFailureTtlSeconds)
      raise newException(IOError, &"Could not resolve {host}: {err.msg}")
    try:
      if info != nil and info.ai_addr != nil:
        result = getAddrString(info.ai_addr)
    finally:
      if info != nil:
        freeAddrInfo(info)
    if result.len == 0:
      rememberAddress(host, "", DnsFailureTtlSeconds)
      raise newException(IOError, &"Could not resolve {host}")
    rememberAddress(host, result, DnsSuccessTtlSeconds)

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

  # Headers that authenticate the caller to one specific origin. A redirect to
  # a different origin must not carry them: an open redirect (or a compromised
  # first hop) would otherwise hand a bearer token or session cookie to
  # whatever host the Location header names.
  const CrossOriginHeaders = ["authorization", "proxy-authorization", "cookie"]

  proc effectiveHttpPort(uri: Uri): string =
    if uri.port.len > 0: uri.port
    elif uri.scheme.toLowerAscii() == "https": "443"
    else: "80"

  proc sameHttpOrigin(a, b: Uri): bool =
    a.scheme.toLowerAscii() == b.scheme.toLowerAscii() and
      a.hostname.toLowerAscii() == b.hostname.toLowerAscii() and
      effectiveHttpPort(a) == effectiveHttpPort(b)

  proc withoutCrossOriginHeaders(headers: HttpHeaders): HttpHeaders =
    result = newHttpHeaders()
    if headers == nil:
      return
    for key, value in headers:
      if key.toLowerAscii() in CrossOriginHeaders:
        continue
      result.add(key, value)

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

  type HttpBodySink* = proc(chunk: string) {.closure, gcsafe.}
    ## Receives body bytes as they come off the socket. What makes the byte
    ## side of the value pipeline work: a consumer that folds (a SpoolWriter,
    ## a hash) never needs the body to exist whole in memory.

  proc readBodyToSink(socket: Socket, headers: HttpHeaders, timeoutMs: int,
                      deadline: float, maxBytes: int, sink: HttpBodySink) =
    var received = 0
    proc push(chunk: string) =
      received += chunk.len
      if maxBytes > 0 and received > maxBytes:
        raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")
      sink(chunk)
    proc recvExactToSink(n: int) =
      var remaining = n
      while remaining > 0:
        let chunk = socket.recv(min(remaining, RecvChunkBytes),
                                timeout = ioTimeoutMs(timeoutMs, deadline))
        if chunk.len == 0:
          raise newException(IOError, "Connection closed mid HTTP response body")
        remaining -= chunk.len
        push(chunk)

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
        if maxBytes > 0 and received + chunkSize > maxBytes:
          raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")
        recvExactToSink(chunkSize)
    elif contentLengthValue.len > 0:
      let contentLength = parseInt(contentLengthValue)
      if maxBytes > 0 and contentLength > maxBytes:
        raise newException(IOError, &"HTTP response exceeded {maxBytes} bytes")
      recvExactToSink(contentLength)
    else:
      # No length information: we always send Connection: close, so read to EOF.
      while true:
        let chunk = socket.recv(RecvChunkBytes, timeout = ioTimeoutMs(timeoutMs, deadline))
        if chunk.len == 0:
          break
        push(chunk)

  proc readBoundedBody(socket: Socket, headers: HttpHeaders, timeoutMs: int,
                       deadline: float, maxBytes: int): string =
    var accumulated = ""
    readBodyToSink(socket, headers, timeoutMs, deadline, maxBytes,
      proc(chunk: string) = accumulated.add(chunk))
    accumulated

  proc singleBoundedRequest(url: string, httpMethod: HttpMethod, body: string,
                            headers: HttpHeaders, timeoutMs: int, maxBytes: int,
                            deadline: float,
                            bodySink: HttpBodySink = nil): BoundedHttpResponse =
    let parsed = parseUri(url)
    let isSsl = parsed.scheme.toLowerAscii() == "https"
    let port =
      if parsed.port.len > 0: Port(parseInt(parsed.port))
      elif isSsl: Port(443)
      else: Port(80)

    # Resolve before opening the socket: resolution can block, and the deadline
    # check below then aborts a request whose DNS already ate the budget
    # instead of starting a connect that cannot finish in time.
    let address = resolveHostBounded(parsed.hostname)
    # Every request — literal IP or DNS name, redirects included — passes its
    # connect address through the managed-frame private-network policy.
    enforceLocalNetworkPolicy(parsed.hostname, port, address)

    var sslContext: SslContext = nil
    var socket = newSocket()
    try:
      # Connect by address, but keep the hostname for SNI and the Host header.
      socket.connect(address, port, timeout = ioTimeoutMs(timeoutMs, deadline))
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
        if bodySink != nil and result.code div 100 == 2:
          # The caller folds the body as it arrives; `result.body` stays empty
          # on purpose. Only success bodies stream — a redirect or error body
          # is small and is about to become a Location header read or an error
          # message, both of which want a materialized string.
          readBodyToSink(socket, result.headers, timeoutMs, deadline, maxBytes, bodySink)
        else:
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
      maxSeconds = DefaultFetchMaxSeconds,
      maxRedirects = DefaultFetchMaxRedirects,
      bodySink: HttpBodySink = nil
    ): BoundedHttpResponse =
    ## HTTP request with every phase bounded. Each redirect is a fresh connect
    ## (and a fresh resolution for a new host), so callers that talk to a known
    ## endpoint should keep `maxRedirects` low.
    ##
    ## With `bodySink`, a 2xx body is handed to the sink chunk by chunk as it
    ## comes off the socket and `result.body` stays empty; everything else
    ## (redirect hops, error bodies) materializes as before.
    validateHttpUrl(url)
    let deadline = if maxSeconds > 0: epochTime() + maxSeconds else: 0.0
    var currentUrl = url
    var currentMethod = httpMethod
    var currentBody = body
    var currentHeaders = headers
    for _ in 0 .. max(maxRedirects, 0):
      result = singleBoundedRequest(currentUrl, currentMethod, currentBody, currentHeaders,
                                    timeoutMs, maxBytes, deadline, bodySink)
      if result.code notin [301, 302, 303, 307, 308]:
        return result
      let location = headerValue(result.headers, "Location")
      if location.len == 0:
        return result
      let previousUri = parseUri(currentUrl)
      currentUrl = $combine(previousUri, parseUri(location))
      validateHttpUrl(currentUrl)
      if not sameHttpOrigin(previousUri, parseUri(currentUrl)):
        currentHeaders = withoutCrossOriginHeaders(currentHeaders)
      if result.code in [301, 302, 303] and currentMethod notin {HttpGet, HttpHead}:
        currentMethod = HttpGet
        currentBody = ""
      # A redirect chain is also a chain of resolutions and connects; make sure
      # what is left of the budget can still cover one.
      discard ioTimeoutMs(timeoutMs, deadline)
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
      maxSeconds = DefaultFetchMaxSeconds,
      maxRedirects = DefaultFetchMaxRedirects
    ): string =
    let response = boundedRequest(url, httpMethod, body, headers, timeoutMs, maxBytes,
                                  maxSeconds, maxRedirects)
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

  proc simpleHeaders(headers: seq[SimpleHttpHeader]): HttpHeaders =
    result = newHttpHeaders()
    for header in headers:
      let name = header.name.strip()
      if name.len > 0:
        result[name] = header.value

  proc simpleMethod(methodName: string): HttpMethod =
    case methodName.toUpperAscii()
    of "POST": HttpPost
    of "PUT": HttpPut
    of "PATCH": HttpPatch
    of "DELETE": HttpDelete
    of "HEAD": HttpHead
    else: HttpGet

  proc boundedRequestWithHeaders*(
      url: string,
      httpMethod = "GET",
      body = "",
      headers: seq[SimpleHttpHeader] = @[],
      timeoutMs = DefaultFetchTimeoutMs,
      maxBytes = DefaultFetchMaxBytes,
      maxSeconds = DefaultFetchMaxSeconds,
      maxRedirects = DefaultFetchMaxRedirects
    ): BoundedHttpResponse =
    boundedRequest(
      url,
      httpMethod = simpleMethod(httpMethod),
      body = body,
      headers = simpleHeaders(headers),
      timeoutMs = timeoutMs,
      maxBytes = maxBytes,
      maxSeconds = maxSeconds,
      maxRedirects = maxRedirects
    )

  proc boundedGetSpool*(
      url: string,
      timeoutMs = DefaultFetchTimeoutMs,
      maxBytes = DefaultFetchMaxBytes,
      maxSeconds = DefaultFetchMaxSeconds,
      headers: seq[SimpleHttpHeader] = @[],
      spoolThresholdBytes = 0,
      spoolDir = "",
      spoolName = "body.tmp"
    ): Spool =
    ## GET whose 2xx body lands in a Spool without ever existing whole in
    ## memory: chunks stream off the socket into a SpoolWriter, which buffers
    ## a small body and spills a large one past the threshold
    ## (frameos/spool.nim). Peak memory is the window, not the document.
    ## Redirects and error bodies still materialize — they are about to become
    ## a Location hop or an error message.
    var writer = initSpoolWriter(spoolThresholdBytes, spoolDir)
    try:
      let response = boundedRequest(url, HttpGet, "", simpleHeaders(headers),
        timeoutMs, maxBytes, maxSeconds, DefaultFetchMaxRedirects,
        bodySink = proc(chunk: string) = writer.add(chunk, spoolName))
      if response.code >= 400:
        let detail = if response.body.len > 0: ": " & response.body else: ""
        raise newException(HttpRequestError, "HTTP " & response.status & detail)
      writer.finish()
    except CatchableError:
      # Close and drop whatever was written; a dropped file-backed spool
      # removes its own file.
      discard writer.finish()
      raise
