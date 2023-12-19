import times
# Import equivalent Nim libraries for SocketIO and other functionalities
from config import Config
from webhook import Webhook

proc convertToJsonSerializable(data: JsonNode): JsonNode =
  # Recursively convert non-JSON serializable objects to JSON serializable formats
  case data.kind
  of JObject:
    for k, v in pairs(data):
      data[k] = convertToJsonSerializable(v)
  of JArray:
    for i, elem in data:
      data[i] = convertToJsonSerializable(elem)
  else:
    data

type
  Logger = object
    config: Config
    logs: seq[JsonNode]
    limit: int
    socketio: SocketIO # Assuming a hypothetical SocketIO type
    webhook: Webhook

proc initLogger(config: Config, limit: int, socketio: SocketIO = nil): Logger =
  return Logger(config: config, logs: @[], limit: limit, socketio: socketio, webhook: initWebhook(config))

proc setSocketio(self: var Logger, socketio: SocketIO) =
  self.socketio = socketio

proc log(self: var Logger, payload: JsonNode) =
  payload.add("timestamp", now().format("yyyy-MM-dd'T'HH:mm:ss'Z'"))
  payload = convertToJsonSerializable(payload)

  self.logs.add(payload)
  if self.socketio != nil:
    self.socketio.emit("log_event", %*{"log": payload})
  self.webhook.addLog(payload)
  if self.logs.len > self.limit:
    self.logs.pop(0)

proc get(self: Logger): seq[JsonNode] =
  return self.logs

proc stop(self: var Logger) =
  self.webhook.stop()
