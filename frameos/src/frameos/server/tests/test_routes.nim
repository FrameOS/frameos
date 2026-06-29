import unittest
import json
import strutils
import mummy/routers

import ../../types
import ../state
import ../routes

suite "Server routes composition":
  proc routeDebugs(router: Router): seq[string] =
    for route in router.routes:
      result.add(repr(route))

  proc hasRoute(routeDump: seq[string], httpMethod: string, pathParts: openArray[string]): bool =
    let methodToken = "httpMethod: \"" & httpMethod & "\""
    for debug in routeDump:
      if methodToken notin debug:
        continue

      var allPartsPresent = true
      for part in pathParts:
        if "\"" & part & "\"" notin debug:
          allPartsPresent = false
          break

      if allPartsPresent:
        return true

  test "router registers expected route surface":
    globalFrameConfig = FrameConfig(
      frameAdminAuth: %*{},
      frameAccess: "public",
      frameAccessKey: "",
      scalingMode: "contain",
    )
    let publicState = initConnectionsState()
    let adminState = initConnectionsState()
    let router = buildRouter(publicState, adminState)

    check router.notFoundHandler != nil
    let routes = routeDebugs(router)

    # Key paths from public web, frame API, admin API, assets, and repository
    # surfaces should all be present without freezing the exact route count.
    check routes.hasRoute("GET", ["ping"])
    check routes.hasRoute("GET", ["img", "**"])
    check routes.hasRoute("GET", ["ws", "admin"])
    check routes.hasRoute("POST", ["setup"])
    check routes.hasRoute("POST", ["event", "@name"])

    check routes.hasRoute("GET", ["api", "apps"])
    check routes.hasRoute("GET", ["api", "frames", "@id", "metrics", "recent"])
    check routes.hasRoute("GET", ["api", "frames", "@id", "states"])
    check routes.hasRoute("POST", ["api", "frames", "@id", "scene_images", "@sceneId"])
    check routes.hasRoute("POST", ["api", "frames", "@id", "upload_scenes"])

    check routes.hasRoute("GET", ["api", "admin", "session"])
    check routes.hasRoute("POST", ["api", "admin", "login"])
    check routes.hasRoute("GET", ["api", "settings"])
    check routes.hasRoute("POST", ["api", "settings"])
    check routes.hasRoute("GET", ["api", "upgrade", "status"])
    check routes.hasRoute("POST", ["api", "upgrade"])
    check routes.hasRoute("GET", ["api", "admin", "frames", "@id", "assets"])
    check routes.hasRoute("POST", ["api", "admin", "frames", "@id", "assets", "upload"])

    check routes.hasRoute("GET", ["api", "repositories", "system"])
    check routes.hasRoute("GET", ["api", "repositories", "system", "@repositorySlug", "templates", "@templateSlug", "image"])

  test "not found logging suppresses stale frontend asset paths":
    check not shouldLogRouteNotFound("/img/logo-2/logo-white-colors.svg")
    check shouldLogRouteNotFound("/missing")
