# This code is autogenerated

import pixie, json, times, strformat

from frameos/types import FrameOS, FrameScene, ExecutionContext
from frameos/logger import log
import apps/unsplash/app as unsplashApp
import apps/text/app as textApp
import apps/clock/app as clockApp
import apps/downloadImage/app as downloadImageApp
import apps/split/app as splitApp
import apps/ifElse/app as ifElseApp
import apps/gradient/app as gradientApp
import apps/rotate/app as rotateApp

let DEBUG = false

type Scene* = ref object of FrameScene
  app_cbef1661_d2f5_4ef8_b0cf_458c3ae11200: unsplashApp.App
  app_b94c5793_aeb1_4f3a_b273_c2305c12096e: textApp.App
  app_1c9414bd_8bc4_4249_8ffb_1b3094715a06: clockApp.App
  app_ddbd3753_ea6a_4a80_98b4_455fb623ef6b: downloadImageApp.App
  app_caa0e562_49c7_47ba_9bfb_c6d1a837e414: splitApp.App
  app_af43bfef_9f59_4a37_912b_8138c07ff9d3: unsplashApp.App
  app_bbe82c34_84f6_4afe_beb3_87baa54f02e7: ifElseApp.App
  app_b5f06d55_8889_4869_b12e_f5207211fa05: gradientApp.App
  app_f4071b08_9afa_47c1_b890_0ca025849914: unsplashApp.App
  app_06d5af4b_069e_4550_bd1b_e636e1b8cc2b: rotateApp.App

{.push hint[XDeclaredButNotUsed]: off.}
proc runNode*(self: Scene, nodeId: string,
    context: var ExecutionContext) =
  let scene = self
  let frameOS = scene.frameOS
  let frameConfig = frameOS.frameConfig
  let state = scene.state
  var nextNode = nodeId
  var currentNode = nodeId
  var timer = epochTime()
  while nextNode != "-1":
    currentNode = nextNode
    timer = epochTime()
    case nextNode:
    of "cbef1661-d2f5-4ef8-b0cf-458c3ae11200":
      self.app_cbef1661_d2f5_4ef8_b0cf_458c3ae11200.run(context)
      nextNode = "-1"
    of "b94c5793-aeb1-4f3a-b273-c2305c12096e":
      self.app_b94c5793_aeb1_4f3a_b273_c2305c12096e.appConfig.text = &"Welcome to FrameOS!\nResolution: {context.image.width} x {context.image.height} .. " &
          scene.state{"magic"}.getStr()
      self.app_b94c5793_aeb1_4f3a_b273_c2305c12096e.appConfig.position = "top-left"
      self.app_b94c5793_aeb1_4f3a_b273_c2305c12096e.run(context)
      nextNode = "1c9414bd-8bc4-4249-8ffb-1b3094715a06"
    of "1c9414bd-8bc4-4249-8ffb-1b3094715a06":
      self.app_1c9414bd_8bc4_4249_8ffb_1b3094715a06.run(context)
      nextNode = "06d5af4b-069e-4550-bd1b-e636e1b8cc2b"
    of "ddbd3753-ea6a-4a80-98b4-455fb623ef6b":
      self.app_ddbd3753_ea6a_4a80_98b4_455fb623ef6b.run(context)
      nextNode = "-1"
    of "caa0e562-49c7-47ba-9bfb-c6d1a837e414":
      self.app_caa0e562_49c7_47ba_9bfb_c6d1a837e414.run(context)
      nextNode = "-1"
    of "af43bfef-9f59-4a37-912b-8138c07ff9d3":
      self.app_af43bfef_9f59_4a37_912b_8138c07ff9d3.run(context)
      nextNode = "-1"
    of "bbe82c34-84f6-4afe-beb3-87baa54f02e7":
      self.app_bbe82c34_84f6_4afe_beb3_87baa54f02e7.appConfig.condition = context.loopIndex mod 2 == 0
      self.app_bbe82c34_84f6_4afe_beb3_87baa54f02e7.run(context)
      nextNode = "-1"
    of "b5f06d55-8889-4869-b12e-f5207211fa05":
      self.app_b5f06d55_8889_4869_b12e_f5207211fa05.run(context)
      nextNode = "-1"
    of "f4071b08-9afa-47c1-b890-0ca025849914":
      self.app_f4071b08_9afa_47c1_b890_0ca025849914.run(context)
      nextNode = "b94c5793-aeb1-4f3a-b273-c2305c12096e"
    of "06d5af4b-069e-4550-bd1b-e636e1b8cc2b":
      self.app_06d5af4b_069e_4550_bd1b_e636e1b8cc2b.run(context)
      nextNode = "-1"
    else:
      nextNode = "-1"
    if DEBUG:
      self.logger.log(%*{"event": "runApp", "node": currentNode, "ms": (-timer +
          epochTime()) * 1000})

proc dispatchEvent*(self: Scene, context: var ExecutionContext) =
  case context.event:
  of "render":
    self.runNode("f4071b08-9afa-47c1-b890-0ca025849914", context)
  else: discard

