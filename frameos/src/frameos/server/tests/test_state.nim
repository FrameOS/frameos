import unittest

import ../state

suite "Server state helpers":
  test "frame api id is fixed":
    check frameApiId() == 1

  test "frame api id parser handles invalid values":
    check parseFrameApiId("123") == 123
    check parseFrameApiId("abc") == -1

  test "connections state starts empty":
    let state = initConnectionsState()
    check not hasConnections(state)
