
import json, httpclient, zippy # , queues, threading, times
from ./config import Config

type
  Webhook* = ref object
    config: Config
    # queue: Queue[JsonNode]
    # stopEvent: Event
    # thread: Thread[void]

proc newWebhook*(config: Config): Webhook =
  new(result)
  result.config = config
#   open(result.queue)
#   initEvent(result.stopEvent)
#   createThread(result.thread, result.run)

# method addLog*(self: Webhook, payload: JsonNode) =
#   self.queue.put(payload)

# method run(self: Webhook) =
#   while not self.stopEvent.test:
#     var batch: seq[JsonNode]

#     # Get at least one item, blocking if the queue is empty
#     batch.add(self.queue.get())

#     # Try to fill the batch up to its max size without blocking
#     for i in 0..<99:
#       if not self.queue.isEmpty:
#         batch.add(self.queue.get())

#     self.sendBatch(batch)

# method sendBatch(self: Webhook, batch: seq[JsonNode]) =
method addLog*(self: Webhook, payload: JsonNode) =
  try:
    let client = newHttpClient(timeout = 10000)
    client.headers = newHttpHeaders([
        ("Authorization", "Bearer " & self.config.serverApiKey),
        ("Content-Type", "application/json"),
        ("Content-Encoding", "gzip")
    ])
    let protocol = if self.config.serverPort mod 1000 ==
        443: "https" else: "http"
    let url = protocol & "://" & self.config.serverHost & ":" &
        $self.config.serverPort & "/api/log"

    let body = %*{
        "log": payload
    }

    let response = client.request(url, httpMethod = HttpPost, body = compress($body))
    echo response.status
    # if response.status != Http200:
    #   echo "Error sending logs: HTTP " & $response.status
  except CatchableError as e:
    echo "Error sending logs: " & $e.msg

proc stopWebhook*(self: Webhook) =
#   self.stopEvent.set()
#   joinThread(self.thread)
  echo "Webhook stopped"
