import json
import strutils
import mummy
import mummy/routers
import httpcore
import frameos/channels
import frameos/types
import ./origin
import ./routes/[web_routes, frame_api_routes, admin_api_routes, repository_api_routes, cloud_api_routes, common]

proc shouldLogRouteNotFound*(path: string): bool =
  if path.startsWith("/img/"):
    return false
  true

proc buildRouter*(connectionsState: ConnectionsState, adminConnectionsState: ConnectionsState): Router =
  addWebRoutes(result, connectionsState, adminConnectionsState)
  addFrameApiRoutes(result, connectionsState)
  addAdminApiRoutes(result)
  addRepositoryApiRoutes(result)
  addCloudApiRoutes(result)

  result.notFoundHandler = proc(request: Request) {.gcsafe.} =
    # A device on the setup hotspot whose DNS resolves everything to the
    # frame lands here for any page it had open: hand it the setup form.
    if captivePortalRedirect(request):
      return
    if shouldLogRouteNotFound(request.path):
      log(%*{"event": "404", "path": request.path})
    request.respond(Http404, body = "Not found!")

proc buildRouterHandler*(router: Router): RequestHandler =
  ## The router behind the same-origin guard (origin.nim): a browser page
  ## from another site cannot change state or open a WebSocket here, whatever
  ## cookies it carries. Everything the server and the route tests serve goes
  ## through this, never through `router.toHandler()` directly.
  let routerHandler = router.toHandler()
  result = proc(request: Request) {.gcsafe.} =
    if not sameOriginAllowed(request):
      log(%*{
        "event": "http:cross_origin",
        "method": request.httpMethod,
        "path": request.path,
        "origin": request.headers["Origin"],
      })
      request.respond(Http403, body = "Cross-origin request refused")
      return
    routerHandler(request)
