import json, pixie, times, options, asyncdispatch, strformat, strutils, locks, tables
import pixie/fileformats/png
import scenes/scenes
import apps/render/image/app as render_imageApp
import apps/data/qr/app as data_qrApp

import frameos/apps
import frameos/channels
import frameos/logger
import frameos/types
import frameos/utils/image
import frameos/portal as portal

import drivers/drivers as drivers

# How fast must a scene render to be condidered fast. Two in a row pauses logging for 10s.
const FAST_SCENE_CUTOFF_SECONDS = 0.5

# How frequently we announce a new render via websockets
const SERVER_RENDER_DELAY_SECONDS = 1.0

# Where to store the persisted states
const SCENE_STATE_JSON_FOLDER = "./state"

# All scenes that are compiled into the FrameOS binary
let exportedScenes*: Table[SceneId, ExportedScene] = getExportedScenes()

var
  thread: Thread[(FrameConfig, Logger)]
  lastImageLock: Lock
  lastImage {.guard: lastImageLock.} = newImage(1, 1)
  lastImagePresent = false
  lastPublicStatesLock: Lock
  lastPublicStates {.guard: lastPublicStatesLock.} = %*{}
  lastPublicSceneId {.guard: lastPublicStatesLock.} = "".SceneId
  lastPersistedStates = %*{}
  lastPersistedSceneId: Option[SceneId] = none(SceneId)

proc setLastImage(image: Image) =
  withLock lastImageLock:
    lastImage = copy(image)
    lastImagePresent = true

proc getLastImagePng*(): string =
  if not lastImagePresent:
    raise newException(Exception, "No image rendered yet")
  var copy: seq[ColorRGBX]
  var width, height: int
  withLock lastImageLock:
    copy = lastImage.data
    width = lastImage.width
    height = lastImage.height
  return encodePng(width, height, 4, copy[0].addr, copy.len * 4)

proc getLastPublicState*(): (SceneId, JsonNode, seq[StateField]) =
  {.gcsafe.}: # It's fine: state is copied and .publicStateFields don't change
    var state = %*{}
    withLock lastPublicStatesLock:
      if lastPublicStates.hasKey(lastPublicSceneId.string):
        state = lastPublicStates[lastPublicSceneId.string].copy()
      return (lastPublicSceneId, state, exportedScenes[lastPublicSceneId].publicStateFields)

proc getAllPublicStates*(): (SceneId, JsonNode) =
  {.gcsafe.}: # It's fine: state is copied and .publicStateFields don't change
    withLock lastPublicStatesLock:
      return (lastPublicSceneId, lastPublicStates.copy())

proc updateLastPublicState*(self: FrameScene) =
  if not exportedScenes.hasKey(self.id):
    return
  let sceneExport = exportedScenes[self.id]
  withLock lastPublicStatesLock:
    if not lastPublicStates.hasKey(self.id.string):
      lastPublicStates[self.id.string] = %*{}
    let lastSceneState = lastPublicStates[self.id.string]
    for field in sceneExport.publicStateFields:
      let key = field.name
      if self.state.hasKey(key) and self.state[key] != lastSceneState{key}:
        lastSceneState[key] = copy(self.state[key])
  self.lastPublicStateUpdate = epochTime()

proc sanitizePathString*(s: string): string =
  return s.multiReplace(("/", "_"), ("\\", "_"), (":", "_"), ("*", "_"), ("?", "_"), ("\"", "_"), ("<", "_"), (">",
      "_"), ("|", "_"))

proc updateLastPersistedState*(self: FrameScene) =
  if not exportedScenes.hasKey(self.id):
    return
  let sceneExport = exportedScenes[self.id]
  var hasChanges = false
  if not lastPersistedStates.hasKey(self.id.string):
    lastPersistedStates[self.id.string] = %*{}
  let persistedState = lastPersistedStates[self.id.string]
  for key in sceneExport.persistedStateKeys:
    if self.state.hasKey(key) and self.state[key] != persistedState{key}:
      persistedState[key] = copy(self.state[key])
      hasChanges = true
  if hasChanges:
    writeFile(&"{SCENE_STATE_JSON_FOLDER}/scene-{sanitizePathString(self.id.string)}.json", $persistedState)
  self.lastPersistedStateUpdate = epochTime()
  if lastPersistedSceneId.isNone() or lastPersistedSceneId.get() != self.id:
    writeFile(&"{SCENE_STATE_JSON_FOLDER}/scene.json", $(%*{"sceneId": self.id.string}))
    lastPersistedSceneId = some(self.id)

