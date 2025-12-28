import json, pixie, times, options, asyncdispatch, strformat, strutils, tables
import std/monotimes
import apps/render/image/app as render_imageApp
import apps/data/qr/app as data_qrApp

import frameos/apps
import frameos/channels
import frameos/logger
import frameos/types
import frameos/utils/image
import frameos/utils/time
import frameos/scenes

import drivers/drivers as drivers

# How fast must a scene render to be condidered fast. Two in a row pauses logging for 10s.
const FAST_SCENE_CUTOFF_SECONDS = 0.5
const INKY_FAST_RENDER_THRESHOLD_MS = 2.0

# How frequently we announce a new render via websockets
const SERVER_RENDER_DELAY_SECONDS = 1.0

var thread: Thread[(FrameConfig, Logger, Option[SceneId])]

proc configureControlCode(self: RunnerThread) =
  if self.frameConfig.controlCode.enabled:
    let controlCode = self.frameConfig.controlCode
    self.controlCodeRender = render_imageApp.App(nodeName: "render/image", nodeId: -1.NodeId,
      frameConfig: self.frameConfig, appConfig: render_imageApp.AppConfig(
      offsetX: controlCode.offsetX,
      offsetY: controlCode.offsetY,
      placement: controlCode.position,
    ))
    self.controlCodeData = data_qrApp.App(nodeName: "data/qr", nodeId: -1.NodeId,
      frameConfig: self.frameConfig, appConfig: data_qrApp.AppConfig(
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
  else:
    self.controlCodeRender = nil
    self.controlCodeData = nil

proc renderSceneImage*(self: RunnerThread, exportedScene: ExportedScene, scene: FrameScene): (Image, float) =
  let sceneTimer = getMonoTime()
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
    case self.frameConfig.flip:
    of "horizontal":
      outImage.flipHorizontal()
    of "vertical":
      outImage.flipVertical()
    of "both":
      outImage.flipHorizontal()
      outImage.flipVertical()
    else:
      discard
    result = (outImage.rotateDegrees(self.frameConfig.rotate), context.nextSleep)
  except Exception as e:
    result = (renderError(requiredWidth, requiredHeight, &"Error: {$e.msg}\n{$e.getStackTrace()}"), context.nextSleep)
    self.logger.log(%*{"event": "render:error", "error": $e.msg, "stacktrace": e.getStackTrace()})

  self.lastRenderAt = epochTime()
  let elapsedMs = durationToMilliseconds(getMonoTime() - sceneTimer)
  self.logger.log(%*{"event": "render:done", "sceneId": scene.id.string, "ms": round(elapsedMs, 3)})

proc startRenderLoop*(self: RunnerThread): Future[void] {.async.} =
  self.logger.log(%*{"event": "render:startLoop"})
  var timer = getMonoTime()
  var driverTimer = getMonoTime()
  var sleepDuration = 0.0
  var fastSceneCount = 0
  var fastSceneResumeAt = none(MonoTime)
  var nextServerRenderAt = getMonoTime()
  var lastSceneId = "".SceneId
  var currentScene: FrameScene
  let serverRenderDelay = initDuration(milliseconds = int(SERVER_RENDER_DELAY_SECONDS * 1000))

  while true:
    timer = getMonoTime()
    self.isRendering = true
    if self.forceSceneReload:
      lastSceneId = "".SceneId
      self.forceSceneReload = false
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
      setLastPublicSceneId(sceneId)

    currentScene.isRendering = true
    self.triggerRenderNext = false # used to debounce render events received while rendering

    let interval = currentScene.refreshInterval
    let (lastRotatedImage, nextSleep) = self.renderSceneImage(exportedScene, currentScene)
    if interval < 1:
      let now = getMonoTime()
      if now >= nextServerRenderAt:
        nextServerRenderAt = nextServerRenderAt + serverRenderDelay
        if nextServerRenderAt < now:
          nextServerRenderAt = now + serverRenderDelay
        triggerServerRender()
    else:
      triggerServerRender()

    driverTimer = getMonoTime()
    try:
      # TODO: render the driver part in another thread
      drivers.render(lastRotatedImage)
      let driverElapsedMs = round(durationToMilliseconds(getMonoTime() - driverTimer), 3)
      self.logger.log(%*{"event": "render:driver",
        "device": self.frameConfig.device, "ms": driverElapsedMs})
      if self.frameConfig.device.startsWith("pimoroni.inky") and driverElapsedMs < INKY_FAST_RENDER_THRESHOLD_MS:
        self.logger.log(%*{"event": "render:driver:warning",
          "device": self.frameConfig.device,
          "ms": driverElapsedMs,
          "message": "Driver render finished suspiciously fast; check inkyPython logs for errors."})
    except Exception as e:
      self.logger.log(%*{"event": "render:driver:error", "error": $e.msg, "stacktrace": e.getStackTrace()})

    if interval < 1 or (nextSleep > 0 and nextSleep < interval):
      let now = getMonoTime()
      let elapsedSeconds = durationToSeconds(now - timer)
      if elapsedSeconds < FAST_SCENE_CUTOFF_SECONDS:
        fastSceneCount += 1
        # Two fast scenes in a row
        if fastSceneCount == 2:
          # TODO: capture logs per _scene_ and log if slow
          self.logger.log(%*{"event": "render:pause", "message": "Rendering fast. Pausing all scene render logs for 10 seconds."})
          self.logger.disable()
          fastSceneResumeAt = some(now + initDuration(seconds = 10))
        elif fastSceneResumeAt.isSome and now > fastSceneResumeAt.get():
          fastSceneCount = 0
          fastSceneResumeAt = none(MonoTime)
          self.logger.enable()
      else:
        fastSceneCount = 0
        fastSceneResumeAt = none(MonoTime)
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
                    else: max((interval - durationToSeconds(getMonoTime() - timer)) * 1000, 0.1)
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
            if not exportedScenes.hasKey(sceneId) and not systemScenes.hasKey(sceneId):
              self.logger.log(%*{"event": "dispatchEvent:error", "error": "Scene not found", "sceneId": sceneId.string,
                  "event": event, "payload": payload})
              continue
            if sceneId != self.currentSceneId:
              self.dispatchSceneEvent(some(self.currentSceneId), "close", payload)
              if not self.scenes.hasKey(sceneId):
                let scene = if exportedScenes.hasKey(sceneId):
                  exportedScenes[sceneId].init(sceneId, self.frameConfig, self.logger, loadPersistedState(sceneId))
                else:
                  systemScenes[sceneId].init(sceneId, self.frameConfig, self.logger, loadPersistedState(sceneId))
                self.scenes[sceneId] = scene
                scene.updateLastPublicState()
              self.currentSceneId = sceneId
              self.triggerRenderNext = true
              self.dispatchSceneEvent(some(sceneId), event, payload)
            elif payload.hasKey("state"):
              self.triggerRenderNext = true
              self.dispatchSceneEvent(some(sceneId), event, payload)
            continue # don't dispatch this event to the scene
          of "reload":
            self.logger.log(%*{"event": "reload", "message": "Reloading config and interpreted scenes"})
            reloadInterpretedScenes()
            self.scenes = initTable[SceneId, FrameScene]()
            if not exportedScenes.hasKey(self.currentSceneId):
              self.currentSceneId = getFirstSceneId()
            self.configureControlCode()
            self.forceSceneReload = true
            self.triggerRenderNext = true
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

proc createRunnerThread*(args: (FrameConfig, Logger, Option[SceneId])) =
  {.cast(gcsafe).}:
    var runnerThread = RunnerThread(
      frameConfig: args[0],
      scenes: initTable[SceneId, FrameScene](),
      currentSceneId: if args[2].isSome: args[2].get() else: getFirstSceneId(),
      lastRenderAt: 0,
      sleepFuture: none(Future[void]),
      isRendering: false,
      triggerRenderNext: false,
      logger: args[1]
    )
    runnerThread.configureControlCode()

    waitFor runnerThread.startRenderLoop() and runnerThread.startMessageLoop()

proc newRunner*(frameConfig: FrameConfig): RunnerControl =
  # create a separate logger, so we can pause it when rendering fast
  var logger = newLogger(frameConfig)
  result = RunnerControl(
    start: proc (firstSceneId: Option[SceneId]) = createThread(thread, createRunnerThread, (frameConfig, logger,
        firstSceneId)),
  )
  setLastImage(renderError(frameConfig.renderWidth(), frameConfig.renderHeight(), "FrameOS booting..."))
