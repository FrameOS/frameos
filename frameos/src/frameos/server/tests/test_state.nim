import std/[atomics, deques, json, locks, unittest]

import ../state
import ../../types

suite "Server state helpers":
  test "frame api id is fixed":
    check frameApiId() == 1

  test "frame api id parser handles invalid values":
    check parseFrameApiId("123") == 123
    check parseFrameApiId("abc") == -1

  test "connections state starts empty":
    let state = initConnectionsState()
    check not hasConnections(state)

  test "stored log entries belong to the store, and readers get copies":
    initLock(globalRecentLogsLock)
    globalRecentLogs = initDeque[JsonNode]()
    globalRecentMetrics = initDeque[JsonNode]()
    var entry = toUiLog(SerializedLog(timestamp: 1.0, event: "metrics", line: """{"event":"metrics","load":1}"""))
    storeUiLog(move(entry))
    # The caller's handle is gone: nothing outside the lock can touch the node.
    check entry.isNil
    let logs = getUiLogs()
    check logs.len == 1
    logs[0]["event"] = %"changed"
    check getUiLogs()[0]["event"].getStr() == "metrics"
    check getUiMetrics().len == 1
    check getUiMetrics()[0]["metrics"]["load"].getInt() == 1

  test "one writer and four readers share the recent logs":
    # The log thread stores while the HTTP workers and the hub client read.
    # Built like the Pi binary (-d:useMalloc) a node shared between them is
    # freed under its reader; this passes because no node ever is.
    initLock(globalRecentLogsLock)
    globalRecentLogs = initDeque[JsonNode]()
    globalRecentMetrics = initDeque[JsonNode]()
    var done: Atomic[bool]
    var bad: Atomic[int]
    proc reader(args: tuple[done: ptr Atomic[bool], bad: ptr Atomic[int]]) {.thread.} =
      {.cast(gcsafe).}:
        while not args.done[].load:
          let logs = getUiLogs()
          for entry in logs:
            if entry{"event"}.getStr("") != "metrics" or entry{"frame_id"}.getInt(0) != FRAME_API_ID:
              discard args.bad[].fetchAdd(1)
          for metric in getUiMetrics():
            if metric{"metrics"}{"load"}.getInt(-1) < 0:
              discard args.bad[].fetchAdd(1)
    var readers: array[4, Thread[tuple[done: ptr Atomic[bool], bad: ptr Atomic[int]]]]
    for t in readers.mitems: createThread(t, reader, (addr done, addr bad))
    for i in 0 ..< MAX_RECENT_LOGS + 2000:
      var entry = toUiLog(SerializedLog(timestamp: float(i), event: "metrics",
        line: """{"event":"metrics","load":""" & $i & "}"))
      # What the log thread does: serialise first, then give the node away.
      let message = $(%*{"event": "new_log", "data": entry})
      check message.len > 0
      storeUiLog(move(entry))
    done.store(true)
    joinThreads(readers)
    check bad.load == 0
    check getUiLogs().len == MAX_RECENT_LOGS
    check getUiMetrics().len == MAX_RECENT_METRICS
