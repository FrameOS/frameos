import httpclient, zippy, json

from frameos/types import FrameConfig, Logger

# TODO:
# - Keep a limited list of logs in memory
# - Send logs to server if requested
# - Batched sending
# - Retry on failure
# - Stop on shutdown
var
  thread: Thread[FrameConfig]
  channel: Channel[JsonNode]

channel.open()

proc logInThread*(frameConfig: FrameConfig, payload: JsonNode,
    client: HttpClient, url: string) =
  try:
    let body = %*{"log": payload}
    let response = client.request(url, httpMethod = HttpPost,
        body = compress($body))
    if response.code != Http200:
      echo "Error sending logs: HTTP " & $response.status
  except CatchableError as e:
    echo "Error sending logs: " & $e.msg

proc threadRunner(frameConfig: FrameConfig) {.thread.} =
  var client = newHttpClient(timeout = 10000)
  client.headers = newHttpHeaders([
      ("Authorization", "Bearer " & frameConfig.serverApiKey),
      ("Content-Type", "application/json"),
      ("Content-Encoding", "gzip")
  ])
  let protocol = if frameConfig.serverPort mod 1000 ==
      443: "https" else: "http"
  let url = protocol & "://" & frameConfig.serverHost & ":" &
    $frameConfig.serverPort & "/api/log"
  while true:
    let payload = channel.recv()
    logInThread(frameConfig, payload, client, url)

proc newLogger*(frameConfig: FrameConfig): Logger =
  createThread(thread, threadRunner, frameConfig)
  var logger = Logger(
    frameConfig: frameConfig,
    channel: channel,
  )
  result = logger

method log*(self: Logger, payload: JsonNode) {.base.} =
  channel.send(payload)