proc init*(frameOS: FrameOS): Scene =
  var state = %*{}
  let frameConfig = frameOS.frameConfig
  let logger = frameOS.logger
  let scene = Scene(frameOS: frameOS, frameConfig: frameConfig, logger: logger, state: state)
  let self = scene
  var context = ExecutionContext(scene: scene, event: "init", eventPayload: %*{},
      image: newImage(1, 1), loopIndex: 0, loopKey: ".")
  result = scene
  scene.execNode = (proc(nodeId: string,
      context: var ExecutionContext) = self.runNode(nodeId, context))
  scene.app_cbef1661_d2f5_4ef8_b0cf_458c3ae11200 = unsplashApp.init(
      "cbef1661-d2f5-4ef8-b0cf-458c3ae11200", scene, unsplashApp.AppConfig(
      cacheSeconds: 60.0, keyword: "birds"))
  scene.app_b94c5793_aeb1_4f3a_b273_c2305c12096e = textApp.init(
      "b94c5793-aeb1-4f3a-b273-c2305c12096e", scene, textApp.AppConfig(
      borderWidth: 2, fontColor: parseHtmlColor("#ffffff"), fontSize: 64.0,
      text: &"Welcome to FrameOS!\nResolution: {context.image.width} x {context.image.height} .. " &
      scene.state{"magic"}.getStr(), position: "top-left", offsetX: 0.0,
      offsetY: 0.0, padding: 10.0, borderColor: parseHtmlColor("#000000")))
  scene.app_1c9414bd_8bc4_4249_8ffb_1b3094715a06 = clockApp.init(
      "1c9414bd-8bc4-4249-8ffb-1b3094715a06", scene, clockApp.AppConfig(
      position: "bottom-center", format: "HH:mm:ss", formatCustom: "",
      offsetX: 0.0, offsetY: 0.0, padding: 10.0, fontColor: parseHtmlColor(
      "#ffffff"), fontSize: 32.0, borderColor: parseHtmlColor("#000000"),
      borderWidth: 1))
  scene.app_ddbd3753_ea6a_4a80_98b4_455fb623ef6b = downloadImageApp.init(
      "ddbd3753-ea6a-4a80-98b4-455fb623ef6b", scene, downloadImageApp.AppConfig(
      url: "http://10.4.0.11:4999/", scalingMode: "cover", cacheSeconds: 60.0))
  scene.app_caa0e562_49c7_47ba_9bfb_c6d1a837e414 = splitApp.init(
      "caa0e562-49c7-47ba-9bfb-c6d1a837e414", scene, splitApp.AppConfig(
      columns: 3, gap: "10", margin: "5", rows: 2,
      render_function: "bbe82c34-84f6-4afe-beb3-87baa54f02e7"))
  scene.app_af43bfef_9f59_4a37_912b_8138c07ff9d3 = unsplashApp.init(
      "af43bfef-9f59-4a37-912b-8138c07ff9d3", scene, unsplashApp.AppConfig(
      keyword: "nature", cacheSeconds: 60.0))
  scene.app_bbe82c34_84f6_4afe_beb3_87baa54f02e7 = ifElseApp.init(
      "bbe82c34-84f6-4afe-beb3-87baa54f02e7", scene, ifElseApp.AppConfig(
      condition: context.loopIndex mod 2 == 0,
      thenNode: "af43bfef-9f59-4a37-912b-8138c07ff9d3",
      elseNode: "b5f06d55-8889-4869-b12e-f5207211fa05"))
  scene.app_b5f06d55_8889_4869_b12e_f5207211fa05 = gradientApp.init(
      "b5f06d55-8889-4869-b12e-f5207211fa05", scene, gradientApp.AppConfig(
      startColor: parseHtmlColor("#800080"), endColor: parseHtmlColor(
      "#ffc0cb"), angle: 45.0))
  scene.app_f4071b08_9afa_47c1_b890_0ca025849914 = unsplashApp.init(
      "f4071b08-9afa-47c1-b890-0ca025849914", scene, unsplashApp.AppConfig(
      cacheSeconds: 600.0, keyword: "nature"))
  scene.app_06d5af4b_069e_4550_bd1b_e636e1b8cc2b = rotateApp.init(
      "06d5af4b-069e-4550-bd1b-e636e1b8cc2b", scene, rotateApp.AppConfig(
      rotationDegree: 45.0, scalingMode: "stretch"))
  dispatchEvent(scene, context)

proc render*(self: Scene): Image =
  var context = ExecutionContext(
    scene: self,
    event: "render",
    eventPayload: %*{},
    image: case self.frameConfig.rotate:
    of 90, 270: newImage(self.frameConfig.height, self.frameConfig.width)
    else: newImage(self.frameConfig.width, self.frameConfig.height),
    loopIndex: 0,
    loopKey: "."
  )
  dispatchEvent(self, context)
  return context.image
{.pop.}
