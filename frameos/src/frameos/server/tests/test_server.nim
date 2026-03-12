import unittest
import times
import httpcore

import ../../server

proc buildHeaders(values: seq[string]): HttpHeaders =
  result = newHttpHeaders()
  for value in values:
    result.add("If-Modified-Since", value)

suite "Server If-Modified-Since handling":
  let referenceTime = parse("Wed, 21 Oct 2015 07:28:00 GMT", "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
  let referenceUnix = referenceTime.toTime().toUnix().float

  test "matches single header value":
    let headers = buildHeaders(@["Wed, 21 Oct 2015 07:28:00 GMT"])
    check shouldReturnNotModified(headers, referenceUnix)

  test "matches split header value":
    let headers = buildHeaders(@["Wed", "21 Oct 2015 07:28:00 GMT"])
    check shouldReturnNotModified(headers, referenceUnix)

  test "newer frame timestamp bypasses cache":
    let headers = buildHeaders(@["Wed, 21 Oct 2015 07:28:00 GMT"])
    check not shouldReturnNotModified(headers, referenceUnix + 60.0)

  test "older frame timestamp returns cached image":
    let headers = buildHeaders(@["Wed, 21 Oct 2015 07:28:00 GMT"])
    check shouldReturnNotModified(headers, referenceUnix - 60.0)

  test "invalid header value is ignored":
    let headers = buildHeaders(@["not a real date"])
    check not shouldReturnNotModified(headers, referenceUnix)

  test "missing header is ignored":
    let headers = newHttpHeaders()
    check not shouldReturnNotModified(headers, referenceUnix)

  test "non-positive last update is ignored":
    let headers = buildHeaders(@["Wed, 21 Oct 2015 07:28:00 GMT"])
    check not shouldReturnNotModified(headers, 0.0)

suite "Server request logging":
  test "suppresses noisy admin and asset requests":
    check not shouldLogHttpRequest("/ws")
    check not shouldLogHttpRequest("/ws/admin")
    check not shouldLogHttpRequest("/static/asset-4X3RUWXO.png")
    check not shouldLogHttpRequest("/api/frames/1/logs")
    check not shouldLogHttpRequest("/api/frames/1/scene_images/example-scene")

  test "keeps meaningful application requests":
    check shouldLogHttpRequest("/api/frames/1")
    check shouldLogHttpRequest("/api/frames/1/state")
    check shouldLogHttpRequest("/api/admin/login")
