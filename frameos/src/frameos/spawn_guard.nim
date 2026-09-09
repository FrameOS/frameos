## Provenance, not transport: the two built-in apps that spawn a child
## process — data/chromiumScreenshot (a headless Chromium pointed at a URL,
## plus `apt-get install`) and data/rstpSnapshot (`ffmpeg -i <url>`) — reach
## the network without going through utils/http_client, so the private-network
## deny that protects a LAN from a provider-pushed scene never saw their
## requests, and until 2026-09-07 they were refused only for payloads whose
## recorded SOURCE was the cloud. A store scene installed through a self-hosted
## backend or uploaded over USB is the same anyone's-code; it got full reach.
##
## Two rules, both keyed on the scene's store provenance (origin.storeSceneId):
##
##  * A store-origin scene may not run these apps at all unless the local admin
##    has said so at the panel (local_access.nim, `allowShellApps` — the same
##    on-panel ceremony that lifts the LAN deny). Scenes the owner authored are
##    unaffected, as before.
##  * Whatever the scene's origin, the URL such an app is about to hand to a
##    child process must be http(s) (or rtsp(s) for the camera app) with a
##    host, and that host must pass the same private-network policy the HTTP
##    client enforces — so `file:///etc/shadow` or a router address does not
##    get through a scene's browser when the deny is on.
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

import frameos/local_access
import frameos/types
import frameos/utils/http_client

proc sceneIsStoreOrigin*(scene: FrameScene): bool =
  scene != nil and scene of InterpretedFrameScene and InterpretedFrameScene(scene).storeOrigin

proc spawningAppRefusal*(scene: FrameScene, appName: string): string =
  ## "" when the app may run for this scene, otherwise the reason it may not.
  if not sceneIsStoreOrigin(scene):
    return ""
  if storedAllowShellApps():
    return ""
  appName & " runs a child process and this scene comes from the scene store; " &
    "a local admin has to allow that on this frame first (Settings → Network → " &
    "shell apps for store scenes, confirmed with the code shown on the panel)."

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
    if pin.address.len > 0 and pin.address != parsed.hostname:
      result.address = pin.address
      var pinned = parsed
      pinned.hostname = if pin.address.contains(':'): "[" & pin.address & "]" else: pin.address
      result.pinnedUrl = $pinned

proc spawnTargetRefusal*(url: string, allowedSchemes: openArray[string]): string =
  ## "" when `url` may be handed to a child process, otherwise the reason not.
  spawnTarget(url, allowedSchemes).refusal
