import std/[atomics, deques, json, locks, monotimes, os, strutils, times, unittest]

import ../state
import ../../types
from ../../config import currentFrameConfigGeneration, updateFrameConfigFrom

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
          # Each read copies the whole deque under the lock. Four readers that
          # re-read the instant they are done keep that (unfair) lock busy and
          # starve the writer: a second at -O3, a minute at -O0. Pausing for
          # four times the last read's cost caps the readers' share of the
          # lock at about 80% on any machine, and they still overlap every
          # one of the writer's passes, which is what the test is about.
          let readStarted = getMonoTime()
          let logs = getUiLogs()
          for entry in logs:
            if entry{"event"}.getStr("") != "metrics" or entry{"frame_id"}.getInt(0) != FRAME_API_ID:
              discard args.bad[].fetchAdd(1)
          for metric in getUiMetrics():
            if metric{"metrics"}{"load"}.getInt(-1) < 0:
              discard args.bad[].fetchAdd(1)
          sleep(max(1, 4 * int((getMonoTime() - readStarted).inMilliseconds)))
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

  test "workers copy the live config's strings while the runner reloads it":
    # What auth.nim does on every request (frameAccess, frameAccessKey,
    # serverApiKey) while a deploy reloads the config in place. Read straight
    # off the object, a key could be the length of one config and the bytes
    # of the next; copied under the reload's lock it is always one or the
    # other.
    let keyA = "a".repeat(40)
    let keyB = "bb".repeat(13)
    globalFrameConfig = FrameConfig(frameAccess: "private", frameAccessKey: keyA,
      serverApiKey: keyB, assetsPath: "/srv/assets")
    var done: Atomic[bool]
    var bad: Atomic[int]
    var reads: Atomic[int]
    var started: Atomic[int]
    proc reader(args: tuple[done: ptr Atomic[bool], bad, reads, started: ptr Atomic[int],
                            keyA, keyB: string]) {.thread.} =
      {.cast(gcsafe).}:
        discard args.started[].fetchAdd(1)
        while not args.done[].load:
          let key = liveConfigValue(frameAccessKey)
          let apiKey = liveConfigValue(serverApiKey)
          if key notin [args.keyA, args.keyB] or apiKey notin [args.keyA, args.keyB] or
              liveConfigValue(frameAccess) != "private" or
              liveConfigValue(assetsPath) != "/srv/assets":
            discard args.bad[].fetchAdd(1)
          discard args.reads[].fetchAdd(1)
          # Allocation churn: a freed string's chunk has to be reused for a
          # premature free to show.
          let junk = parseJson("""{"a":[1,2,3],"b":{"c":"dddddddddddddddd"}}""")
          if junk{"a"}.len != 3:
            discard args.bad[].fetchAdd(1000)
    var readers: array[4, Thread[tuple[done: ptr Atomic[bool], bad, reads, started: ptr Atomic[int],
                                       keyA, keyB: string]]]
    for t in readers.mitems:
      createThread(t, reader, (addr done, addr bad, addr reads, addr started, keyA, keyB))
    # The claim is about reads that overlap reloads. On a two-core CI runner
    # 2000 reloads can finish before a new thread is scheduled at all (reads
    # was 0 there once), so wait until every reader is in its loop, and keep
    # reloading until the readers have read alongside.
    while started.load < readers.len:
      cpuRelax()
    let generationBefore = currentFrameConfigGeneration()
    let readsBefore = reads.load
    var reloads = 0
    while reloads < 2000 or reads.load - readsBefore < 2000:
      let even = reloads mod 2 == 0
      updateFrameConfigFrom(globalFrameConfig, FrameConfig(frameAccess: "private",
        frameAccessKey: if even: keyB else: keyA, serverApiKey: if even: keyA else: keyB,
        assetsPath: "/srv/assets"))
      inc reloads
    done.store(true)
    joinThreads(readers)
    check bad.load == 0
    check currentFrameConfigGeneration() - generationBefore == reloads
    # The last reload was number reloads - 1: an even one sets keyB.
    check liveConfigValue(frameAccessKey) == (if (reloads - 1) mod 2 == 0: keyB else: keyA)
