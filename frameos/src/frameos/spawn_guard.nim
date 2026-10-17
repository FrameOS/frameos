## The two built-in apps that spawn a child process — data/chromiumScreenshot
## (a headless Chromium pointed at a URL, plus `apt-get install`) and
## data/rstpSnapshot (`ffmpeg -i <url>`) — reach the network without going
## through utils/http_client, so the private-network deny never sees their
## requests. This module holds what they hand to a child to the same policy.
##
## Who may run them at all is not decided here. A scene that uses either app
## says so in its own JSON (the app's keyword), so every control plane shows
## it as "runs shell commands" (frontend/src/utils/sceneAccess.ts) and asks
## before installing it; installing it is the approval. Cloud-managed frames
## refuse both apps outright (cloud/scene_guard.nim). Until 2026.10.16 a
## store-origin scene (origin.storeSceneId) also needed the local admin's
## say-so at the panel; provenance is not something the frame can keep true
## across copies and imports, so that check is gone.
##
## Whatever the scene, the URL such an app is about to hand to a child
## process must be http(s) (or rtsp(s) for the camera app) with a host, and
## that host must pass the same private-network policy the HTTP client
## enforces — so `file:///etc/shadow` or a router address does not get
## through a scene's browser when the deny is on.
##
## The policy check resolves the host once. While the deny is active the
## child must connect to THAT answer and nothing else (`SpawnTarget.address`
## — Chromium gets a host-resolver rule, ffmpeg the literal in the URL):
## letting Chromium or ffmpeg resolve the name again is a DNS-rebinding
## bypass, since a second lookup can answer with the router address the
## first lookup did not. The apps also hold the child to the checked host
## for everything after the first request (redirects, sub-resources), see
## each app for how.

import std/[strutils, uri]

import frameos/utils/http_client

type
  SpawnTarget* = object
    ## What the guard decided about a URL an app wants to hand to a child.
    refusal*: string   ## "" when the URL may be used, otherwise why not
    url*: string       ## the URL as configured (trimmed)
    scheme*: string    ## lowercase
    hostname*: string  ## as written in the URL
    port*: int         ## explicit, or the scheme's default
    address*: string   ## the IP the policy check resolved the host to — set
                       ## only while the private-network deny is active; the
                       ## child must then connect to exactly this address
    denyActive*: bool  ## the private-network deny was on when the URL was
                       ## checked (a literal address then has no `address`
                       ## to pin, but the child still has to be held to the
                       ## checked host set — see chromiumScreenshot)
    pinnedUrl*: string ## `url` with the host replaced by `address` (or `url`
                       ## itself when nothing is pinned)

proc spawnTarget*(url: string, allowedSchemes: openArray[string]): SpawnTarget =
  ## Checks `url` for a child process and, while the private-network deny is
  ## active, pins the host to the address the check was made against.
  let trimmed = url.strip()
  result = SpawnTarget(url: trimmed, pinnedUrl: trimmed)
  if trimmed.len == 0:
    result.refusal = "no URL configured"
    return
  var parsed: Uri
  try:
    parsed = parseUri(trimmed)
  except CatchableError:
    result.refusal = "URL could not be parsed: " & trimmed
    return
  let scheme = parsed.scheme.toLowerAscii()
  result.scheme = scheme
  if scheme notin allowedSchemes:
    result.refusal = "URL scheme \"" & scheme & "\" is not allowed here (" & allowedSchemes.join(", ") & " only): " & trimmed
    return
  if parsed.hostname.len == 0:
    result.refusal = "URL has no host: " & trimmed
    return
  result.hostname = parsed.hostname
  var port = 0
  if parsed.port.len > 0:
    try:
      port = parseInt(parsed.port)
    except ValueError:
      result.refusal = "URL has an invalid port: " & trimmed
      return
  else:
    port = case scheme
      of "https", "rtsps": 443
      of "rtsp": 554
      else: 80
  result.port = port
  when defined(frameosEmbedded) or defined(frameosWasm):
    discard
  else:
    let pin = localNetworkPolicyPin(parsed.hostname, port)
    if pin.refusal.len > 0:
      result.refusal = pin.refusal
      return
    result.denyActive = pin.address.len > 0
    if pin.address.len > 0 and pin.address != parsed.hostname:
      result.address = pin.address
      var pinned = parsed
      pinned.hostname = if pin.address.contains(':'): "[" & pin.address & "]" else: pin.address
      result.pinnedUrl = $pinned

proc spawnTargetRefusal*(url: string, allowedSchemes: openArray[string]): string =
  ## "" when `url` may be handed to a child process, otherwise the reason not.
  spawnTarget(url, allowedSchemes).refusal

proc spawnSubresourcePin*(host: string, port: int): tuple[refusal: string, address: string] =
  ## The same once-only resolve-and-classify for a host a child process wants
  ## to reach AFTER its first request (a page's sub-resources): "" refusal
  ## when `host:port` may be reached under the current policy, and then the
  ## address the child must be held to — the literal itself for a literal
  ## host, or the one answer the check was made against for a name. Empty
  ## address with an empty refusal means the deny is off and there is
  ## nothing to pin.
  if host.len == 0:
    return ("URL has no host", "")
  when defined(frameosEmbedded) or defined(frameosWasm):
    ("", "")
  else:
    let pin = localNetworkPolicyPin(host, port)
    if pin.refusal.len > 0:
      return (pin.refusal, "")
    ("", pin.address)
