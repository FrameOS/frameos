import std/[json, options, times, unittest]

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
    check mainPayload[0] >= before
    check mainPayload[1]["event"].getStr() == "unit"
    check mainPayload[1]["value"].getInt() == 42

    let (okBroadcast, broadcastPayload) = logBroadcastChannel.tryRecv()
    check okBroadcast
    check broadcastPayload[1]["event"].getStr() == "unit"

  test "triggerServerRender uses bounded queue semantics":
    triggerServerRender()
    triggerServerRender()

    let (okFirst, first) = serverChannel.tryRecv()
    let (okSecond, _) = serverChannel.tryRecv()

    check okFirst
    check first
    check not okSecond
