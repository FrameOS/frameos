import json
import mummy
import mummy/routers
import httpcore
import frameos/channels
import frameos/types
import ./routes/[web_routes, frame_api_routes, admin_api_routes, common]

proc buildRouter*(connectionsState: ConnectionsState, adminConnectionsState: ConnectionsState): Router =
  addWebRoutes(result, connectionsState, adminConnectionsState)
  addFrameApiRoutes(result, connectionsState)
  addAdminApiRoutes(result)

  result.notFoundHandler = proc(request: Request) {.gcsafe.} =
    log(%*{"event": "404", "path": request.path})
    request.respond(Http404, body = "Not found!")
