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
import frameos/utils/url
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

proc respondFrameWebAsset(request: Request, assetPath: string, headOnly = false) {.gcsafe.} =
  ## One file out of the compiled frame_web table. `headOnly` answers a HEAD:
  ## same status and headers, no body. mummy routes HEAD to its own handler
  ## and never strips a body itself, so the handler has to.
  if not allowUnauthenticatedStaticAssets() and not hasAccess(request, Read):
    if headOnly:
      request.respond(Http401)
    else:
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
    if headOnly:
      headers["Content-Length"] = $asset.len
      request.respond(Http200, headers)
    else:
      request.respond(Http200, headers, asset)
  except KeyError:
    if headOnly:
      request.respond(Http404)
    else:
      request.respond(Http404, body = "Not found!")

proc respondFrameWebDirAsset(request: Request, directory: string, headOnly = false) {.gcsafe.} =
  ## `@asset` under one embedded directory. mummy splits the path on `/`, so
  ## the parameter is a single segment by construction; the guard is here
  ## because the table key is built by concatenation. An unusable name gets
  ## the empty key, which is in no table: the request 404s after the same
  ## access check every other embedded asset goes through.
  let asset = request.pathParams["asset"]
  let assetPath =
    if asset.len == 0 or '/' in asset or '\\' in asset or ".." in asset:
      ""
    else:
      directory & asset
  respondFrameWebAsset(request, assetPath, headOnly = headOnly)

const captiveProbePaths* = [
  "/generate_204", "/gen_204",                       # Android, Chrome
  "/hotspot-detect.html", "/library/test/success.html", # Apple
  "/connecttest.txt", "/ncsi.txt", "/redirect",      # Windows
  "/success.txt", "/canonical.html",                 # Firefox, Ubuntu
  "/check_network_status.txt", "/nm-check.txt",      # NetworkManager
]

proc hotspotSetupUrl(): string {.gcsafe.} =
  {.gcsafe.}:
    let port = hotspotSetupPort(globalFrameOS.frameConfig)
    "http://10.42.0.1" & (if port == 80: "" else: ":" & $port) & "/"

