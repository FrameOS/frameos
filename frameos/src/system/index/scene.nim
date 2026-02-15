{.warning[UnusedImport]: off.}
import pixie, json, strformat, strutils, sequtils, options, os, tables, algorithm
import std/monotimes
import zippy

import frameos/values
import frameos/types
import frameos/channels
import frameos/utils/url
import frameos/utils/time
import apps/render/text/app as render_textApp
import scenes/scenes as compiledScenes
import system/options as sceneOptions

const DEBUG = true
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_textApp.App

proc loadInterpretedSceneOptions(): seq[(SceneId, string)] =
  var data = ""
  let envPath = getEnv("FRAMEOS_SCENES_JSON")
  if envPath.len > 0:
    try:
      if envPath.endsWith(".gz") and fileExists(envPath):
        data = uncompress(readFile(envPath))
      elif fileExists(envPath):
        data = readFile(envPath)
    except CatchableError:
      data = ""
  if data.len == 0:
    try:
      if fileExists("./scenes.json.gz"):
        data = uncompress(readFile("./scenes.json.gz"))
      elif fileExists("./scenes.json"):
        data = readFile("./scenes.json")
    except CatchableError:
      data = ""
  if data.len == 0:
    return @[]
  try:
    let parsed = parseJson(data)
    if parsed.kind == JArray:
      for scene in parsed.items:
        if scene.kind != JObject or not scene.hasKey("id"):
          continue
        let idStr = scene["id"].getStr()
        if idStr.len == 0:
          continue
        let nameStr = if scene.hasKey("name"): scene["name"].getStr() else: idStr
        result.add((SceneId(idStr), nameStr))
  except JsonParsingError, CatchableError:
    discard

proc buildSceneList(self: Scene): seq[(string, string)] =
  var entries = initOrderedTable[string, string]()
  for (sceneId, sceneName) in compiledScenes.sceneOptions:
    entries[sceneId.string] = sceneName
  for (sceneId, sceneName) in loadInterpretedSceneOptions():
    if not entries.hasKey(sceneId.string):
      entries[sceneId.string] = sceneName
  for (sceneId, sceneName) in sceneOptions.sceneOptions:
    if sceneId.string.startsWith("system/"):
      continue
    entries[sceneId.string] = sceneName
  var ordered: seq[(string, string)] = @[]
  for key, value in entries:
    ordered.add((key, value))
  ordered.sort(proc(a, b: (string, string)): int = cmpIgnoreCase(a[1], b[1]))
  return ordered

proc buildSceneListText(self: Scene): string =
  let entries = self.buildSceneList()
  let frameConfig = self.frameConfig
  let resolution = &"{frameConfig.width}x{frameConfig.height}"
  let deviceName = if frameConfig.name.len > 0: frameConfig.name else: "Unnamed frame"
  let deviceType = if frameConfig.device.len > 0: frameConfig.device else: "unknown device"
  let serverHost = if frameConfig.serverHost.len > 0: frameConfig.serverHost else: "not configured"
  let serverPort = if frameConfig.serverPort > 0: $frameConfig.serverPort else: "?"
  let frameHost = if frameConfig.frameHost.len > 0: frameConfig.frameHost else: "0.0.0.0"
  let framePort = if publicPort(frameConfig) > 0: $publicPort(frameConfig) else: "?"
  let frameScheme = publicScheme(frameConfig)
  let agentAccess = if frameConfig.agent != nil and frameConfig.agent.agentEnabled: "enabled" else: "disabled"
  var lines: seq[string] = @[
    "FrameOS System Info",
    "",
    &"Name: {deviceName}",
    &"Device: {deviceType}",
    &"Resolution: {resolution}",
    &"Rotation: {frameConfig.rotate}°",
    &"Time zone: {frameConfig.timeZone}",
    &"Server: {serverHost}:{serverPort}",
    &"Frame: {frameScheme}://{frameHost}:{framePort}",
    &"Agent access: {agentAccess}",
    ""
  ]
  if entries.len == 0:
    lines.add("No scenes found.")
    return lines.join("\n")
  lines.add("Installed Scenes")
  lines.add("")
  for idx, (sceneId, sceneName) in entries.pairs:
    lines.add(&"{idx + 1}. {sceneName}")
  return lines.join("\n")

proc runNode*(self: Scene, nodeId: NodeId, context: ExecutionContext) =
  let timer = getMonoTime()
  case nodeId:
  of 1.NodeId:
    self.node1.appConfig.text = self.buildSceneListText()
    self.node1.run(context)
  else:
    discard
  if DEBUG:
    let elapsedMs = durationToMilliseconds(getMonoTime() - timer)
    self.logger.log(%*{"event": "debug:scene", "node": nodeId, "ms": elapsedMs})

proc runEvent*(self: Scene, context: ExecutionContext) =
  case context.event:
  of "render":
    try:
      self.runNode(1.NodeId, context)
    except CatchableError as e:
      self.logger.log(%*{"event": "render:error", "node": 1, "error": $e.msg,
        "stacktrace": e.getStackTrace()})
  of "setSceneState":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      let payload = context.payload["state"]
      for field in PUBLIC_STATE_FIELDS:
        let key = field.name
        if payload.hasKey(key) and payload[key] != self.state{key}:
          self.state[key] = copy(payload[key])
    if context.payload.hasKey("render"):
      sendEvent("render", %*{})
  of "setCurrentScene":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      let payload = context.payload["state"]
      for field in PUBLIC_STATE_FIELDS:
        let key = field.name
        if payload.hasKey(key) and payload[key] != self.state{key}:
          self.state[key] = copy(payload[key])
  else:
    discard

proc runEvent*(self: FrameScene, context: ExecutionContext) =
  runEvent(Scene(self), context)

proc render*(self: FrameScene, context: ExecutionContext): Image =
  let self = Scene(self)
  context.image.fill(self.backgroundColor)
  runEvent(self, context)
  return context.image

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  var state = %*{}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(
    id: sceneId,
    frameConfig: frameConfig,
    state: state,
    logger: logger,
    refreshInterval: 300.0,
    backgroundColor: parseHtmlColor("#000000")
  )
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: ExecutionContext) = scene.runNode(nodeId, context))
  scene.getDataNode = (proc(nodeId: NodeId, context: ExecutionContext): Value = scene.getDataNode(nodeId, context))
  scene.node1 = render_textApp.App(nodeName: "render/text", nodeId: 1.NodeId, scene: scene.FrameScene,
    frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
      inputImage: none(Image),
      text: "",
      richText: "basic-caret",
      position: "left",
      vAlign: "top",
      offsetX: 0.0,
      offsetY: 0.0,
      padding: 24.0,
      font: "",
      fontColor: parseHtmlColor("#ffffff"),
      fontSize: 28.0,
      borderColor: parseHtmlColor("#000000"),
      borderWidth: 0,
      overflow: "fit-bounds",
    ))
  runEvent(self, context)

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)
