import std/[strutils, unittest]
import mummy

import ../state
import ../routes/common
import ../../types

suite "server common route helpers":
  test "requestedFrameMatches validates frame id":
    var goodRequest = RequestObj(pathParams: default(PathParams))
    goodRequest.pathParams["id"] = "1"
    check requestedFrameMatches(addr goodRequest)

    var badRequest = RequestObj(pathParams: default(PathParams))
    badRequest.pathParams["id"] = "2"
    check not requestedFrameMatches(addr badRequest)

    var invalidRequest = RequestObj(pathParams: default(PathParams))
    invalidRequest.pathParams["id"] = "not-a-number"
    check not requestedFrameMatches(addr invalidRequest)

  test "frameWebHtml substitutes scaling mode":
    globalFrameConfig = FrameConfig(scalingMode: "cover")
    check "cover" in frameWebHtml()

    globalFrameConfig = FrameConfig(scalingMode: "stretch")
    check "100% 100%" in frameWebHtml()

    globalFrameConfig = FrameConfig(scalingMode: "unknown")
    check "contain" in frameWebHtml()
