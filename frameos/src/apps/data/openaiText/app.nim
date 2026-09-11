import pixie
import options
import json
import strformat
import frameos/apps
import frameos/types
import frameos/utils/http_client

type
  AppConfig* = object
    model*: string
    system*: string
    user*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc error*(self: App, message: string) =
  # Logged only. This used to also write "Error: ..." into
  # scene.state[stateKey], but config.json never declared a stateKey field,
  # so every error landed in the state key "".
  self.logError(message)

proc requestLogPayload*(self: App): JsonNode =
  ## What a request logs. Prompts can carry personal data and logs ship to
  ## the control plane, so only their sizes are recorded.
  %*{
    "model": self.appConfig.model,
    "systemPromptChars": self.appConfig.system.len,
    "userPromptChars": self.appConfig.user.len,
  }

proc get*(self: App, context: ExecutionContext): string =
  if self.appConfig.user == "" and self.appConfig.system == "":
    self.error("No system or user prompt provided in app config.")
    return
  let apiKey = self.frameConfig.settings{"openAI"}{"apiKey"}.getStr
  if apiKey == "":
    self.error("Please provide an OpenAI API key in the settings.")
    return

  let body = %*{
      "model": self.appConfig.model,
      "messages": [
        {
          "role": "system",
          "content": self.appConfig.system
        },
        {
          "role": "user",
          "content": self.appConfig.user
        }
      ]
    }
  try:
    self.log(self.requestLogPayload())
    let response = boundedRequestWithHeaders(
      "https://api.openai.com/v1/chat/completions",
      httpMethod = "POST",
      body = $body,
      headers = @[
        (name: "Authorization", value: "Bearer " & apiKey),
        (name: "Content-Type", value: "application/json"),
      ],
      timeoutMs = 60000,
      maxBytes = self.maxHttpResponseBytes(),
      maxSeconds = 60
    )
    if response.code != 200:
      try:
        let json = parseJson(response.body)
        let error = json{"error"}{"message"}.getStr(json{"error"}.getStr($json))
        self.error("Error making request " & $response.status & ": " & error)
      except:
        self.error "Error making request " & $response.status & ": " & response.body
      return
    let json = parseJson(response.body)
    let reply = json{"choices"}{0}{"message"}{"content"}.getStr
    self.log(%*{"replyChars": reply.len})
    result = reply
  except CatchableError as e:
    self.error "OpenAI API error: " & $e.msg
    result = "OpenAI API error: " & $e.msg
