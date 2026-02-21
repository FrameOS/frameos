{.warning[UnusedImport]: off.}
import pixie, json, strformat, strutils, options
import std/monotimes

import frameos/values
import frameos/types
import frameos/channels
import frameos/utils/time
import frameos/boot_guard
import apps/render/text/app as render_textApp

const DEBUG = true
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_textApp.App

proc buildFailureText(self: Scene): string =
  let details = loadBootGuardFailureDetails()
  let sceneName = if details.sceneId.isSome: details.sceneId.get() else: "(unknown scene)"

  var lines: seq[string] = @[
    "FrameOS Safe Mode",
    "",
    &"FrameOS tried to render scene '{sceneName}' {BOOT_GUARD_CRASH_LIMIT} times, but it crashed each time.",
    "",
    "Use the control interface to select a new scene to render."
  ]

  if details.error.isSome:
    lines.add("")
    lines.add("Last captured error:")
    lines.add(details.error.get())
  else:
    lines.add("")
    lines.add("No detailed crash error was captured.")

  lines.join("\n")

proc runNode*(self: Scene, nodeId: NodeId, context: ExecutionContext) =
  let timer = getMonoTime()
  case nodeId:
  of 1.NodeId:
    self.node1.appConfig.text = self.buildFailureText()
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
    discard
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
  let scene = Scene(
    id: sceneId,
    frameConfig: frameConfig,
    state: %*{},
    logger: logger,
    refreshInterval: 120.0,
    backgroundColor: parseHtmlColor("#000000")
  )
  scene.node1 = render_textApp.App(nodeName: "render/text", nodeId: 1.NodeId, scene: scene.FrameScene,
    frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    vAlign: "top",
    text: "",
    richText: "basic-caret",
    inputImage: none(Image),
    position: "center",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 16.0,
    fontColor: parseHtmlColor("#ffffff"),
    fontSize: 26.0,
    borderColor: parseHtmlColor("#000000"),
    borderWidth: 2,
    overflow: "fit-bounds",
  ))
  result = scene

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)
