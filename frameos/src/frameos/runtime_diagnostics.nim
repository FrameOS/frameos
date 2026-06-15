import json, locks, random, times
import frameos/hal/entropy

type
  RuntimeDiagnosticsState = object
    active: bool
    mode: string
    sceneId: string
    contextEvent: string
    phase: string
    currentSceneId: string
    nodeId: int
    hasNodeId: bool
    nodeType: string
    keyword: string
    childSceneId: string
    device: string
    width: int
    height: int
    startedAt: float
    updatedAt: float
    completedAt: float
    sequence: int64

var
  diagnosticsLock: Lock
  runtimeState: RuntimeDiagnosticsState
  nextSequence: int64

const BootIdAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
const BootIdLength = 8

proc generateRuntimeBootId(): string =
  randomizeSafe()
  result = newString(BootIdLength)
  for index in 0..<BootIdLength:
    result[index] = BootIdAlphabet[rand(BootIdAlphabet.high)]

let runtimeBootId = generateRuntimeBootId()

initLock(diagnosticsLock)

proc nextSequenceLocked(): int64 =
  inc nextSequence
  nextSequence

proc markUpdatedLocked(phase: string) =
  runtimeState.phase = phase
  runtimeState.updatedAt = epochTime()
  runtimeState.sequence = nextSequenceLocked()

proc markRuntimeStart*(mode, sceneId, contextEvent: string, width = 0, height = 0) {.gcsafe.} =
  {.gcsafe.}:
    withLock diagnosticsLock:
      let now = epochTime()
      runtimeState = RuntimeDiagnosticsState(
        active: true,
        mode: mode,
        sceneId: sceneId,
        contextEvent: contextEvent,
        phase: mode & ":start",
        currentSceneId: sceneId,
        nodeId: -1,
        hasNodeId: false,
        width: width,
        height: height,
        startedAt: now,
        updatedAt: now,
        completedAt: runtimeState.completedAt,
        sequence: nextSequenceLocked()
      )

proc markRuntimeCheckpoint*(
    phase: string,
    currentSceneId = "",
    contextEvent = "",
    nodeId = -1,
    nodeType = "",
    keyword = "",
    childSceneId = "",
    device = "",
    clearNode = false
  ) {.gcsafe.} =
  {.gcsafe.}:
    withLock diagnosticsLock:
      if not runtimeState.active:
        return
      if currentSceneId.len > 0:
        runtimeState.currentSceneId = currentSceneId
      if contextEvent.len > 0:
        runtimeState.contextEvent = contextEvent
      if clearNode:
        runtimeState.nodeId = -1
        runtimeState.hasNodeId = false
        runtimeState.nodeType = ""
        runtimeState.keyword = ""
        runtimeState.childSceneId = ""
      elif nodeId >= 0:
        runtimeState.nodeId = nodeId
        runtimeState.hasNodeId = true
      if nodeType.len > 0:
        runtimeState.nodeType = nodeType
      if keyword.len > 0:
        runtimeState.keyword = keyword
      if childSceneId.len > 0:
        runtimeState.childSceneId = childSceneId
      if device.len > 0:
        runtimeState.device = device
      elif phase != "driver:start":
        runtimeState.device = ""
      markUpdatedLocked(phase)

proc markRuntimeDone*() {.gcsafe.} =
  {.gcsafe.}:
    withLock diagnosticsLock:
      runtimeState.active = false
      runtimeState.completedAt = epochTime()
      markUpdatedLocked("idle")

proc runtimeDiagnosticsSnapshot*(): JsonNode {.gcsafe.} =
  {.gcsafe.}:
    let now = epochTime()
    withLock diagnosticsLock:
      result = %*{
        "active": runtimeState.active,
        "bootId": runtimeBootId,
        "mode": runtimeState.mode,
        "phase": runtimeState.phase,
        "sequence": runtimeState.sequence,
      }
      if runtimeState.active:
        result["sceneId"] = %runtimeState.sceneId
        result["currentSceneId"] = %runtimeState.currentSceneId
        result["contextEvent"] = %runtimeState.contextEvent
        result["elapsedMs"] = %((now - runtimeState.startedAt) * 1000.0)
        result["checkpointAgeMs"] = %((now - runtimeState.updatedAt) * 1000.0)
        if runtimeState.width > 0:
          result["width"] = %runtimeState.width
        if runtimeState.height > 0:
          result["height"] = %runtimeState.height
        if runtimeState.hasNodeId:
          result["nodeId"] = %runtimeState.nodeId
        if runtimeState.nodeType.len > 0:
          result["nodeType"] = %runtimeState.nodeType
        if runtimeState.keyword.len > 0:
          result["keyword"] = %runtimeState.keyword
        if runtimeState.childSceneId.len > 0:
          result["childSceneId"] = %runtimeState.childSceneId
        if runtimeState.device.len > 0:
          result["device"] = %runtimeState.device
      elif runtimeState.completedAt > 0:
        result["lastCompletedAgoMs"] = %((now - runtimeState.completedAt) * 1000.0)

proc resetRuntimeDiagnosticsForTest*() =
  withLock diagnosticsLock:
    runtimeState = RuntimeDiagnosticsState(nodeId: -1)
    nextSequence = 0
