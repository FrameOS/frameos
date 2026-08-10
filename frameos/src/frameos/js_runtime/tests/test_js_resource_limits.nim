## Ceilings on untrusted scene JS: execution time, heap, and the rule that
## time spent inside a native binding is not the script spinning.

import std/[json, monotimes, os, sequtils, strutils, times, unittest]

import frameos/js_runtime/burrito
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