proc loadPersistedState*(sceneId: SceneId): JsonNode =
  try:
    return parseJson(readFile(&"{SCENE_STATE_JSON_FOLDER}/scene-{sanitizePathString(sceneId.string)}.json"))
  except JsonParsingError, IOError:
    return %*{}

proc loadLastScene*(): Option[SceneId] =
  try:
    let json = parseJson(readFile(&"{SCENE_STATE_JSON_FOLDER}/scene.json"))
    if json.hasKey("sceneId"):
      result = some(SceneId(json["sceneId"].getStr()))
      lastPersistedSceneId = result
  except JsonParsingError, IOError:
    return none(SceneId)

proc getFirstSceneId*(): SceneId =
  if defaultSceneId.isSome():
    return defaultSceneId.get()
  let lastSceneId = loadLastScene()
  if lastSceneId.isSome() and exportedScenes.hasKey(lastSceneId.get()):
    return lastSceneId.get()
  if len(exportedScenes) > 0:
    for key in keys(exportedScenes):
      return key
  return "".SceneId

proc renderSceneImage*(self: RunnerThread, exportedScene: ExportedScene, scene: FrameScene): (Image, float) =
  let sceneTimer = epochTime()
  let requiredWidth = self.frameConfig.renderWidth()
  let requiredHeight = self.frameConfig.renderHeight()
  self.logger.log(%*{"event": "render:scene", "width": requiredWidth, "height": requiredHeight,
      "sceneId": scene.id.string})

  var context = ExecutionContext(
    scene: scene,
    event: "render",
    payload: %*{},
    image: case self.frameConfig.rotate:
    of 90, 270: newImage(self.frameConfig.height, self.frameConfig.width)
    else: newImage(self.frameConfig.width, self.frameConfig.height),
    hasImage: true,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: -1
  )

  try:
    discard exportedScene.render(scene, context)
    if self.frameConfig.controlCode.enabled:
      render_imageApp.App(self.controlCodeRender).appConfig.image = data_qrApp.App(self.controlCodeData).get(context)
      render_imageApp.App(self.controlCodeRender).run(context)
    let image = context.image

    var outImage: Image
    if image.width != requiredWidth or image.height != requiredHeight:
      outImage = newImage(requiredWidth, requiredHeight)
      outImage.fill(scene.backgroundColor)
      scaleAndDrawImage(outImage, image, self.frameConfig.scalingMode)
    else:
      outImage = image
    setLastImage(outImage)
    result = (outImage.rotateDegrees(self.frameConfig.rotate), context.nextSleep)
  except Exception as e:
    result = (renderError(requiredWidth, requiredHeight, &"Error: {$e.msg}\n{$e.getStackTrace()}"), context.nextSleep)
    self.logger.log(%*{"event": "render:error", "error": $e.msg, "stacktrace": e.getStackTrace()})

  # status bar (if we are in captive-portal mode)
  let statusMsg = portal.getStatusMessage(self.frameConfig)
  if statusMsg.len > 0:
    drawStatusBar(result[0], statusMsg)

  self.lastRenderAt = epochTime()
  self.logger.log(%*{"event": "render:done", "sceneId": scene.id.string, "ms": round((epochTime() - sceneTimer) * 1000, 3)})

