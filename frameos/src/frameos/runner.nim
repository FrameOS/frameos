import json, pixie, times, options, asyncdispatch, strformat, strutils, locks
import pixie/fileformats/png
import scenes/default as defaultScene

import frameos/channels
import frameos/types
import frameos/config
import frameos/utils/image

import drivers/drivers as drivers

const FAST_SCENE = 0.5
const SERVER_RENDER_DELAY = 1.0

const SCENE_STATE_JSON_PATH = "../db/scene.json"

type
  RunnerThread = ref object
    frameConfig: FrameConfig
    logger: Logger
    scene: FrameScene
    lastRenderAt: float
    sleepFuture: Option[Future[void]]
    isRendering: bool = false
    triggerRenderNext: bool = false

var
  thread: Thread[(FrameConfig, Logger)]
  pngLock: Lock
  pngImage = newImage(1, 1)
  hasPngImage = false
  lastPublicState = %*{}
  lastPublicStateLock: Lock
  lastPublicStateUpdate = 0.0
  lastPersistedState = %*{}
  lastPersistedStateUpdate = 0.0

proc setLastImage(image: Image) =
  withLock pngLock:
    if pngImage.width != image.width or pngImage.height != image.height:
      pngImage = newImage(image.width, image.height)
    pngImage.draw(image)
    hasPngImage = true

proc getLastPng*(): string =
  if not hasPngImage:
    raise newException(Exception, "No image rendered yet")
  var copy: seq[ColorRGBX]
  withLock pngLock:
    copy = pngImage.data
  return encodePng(pngImage.width, pngImage.height, 4, copy[0].addr, copy.len * 4)

proc updateLastPublicState*(state: JsonNode) =
  withLock lastPublicStateLock:
    for field in defaultScene.PUBLIC_STATE_FIELDS:
      let key = field.name
      if state.hasKey(key) and state[key] != lastPublicState{key}:
        lastPublicState[key] = copy(state[key])

proc getLastPublicState*(): JsonNode =
  {.gcsafe.}:
    withLock lastPublicStateLock:
      return lastPublicState.copy()

proc getPublicStateFields*(): seq[StateField] =
  {.gcsafe.}:
    return defaultScene.PUBLIC_STATE_FIELDS

proc updateLastPersistedState*(state: JsonNode) =
  var hasChanges = false
  for key in defaultScene.PERSISTED_STATE_KEYS:
    if state.hasKey(key) and state{key} != lastPersistedState{key}:
      lastPersistedState[key] = copy(state[key])
      hasChanges = true
  if hasChanges:
    writeFile(SCENE_STATE_JSON_PATH, $state)
  lastPersistedStateUpdate = epochTime()

proc loadPersistedState*(): JsonNode =
  try:
    return parseJson(readFile(SCENE_STATE_JSON_PATH))
  except IOError:
    return %*{}

proc renderScene*(self: RunnerThread): Image =
  let sceneTimer = epochTime()
  let requiredWidth = self.frameConfig.renderWidth()
  let requiredHeight = self.frameConfig.renderHeight()
  self.logger.log(%*{"event": "render", "width": requiredWidth, "height": requiredHeight})

  try:
    let image = defaultScene.render(defaultScene.Scene(self.scene))
    if image.width != requiredWidth or image.height != requiredHeight:
      let resizedImage = newImage(requiredWidth, requiredHeight)
      resizedImage.fill(self.frameConfig.backgroundColor)
      scaleAndDrawImage(resizedImage, image, self.frameConfig.scalingMode)
      setLastImage(resizedImage)
      result = resizedImage.rotateDegrees(self.frameConfig.rotate)
    else:
      setLastImage(image)
      result = image.rotateDegrees(self.frameConfig.rotate)
  except Exception as e:
    result = renderError(requiredWidth, requiredHeight, &"Error: {$e.msg}\n{$e.getStackTrace()}")
    self.logger.log(%*{"event": "render:error", "error": $e.msg, "stacktrace": e.getStackTrace()})
  self.lastRenderAt = epochTime()
  self.logger.log(%*{"event": "render:done", "ms": round((epochTime() - sceneTimer) * 1000, 3)})

