import httpclient, zippy, json

from config import Config

# TODO:
# - Keep a limited list of logs in memory
# - Send logs to server if requested
# - Batched sending
# - Send on a background thread
# - Retry on failure
# - Stop on shutdown

type
  Logger* = ref object
    config: Config
    client: HttpClient
    url: string

proc newLogger*(config: Config): Logger =
  new(result)
  result.config = config
  result.client = newHttpClient(timeout = 10000)
  result.client.headers = newHttpHeaders([
      ("Authorization", "Bearer " & config.serverApiKey),
      ("Content-Type", "application/json"),
      ("Content-Encoding", "gzip")
  ])
  let protocol = if config.serverPort mod 1000 ==
      443: "https" else: "http"
  result.url = protocol & "://" & config.serverHost & ":" &
      $config.serverPort & "/api/log"


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
