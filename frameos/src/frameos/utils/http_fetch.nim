import httpclient
import os
import osproc
import random
import streams
import strformat
import strutils
import times

type FetchResponse* = object
  status*: int
  body*: string

proc curlCommand(): string =
  findExe("curl")

proc isHttpUrl*(url: string): bool =
  url.startsWith("http://") or url.startsWith("https://")

proc httpStatusMessage*(status: int): string =
  case status
  of 400: "400 Bad Request"
  of 401: "401 Unauthorized"
  of 403: "403 Forbidden"
  of 404: "404 Not Found"
  of 408: "408 Request Timeout"
  of 429: "429 Too Many Requests"
  of 500: "500 Internal Server Error"
  of 502: "502 Bad Gateway"
  of 503: "503 Service Unavailable"
  of 504: "504 Gateway Timeout"
  else: &"HTTP {status}"

proc shortErrorBody(body: string): string =
  let trimmed = body.strip()
  if trimmed.len > 0 and trimmed.len <= 120 and not trimmed.contains('<'):
    return trimmed
  return ""

proc errorMessage*(response: FetchResponse): string =
  let bodyMessage = shortErrorBody(response.body)
  if bodyMessage != "":
    return bodyMessage
  return httpStatusMessage(response.status)

proc fetchWithCurl(url: string): FetchResponse =
  let curl = curlCommand()
  if curl == "":
    raise newException(OSError, "curl executable not found")

  randomize()
  let bodyPath = getTempDir() / &"frameos-fetch-{epochTime().int}-{rand(1_000_000)}.bin"
  var p = startProcess(
    curl,
    args = @["-sS", "-L", "-o", bodyPath, "-w", "%{http_code}", url],
    options = {poUsePath}
  )
  try:
    let statusText = p.outputStream.readAll().strip()
    let stderrText = p.errorStream.readAll().strip()
    let rc = p.waitForExit()
    let body = if fileExists(bodyPath): readFile(bodyPath) else: ""

    if rc != 0:
      let message =
        if stderrText != "":
          stderrText
        else:
          &"curl exited with status {rc}"
      raise newException(IOError, message)

    let status =
      try:
        parseInt(statusText)
      except ValueError:
        0

    return FetchResponse(status: status, body: body)
  finally:
    p.close()
    if fileExists(bodyPath):
      removeFile(bodyPath)

proc fetchUrl*(url: string): FetchResponse =
  if not isHttpUrl(url):
    raise newException(ValueError, "Invalid URL.")

  if curlCommand() != "":
    return fetchWithCurl(url)

  var client = newHttpClient(timeout = 30000)
  try:
    let response = client.request(url, httpMethod = HttpGet)
    return FetchResponse(status: response.code.int, body: response.body)
  finally:
    client.close()
