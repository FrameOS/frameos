import std/[json, os, sequtils, strutils]
import ../channels
import ../event_log
import ../events
import ../interpreter
import ../scheduler
import ../server/auth
import ../types

# The Nim runner of docs/event-fixtures.json, the conformance corpus of the
# scene event contract (docs/events-contract.json, docs/events.md). "Add a case
# there first; a runner that disagrees is the bug."
#
# What it runs is the code all three hosts compile: the generated allow-lists,
# the log policy, and what the interpreter does with an event it is handed.
# What happens around that — queueing, origins, render-after — is the shared
# dispatcher's, and the `dispatcher` section's: test_event_loop.nim.

const fixturesPath = currentSourcePath().parentDir / ".." / ".." / ".." / ".." / "docs" / "event-fixtures.json"
let fixtures = parseFile(fixturesPath)

proc originOf(name: string): EventOrigin =
  for origin in EventOrigin:
    if $origin == name:
      return origin
  doAssert false, "unknown origin in fixtures: " & name

# ------------------------------------------------------------------ origins

block origin_matrix:
  var ran = 0
  for c in fixtures["origins"]["cases"]:
    let origin = originOf(c["origin"].getStr())
    let event = c["event"].getStr()
    let allowed = c["allowed"].getBool()
    # What an edge that cannot see the scene answers; the scene-dependent half
    # (a custom event's declaration) is the dispatcher's — test_event_loop.nim.
    doAssert originMayQueue(origin, event) == allowed,
      $origin & " / " & event & ": expected allowed=" & $allowed
    # The edges that ask, each by its own name.
    case origin
    of eoHttpWrite:
      doAssert isControlEvent(event) == not allowed, "auth.isControlEvent disagrees on " & event
    of eoSchedule:
      doAssert scheduleMayFire(event) == allowed, "scheduler disagrees on " & event
    else:
      discard
    inc ran
  doAssert ran > 20

block refused_lists_are_derived:
  doAssert refusedEvents(eoSchedule) == @["init", "open", "close", "uploadScenes"]
  doAssert refusedEvents(eoHttpAdmin).len == 0
  doAssert refusedEvents(eoSystem).len == 0
  # A scene is refused the device commands, and the lifecycle events — those
  # are the host's to say, at the moment they are true.
  for name in refusedEvents(eoScene):
    doAssert isDeviceCommand(name) or eventPolicy(name).class == ecLifecycle,
      name & " is refused to scenes but is neither a device command nor lifecycle"

# ---------------------------------------------------------------------- log

block log_policy:
  for c in fixtures["log"]["cases"]:
    let event = c["event"].getStr()
    let payload = if c["payload"].kind == JNull: nil else: c["payload"]
    if c["logged"].kind == JNull:
      doAssert not eventIsLogged(event), event & " must not be logged"
    else:
      doAssert eventIsLogged(event), event & " must be logged"
      let line = withEventPayload(%*{"event": "event:" & event}, event, payload)
      doAssert line == c["logged"], event & ": logged " & $line & ", expected " & $c["logged"]

# ---------------------------------------------------------------- sequences

var logged: seq[JsonNode] = @[]

proc testConfig(): FrameConfig =
  FrameConfig(width: 4, height: 3, rotate: 0, scalingMode: "cover", debug: false, saveAssets: %*false)

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    logged.add(payload)
  logger.enable = proc() =
    logger.enabled = true
  logger.disable = proc() =
    logger.enabled = false
  logger

proc drainQueued(): seq[(string, JsonNode)] =
  while true:
    let (ok, msg) = eventChannel.tryRecv()
    if not ok:
      break
    result.add((msg[1], msg[2]))

proc isSubset(expected, actual: JsonNode): bool =
  if expected.kind != JObject:
    return expected == actual
  if actual.isNil or actual.kind != JObject:
    return false
  for key, value in expected:
    if not actual.hasKey(key) or not isSubset(value, actual[key]):
      return false
  true

block sequences:
  var allScenes = newJArray()
  for c in fixtures["sequences"]["cases"]:
    for scene in c["scenes"]:
      allScenes.add(scene)
  setUploadedInterpretedScenes(buildInterpretedScenes(parseInterpretedSceneInputs($allScenes)))
  resetInterpretedScenes()

  for c in fixtures["sequences"]["cases"]:
    let name = c["name"].getStr()
    let config = testConfig()
    let scene = InterpretedFrameScene(init(c["scene"].getStr().SceneId, config, testLogger(config), %*{}))
    discard drainQueued()
    for index, step in c["steps"].getElems():
      let where = name & ", step " & $(index + 1)
      logged.setLen(0)
      let listenersBefore = eventListenersRun
      let send = step["send"]
      var context = ExecutionContext(scene: scene, event: send["event"].getStr(),
        payload: (if send{"payload"}.isNil: %*{} else: copy(send["payload"])),
        hasImage: false, loopIndex: 0, loopKey: ".")
      runEvent(scene, context)
      let queued = drainQueued()

      if step.hasKey("listenersRun"):
        doAssert eventListenersRun - listenersBefore == step["listenersRun"].getInt(),
          where & ": " & $(eventListenersRun - listenersBefore) & " listeners ran"
      if step.hasKey("state"):
        for key, value in step["state"]:
          if value.kind == JNull:
            doAssert not scene.state.hasKey(key), where & ": state." & key & " is set: " & $scene.state
          else:
            doAssert scene.state{key} == value, where & ": state." & key & " = " & $scene.state{key}
      if step.hasKey("queued"):
        doAssert queued.mapIt(it[0]) == step["queued"].getElems().mapIt(it["event"].getStr()),
          where & ": queued " & $queued.mapIt(it[0])
        for i, expected in step["queued"].getElems():
          if expected.hasKey("payload"):
            doAssert queued[i][1] == expected["payload"], where & ": queued payload " & $queued[i][1]
      if step.hasKey("logged"):
        for expected in step["logged"]:
          doAssert logged.anyIt(isSubset(expected, it)), where & ": no log line like " & $expected & " in " & $logged
      if step.hasKey("notLogged"):
        for needle in step["notLogged"]:
          doAssert needle.getStr() notin $logged, where & ": the log says " & needle.getStr()

echo "test_event_fixtures: ok"