proc startRenderLoop*(self: RunnerThread): Future[void] {.async.} =
  self.logger.log(%*{"event": "render:startLoop"})
  var timer = 0.0
  var driverTimer = 0.0
  var sleepDuration = 0.0
  var fastSceneCount = 0
  var fastSceneResumeAt = 0.0
  var nextServerRenderAt = 0.0
  var lastSceneId = "".SceneId
  var currentScene: FrameScene

  while true:
    timer = epochTime()
    self.isRendering = true
    let sceneId = if exportedScenes.hasKey(self.currentSceneId): self.currentSceneId else: getFirstSceneId()
    let exportedScene = exportedScenes[sceneId]
    if lastSceneId != sceneId:
      self.logger.log(%*{"event": "render:sceneChange", "sceneId": sceneId.string})
      if self.scenes.hasKey(sceneId):
        currentScene = self.scenes[sceneId]
      else:
        try:
          currentScene = exportedScenes[sceneId].init(sceneId, self.frameConfig, self.logger, loadPersistedState(sceneId))
          self.scenes[sceneId] = currentScene
          currentScene.updateLastPublicState()
        except Exception as e:
          self.logger.log(%*{"event": "render:error:scene:init", "error": $e.msg, "stacktrace": e.getStackTrace()})

      lastSceneId = sceneId
      withLock lastPublicStatesLock:
        lastPublicSceneId = sceneId

    currentScene.isRendering = true
    self.triggerRenderNext = false # used to debounce render events received while rendering

    let interval = currentScene.refreshInterval
    let (lastRotatedImage, nextSleep) = self.renderSceneImage(exportedScene, currentScene)
    if interval < 1:
      let now = epochTime()
      if now >= nextServerRenderAt:
        nextServerRenderAt = nextServerRenderAt + SERVER_RENDER_DELAY_SECONDS
        if nextServerRenderAt < now:
          nextServerRenderAt = now + SERVER_RENDER_DELAY_SECONDS
        triggerServerRender()
    else:
      triggerServerRender()

    driverTimer = epochTime()
    try:
      # TODO: render the driver part in another thread
      drivers.render(lastRotatedImage)
      self.logger.log(%*{"event": "render:driver",
        "device": self.frameConfig.device, "ms": round((epochTime() - driverTimer) * 1000, 3)})
    except Exception as e:
      self.logger.log(%*{"event": "render:driver:error", "error": $e.msg, "stacktrace": e.getStackTrace()})

    if interval < 1 or (nextSleep > 0 and nextSleep < interval):
      let now = epochTime()
      if now - timer < FAST_SCENE_CUTOFF_SECONDS:
        fastSceneCount += 1
        # Two fast scenes in a row
        if fastSceneCount == 2:
          # TODO: capture logs per _scene_ and log if slow
          self.logger.log(%*{"event": "render:pause", "message": "Rendering fast. Pausing all scene render logs for 10 seconds."})
          self.logger.disable()
          fastSceneResumeAt = now + 10
        elif fastSceneResumeAt != 0.0 and now > fastSceneResumeAt:
          fastSceneCount = 0
          fastSceneResumeAt = 0.0
          self.logger.enable()
      else:
        fastSceneCount = 0
        fastSceneResumeAt = 0.0
        self.logger.enable()

    # Gives a chance for the gathered events to be collected
    await sleepAsync(0.001)
    self.isRendering = false
    currentScene.isRendering = false

    if epochTime() > currentScene.lastPublicStateUpdate + 1.0:
      currentScene.updateLastPublicState()

    if epochTime() > currentScene.lastPersistedStateUpdate + 1.0:
      currentScene.updateLastPersistedState()

    # While we were rendering an event to trigger a render was dispatched
    if self.triggerRenderNext:
      self.triggerRenderNext = false
      continue

    # If no sleep duration provided by the scene, calculate based on the interval
    sleepDuration = if nextSleep >= 0: nextSleep * 1000
                    else: max((interval - (epochTime() - timer)) * 1000, 0.1)
    self.logger.log(%*{"event": "render:sleep", "ms": round(sleepDuration, 3)})

    let future = sleepAsync(sleepDuration)
    self.sleepFuture = some(future)
    await future
    self.sleepFuture = none(Future[void])

proc triggerRender*(self: RunnerThread): void =
  if self.sleepFuture.isSome:
    self.sleepFuture.get().complete()
  else:
    self.logger.log(%*{"event": "render", "error": "Render already in progress, ignoring."})

proc dispatchSceneEvent*(self: RunnerThread, sceneId: Option[SceneId], event: string, payload: JsonNode) =
  let targetSceneId: SceneId = if sceneId.isSome: sceneId.get() else: self.currentSceneId
  if not self.scenes.hasKey(targetSceneId):
    self.logger.log(%*{"event": "dispatchEvent:error", "error": "Scene not initialized",
        "sceneId": targetSceneId.string, "event": event, "payload": payload})
    return
  let scene = self.scenes[targetSceneId]
  let exportedScene = exportedScenes[targetSceneId]
  var context = ExecutionContext(
    scene: scene,
    event: event,
    payload: payload,
    hasImage: false,
    loopIndex: 0,
    loopKey: ".",
    nextSleep: -1
  )
  exportedScene.runEvent(scene, context)
  if event == "setSceneState" or event == "setCurrentScene":
    scene.updateLastPublicState()
    scene.updateLastPersistedState()

