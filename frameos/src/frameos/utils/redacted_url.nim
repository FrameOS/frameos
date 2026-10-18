## The part of a request URL that may leave the frame.
##
## A URL a scene fetches can carry a secret anywhere past the host: a Photos
## share link is `/api/photos/shared/pk_<token>/photo?...`, API keys ride in
## query strings, presigned storage URLs sign theirs, and `user:pass@` is
## userinfo. Error messages and log lines do leave the frame — an app draws
## its error text on the panel (and so into every screenshot), the log ring
## is shipped to the control plane and printed on the USB console — so a
## message that names a request URL names it through `redactedUrl`: scheme,
## host and port, nothing else. The ESP32's C side has the same rule
## (fos_netguard_url_origin) and so does the wasm preview's HTTP hook
## (frameosLogUrl in tools/wasm/frameos_library.js).
##
## Import-light on purpose: http_client, the spawn guard and the JS bridge
## all use it, and its test compiles in a second.
##
## On the ESP32 `redactedUrl` IS fos_netguard_url_origin, which the C side
## links anyway: one copy of the rule in the firmware instead of two (the
## Nim one was 1.5 KB of flash). Both are held to the same cases.

import std/strutils

const
  InvalidUrlText* = "(invalid URL)"
    ## What `redactedUrl` answers for anything that is not
    ## `scheme://host[:port]...`: never the input echoed back, since an input
    ## that does not parse can still be a secret.
  SchemeChars = {'a'..'z', 'A'..'Z', '0'..'9', '+', '-', '.'}
  HostChars = {'a'..'z', 'A'..'Z', '0'..'9', '-', '.', '_', '~', '%', '\x80'..'\xff'}
    ## A registered name, percent-encoded or raw UTF-8 (IDN) included.
  Ipv6Chars = {'0'..'9', 'a'..'f', 'A'..'F', ':', '.'}

when defined(frameosEmbedded):
  proc fos_netguard_url_origin(url: cstring, output: cstring, outputLen: csize_t)
                              {.importc: "fos_netguard_url_origin", cdecl.}

  proc redactedUrl*(url: string): string =
    ## The origin is never longer than the URL it came from, nor the
    ## placeholder longer than itself, so nothing is cut.
    let trimmed = url.strip()
    result = newString(max(trimmed.len, InvalidUrlText.len) + 1)
    fos_netguard_url_origin(trimmed.cstring, result.cstring, result.len.csize_t)
    result.setLen(result.cstring.len)

else:
  proc redactedUrl*(url: string): string =
    ## `scheme://host[:port]` of `url`, scheme and host lowercased; userinfo,
    ## path, query and fragment dropped. An IPv6 host keeps its brackets.
    ## Anything without a scheme, with an empty or malformed host or a
    ## non-numeric port is `InvalidUrlText`.
    let trimmed = url.strip()
    let mark = trimmed.find("://")
    if mark <= 0 or trimmed[0] notin Letters:
      return InvalidUrlText
    for i in 0 ..< mark:
      if trimmed[i] notin SchemeChars:
        return InvalidUrlText
    var authorityEnd = mark + 3
    while authorityEnd < trimmed.len and trimmed[authorityEnd] notin {'/', '?', '#', '\\'}:
      inc authorityEnd
    var authority = trimmed[mark + 3 ..< authorityEnd]
    # Userinfo ends at the LAST '@', the way browsers read it: everything
    # before it is credentials, whatever it contains.
    let at = authority.rfind('@')
    if at >= 0:
      authority = authority[at + 1 .. ^1]
    var host, port: string
    if authority.startsWith("["):
      let close = authority.find(']')
      if close < 2:
        return InvalidUrlText
      for c in authority[1 ..< close]:
        if c notin Ipv6Chars:
          return InvalidUrlText
      host = authority[0 .. close]
      let rest = authority[close + 1 .. ^1]
      if rest.len > 0:
        if rest[0] != ':':
          return InvalidUrlText
        port = rest[1 .. ^1]
    else:
      let colon = authority.find(':')
      host = if colon >= 0: authority[0 ..< colon] else: authority
      port = if colon >= 0: authority[colon + 1 .. ^1] else: ""
      if host.len == 0:
        return InvalidUrlText
      for c in host:
        if c notin HostChars:
          return InvalidUrlText
    if port.len > 5:
      return InvalidUrlText
    for c in port:
      if c notin Digits:
        return InvalidUrlText
    result = trimmed[0 ..< mark].toLowerAscii() & "://" & host.toLowerAscii()
    if port.len > 0:
      result.add(":" & port)

const
  UrlStop = Whitespace + {'"', '\'', '<', '>', '`'}
  TrailingPunctuation = {')', '.', ',', ';', ':', '!', '?'}

proc redactedUrlsIn*(text: string): string =
  ## `text` with every `scheme://...` in it replaced by its `redactedUrl`.
  ## For messages written further away than this runtime (an exception from
  ## a library, a child process's output) that may quote a URL in full.
  ## Punctuation that closes the sentence around a URL stays.
  var i = 0
  while i < text.len:
    let mark = text.find("://", i)
    if mark < 0:
      result.add(text.substr(i))
      break
    var start = mark
    while start > i and text[start - 1] in SchemeChars:
      dec start
    while start < mark and text[start] notin Letters:
      inc start
    if start == mark:
      result.add(text.substr(i, mark + 2))
      i = mark + 3
      continue
    var stop = mark + 3
    while stop < text.len and text[stop] notin UrlStop:
      inc stop
    var urlEnd = stop
    while urlEnd > mark + 3 and text[urlEnd - 1] in TrailingPunctuation:
      dec urlEnd
    result.add(text.substr(i, start - 1))
    result.add(redactedUrl(text.substr(start, urlEnd - 1)))
    result.add(text.substr(urlEnd, stop - 1))
    i = stop
