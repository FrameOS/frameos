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

proc spawnTargetRefusal*(url: string, allowedSchemes: openArray[string]): string =
  ## "" when `url` may be handed to a child process, otherwise the reason not.
  let trimmed = url.strip()
  if trimmed.len == 0:
    return "no URL configured"
  var parsed: Uri
  try:
    parsed = parseUri(trimmed)
  except CatchableError:
    return "URL could not be parsed: " & trimmed
  let scheme = parsed.scheme.toLowerAscii()
  if scheme notin allowedSchemes:
    return "URL scheme \"" & scheme & "\" is not allowed here (" & allowedSchemes.join(", ") & " only): " & trimmed
  if parsed.hostname.len == 0:
    return "URL has no host: " & trimmed
  var port = 0
  if parsed.port.len > 0:
    try:
      port = parseInt(parsed.port)
    except ValueError:
      return "URL has an invalid port: " & trimmed
  else:
    port = case scheme
      of "https", "rtsps": 443
      of "rtsp": 554
      else: 80
  when defined(frameosEmbedded) or defined(frameosWasm):
    discard port
    ""
  else:
    localNetworkPolicyRefusal(parsed.hostname, port)
