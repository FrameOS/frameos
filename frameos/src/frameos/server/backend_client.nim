## Outbound calls from the frame to its FrameOS backend.
##
## Used by the on-device admin for two things: adopting a standalone frame
## into a backend (claiming an adoption code) and asking the backend to deploy
## a fresh FrameOS/agent build to this device. The frame only ever talks to
## the backend configured in frame.json (or, during adoption, the one the
## user typed in) — it never downloads binaries from arbitrary URLs itself.

import httpcore, json, strutils

import frameos/utils/http_client

const BackendRequestTimeoutMs = 20_000

proc backendBaseUrl*(serverHost: string, serverPort: int): string =
  ## Mirrors the frame's convention: ports ending in 443 mean HTTPS.
  let scheme = if serverPort mod 1000 == 443: "https" else: "http"
  let isDefaultPort = (scheme == "https" and serverPort == 443) or
    (scheme == "http" and serverPort == 80)
  result = scheme & "://" & serverHost
  if not isDefaultPort:
    result &= ":" & $serverPort

proc postBackendJson*(url: string, payload: JsonNode, apiKey = ""): tuple[code: int, body: JsonNode] =
  var headers = newHttpHeaders()
  headers["Content-Type"] = "application/json"
  if apiKey.len > 0:
    headers["Authorization"] = "Bearer " & apiKey
  let response = boundedRequest(url, HttpPost, $payload, headers, timeoutMs = BackendRequestTimeoutMs)
  var body: JsonNode
  try:
    body = parseJson(response.body)
  except CatchableError:
    body = %*{"detail": response.body.strip()}
  (response.code, body)