proc startMessageLoop*(self: RunnerThread): Future[void] {.async.} =
  var waitTime = 10

  while true:
    let (success, (sceneId, event, payload)) = eventChannel.tryRecv()
    if success:
      waitTime = 1
      if not event.startsWith("mouse"):
        self.logger.log(%*{"event": "event:" & event, "payload": payload})
      try:
        case event:
          of "render":
            self.triggerRenderNext = true
            continue
          of "turnOn":
            drivers.turnOn()
          of "turnOff":
            drivers.turnOff()
          of "mouseMove":
            if self.frameConfig.width > 0 and self.frameConfig.height > 0:
              payload["x"] = %*((self.frameConfig.width.float * payload["x"].getInt().float / 32767.0).int)
              payload["y"] = %*((self.frameConfig.height.float * payload["y"].getInt().float / 32767.0).int)
          of "setCurrentScene":
            let sceneId = SceneId(payload["sceneId"].getStr())
            if not exportedScenes.hasKey(sceneId):
              self.logger.log(%*{"event": "dispatchEvent:error", "error": "Scene not found", "sceneId": sceneId.string,
                  "event": event, "payload": payload})
              continue
            if sceneId != self.currentSceneId:
              self.dispatchSceneEvent(some(self.currentSceneId), "close", payload)
              if not self.scenes.hasKey(sceneId):
                let scene = exportedScenes[sceneId].init(sceneId, self.frameConfig, self.logger, loadPersistedState(sceneId))
                self.scenes[sceneId] = scene
                scene.updateLastPublicState()
              self.currentSceneId = sceneId
              self.triggerRenderNext = true
              self.dispatchSceneEvent(some(sceneId), event, payload)
            elif payload.hasKey("state"):
              self.triggerRenderNext = true
              self.dispatchSceneEvent(some(sceneId), event, payload)
            continue # don't dispatch this event to the scene
          else: discard
        self.dispatchSceneEvent(sceneId, event, payload)
      except Exception as e:
        self.logger.log(%*{"event": "event:error", "error": $e.msg, "stacktrace": e.getStackTrace()})

    # after we have processed all queued messages
    if not success:
      if self.triggerRenderNext and not self.isRendering:
        self.triggerRenderNext = false
        self.triggerRender()
      else:
        await sleepAsync(waitTime)
        if waitTime < 200:
          waitTime += 5

proc createRunnerThread*(args: (FrameConfig, Logger)) =
  {.cast(gcsafe).}:
    var runnerThread = RunnerThread(
      frameConfig: args[0],
      scenes: initTable[SceneId, FrameScene](),
      currentSceneId: getFirstSceneId(),
      lastRenderAt: 0,
      sleepFuture: none(Future[void]),
      isRendering: false,
      triggerRenderNext: false,
      logger: args[1]
    )
    if args[0].controlCode.enabled:
      let controlCode = args[0].controlCode
      runnerThread.controlCodeRender = render_imageApp.App(nodeName: "render/image", nodeId: -1.NodeId,
        frameConfig: args[0], appConfig: render_imageApp.AppConfig(
        offsetX: controlCode.offsetX,
        offsetY: controlCode.offsetY,
        placement: controlCode.position,
      ))
      runnerThread.controlCodeData = data_qrApp.App(nodeName: "data/qr", nodeId: -1.NodeId,
        frameConfig: args[0], appConfig: data_qrApp.AppConfig(
        backgroundColor: controlCode.backgroundColor,
        qrCodeColor: controlCode.qrCodeColor,
        padding: controlCode.padding,
        size: controlCode.size,
        codeType: "Frame Control URL",
        code: "",
        sizeUnit: "pixels per dot",
        alRad: 30.0,
        moRad: 0.0,
        moSep: 0.0
      ))

    waitFor runnerThread.startRenderLoop() and runnerThread.startMessageLoop()

proc newRunner*(frameConfig: FrameConfig): RunnerControl =
  # create a separate logger, so we can pause it when rendering fast
  var logger = newLogger(frameConfig)
  result = RunnerControl(
    start: proc () = createThread(thread, createRunnerThread, (frameConfig, logger)),
  )
  setLastImage(renderError(frameConfig.renderWidth(), frameConfig.renderHeight(), "FrameOS booting..."))
