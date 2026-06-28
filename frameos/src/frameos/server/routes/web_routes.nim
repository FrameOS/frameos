import json
import strutils
import tables
import threadpool
import mummy
import mummy/routers
import httpcore
import frameos/channels
import frameos/config
import frameos/types
import frameos/portal as netportal
import ../state
import ../auth
import ../api
import ../embedded_assets
import ./admin_api_assets_routes
import ./common

proc clientAcceptsGzip(request: Request): bool =
  if not request.headers.contains("Accept-Encoding"):
    return false

  var wildcardAllowed = false
  for entry in request.headers["Accept-Encoding"].split(","):
    let parts = entry.strip().split(";")
    if parts.len == 0:
      continue

    let encoding = parts[0].strip().toLowerAscii()
    var quality = 1.0
    for i in 1 ..< parts.len:
      let param = parts[i].strip()
      if param.startsWith("q="):
        try:
          quality = parseFloat(param[2 .. param.high])
        except ValueError:
          quality = 0.0

    if encoding == "gzip":
      return quality > 0
    if encoding == "*":
      wildcardAllowed = quality > 0

  wildcardAllowed

proc redirectTo(request: Request, location: string) {.gcsafe.} =
  var headers: mummy.HttpHeaders
  headers["Location"] = location
  request.respond(Http302, headers)

proc respondAdminWebApp(request: Request) {.gcsafe.} =
  if not adminPanelEnabled():
    request.respond(Http401, body = "Admin panel disabled")
  elif not hasAdminSession(request):
    redirectTo(request, "/login")
  else:
    request.respond(Http200, body = frameWebHtml(frameAdminMode = true))

proc respondFrameWebAsset(request: Request, assetPath: string) {.gcsafe.} =
  if not allowUnauthenticatedStaticAssets() and not hasAccess(request, Read):
    request.respond(Http401, body = "Unauthorized")
    return
  try:
    var headers: mummy.HttpHeaders
    headers["Content-Type"] = contentTypeForAsset(assetPath)
    headers["Vary"] = "Accept-Encoding"
    let asset =
      if clientAcceptsGzip(request):
        headers["Content-Encoding"] = "gzip"
        getCompressedFrameWebAsset(assetPath)
      else:
        getFrameWebAsset(assetPath)
    request.respond(Http200, headers, asset)
  except KeyError:
    request.respond(Http404, body = "Not found!")

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
          headers["Set-Cookie"] = accessCookieHeader(request, accessKey)
          request.respond(Http302, headers)
        elif adminPanelEnabled() and hasAdminSession(request):
          redirectTo(request, "/admin")
        elif not hasAccess(request, Read):
          request.respond(Http401, body = "Unauthorized")
        else:
          request.respond(Http200, body = frameWebHtml())
  )

  router.get("/admin", proc(request: Request) {.gcsafe.} =
    respondAdminWebApp(request)
  )

  router.get("/control", proc(request: Request) {.gcsafe.} =
    if not adminPanelEnabled():
      request.respond(Http401, body = "Admin panel disabled")
    else:
      redirectTo(request, "/admin")
  )

  router.get("/login", proc(request: Request) {.gcsafe.} =
    if not adminPanelEnabled():
      request.respond(Http401, body = "Admin panel disabled")
    elif not adminAuthEnabled():
      redirectTo(request, "/admin")
    elif hasAdminSession(request):
      redirectTo(request, "/admin")
    else:
      request.respond(Http200, body = frameWebHtml(frameAdminMode = true))
  )

  router.get("/logout", proc(request: Request) {.gcsafe.} =
    invalidateAdminSession(request)
    var headers: mummy.HttpHeaders
    headers["Location"] = "/login"
    headers["Set-Cookie"] = clearAdminSessionCookieHeader(request)
    request.respond(Http302, headers)
  )

  for path in [
    "/frames",
    "/frames/**",
    "/scenes",
    "/scenes/**",
    "/apps",
    "/apps/**",
    "/settings",
    "/signup",
    "/setup-unavailable",
  ]:
    router.get(path, respondAdminWebApp)

  router.get("/static/@asset", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      let assetPath = "assets/compiled/frame_web/static/" & request.pathParams["asset"]
      respondFrameWebAsset(request, assetPath)
  )

  router.get("/img/**", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      respondFrameWebAsset(request, "assets/compiled/frame_web" & request.path)
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
    if not hasAdminAccess(request):
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
    {.gcsafe.}:
      log(%*{"event": "http", "get": request.path})
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

  router.post("/event/@name", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(request.pathParams["name"], payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/uploadScenes", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent("uploadScenes", payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/reload", proc(request: Request) {.gcsafe.} =
    if not hasAccess(request, Write):
      request.respond(Http401, body = "Unauthorized")
      return
    try:
      {.gcsafe.}:
        # Parse the config here only to validate it (and 500 on a broken
        # frame.json). The shared FrameConfig is mutated exclusively by the
        # runner thread's "reload" handler: reassigning ~35 ref fields of an
        # object other threads are reading is a use-after-free waiting to
        # happen under ORC.
        discard loadConfig()
      sendEvent("reload", %*{})
      jsonResponse(request, Http200, %*{"status": "ok"})
    except CatchableError as e:
      log(%*{"event": "reload:error", "error": e.msg})
      jsonResponse(request, Http500, %*{"status": "error", "error": e.msg})
  )
