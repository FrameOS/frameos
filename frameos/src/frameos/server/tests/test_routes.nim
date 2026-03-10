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
    check router.routes.len == 45

    var getCount = 0
    var postCount = 0
    var routeDump: seq[string] = @[]
    for route in router.routes:
      let debug = repr(route)
      routeDump.add(debug)
      if "httpMethod: \"GET\"" in debug:
        inc getCount
      elif "httpMethod: \"POST\"" in debug:
        inc postCount

    check getCount == 32
    check postCount == 13

    # Key paths from public, frame API, and admin surfaces should all be present.
    check routeDump.anyIt("\"ping\"" in it)
    check routeDump.anyIt("\"states\"" in it)
    check routeDump.anyIt("\"api\"" in it and "\"admin\"" in it and "\"session\"" in it)
    check routeDump.anyIt("\"api\"" in it and "\"frames\"" in it and "\"event\"" in it)
