import json
import tables
import threadpool
import mummy
import mummy/routers
import httpcore
import frameos/channels
import frameos/types
import frameos/portal as netportal
import ../state
import ../auth
import ../api
import ../embedded_assets
import ./common

proc addWebRoutes*(router: var Router, connectionsState: ConnectionsState, adminConnectionsState: ConnectionsState) =
  router.get("/", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      if netportal.isHotspotActive(globalFrameOS):
        log(%*{"event": "portal:http", "get": request.path})
        request.respond(Http200, body = netportal.setupHtml(globalFrameOS))
      else:
        let accessKey = frameAccessKeyValue()
        if accessKey != "" and request.queryParams.contains("k") and request.queryParams["k"] == accessKey:
          var headers: mummy.HttpHeaders
          headers["Location"] = "/"
          headers["Set-Cookie"] = ACCESS_COOKIE & "=" & accessKey & "; Path=/; SameSite=Lax"
          request.respond(Http302, headers)
        elif not hasAccess(request, Read):
          request.respond(Http401, body = "Unauthorized")
        else:
          request.respond(Http200, body = frameWebHtml())
  )

  router.get("/admin", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      if netportal.isHotspotActive(globalFrameOS):
        log(%*{"event": "portal:http", "get": request.path})
        request.respond(Http200, body = netportal.setupHtml(globalFrameOS))
      elif not adminPanelEnabled():
        request.respond(Http401, body = "Admin panel disabled")
      else:
        let accessKey = frameAccessKeyValue()
        if accessKey != "" and request.queryParams.contains("k") and request.queryParams["k"] == accessKey:
          var headers: mummy.HttpHeaders
          headers["Location"] = if hasAdminSession(request): "/admin" else: "/login"
          headers["Set-Cookie"] = ACCESS_COOKIE & "=" & accessKey & "; Path=/; SameSite=Lax"
          request.respond(Http302, headers)
        elif not hasAdminSession(request):
          var headers: mummy.HttpHeaders
          headers["Location"] = "/login"
          request.respond(Http302, headers)
        elif not hasAccess(request, Read):
          request.respond(Http401, body = "Unauthorized")
        else:
          request.respond(Http200, body = frameWebHtml())
  )

  router.get("/control", proc(request: Request) {.gcsafe.} =
    if not adminPanelEnabled():
      request.respond(Http401, body = "Admin panel disabled")
    else:
      var headers: mummy.HttpHeaders
      headers["Location"] = "/admin"
      request.respond(Http302, headers)
  )

  router.get("/login", proc(request: Request) {.gcsafe.} =
    if not adminPanelEnabled():
      request.respond(Http401, body = "Admin panel disabled")
    elif not adminAuthEnabled():
      var headers: mummy.HttpHeaders
      headers["Location"] = "/admin"
      request.respond(Http302, headers)
    else:
      request.respond(Http200, body = frameWebHtml())
  )

  router.get("/logout", proc(request: Request) {.gcsafe.} =
    var headers: mummy.HttpHeaders
    headers["Location"] = "/login"
    headers["Set-Cookie"] = ADMIN_SESSION_COOKIE & "=; Path=/; Max-Age=0; SameSite=Lax"
    request.respond(Http302, headers)
  )

  router.get("/static/@asset", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      let assetName = request.pathParams["asset"]
      let isLoginAsset =
        assetName == "main.js" or assetName == "main.css" or assetName == "main.js.map" or assetName == "main.css.map"
      let allowUnauthedLoginAsset = adminAuthEnabled() and isLoginAsset
      if not hasAccess(request, Read) and not allowUnauthedLoginAsset:
        request.respond(Http401, body = "Unauthorized")
        return
      let assetPath = "assets/compiled/frame_web/static/" & request.pathParams["asset"]
      try:
        let asset = getFrameWebAsset(assetPath)
        var headers: mummy.HttpHeaders
        headers["Content-Type"] = contentTypeForAsset(assetPath)
        request.respond(Http200, headers, asset)
      except KeyError:
        request.respond(Http404, body = "Not found!")
  )

  router.post("/setup", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      if not netportal.isHotspotActive(globalFrameOS):
        request.respond(Http400, body = "Not in setup mode")
        return
      let params = parseUrlEncoded(request.body)
      log(%*{"event": "portal:http", "post": request.path, "params": params})
      if not params.hasKey("ssid"):
        request.respond(Http400, body = "Missing ssid")
        return
      spawn netportal.connectToWifi(
        globalFrameOS,
        params["ssid"],
        params.getOrDefault("password", ""),
        params.getOrDefault("serverHost", globalFrameOS.frameConfig.serverHost),
        params.getOrDefault("serverPort", $globalFrameOS.frameConfig.serverPort),
      )
      request.respond(Http200, body = netportal.confirmHtml())
  )

  router.get("/ping", proc(request: Request) {.gcsafe.} =
    request.respond(Http200, body = "pong")
  )

  router.get("/setup", proc(request: Request) {.gcsafe.} =
    var headers: mummy.HttpHeaders
    headers["Location"] = "/"
    request.respond(Http302, headers)
  )

  router.get("/wifi", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      if not netportal.isHotspotActive(globalFrameOS):
        request.respond(Http400, body = "Not in setup mode")
      else:
        var headers: mummy.HttpHeaders
        headers["Content-Type"] = "application/json"
        let nets = netportal.availableNetworks(globalFrameOS)
        request.respond(Http200, headers, $(%*{"networks": nets}))
  )

  router.get("/ws", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    try:
      let websocket = request.upgradeToWebSocket()
      addConnection(connectionsState, websocket)
    except CatchableError:
      request.respond(Http500, body = "WebSocket upgrade failed")
  )

  router.get("/ws/admin", proc(request: Request) {.gcsafe.} =
    if not hasAdminAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    try:
      let websocket = request.upgradeToWebSocket()
      addConnection(adminConnectionsState, websocket)
    except CatchableError:
      request.respond(Http500, body = "WebSocket upgrade failed")
  )

  router.get("/image", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Read):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let (status, headers, body) = buildFrameImageResponse(request)
      request.respond(status, headers, body)
  )

  router.get("/states", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let payload = frameStatesPayload()
      jsonResponse(request, Http200, %*{"sceneId": $payload.sceneId, "states": payload.states})
  )

  router.get("/getUploadedScenes", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let payload = %*{"scenes": uploadedScenesPayload()}
      jsonResponse(request, Http200, payload)
  )

  router.get("/state", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "get": request.path})
    {.gcsafe.}:
      let payload = frameStatePayload()
      jsonResponse(request, Http200, %*{"sceneId": $payload.sceneId, "state": payload.state})
  )

  router.get("/c", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    renderControlPage(request)
  )
