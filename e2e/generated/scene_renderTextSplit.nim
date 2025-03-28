# This file is autogenerated

{.warning[UnusedImport]: off.}
import pixie, json, times, strformat, strutils, sequtils, options, algorithm

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/render/split/app as render_splitApp
import apps/render/text/app as render_textApp
import apps/render/image/app as render_imageApp
import apps/data/newImage/app as data_newImageApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_splitApp.App
  node2: render_textApp.App
  node3: render_imageApp.App
  node4: render_imageApp.App
  node5: render_imageApp.App
  node6: render_textApp.App
  node7: render_textApp.App
  node8: render_textApp.App
  node9: data_newImageApp.App

{.push hint[XDeclaredButNotUsed]: off.}
var cache0: Option[Image] = none(Image)

proc runNode*(self: Scene, nodeId: NodeId, context: var ExecutionContext) =
  let scene = self
  let frameConfig = scene.frameConfig
  let state = scene.state
  var nextNode = nodeId
  var currentNode = nodeId
  var timer = epochTime()
  while nextNode != -1.NodeId:
    currentNode = nextNode
    timer = epochTime()
    case nextNode:
    of 1.NodeId: # render/split
      self.node1.run(context)
      nextNode = -1.NodeId
    of 2.NodeId: # render/text
      self.node2.run(context)
      nextNode = -1.NodeId
    of 3.NodeId: # render/image
      self.node3.appConfig.image = block:
        self.node6.get(context)
      self.node3.run(context)
      nextNode = -1.NodeId
    of 4.NodeId: # render/image
      self.node4.appConfig.image = block:
        self.node7.get(context)
      self.node4.run(context)
      nextNode = -1.NodeId
    of 5.NodeId: # render/image
      self.node5.appConfig.image = block:
        self.node8.appConfig.inputImage = some(block:
          if cache0.isNone():
            cache0 = some(block:
              self.node9.get(context))
          cache0.get())
        self.node8.get(context)
      self.node5.run(context)
      nextNode = -1.NodeId
    else:
      nextNode = -1.NodeId
    
    if DEBUG:
      self.logger.log(%*{"event": "debug:scene", "node": currentNode, "ms": (-timer + epochTime()) * 1000})

proc runEvent*(self: Scene, context: var ExecutionContext) =
  case context.event:
  of "render":
    try: self.runNode(1.NodeId, context)
    except Exception as e: self.logger.log(%*{"event": "render:error", "node": 1, "error": $e.msg, "stacktrace": e.getStackTrace()})
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
  else: discard

proc runEvent*(self: FrameScene, context: var ExecutionContext) =
    runEvent(Scene(self), context)

proc render*(self: FrameScene, context: var ExecutionContext): Image =
  let self = Scene(self)
  context.image.fill(self.backgroundColor)
  runEvent(self, context)
  return context.image

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  var state = %*{}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 300.0, backgroundColor: parseHtmlColor("#76500f"))
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = render_splitApp.App(nodeName: "render/split", nodeId: 1.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_splitApp.AppConfig(
    rows: 2,
    columns: 2,
    inputImage: none(Image),
    hideEmpty: false,
    render_functions: @[
      @[
        2.NodeId,
        3.NodeId,
      ],
      @[
        4.NodeId,
        5.NodeId,
      ],
    ],
    render_function: 0.NodeId,
  ))
  scene.node2 = render_textApp.App(nodeName: "render/text", nodeId: 2.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    text: "Rendering a lot of text as just a text node. Rendering a lot of text as just a text node. Rendering a lot of text as just a text node. ",
    fontSize: 66.0,
    inputImage: none(Image),
    richText: "disabled",
    position: "center",
    vAlign: "middle",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 10.0,
    fontColor: parseHtmlColor("#ffffff"),
    borderColor: parseHtmlColor("#000000"),
    borderWidth: 2,
    overflow: "fit-bounds",
  ))
  scene.node3 = render_imageApp.App(nodeName: "render/image", nodeId: 3.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_imageApp.AppConfig(
    placement: "center",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
    blendMode: "normal",
  ))
  scene.node6 = render_textApp.App(nodeName: "render/text", nodeId: 6.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    text: "Rendering a lot of text as an image node with no image. Rendering a lot of text as an image node with no imageRendering a lot of text as an image node with no imageRendering a lot of text as an image node with no image",
    fontColor: parseHtmlColor("#000000"),
    fontSize: 24.0,
    borderWidth: 0,
    inputImage: none(Image),
    richText: "disabled",
    position: "center",
    vAlign: "middle",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 10.0,
    borderColor: parseHtmlColor("#000000"),
    overflow: "fit-bounds",
  ))
  scene.node4 = render_imageApp.App(nodeName: "render/image", nodeId: 4.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_imageApp.AppConfig(
    placement: "bottom-right",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
    blendMode: "normal",
  ))
  scene.node7 = render_textApp.App(nodeName: "render/text", nodeId: 7.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    text: "little  \ntext line",
    inputImage: none(Image),
    richText: "disabled",
    position: "center",
    vAlign: "middle",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 10.0,
    fontColor: parseHtmlColor("#ffffff"),
    fontSize: 32.0,
    borderColor: parseHtmlColor("#000000"),
    borderWidth: 2,
    overflow: "fit-bounds",
  ))
  scene.node5 = render_imageApp.App(nodeName: "render/image", nodeId: 5.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_imageApp.AppConfig(
    placement: "center",
    inputImage: none(Image),
    offsetX: 0,
    offsetY: 0,
    blendMode: "normal",
  ))
  scene.node9 = data_newImageApp.App(nodeName: "data/newImage", nodeId: 9.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: data_newImageApp.AppConfig(
    width: 100,
    height: 100,
    color: parseHtmlColor("#b30000"),
    opacity: 1.0,
    renderNext: 0.NodeId,
  ))
  scene.node8 = render_textApp.App(nodeName: "render/text", nodeId: 8.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_textApp.AppConfig(
    text: "text on image, i repeat this is text on an image",
    inputImage: some(block:
      if cache0.isNone():
        cache0 = some(block:
          self.node9.get(context))
      cache0.get()),
    richText: "disabled",
    position: "center",
    vAlign: "middle",
    offsetX: 0.0,
    offsetY: 0.0,
    padding: 10.0,
    fontColor: parseHtmlColor("#ffffff"),
    fontSize: 32.0,
    borderColor: parseHtmlColor("#000000"),
    borderWidth: 2,
    overflow: "fit-bounds",
  ))
  runEvent(self, context)
  
{.pop.}

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)
