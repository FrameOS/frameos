## Same-origin guard for the on-device HTTP API.
##
## Browsers attach an `Origin` header to every cross-origin request, to every
## POST (same-origin included) and to every WebSocket handshake; non-browser
## clients — the backend with its serverApiKey bearer, the cloud hub, curl —
## send none. So a state-changing request (anything but GET/HEAD/OPTIONS) or
## a WebSocket upgrade that carries an Origin must name the host the request
## was addressed to: the page that issued it was served by this frame,
## directly or through the setup TLS proxy (caddy forwards `Host` unchanged
## and adds `X-Forwarded-Host`). A page on another site that POSTs at the
## frame's LAN address is refused with 403 — classic CSRF, which
## `SameSite=Lax` only covers for cookie-holding sessions, not a `public` or
## `protected` frame that needs no cookie.
##
## Not covered: an attacker's DNS name pointed at the frame's IP (DNS
## rebinding) makes Origin and Host agree. Refusing that needs a Host
## allow-list, and the runtime has no reliable notion of the names it is
## reached by (mDNS, a router's own suffix, a reverse proxy's public name)
## — a config field to grow, not a guess to hard-code.
import std/strutils
import mummy

proc hostPortKey(authority: string, defaultPort: int): string =
  ## "Host[:port]" → "host:port", lower-cased, IPv6 brackets kept, default
  ## port filled in when absent. "" when the authority is empty.
  let value = authority.strip()
  if value.len == 0:
    return ""
  var host = value
  var port = defaultPort
  if value.startsWith("["):
    let close = value.find(']')
    if close < 0:
      return ""
    host = value[0 .. close]
    let rest = value[(close + 1) .. ^1]
    if rest.startsWith(":"):
      port = parseInt(rest[1 .. ^1])
    elif rest.len > 0:
      return ""
  else:
    let colon = value.rfind(':')
    if colon >= 0:
      host = value[0 ..< colon]
      port = parseInt(value[(colon + 1) .. ^1])
  if host.len == 0:
    return ""
  host.toLowerAscii() & ":" & $port

proc originMatchesHost*(origin, host: string, forwardedHost = "", requestIsHttps = false): bool =
  ## Whether a browser Origin names the host this request was addressed to.
  ## `forwardedHost` is `X-Forwarded-Host` (first value) from a proxy that
  ## rewrote `Host`; `requestIsHttps` fills in the Host header's default
  ## port. A malformed Origin, or the opaque `null`, never matches.
  let lower = origin.strip().toLowerAscii()
  var originDefaultPort = 80
  var authority = ""
  if lower.startsWith("http://"):
    authority = lower[7 .. ^1]
  elif lower.startsWith("https://"):
    authority = lower[8 .. ^1]
    originDefaultPort = 443
  else:
    return false
  # An Origin is scheme://host[:port] — nothing after the authority.
  if authority.find('/') >= 0 or authority.len == 0:
    return false
  let originKey =
    try:
      hostPortKey(authority, originDefaultPort)
    except ValueError:
      ""
  if originKey.len == 0:
    return false
  let hostDefaultPort = if requestIsHttps: 443 else: 80
  for candidate in [host, forwardedHost.split(',', 1)[0]]:
    let key =
      try:
        hostPortKey(candidate, hostDefaultPort)
      except ValueError:
        ""
    if key.len > 0 and key == originKey:
      return true
  false

proc isWebSocketUpgrade(request: Request): bool =
  request.headers.contains("Upgrade") and
    request.headers["Upgrade"].strip().toLowerAscii() == "websocket"

proc needsSameOrigin*(request: Request): bool =
  ## The requests the guard applies to: anything that can change state, plus
  ## WebSocket handshakes (a page on another site opening `/ws/admin` with
  ## the owner's cookie would otherwise read the admin log stream).
  request.httpMethod notin ["GET", "HEAD", "OPTIONS"] or isWebSocketUpgrade(request)

proc sameOriginAllowed*(request: Request): bool =
  ## False only for a request the guard applies to that carries an Origin
  ## naming somebody else. No Origin means no browser: let it through to the
  ## route's own authentication.
  if not needsSameOrigin(request) or not request.headers.contains("Origin"):
    return true
  let forwardedProto = request.headers["X-Forwarded-Proto"].split(',', 1)[0].strip().toLowerAscii()
  originMatchesHost(
    request.headers["Origin"],
    request.headers["Host"],
    forwardedHost = request.headers["X-Forwarded-Host"],
    requestIsHttps = forwardedProto == "https",
  )
