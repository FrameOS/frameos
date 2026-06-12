import unittest
import json
import strutils
import sequtils

import ../../types
import ../state
import ../routes

suite "Server routes composition":
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
    check router.routes.len == 56

    var getCount = 0
    var postCount = 0
    var headCount = 0
    var routeDump: seq[string] = @[]
    for route in router.routes:
      let debug = repr(route)
      routeDump.add(debug)
      if "httpMethod: \"GET\"" in debug:
        inc getCount
      elif "httpMethod: \"POST\"" in debug:
        inc postCount
      elif "httpMethod: \"HEAD\"" in debug:
        inc headCount

    check getCount == 36
    check postCount == 19
    check headCount == 1

    # Key paths from public, frame API, and admin surfaces should all be present.
    check routeDump.anyIt("\"ping\"" in it)
    check routeDump.anyIt("\"states\"" in it)
    check routeDump.anyIt("\"api\"" in it and "\"admin\"" in it and "\"session\"" in it)
    check routeDump.anyIt("\"api\"" in it and "\"frames\"" in it and "\"event\"" in it)
    check routeDump.anyIt("\"api\"" in it and "\"frames\"" in it and "\"adopt\"" in it)
    check routeDump.anyIt("\"api\"" in it and "\"frames\"" in it and "\"request_update\"" in it)
    # The admin SPA serves the scene/app editors from sub-paths of /admin.
    check routeDump.anyIt("\"admin\"" in it and "\"**\"" in it)
    check routeDump.anyIt("\"api\"" in it and "\"apps\"" in it and "\"source\"" in it)
    check routeDump.anyIt("\"api\"" in it and "\"apps\"" in it and "\"validate_source\"" in it)
