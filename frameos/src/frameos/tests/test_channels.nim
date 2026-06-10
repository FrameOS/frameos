import std/[atomics, json, options, times, unittest]

import ../channels
import ../types

proc drainEventChannel() =
  while true:
    let (ok, _) = eventChannel.tryRecv()
    if not ok:
      break

proc drainLogChannels() =
  while true:
    let (ok, _) = logChannel.tryRecv()
    if not ok:
      break
  while true:
    let (ok, _) = logBroadcastChannel.tryRecv()
    if not ok:
      break

proc drainServerChannel() =
  while true:
    let (ok, _) = serverChannel.tryRecv()
    if not ok:
      break

proc logJson(payload: SerializedLog): JsonNode =
  parseJson(payload.line)

suite "frameos channels":
  setup:
    drainEventChannel()
    drainLogChannels()
    drainServerChannel()

  test "sendEvent overloads write expected tuples":
    let payload = %*{"value": 1}
    sendEvent("refresh", payload)
    let (okCurrent, current) = eventChannel.tryRecv()
    check okCurrent
    check current[0].isNone()
    check current[1] == "refresh"
    check current[2]["value"].getInt() == 1

    sendEvent(some("scene/a".SceneId), "jump", %*{"target": "x"})
    let (okScene, direct) = eventChannel.tryRecv()
    check okScene
    check direct[0].isSome()
    check direct[0].get() == "scene/a".SceneId
    check direct[1] == "jump"
    check direct[2]["target"].getStr() == "x"

  test "log writes to main channel and broadcast channel":
    let before = epochTime()
    log(%*{"event": "unit", "value": 42})

    let (okMain, mainPayload) = logChannel.tryRecv()
    check okMain
    check mainPayload.timestamp >= before
    check mainPayload.event == "unit"
    let mainLog = logJson(mainPayload)
    check mainLog["event"].getStr() == "unit"
    check mainLog["value"].getInt() == 42

    let (okBroadcast, broadcastPayload) = logBroadcastChannel.tryRecv()
    check okBroadcast
    check broadcastPayload.event == "unit"
    check logJson(broadcastPayload)["event"].getStr() == "unit"

  test "log drops and counts when the channel is full":
    discard logsDroppedCounter.exchange(0)
    # Fill the bounded channel to capacity without a consumer.
    var sent = 0
    while logChannel.trySend(SerializedLog(timestamp: 1.0, event: "filler", line: "{}")):
      inc sent
    check sent > 0

    log(%*{"event": "overflow", "value": 1})
    check logsDroppedCounter.load() == 1

    drainLogChannels()
    discard logsDroppedCounter.exchange(0)
    log(%*{"event": "fits-again"})
    check logsDroppedCounter.load() == 0
    drainLogChannels()

  test "triggerServerRender uses bounded queue semantics":
    triggerServerRender()
    triggerServerRender()

    let (okFirst, first) = serverChannel.tryRecv()
    let (okSecond, _) = serverChannel.tryRecv()

    check okFirst
    check first
    check not okSecond
