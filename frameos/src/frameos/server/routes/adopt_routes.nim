## A backend adopts this frame with the code its frame page shows
## (docs/scene-settings.md "Connecting the frame", docs/api-triality.md):
## Managed by → Your backend puts six digits on the frame page
## (local_access.nim, scope `adopt`; no picture is kept while they show, so
## no image the frame serves carries them), and the backend's Adopt form
## sends them here. A right code
## is exchanged for the frame's admin login, minted when it has none, and the
## backend goes on as an adoption with a password does: it logs in, reads
## `GET /api/frames/1` and writes its own address back.
##
## No session and no key: the code is the credential, so it gets the
## ceremony's limits (five tries, the wrong-code budget) and the per-peer
## limiter on top. The ESP32 answers the same two routes (main/fos_http.c),
## with `kind: "embedded"` and its own body.

import json
import strutils
import mummy
import mummy/routers
import httpcore
import locks
import frameos/channels
import frameos/events_gen
import frameos/local_access
import frameos/types
import frameos/cloud/link_state
from frameos/cloud/enrollment import frameDisplayName
from frameos/upgrade import installedFrameOSVersion
import ../auth
import ../api
import ../rate_limit
import ../state

const
  ADOPT_LIMIT = 10
  ADOPT_WINDOW = 300.0
  AdminLoginUser = "admin"

proc adopting(): bool {.gcsafe.} =
  {.gcsafe.}:
    pendingLocalAccessScope() == LocalAccessScopeAdopt

proc cloudManaged(): bool {.gcsafe.} =
  {.gcsafe.}:
    withLock cloudLinkLock:
      result = isManagedLink(loadCloudLinkState())

proc refusal(request: Request, verdict: LocalAccessVerdict) =
  let status =
    case verdict.error
    of "code_required": Http400
    of "code_expired": Http410
    of "rate_limited": Http429
    else: Http403
  jsonResponse(request, status, %*{"error": verdict.error, "detail": verdict.detail})

proc addAdoptRoutes*(router: var Router) =
  router.get("/api/adopt", proc(request: Request) {.gcsafe.} =
    # Nothing about the frame while no code shows: the page is how the person
    # at the frame says it may be adopted.
    if not adopting():
      jsonResponse(request, Http200, %*{"adopting": false})
      return
    {.gcsafe.}:
      let config = FrameConfig(name: liveConfigValue(name))
      jsonResponse(request, Http200, %*{"adopting": true, "kind": "linux", "platform": "linux",
        "name": frameDisplayName(config), "version": installedFrameOSVersion()})
  )

  router.post("/api/adopt", proc(request: Request) {.gcsafe.} =
    if rateLimitExceeded(request, "adopt", ADOPT_LIMIT, ADOPT_WINDOW):
      jsonResponse(request, Http429, %*{"error": "rate_limited", "detail": "Too many attempts"})
      return
    let payload = try:
        parseJson(if request.body.strip().len == 0: "{}" else: request.body)
      except CatchableError:
        jsonResponse(request, Http400, %*{"error": "invalid_request", "detail": "Invalid JSON"})
        return
    if payload.kind != JObject or (payload.hasKey("code") and payload["code"].kind != JString):
      jsonResponse(request, Http400, %*{"error": "invalid_request", "detail": "Send {\"code\": \"123456\"}"})
      return
    if cloudManaged():
      # One control plane at a time; the cloud link is left at the frame.
      jsonResponse(request, Http409, %*{"error": "managed",
        "detail": "FrameOS Cloud manages this frame; disconnect it on the frame first"})
      return
    {.gcsafe.}:
      let verdict = consumeLocalAccessCode(payload{"code"}.getStr(), LocalAccessScopeAdopt)
      if not verdict.ok:
        refusal(request, verdict)
        return
      var login = frameAdminAuthSnapshot()
      var user = login{"user"}.getStr()
      var pass = login{"pass"}.getStr()
      let minted = not (login{"enabled"}.getBool() and user.len > 0 and pass.len > 0)
      if minted:
        user = AdminLoginUser
        pass = secureRandomToken(18)
        try:
          persistFrameAdminLogin(user, pass)
          invalidateFrameAdminAuthCache()
        except CatchableError as error:
          log(%*{"event": "adopt:error", "error": error.msg})
          jsonResponse(request, Http500, %*{"error": "write_failed", "detail": "Could not save the admin login"})
          return
      log(%*{"event": "adopt:handover", "mintedLogin": minted})
      # The code is spent: the frame page draws without it.
      sendEvent(evRender, newJObject(), eoSystem)
      jsonResponse(request, Http200, %*{"username": user, "password": pass})
  )