proc captivePortalRedirect*(request: Request): bool {.gcsafe.} =
  ## While the setup hotspot is up, any request that is not for the hotspot's
  ## own address is a connectivity probe or a stray page load from a device
  ## whose DNS now points everywhere at 10.42.0.1: send it to the setup form.
  ## Returns false when there is nothing to redirect (no hotspot, or the
  ## request already targets 10.42.0.1 by name).
  {.gcsafe.}:
    if not netportal.isHotspotActive(globalFrameOS):
      return false
    let host = if request.headers.contains("Host"): request.headers["Host"].split(':')[0].strip() else: ""
    if host == "10.42.0.1" and request.path notin captiveProbePaths:
      return false
    var headers: mummy.HttpHeaders
    headers["Location"] = hotspotSetupUrl()
    headers["Cache-Control"] = "no-store"
    request.respond(Http302, headers)
    return true

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
          if adminPanelEnabled():
            # A private frame used to answer a bare-body 401 here, which a
            # browser renders as a blank page. Whoever typed the frame's
            # address wants the admin login, so send them there.
            redirectTo(request, "/login")
          else:
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
      respondFrameWebDirAsset(request, "assets/compiled/frame_web/static/")
  )

  # The browser (wasm) preview runtime, served same-origin out of the same
  # embedded table as everything else the admin SPA loads: the SPA starts
  # `new Worker("/frameos-wasm/preview-worker.js", {type: "module"})`, which
  # imports frameos.js and fetches frameos.wasm and version.json next to it.
  # Present only in builds whose frontend/public/frameos-wasm was populated
  # before the assets were baked (the release chain and the Docker image do
  # that; PR builds stay wasm-less on purpose), so a 404 here means "this
  # FrameOS build has no browser preview runtime" — which is exactly what the
  # SPA probes for with a HEAD before it offers the button.
  router.get("/frameos-wasm/@asset", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      respondFrameWebDirAsset(request, "assets/compiled/frame_web/frameos-wasm/")
  )

  router.head("/frameos-wasm/@asset", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      respondFrameWebDirAsset(request, "assets/compiled/frame_web/frameos-wasm/", headOnly = true)
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
      log(%*{"event": "portal:http", "post": request.path, "params": netportal.loggableSetupParams(params)})
      if not params.hasKey("ssid"):
        request.respond(Http400, body = "Missing ssid")
        return
      let options = netportal.parseSetupOptions(params, globalFrameOS.frameConfig)
      let problem = netportal.setupOptionsProblem(options, globalFrameOS.frameConfig)
      if problem.len > 0:
        request.respond(Http400, body = problem)
        return
      if not netportal.persistPortalSetup(globalFrameOS, options):
        request.respond(Http500, body = netportal.setupHtml(globalFrameOS))
        return
      spawn netportal.connectToWifiDetached(netportal.runtimeHandle(globalFrameOS), options)
      request.respond(Http200, body = netportal.confirmHtml(globalFrameOS, ssid = options.ssid))
  )

  # Polled by the "Saved!" page from the hotspot origin AND from the frame's
  # LAN address: it moves the browser over once the frame is online.
  # Unauthenticated on purpose, but not for everyone: cross-origin reads are
  # allowed only from the setup hotspot's own origin (it used to be `*`, so
  # any page the owner visited could read the home SSID out of `error`), and
  # once the hotspot is down the answer carries no error text at all — the
  # setup window is over and the details belong to the admin log.
  router.get("/setup/status", proc(request: Request) {.gcsafe.} =
    {.gcsafe.}:
      var headers: mummy.HttpHeaders
      headers["Content-Type"] = "application/json"
      headers["Cache-Control"] = "no-store"
      let origin = request.headers["Origin"]
      if netportal.isSetupHotspotOrigin(origin):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Vary"] = "Origin"
      let hotspot = netportal.isHotspotActive(globalFrameOS)
      request.respond(Http200, headers,
        $netportal.setupStatusJson(globalFrameOS, includeError = hotspot))
  )

  # Captive-portal probes. While the setup hotspot is up, a phone that joined
  # it asks these well-known URLs whether the internet is reachable; anything
  # but the expected body means "sign-in required" and the OS opens the page
  # we redirect to. (Only reaches us once the hotspot's DNS answers every
  # name with 10.42.0.1 and port 80 lands on this server — docs/todo.md.)
  for path in captiveProbePaths:
    router.get(path, proc(request: Request) {.gcsafe.} =
      {.gcsafe.}:
        if not captivePortalRedirect(request):
          request.respond(Http404, body = "Not found!")
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
    # Scene events take frame write access (the access key, or `public`
    # mode). The control-plane verbs the runner handles itself — reload,
    # restart, reboot, uploadScenes — take an admin session or the backend's
    # serverApiKey bearer instead; see ControlEvents in auth.nim.
    let eventName = request.pathParams["name"]
    let allowed =
      if isControlEvent(eventName): hasControlAccess(request)
      else: hasAccess(request, Write)
    if not allowed:
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent(eventName, payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/uploadScenes", proc(request: Request) {.gcsafe.} =
    if not hasControlAccess(request):
      request.respond(Http401, body = "Unauthorized")
      return
    log(%*{"event": "http", "post": request.path})
    let payload = parseJson(if request.body == "": "{}" else: request.body)
    sendEvent("uploadScenes", payload)
    jsonResponse(request, Http200, %*{"status": "ok"})
  )

  router.post("/reload", proc(request: Request) {.gcsafe.} =
    if not hasControlAccess(request):
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
      jsonResponse(request, Http500, %*{"status": "error", "error": "Failed to reload the configuration"})
  )
