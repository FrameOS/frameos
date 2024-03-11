import json, pixie, times, options, asyncdispatch, strformat, strutils, locks, tables
import pixie/fileformats/png
from scenes/scenes import getExportedScenes, defaultSceneId

import frameos/channels
import frameos/types
import frameos/config
import frameos/logger
import frameos/utils/image

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

proc setLastImage(image: Image) =
  withLock lastImageLock:
    if lastImage.width != image.width or lastImage.height != image.height:
      lastImage = newImage(image.width, image.height)
    lastImage.draw(image)
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

proc loadPersistedState*(sceneId: SceneId): JsonNode =
  try:
    return parseJson(readFile(&"{SCENE_STATE_JSON_FOLDER}/scene-{sanitizePathString(sceneId.string)}.json"))
  except IOError:
    return %*{}

proc getLastPublicStateForScene*(sceneId: SceneId): (JsonNode, seq[StateField]) =
  {.gcsafe.}:
    withLock lastPublicStatesLock:
      if lastPublicStates.hasKey(sceneId.string):
        let state = lastPublicStates[sceneId.string].copy()
        return (state, exportedScenes[sceneId].publicStateFields)
      else:
        let persistedState = loadPersistedState(sceneId)
        let publicFields = exportedScenes[sceneId].publicStateFields
        var newState = %*{}
        for field in publicFields:
          if persistedState.hasKey(field.name):
            newState[field.name] = copy(persistedState[field.name])
          else:
            newState[field.name] = field.defaultValue
        return (newState, publicFields)

proc renderSceneImage*(self: RunnerThread, exportedScene: ExportedScene, scene: FrameScene): Image =
  let sceneTimer = epochTime()
  let requiredWidth = self.frameConfig.renderWidth()
  let requiredHeight = self.frameConfig.renderHeight()
  self.logger.log(%*{"event": "render", "width": requiredWidth, "height": requiredHeight})

  try:
    let image = exportedScene.render(scene)
    if image.width != requiredWidth or image.height != requiredHeight:
      let resizedImage = newImage(requiredWidth, requiredHeight)
      resizedImage.fill(scene.backgroundColor)
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
  var lastSceneId = "".SceneId
  var currentScene: FrameScene

  while true:
    timer = epochTime()
    self.isRendering = true
    let sceneId = self.currentSceneId
    if not exportedScenes.hasKey(sceneId):
      raise newException(Exception, &"Scene {sceneId} not found")
    let exportedScene = exportedScenes[sceneId]
    if lastSceneId != sceneId:
      self.logger.log(%*{"event": "sceneChange", "sceneId": sceneId.string})
      if self.scenes.hasKey(sceneId):
        currentScene = self.scenes[sceneId]
      else:
        currentScene = exportedScenes[sceneId].init(sceneId, self.frameConfig, self.logger, loadPersistedState(sceneId))
        self.scenes[sceneId] = currentScene
        currentScene.updateLastPublicState()
      lastSceneId = sceneId
      withLock lastPublicStatesLock:
        lastPublicSceneId = sceneId

    currentScene.isRendering = true
    self.triggerRenderNext = false # used to debounce render events received while rendering

    let interval = currentScene.refreshInterval
    let lastRotatedImage = self.renderSceneImage(exportedScene, currentScene)
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

    if interval < 1:
      let now = epochTime()
      if now - timer < FAST_SCENE_CUTOFF_SECONDS:
        fastSceneCount += 1
        # Two fast scenes in a row
        if fastSceneCount == 2:
          # TODO: capture logs per _scene_ and log if slow
          self.logger.log(%*{"event": "pause", "message": "Rendering fast. Pausing all scene render logs for 10 seconds."})
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

    # Sleep until the next frame
    sleepDuration = max((interval - (epochTime() - timer)) * 1000, 0.1)
    self.logger.log(%*{"event": "sleep", "ms": round(sleepDuration, 3)})
    # Calculate once more to subtract the time it took to log the message
    sleepDuration = max((interval - (epochTime() - timer)) * 1000, 0.1)
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
    image: newImage(1, 1),
    loopIndex: 0,
    loopKey: "."
  )
  exportedScene.runEvent(context)
  if event == "setSceneState":
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
            if sceneId == self.currentSceneId and not payload.hasKey("state"):
              continue
            if not exportedScenes.hasKey(sceneId):
              self.logger.log(%*{"event": "dispatchEvent:error", "error": "Scene not found", "sceneId": sceneId.string,
                  "event": event, "payload": payload})
              continue
            if self.currentSceneId != sceneId:
              self.dispatchSceneEvent(some(self.currentSceneId), "close", payload)

            var nextState = %*{}
            let fields = exportedScenes[sceneId].publicStateFields
            if payload.hasKey("state"):
              var requestedState = %*{}
              if payload["state"].getStr() != "":
                requestedState = parseJson(payload["state"].getStr())
              else:
                requestedState = payload["state"].copy()

              for field in fields:
                if requestedState.hasKey(field.name):
                  nextState[field.name] = requestedState[field.name].copy()

            if not self.scenes.hasKey(sceneId):
              let persistedState = loadPersistedState(sceneId)
              for field in fields:
                if not nextState.hasKey(field.name) and persistedState.hasKey(field.name):
                  nextState[field.name] = copy(persistedState[field.name])
              let scene = exportedScenes[sceneId].init(sceneId, self.frameConfig, self.logger, nextState)
              self.scenes[sceneId] = scene
              scene.updateLastPublicState()
            else:
              let scene = self.scenes[sceneId]
              for field in fields:
                if nextState.hasKey(field.name):
                  scene.state[field.name] = copy(nextState[field.name])
              scene.updateLastPublicState()
              scene.updateLastPersistedState()
            self.currentSceneId = sceneId
            self.triggerRenderNext = true
            self.dispatchSceneEvent(some(sceneId), "open", nextState)
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
      currentSceneId: defaultSceneId,
      lastRenderAt: 0,
      sleepFuture: none(Future[void]),
      isRendering: false,
      triggerRenderNext: false,
      logger: args[1]
    )
    waitFor runnerThread.startRenderLoop() and runnerThread.startMessageLoop()

proc newRunner*(frameConfig: FrameConfig): RunnerControl =
  # create a separate logger, so we can pause it when rendering fast
  var logger = newLogger(frameConfig)
  result = RunnerControl(
    start: proc () = createThread(thread, createRunnerThread, (frameConfig, logger)),
  )
  setLastImage(renderError(frameConfig.renderWidth(), frameConfig.renderHeight(), "FrameOS booting..."))
