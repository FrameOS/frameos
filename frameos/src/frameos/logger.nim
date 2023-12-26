import httpclient, zippy, json

from frameos/types import FrameConfig, Logger

# TODO:
# - Keep a limited list of logs in memory
# - Send logs to server if requested
# - Batched sending
# - Send on a background thread
# - Retry on failure
# - Stop on shutdown

proc newLogger*(frameConfig: FrameConfig): Logger =
  var client = newHttpClient(timeout = 10000)
  client.headers = newHttpHeaders([
      ("Authorization", "Bearer " & frameConfig.serverApiKey),
      ("Content-Type", "application/json"),
      ("Content-Encoding", "gzip")
  ])
  var protocol = if frameConfig.serverPort mod 1000 ==
      443: "https" else: "http"
  var url = protocol & "://" & frameConfig.serverHost & ":" &
      $frameConfig.serverPort & "/api/log"
  result = Logger(
    frameConfig: frameConfig,
    client: client,
    url: url
  )


method log*(self: Logger, payload: JsonNode) {.base.} =
  try:
    let body = %*{
        "log": payload
    }
    let response = self.client.request(self.url, httpMethod = HttpPost,
        body = compress($body))
    if response.code != Http200:
      echo "Error sending logs: HTTP " & $response.status
  except CatchableError as e:
    echo "Error sending logs: " & $e.msg
