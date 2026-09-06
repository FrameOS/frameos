## Ceilings on untrusted scene JS: execution time, heap, and the rule that
## time spent inside a native binding is not the script spinning.

import std/[json, monotimes, os, sequtils, strutils, times, unittest]

import frameos/js_runtime/burrito
import frameos/js_runtime/run_budget
import frameos/js_runtime/runtime
import frameos/types
import frameos/values

proc testScene(): InterpretedFrameScene =
  InterpretedFrameScene(
    id: "tests/js-limits".SceneId,
    frameConfig: FrameConfig(
      js: JsRuntimeConfig(executionTimeoutMs: 300, memoryLimitMb: -1, maxStackKb: -1,
                          assetSandbox: "frame")
    ),
    logger: Logger(
      enabled: true,
      log: proc(payload: JsonNode) = discard payload,
      enable: proc() = discard,
      disable: proc() = discard
    )
  )

proc testContext(scene: FrameScene): ExecutionContext =
  ExecutionContext(
    scene: scene,
    event: "render",
    payload: %*{},
    hasImage: false,
    loopIndex: 0,
    loopKey: "."
  )

proc sleepingBinding(ctx: ptr JSContext): JSValue {.nimcall.} =
  ## Stands in for fetchText/readAsset: slow, but slow in Nim, not in JS.
  sleep(300)
  return nimIntToJS(ctx, 1'i32)

suite "js execution deadline":
  test "an infinite loop is interrupted instead of hanging the thread":
    var config = defaultConfig()
    config.executionTimeoutMs = 250
    var js = newQuickJS(config)
    defer: js.close()

    let started = getMonoTime()
    expect JSException:
      discard js.eval("while (true) {}")
    let elapsedMs = (getMonoTime() - started).inMilliseconds

    # Generous upper bound: the handler only runs between bytecode batches.
    check elapsedMs >= 200
    check elapsedMs < 5_000

  test "the raised error names the budget rather than 'interrupted'":
    var config = defaultConfig()
    config.executionTimeoutMs = 150
    var js = newQuickJS(config)
    defer: js.close()

    var message = ""
    try:
      discard js.eval("for (;;) {}")
    except JSException as err:
      message = err.msg
    check message.contains("150ms time budget")

  test "a script that finishes inside its budget is untouched":
    var config = defaultConfig()
    config.executionTimeoutMs = 5_000
    var js = newQuickJS(config)
    defer: js.close()

    check js.eval("let total = 0; for (let i = 0; i < 100000; i++) total += i; total") ==
      "4999950000"
    check not js.deadlineTripped()

  test "time inside a native binding does not spend the budget":
    var config = defaultConfig()
    config.executionTimeoutMs = 500
    var js = newQuickJS(config)
    defer: js.close()

    js.registerFunction("slowNativeCall", sleepingBinding)
    # Three 300ms native calls = 900ms wall clock, well past the 500ms budget,
    # but almost no interpreter time. This must not be read as a runaway loop.
    check js.eval("slowNativeCall() + slowNativeCall() + slowNativeCall()") == "3"
    check not js.deadlineTripped()

  test "a zero timeout disables the ceiling":
    var config = defaultConfig()
    config.executionTimeoutMs = 0
    var js = newQuickJS(config)
    defer: js.close()

    check js.armDeadline() == false
    check js.eval("1 + 1") == "2"

  test "scene code nodes inherit the deadline":
    var logs: seq[JsonNode] = @[]
    var scene = testScene()
    scene.logger.log = proc(payload: JsonNode) =
      logs.add(payload)

    let value = evalSnippet(
      scene,
      testContext(scene),
      1.NodeId,
      "(() => { while (true) {} })()"
    )

    check value.kind == fkNone
    let logged = logs.mapIt($it).join(" ")
    check logged.contains("time budget")
    cleanupSceneJs(scene)
    cleanupCompilerJs()

suite "js memory ceiling":
  test "an oversized allocation fails the script, not the process":
    var config = defaultConfig()
    config.memoryLimitBytes = 4 * 1024 * 1024
    var js = newQuickJS(config)
    defer: js.close()

    expect JSException:
      discard js.eval("const hog = []; while (true) { hog.push(new Array(100000).fill(7)) }")

  test "ordinary allocations still work under the ceiling":
    var js = newQuickJS()
    defer: js.close()
    check js.eval("new Array(1000).fill(1).length") == "1000"

suite "wall-clock render deadline":
  test "time inside native bindings counts against the render deadline":
    # The interpreter budget stops its clock in a binding (previous suite);
    # the run's wall-clock deadline does not. Three 300ms native calls against
    # a 500ms deadline must end the script, and the message must say which
    # clock ran out.
    var config = defaultConfig()
    config.executionTimeoutMs = 5_000
    var js = newQuickJS(config)
    defer: js.close()
    js.registerFunction("slowNativeCall", sleepingBinding)

    check armRenderDeadline(500)
    defer: disarmRenderDeadline()
    var message = ""
    try:
      discard js.eval("slowNativeCall(); slowNativeCall(); slowNativeCall(); 1")
    except JSException as err:
      message = err.msg
    check message.contains("wall-clock")
    check message.contains("500ms")
    check renderDeadlinePassed()

  test "a run that finishes inside the deadline is untouched":
    var js = newQuickJS()
    defer: js.close()
    check armRenderDeadline(5_000)
    defer: disarmRenderDeadline()
    check js.eval("let n = 0; for (let i = 0; i < 1000; i++) n += i; n") == "499500"
    check not js.deadlineTripped()
    check renderDeadlineRemainingMs() > 0

  test "the deadline applies even when the interpreter-time budget is off":
    var config = defaultConfig()
    config.executionTimeoutMs = 0
    var js = newQuickJS(config)
    defer: js.close()
    check armRenderDeadline(150)
    defer: disarmRenderDeadline()
    var message = ""
    try:
      discard js.eval("for (;;) {}")
    except JSException as err:
      message = err.msg
    check message.contains("wall-clock")

  test "arming is re-entrant and a nested run does not reset the clock":
    check armRenderDeadline(1_000)
    check not armRenderDeadline(50)
    check renderDeadlineBudgetMs() == 1_000
    disarmRenderDeadline()
    check renderDeadlineRemainingMs() == -1
    check not renderDeadlinePassed()
    check capToRenderDeadline(30_000) == 30_000

  test "capToRenderDeadline shortens a timeout to what is left":
    check armRenderDeadline(200)
    defer: disarmRenderDeadline()
    let capped = capToRenderDeadline(30_000)
    check capped > 0
    check capped <= 200
    sleep(250)
    check capToRenderDeadline(30_000) == 1
    check renderDeadlineRemainingMs() == 0

suite "dispatch budget":
  test "a run may dispatch only so many events, and the first refusal is flagged once":
    setDispatchBudget(3)
    check takeDispatchBudget() == dvAllowed
    check takeDispatchBudget() == dvAllowed
    check takeDispatchBudget() == dvAllowed
    check takeDispatchBudget() == dvRefusedFirst
    check takeDispatchBudget() == dvRefused
    check dispatchBudgetTotalNow() == 3
    setDispatchBudget(0)
    check takeDispatchBudget() == dvAllowed

suite "per-scene heap budget":
  test "the runtimes of one scene draw on one ceiling":
    # Two runtimes, each allowed 4 MB on its own, share a 3 MB scene budget:
    # what the first holds is not available to the second.
    let budget = sceneHeapBudgetFor("tests/js-heap-budget", 3 * 1024 * 1024)
    var config = defaultConfig()
    config.memoryLimitBytes = 4 * 1024 * 1024
    config.heapBudget = budget
    var first = newQuickJS(config)
    var second = newQuickJS(config)
    # ~1.6 MB of JSValues, well inside 4 MB on its own.
    check first.eval("globalThis.hog = new Array(100000).fill(7); hog.length") == "100000"
    check sceneHeapBudgetUsedBytes("tests/js-heap-budget") > 1_500_000
    var message = ""
    try:
      discard second.eval("globalThis.hog = new Array(100000).fill(7); hog.length")
    except JSException as err:
      message = err.msg
    check message.contains("out of memory")
    first.close()
    second.close()
    # Everything the two runtimes charged was released with them.
    check sceneHeapBudgetUsedBytes("tests/js-heap-budget") == 0

  test "a second scene's budget is its own":
    let budgetA = sceneHeapBudgetFor("tests/js-heap-a", 3 * 1024 * 1024)
    let budgetB = sceneHeapBudgetFor("tests/js-heap-b", 3 * 1024 * 1024)
    check budgetA != budgetB
    var configA = defaultConfig()
    configA.heapBudget = budgetA
    var configB = defaultConfig()
    configB.heapBudget = budgetB
    var a = newQuickJS(configA)
    var b = newQuickJS(configB)
    defer:
      a.close()
      b.close()
    check a.eval("globalThis.hog = new Array(100000).fill(7); 1") == "1"
    check b.eval("globalThis.hog = new Array(100000).fill(7); 1") == "1"

  test "scene code nodes run under the scene's budget":
    var scene = testScene()
    scene.frameConfig.js.memoryLimitMb = 2
    var logs: seq[JsonNode] = @[]
    scene.logger.log = proc(payload: JsonNode) =
      logs.add(payload)
    let value = evalSnippet(
      scene,
      testContext(scene),
      1.NodeId,
      "(() => { const hog = []; for (;;) hog.push(new Array(10000).fill(1)); })()"
    )
    check value.kind == fkNone
    let logged = logs.mapIt($it).join(" ")
    check logged.contains("out of memory")
    check logged.contains("heap budget")
    cleanupSceneJs(scene)
    cleanupCompilerJs()
    check sceneHeapBudgetUsedBytes("tests/js-limits") == 0
