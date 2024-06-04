import pixie
import options
import json
import strformat
import lib/httpclient
import frameos/types

type
  AppConfig* = object
    model*: string
    system*: string
    user*: string
    stateKey*: string

  AppOutput* = object
    reply*: string

  App* = ref object
    nodeId*: NodeId
    scene*: FrameScene
    appConfig*: AppConfig
    frameConfig*: FrameConfig

proc init*(nodeId: NodeId, scene: FrameScene, appConfig: AppConfig): App =
  result = App(
    nodeId: nodeId,
    scene: scene,
    frameConfig: scene.frameConfig,
    appConfig: appConfig,
  )

proc log*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"openai:{self.nodeId}:log", "message": message})

proc error*(self: App, message: string) =
  self.scene.logger.log(%*{"event": &"openai:{self.nodeId}:error", "error": message})
  self.scene.state[self.appConfig.stateKey] = %*(&"Error: {message}")

proc run*(self: App, context: ExecutionContext): AppOutput =
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
    self.scene.logger.log(%*{"event": &"openai:{self.nodeId}:request", "user": self.appConfig.user,
        "system": self.appConfig.system})
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
    self.scene.logger.log(%*{"event": &"openai:{self.nodeId}:reply", "reply": reply})
    result = AppOutput(reply: reply)
  except CatchableError as e:
    self.error "OpenAI API error: " & $e.msg
    result = AppOutput(reply: "OpenAI API error: " & $e.msg)
  finally:
    client.close()
