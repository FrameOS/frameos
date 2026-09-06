import json
import strutils
import mummy
import mummy/routers
import httpcore
import frameos/channels
import frameos/types
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
