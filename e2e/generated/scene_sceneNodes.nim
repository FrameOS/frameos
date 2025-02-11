# This file is autogenerated

{.warning[UnusedImport]: off.}
import pixie, json, times, strformat, strutils, sequtils, options, algorithm

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/render/split/app as render_splitApp
import scenes/scene_renderTextSplit as scene_renderTextSplit
import scenes/scene_renderTextRich as scene_renderTextRich
import scenes/scene_renderGradientSplit as scene_renderGradientSplit
import scenes/scene_logicIfElse as scene_logicIfElse

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: render_splitApp.App
  node2: scene_renderTextSplit.Scene
  node3: scene_renderTextRich.Scene
  node4: scene_renderGradientSplit.Scene
  node5: scene_logicIfElse.Scene

{.push hint[XDeclaredButNotUsed]: off.}


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
    of 2.NodeId: # render
      scene_renderTextSplit.runEvent(self.node2, context)
      nextNode = -1.NodeId
    of 3.NodeId: # render
      scene_renderTextRich.runEvent(self.node3, context)
      nextNode = -1.NodeId
    of 4.NodeId: # render
      scene_renderGradientSplit.runEvent(self.node4, context)
      nextNode = -1.NodeId
    of 5.NodeId: # render
      scene_logicIfElse.runEvent(self.node5, context)
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
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 3600.0, backgroundColor: parseHtmlColor("#000000"))
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = render_splitApp.App(nodeName: "render/split", nodeId: 1.NodeId, scene: scene.FrameScene, frameConfig: scene.frameConfig, appConfig: render_splitApp.AppConfig(
    rows: 2,
    columns: 2,
    gap: "10",
    margin: "10",
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
  scene.node2 = scene_renderTextSplit.Scene(scene_renderTextSplit.init("renderTextSplit".SceneId, frameConfig, logger, %*({})))
  scene.node3 = scene_renderTextRich.Scene(scene_renderTextRich.init("renderTextRich".SceneId, frameConfig, logger, %*({})))
  scene.node4 = scene_renderGradientSplit.Scene(scene_renderGradientSplit.init("renderGradientSplit".SceneId, frameConfig, logger, %*({})))
  scene.node5 = scene_logicIfElse.Scene(scene_logicIfElse.init("logicIfElse".SceneId, frameConfig, logger, %*({})))
  runEvent(self, context)
  
{.pop.}

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)
