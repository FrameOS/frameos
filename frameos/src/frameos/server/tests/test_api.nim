import unittest
import times
import httpcore
import mummy
import tables

import ../api

proc buildHeaders(values: seq[string]): httpcore.HttpHeaders =
  result = httpcore.newHttpHeaders()
  for value in values:
    result.add("If-Modified-Since", value)

suite "Server API helpers":
  test "content type for compiled web assets":
    check contentTypeForAsset("bundle.css") == "text/css"
    check contentTypeForAsset("bundle.js") == "application/javascript"
    check contentTypeForAsset("font.woff2") == "font/woff2"

  test "content type for regular files":
    check contentTypeForFilePath("image.png") == "image/png"
    check contentTypeForFilePath("image.jpeg") == "image/jpeg"
    check contentTypeForFilePath("image.webp") == "image/webp"

  test "path containment checks":
    check withinBasePath("/tmp/a/b", "/tmp/a")
    check not withinBasePath("/tmp/a/../b", "/tmp/a")

  test "url encoded parser decodes values":
    let parsed = parseUrlEncoded("name=Frame%20One&flag=true&empty=")
    check parsed["name"] == "Frame One"
    check parsed["flag"] == "true"
    check parsed["empty"] == ""

  test "if-modified-since handling for httpcore headers":
    let referenceTime = parse("Wed, 21 Oct 2015 07:28:00 GMT", "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    let referenceUnix = referenceTime.toTime().toUnix().float
    let headers = buildHeaders(@["Wed, 21 Oct 2015 07:28:00 GMT"])
    check shouldReturnNotModified(headers, referenceUnix)
    check not shouldReturnNotModified(headers, referenceUnix + 60.0)

  test "if-modified-since handling for mummy headers":
    let referenceTime = parse("Wed, 21 Oct 2015 07:28:00 GMT", "ddd, dd MMM yyyy HH:mm:ss 'GMT'", utc())
    let referenceUnix = referenceTime.toTime().toUnix().float
    var headers: mummy.HttpHeaders
    headers["If-Modified-Since"] = "Wed, 21 Oct 2015 07:28:00 GMT"
    check shouldReturnNotModified(headers, referenceUnix)
