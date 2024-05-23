# This file is autogenerated

import pixie, json, times, strformat, strutils, sequtils, options

import frameos/types
import frameos/channels
import frameos/utils/image
import frameos/utils/url
import apps/split/app as splitApp
import apps/ifElse/app as ifElseApp
import apps/color/app as colorApp

const DEBUG = false
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

type Scene* = ref object of FrameScene
  node1: splitApp.App
  node2: ifElseApp.App
  node3: colorApp.App
  node4: colorApp.App

{.push hint[XDeclaredButNotUsed]: off.}



proc runNode*(self: Scene, nodeId: NodeId,
    context: var ExecutionContext) =
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
    of 1.NodeId: # split
      self.node1.run(context)
      nextNode = -1.NodeId
    of 2.NodeId: # ifElse
      self.node2.appConfig.condition = context.loopIndex mod 2 == 0
      self.node2.run(context)
      nextNode = -1.NodeId
    of 3.NodeId: # color
      self.node3.run(context)
      nextNode = -1.NodeId
    of 4.NodeId: # color
      self.node4.run(context)
      nextNode = -1.NodeId
    else:
      nextNode = -1.NodeId
    
    if DEBUG:
      self.logger.log(%*{"event": "scene:debug:app", "node": currentNode, "ms": (-timer + epochTime()) * 1000})

proc runEvent*(context: var ExecutionContext) =
  let self = Scene(context.scene)
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
  else: discard

proc render*(self: FrameScene, context: var ExecutionContext): Image =
  let self = Scene(self)
  context.image.fill(self.backgroundColor)
  runEvent(context)
  return context.image

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  var state = %*{}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(id: sceneId, frameConfig: frameConfig, state: state, logger: logger, refreshInterval: 300.0, backgroundColor: parseHtmlColor("#000000"))
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: var ExecutionContext) = scene.runNode(nodeId, context))
  scene.node1 = splitApp.init(1.NodeId, scene.FrameScene, splitApp.AppConfig(
    rows: 3,
    columns: 3,
    width_ratios: "1 2 1",
    height_ratios: "2 1 2",
    render_functions: @[
      @[
        0.NodeId,
        0.NodeId,
        0.NodeId,
      ],
      @[
        0.NodeId,
        0.NodeId,
        0.NodeId,
      ],
      @[
        0.NodeId,
        0.NodeId,
        0.NodeId,
      ],
    ],
    render_function: 2.NodeId,
  ))
  scene.node2 = ifElseApp.init(2.NodeId, scene.FrameScene, ifElseApp.AppConfig(
    condition: context.loopIndex mod 2 == 0,
    thenNode: 3.NodeId,
    elseNode: 4.NodeId,
  ))
  scene.node3 = colorApp.init(3.NodeId, scene.FrameScene, colorApp.AppConfig(
    color: parseHtmlColor("#aba12b"),
  ))
  scene.node4 = colorApp.init(4.NodeId, scene.FrameScene, colorApp.AppConfig(
    color: parseHtmlColor("#814141"),
  ))
  runEvent(context)
  
{.pop.}

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)
