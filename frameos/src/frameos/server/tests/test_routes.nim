import unittest
import json

import ../../types
import ../state
import ../routes

suite "Server routes composition":
  test "router builds with split route modules":
    globalFrameConfig = FrameConfig(
      frameAdminAuth: %*{},
      frameAccess: "public",
      frameAccessKey: "",
      scalingMode: "contain",
    )
    let publicState = initConnectionsState()
    let adminState = initConnectionsState()
    discard buildRouter(publicState, adminState)
    check true
