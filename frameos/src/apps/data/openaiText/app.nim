import pixie
import options
import json
import strformat
import httpclient
import frameos/apps
import frameos/types

type
  AppConfig* = object
    model*: string
    system*: string
    user*: string
    stateKey*: string

  App* = ref object of AppRoot
    appConfig*: AppConfig

proc error*(self: App, message: string) =
  self.logError(message)
  self.scene.state[self.appConfig.stateKey] = %*(&"Error: {message}")

proc get*(self: App, context: ExecutionContext): string =
  if self.appConfig.user == "" and self.appConfig.system == "":
    self.error("No system or user prompt provided in app config.")
    return
  let apiKey = self.frameConfig.settings{"openAI"}{"apiKey"}.getStr
  if apiKey == "":
    self.error("Please provide an OpenAI API key in the settings.")
    return

  var client = newHttpClient(timeout = 60000)
  client.headers = newHttpHeaders([
      ("Authorization", "Bearer " & apiKey),
      ("Content-Type", "application/json"),
  ])
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
    self.log(%*{"user": self.appConfig.user, "system": self.appConfig.system})
    let response = client.request("https://api.openai.com/v1/chat/completions",
        httpMethod = HttpPost, body = $body)
    if response.code != Http200:
      try:
        let json = parseJson(response.body)
        let error = json{"error"}{"message"}.getStr(json{"error"}.getStr($json))
        self.error("Error making request " & $response.status & ": " & error)
      except:
        self.error "Error making request " & $response.status & ": " & response.body
      return
    let json = parseJson(response.body)
    let reply = json{"choices"}{0}{"message"}{"content"}.getStr
    self.log(%*{"reply": reply})
    result = reply
  except CatchableError as e:
    self.error "OpenAI API error: " & $e.msg
    result = "OpenAI API error: " & $e.msg
  finally:
    client.close()
