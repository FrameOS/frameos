import std/[json, locks, os, strutils, unittest]

import ../../channels
import ../routes/repository_api_routes

# The hook is nimcall + gcsafe, so the counters live in globals behind a
# lock and are reached through a gcsafe cast.
var hookLock: Lock
initLock(hookLock)
var hookCalls = 0
var hookMaxBytes = 0
var hookDelayMs = 0
var hookStatus = 200

proc countingHook(url: string, maxBytes: int): tuple[body: string, status: int] {.gcsafe, nimcall.} =
  {.cast(gcsafe).}:
    var delay = 0
    var status = 200
    withLock hookLock:
      inc hookCalls
      hookMaxBytes = maxBytes
      delay = hookDelayMs
      status = hookStatus
    if delay > 0:
      sleep(delay)
    if status != 200:
      return (body: "connection refused", status: status)
    (body: $(%*{
      "name": "FrameOS Cloud store",
      "templates": [
        {"name": "Weather", "sceneId": "8a5f1f2e-1111-4222-8333-444455556666",
         "image": "./scenes/8a5f1f2e-1111-4222-8333-444455556666/image?v=3"},
      ],
    }), status: 200)

proc drainLogChannel() =
  while true:
    let (ok, _) = logChannel.tryRecv()
    if not ok:
      break

proc resetHook(delayMs = 0, status = 200) =
  withLock hookLock:
    hookCalls = 0
    hookMaxBytes = 0
    hookDelayMs = delayMs
    hookStatus = status
  resetCloudStoreCacheForTest()
  setCloudStoreFetchHookForTest(countingHook)
  drainLogChannel()

proc calls(): int =
  withLock hookLock:
    result = hookCalls

proc maxBytesSeen(): int =
  withLock hookLock:
    result = hookMaxBytes

var threadSawEntry: array[4, bool]

proc fetchFromThread(index: int) {.thread.} =
  let payload = cloudStoreRepositoryPayload()
  {.cast(gcsafe).}:
    threadSawEntry[index] = payload != nil and payload{"id"}.getStr("") == CloudStoreRepositoryId

suite "cloud store repository cache":
  teardown:
    setCloudStoreFetchHookForTest(nil)
    resetCloudStoreCacheForTest()

  test "concurrent requests past a cold cache share one fetch":
    resetHook(delayMs = 300)
    var threads: array[4, Thread[int]]
    for index, t in threads.mpairs:
      createThread(t, fetchFromThread, index)
    for t in threads.mitems:
      joinThread(t)
    check calls() == 1
    for saw in threadSawEntry:
      check saw

  test "a fresh entry is served without another fetch, and the index fetch is bounded":
    resetHook()
    let first = cloudStoreRepositoryPayload()
    check first != nil
    check first["templates"][0]["scenesUrl"].getStr() ==
      "/api/repositories/cloud-store/scenes/8a5f1f2e-1111-4222-8333-444455556666/scenes.json"
    check maxBytesSeen() == CloudStoreIndexMaxBytes
    check CloudStoreIndexMaxBytes > 0
    check CloudStoreScenesMaxBytes >= CloudStoreIndexMaxBytes
    discard cloudStoreRepositoryPayload()
    discard cloudStoreRepositoryEntry()
    check calls() == 1

  test "every caller gets its own node, the cached entry is a string":
    resetHook()
    var first = cloudStoreRepositoryPayload()
    first["name"] = %"mutated by one worker"
    first["templates"].add(%*{"name": "injected"})
    let second = cloudStoreRepositoryPayload()
    check second["name"].getStr() == "FrameOS Cloud store"
    check second["templates"].len == 1
    check calls() == 1

  test "an unreachable provider is not asked again on the next request":
    resetHook(status = 0)
    check cloudStoreRepositoryPayload() == nil
    check cloudStoreRepositoryEntry() == ""
    check cloudStoreRepositoryPayload() == nil
    check calls() == 1
    # Resetting the cache ends the failure window.
    resetCloudStoreCacheForTest()
    check cloudStoreRepositoryPayload() == nil
    check calls() == 2