proc startRenderLoop*(self: RunnerThread): Future[void] {.async.} =
  self.logger.log(%*{"event": "startRenderLoop"})
  var timer = 0.0
  var driverTimer = 0.0
  var sleepDuration = 0.0
  var fastSceneCount = 0
  var fastSceneResumeAt = 0.0
  var nextServerRenderAt = 0.0

  while true:
    timer = epochTime()
    self.isRendering = true
    self.scene.isRendering = true
    self.triggerRenderNext = false # used to debounce render events received while rendering
    let lastRotatedImage = self.renderScene()
    if self.frameConfig.interval < 1:
      let now = epochTime()
      if now >= nextServerRenderAt:
        nextServerRenderAt = nextServerRenderAt + SERVER_RENDER_DELAY
        if nextServerRenderAt < now:
          nextServerRenderAt = now + SERVER_RENDER_DELAY
        triggerServerRender()
    else:
      triggerServerRender()

    driverTimer = epochTime()
    # TODO: render the driver part in another thread if fast rendering is enabled
    try:
      drivers.render(lastRotatedImage)
      self.logger.log(%*{"event": "render:driver",
        "device": self.frameConfig.device, "ms": round((epochTime() - driverTimer) * 1000, 3)})
    except Exception as e:
      self.logger.log(%*{"event": "render:driver:error", "error": $e.msg, "stacktrace": e.getStackTrace()})

    if self.frameConfig.interval < 1:
      let now = epochTime()
      if now - timer < FAST_SCENE:
        fastSceneCount += 1
        # Two fast scenes in a row
        if fastSceneCount == 2:
          # TODO: capture logs per scene and log if slow
          self.logger.log(%*{"event": "pause", "message": "Rendering fast. Pausing logging for 10s"})
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
    self.scene.isRendering = false

    if epochTime() > lastPublicStateUpdate + 1.0:
      updateLastPublicState(defaultScene.getPublicState(defaultScene.Scene(self.scene)))
      lastPublicStateUpdate = epochTime()

    if epochTime() > lastPersistedStateUpdate + 1.0:
      updateLastPersistedState(defaultScene.getPersistedState(defaultScene.Scene(self.scene)))
      lastPersistedStateUpdate = epochTime()

    # While we were rendering an event to trigger a render was dispatched
    if self.triggerRenderNext:
      self.triggerRenderNext = false
      continue

    # Sleep until the next frame
    sleepDuration = max((self.frameConfig.interval - (epochTime() - timer)) * 1000, 0.1)
    self.logger.log(%*{"event": "sleep", "ms": round(sleepDuration, 3)})
    # Calculate once more to subtract the time it took to log the message
    sleepDuration = max((self.frameConfig.interval - (epochTime() - timer)) * 1000, 0.1)
    let future = sleepAsync(sleepDuration)
    self.sleepFuture = some(future)
    await future
    self.sleepFuture = none(Future[void])

proc triggerRender*(self: RunnerThread): void =
  if self.sleepFuture.isSome:
    self.sleepFuture.get().complete()
  else:
    self.logger.log(%*{"event": "render", "error": "Render already in progress, ignoring."})

proc dispatchSceneEvent*(self: RunnerThread, event: string, payload: JsonNode) =
  var context = ExecutionContext(
    scene: self.scene,
    event: event,
    payload: payload,
    image: newImage(1, 1),
    loopIndex: 0,
    loopKey: "."
  )
  let scene = defaultScene.Scene(self.scene)
  defaultScene.runEvent(scene, context)

proc startMessageLoop*(self: RunnerThread): Future[void] {.async.} =
  var waitTime = 10

  while true:
    let (success, (event, payload)) = eventChannel.tryRecv()
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
          else: discard

        self.dispatchSceneEvent(event, payload)
      except Exception as e:
        self.logger.log(%*{"event": "event:error", "error": $e.msg,
            "stacktrace": e.getStackTrace()})

    # after we have processed all queued messages
    if not success:
      if self.triggerRenderNext and not self.isRendering:
        self.triggerRenderNext = false
        self.triggerRender()
      else:
        await sleepAsync(waitTime)
        if waitTime < 200:
          waitTime += 5

proc createThreadRunner*(args: (FrameConfig, Logger)) =
  {.cast(gcsafe).}:
    var scene = defaultScene.init(
      args[0],
      args[1],
      proc(event: string, payload: JsonNode) = eventChannel.send((event, payload)),
      loadPersistedState()
    ).FrameScene
    var runnerThread = RunnerThread(
      frameConfig: args[0],
      logger: args[1],
      scene: scene,
      lastRenderAt: 0,
      sleepFuture: none(Future[void]),
    )
    waitFor runnerThread.startRenderLoop() and runnerThread.startMessageLoop()

proc newRunner*(frameConfig: FrameConfig, logger: Logger): RunnerControl =
  var runner = RunnerControl(
    logger: logger,
    frameConfig: frameConfig,
    start: proc () = createThread(thread, createThreadRunner, (frameConfig, logger)),
    sendEvent: proc (event: string, payload: JsonNode) = eventChannel.send((event, payload)),
  )
  setLastImage(renderError(frameConfig.renderWidth(), frameConfig.renderHeight(), "FrameOS booting..."))
  return runner

proc triggerRender*(self: RunnerControl): void =
  self.sendEvent("render", %*{})
