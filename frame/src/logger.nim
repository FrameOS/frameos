from json import JsonNode

from config import Config
from webhook import Webhook, newWebhook, addLog, stopWebhook

type
  Logger* = ref object
    config: Config
    # logs: seq[JsonNode]
    limit: int
    webhook: Webhook

proc newLogger*(config: Config): Logger =
  new(result)
  result.config = config
  # result.limit = limit
  result.webhook = newWebhook(config)
  # result.logs = @[]

method log*(self: Logger, payload: JsonNode) =
  # var logEntry = %*{"timestamp": now().format("yyyy-MM-dd'T'HH:mm:ss"), &*payload}
  # self.logs.add(logEntry)
  # self.webhook.addLog(logEntry)
  self.webhook.addLog(payload)

  # # Maintain log limit
  # if self.logs.len > self.limit:
  #   self.logs.pop()

# method get*(self: Logger): seq[JsonNode] =
#   return self.logs

proc stop*(self: Logger) =
  self.webhook.stopWebhook()
