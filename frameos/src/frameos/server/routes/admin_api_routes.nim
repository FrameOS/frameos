import json
import mummy
import mummy/routers
import httpcore
import tables
import strutils
import frameos/channels
import frameos/config
import ../auth
import ../api
import ../state
import ./common

proc ensureAdminAssetsAccess(request: Request): bool =
  if not hasAssetsAccessPermission():
    request.respond(Http403, body = "Assets access disabled")
    return false
  true

proc ensureAdminFrameControlAccess(request: Request): bool =
  if not hasControlFramePermission():
    request.respond(Http403, body = "Frame control disabled")
    return false
  true

proc ensureAdminModifyScenesAccess(request: Request): bool =
  if not hasModifyScenesPermission():
    request.respond(Http403, body = "Scene modification disabled")
    return false
  true

proc addAdminApiRoutes*(router: var Router) =
  router.get("/api/admin/session", proc(request: Request) {.gcsafe.} =
    let authenticated = hasAuthenticatedAdminSession(request)
    jsonResponse(request, Http200, %*{"authenticated": authenticated})
  )

  router.post("/api/admin/login", proc(request: Request) {.gcsafe.} =
    if not adminAuthEnabled():
      jsonResponse(request, Http401, %*{"detail": "Admin auth disabled"})
      return
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    let username = payload{"username"}.getStr("")
    let password = payload{"password"}.getStr("")
    if validateAdminCredentials(username, password):
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      headers["Set-Cookie"] = ADMIN_SESSION_COOKIE & "=" & adminSessionCookieValue() &
        "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" & $ADMIN_SESSION_TTL_SECONDS
      request.respond(Http200, headers, $(%*{"status": "ok"}))
    else:
      jsonResponse(request, Http401, %*{"detail": "Invalid credentials"})
  )

  router.post("/api/admin/logout", proc(request: Request) {.gcsafe.} =
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = "application/json"
    headers["Set-Cookie"] = ADMIN_SESSION_COOKIE & "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
    request.respond(Http200, headers, $(%*{"status": "ok"}))
  )

  router.get("/api/admin/frames/@id/assets", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminAssetsAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        jsonResponse(request, Http200, %*{"assets": frameAssetsPayload()})
  )

  router.get("/api/admin/frames/@id/asset", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminAssetsAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let path = request.queryParams.getOrDefault("path", "")
        let thumb = request.queryParams.getOrDefault("thumb", "") == "1"
        let (status, headers, body) = getAssetPayload(path, thumb)
        request.respond(status, headers, body)
  )

  router.post("/api/admin/frames/@id/assets/upload", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminAssetsAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        try:
          if request.queryParams.contains("upload_id"):
            let chunkIndex =
              try:
                parseInt(request.queryParams.getOrDefault("chunk_index", "0"))
              except ValueError:
                0
            appendUploadChunk(request.queryParams["upload_id"], chunkIndex, request.body)
            if request.queryParams.getOrDefault("complete", "") == "1":
              jsonResponse(
                request,
                Http200,
                finishChunkedAssetUpload(
                  request.queryParams["upload_id"],
                  request.queryParams.getOrDefault("path", ""),
                  request.queryParams.getOrDefault("filename", "uploaded_file")
                )
              )
            else:
              jsonResponse(request, Http200, %*{"status": "partial"})
          else:
            let payload = parseJson(if request.body == "": "{}" else: request.body)
            let path = payload{"path"}.getStr("")
            let filename = payload{"filename"}.getStr("uploaded_file")
            let dataUrl = payload{"data_url"}.getStr("")
            if dataUrl.len == 0:
              jsonResponse(request, Http400, %*{"detail": "Missing upload payload"})
              return
            let asset = saveAssetUploadPayload(path, filename, decodeDataUrlPayload(dataUrl))
            jsonResponse(request, Http200, asset)
        except ValueError as e:
          jsonResponse(request, Http400, %*{"detail": e.msg})
        except OSError:
          jsonResponse(request, Http404, %*{"detail": "Upload not found"})
        except CatchableError as e:
          jsonResponse(request, Http500, %*{"detail": e.msg})
  )

  router.post("/api/admin/frames/@id/assets/upload_image", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminAssetsAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        try:
          if request.queryParams.contains("upload_id"):
            let chunkIndex =
              try:
                parseInt(request.queryParams.getOrDefault("chunk_index", "0"))
              except ValueError:
                0
            appendUploadChunk(request.queryParams["upload_id"], chunkIndex, request.body)
            if request.queryParams.getOrDefault("complete", "") == "1":
              jsonResponse(
                request,
                Http200,
                finishChunkedImageUpload(
                  request.queryParams["upload_id"],
                  request.queryParams.getOrDefault("filename", "image")
                )
              )
            else:
              jsonResponse(request, Http200, %*{"status": "partial"})
          else:
            let payload = parseJson(if request.body == "": "{}" else: request.body)
            let filename = payload{"filename"}.getStr("image")
            let dataUrl = payload{"data_url"}.getStr("")
            if dataUrl.len == 0:
              jsonResponse(request, Http400, %*{"detail": "Missing upload payload"})
              return
            jsonResponse(request, Http200, saveUploadedImagePayload(filename, decodeDataUrlPayload(dataUrl)))
        except ValueError as e:
          jsonResponse(request, Http400, %*{"detail": e.msg})
        except OSError:
          jsonResponse(request, Http404, %*{"detail": "Upload not found"})
        except CatchableError as e:
          jsonResponse(request, Http500, %*{"detail": e.msg})
  )

  router.post("/api/admin/frames/@id/assets/mkdir", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminAssetsAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        try:
          let params = parseUrlEncoded(request.body)
          createAssetDirectory(if params.hasKey("path"): params["path"] else: "")
          jsonResponse(request, Http200, %*{"message": "Created"})
        except ValueError as e:
          jsonResponse(request, Http400, %*{"detail": e.msg})
        except CatchableError as e:
          jsonResponse(request, Http500, %*{"detail": e.msg})
  )

  router.post("/api/admin/frames/@id/assets/delete", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminAssetsAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        try:
          let params = parseUrlEncoded(request.body)
          deleteAssetEntry(if params.hasKey("path"): params["path"] else: "")
          jsonResponse(request, Http200, %*{"message": "Deleted"})
        except ValueError as e:
          jsonResponse(request, Http400, %*{"detail": e.msg})
        except OSError:
          jsonResponse(request, Http404, %*{"detail": "Asset not found"})
        except CatchableError as e:
          jsonResponse(request, Http500, %*{"detail": e.msg})
  )

  router.post("/api/admin/frames/@id/assets/rename", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminAssetsAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        try:
          let params = parseUrlEncoded(request.body)
          renameAssetEntry(
            if params.hasKey("src"): params["src"] else: "",
            if params.hasKey("dst"): params["dst"] else: ""
          )
          jsonResponse(request, Http200, %*{"message": "Renamed"})
        except ValueError as e:
          jsonResponse(request, Http400, %*{"detail": e.msg})
        except OSError:
          jsonResponse(request, Http404, %*{"detail": "Asset not found"})
        except CatchableError as e:
          jsonResponse(request, Http500, %*{"detail": e.msg})
  )

  router.post("/api/frames/@id/event/@name", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminFrameControlAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        log(%*{"event": "http", "post": request.path})
        let payload = parseJson(if request.body == "": "{}" else: request.body)
        sendEvent(request.pathParams["name"], payload)
        jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/api/frames/@id/event", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminFrameControlAccess(request):
      return
    {.gcsafe.}:
      if not requestedFrameMatches(request):
        request.respond(Http404, body = "Not found!")
      else:
        let payload = parseJson(if request.body == "": "{}" else: request.body)
        let eventName = payload{"event"}.getStr("")
        if eventName.len == 0:
          jsonResponse(request, Http400, %*{"detail": "Missing event"})
        else:
          let eventPayload = payload{"payload"}
          log(%*{"event": "http", "post": request.path, "eventName": eventName})
          sendEvent(eventName, if eventPayload.kind == JNull: %*{} else: eventPayload)
          jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/event/@name", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminFrameControlAccess(request):
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(request.pathParams["name"], payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/uploadScenes", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminModifyScenesAccess(request):
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent("uploadScenes", payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/reload", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    if not ensureAdminModifyScenesAccess(request):
      return
    try:
      {.gcsafe.}:
        let newConfig = loadConfig()
        updateFrameConfigFrom(globalFrameOS.frameConfig, newConfig)
      sendEvent("reload", %*{})
      jsonResponse(request, Http200, %*{"status": "ok"})
    except CatchableError as e:
      log(%*{"event": "reload:error", "error": e.msg})
      jsonResponse(request, Http500, %*{"status": "error", "error": e.msg})
  )
