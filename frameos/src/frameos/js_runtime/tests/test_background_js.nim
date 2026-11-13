## Background JavaScript (docs/background-js.md): an app's `background()`,
## `frameos.fetch` and `frameos.sleep` on a Pi. The runner's loop is played
## here by `pumpJsBackground`; the network by `jsIoHook`, on the workers.

import std/[json, monotimes, os, sequtils, strutils, tables, times, unittest]

import frameos/channels
import frameos/js_runtime/app_runtime
import frameos/js_runtime/js_io
import frameos/types
import frameos/values

proc testConfig(): FrameConfig =
  FrameConfig(width: 6, height: 4, rotate: 0, scalingMode: "cover", debug: true, saveAssets: %*false,
    assetsPath: "/tmp")

var logged: seq[string]

proc testLogger(config: FrameConfig): Logger =
  var logger = Logger(frameConfig: config, enabled: true)
  logger.log = proc(payload: JsonNode) =
    {.cast(gcsafe).}:
      logged.add($payload)
  logger.enable = proc() = logger.enabled = true
  logger.disable = proc() = logger.enabled = false
  logger

# The network: `?ms=N` answers after N ms, `/fail` does not answer at all.
jsIoHook = proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.} =
  let at = request.url.find("ms=")
  if at >= 0:
    sleep(parseInt(request.url[at + 3 .. ^1]))
  if "/fail" in request.url:
    return JsIoResult(error: "connection refused")
  var header = ""
  for (name, value) in request.headers:
    if name == "x-test": header = value
  JsIoResult(code: 200, body: request.httpMethod & " " & header)

let config = testConfig()

proc app(source: string, name = "bg"): tuple[runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext] =
  let scene = FrameScene(id: ("tests/" & name).SceneId, frameConfig: config, state: %*{},
    logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: name, scene: scene, frameConfig: config)
  result.context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  result.runtime = newJsAppRuntime(category = "data", outputType = "text", source = source)

proc render(a: tuple[runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext]): string =
  a.runtime.get(a.owner, %*{}, a.context).asString()

proc pumpUntil(done: proc(): bool, ms = 3000): bool =
  let start = getMonoTime()
  while (getMonoTime() - start).inMilliseconds < ms:
    discard pumpJsBackground()
    if done():
      return true
    sleep(2)
  done()

proc msSince(start: MonoTime): int64 = (getMonoTime() - start).inMilliseconds

suite "background JavaScript":
  setup:
    logged = @[]

  test "background() runs to its first await at the first render, and on after each sleep":
    let a = app("""
      let ticks = 0
      export async function background(app) {
        while (ticks < 3) {
          ticks++
          frameos.setState("ticks", ticks)
          await frameos.sleep(0.02)
        }
        frameos.setState("done", true)
      }
      export function get() { return `ticks:${ticks}` }
    """)
    check a.render() == "ticks:1"
    check a.owner.scene.state{"ticks"}.getInt() == 1
    check nextJsBackgroundMs() in 0 .. 20
    check pumpUntil(proc(): bool = a.owner.scene.state{"done"}.getBool())
    check a.owner.scene.state{"ticks"}.getInt() == 3
    check a.render() == "ticks:3"
    check jsBackgroundPending() == 0

  test "a render never waits for a fetch, and the answer asks for one":
    while eventChannel.tryRecv()[0]: discard
    let a = app("""
      let weather = "loading"
      export async function background() {
        const r = await frameos.fetch("https://weather.test/now?ms=300", { method: "post", headers: { "x-test": "sunny" } })
        weather = `${r.status} ${r.body}`
        frameos.dispatch("render")
      }
      export function get() { return weather }
    """, "weather")
    let start = getMonoTime()
    check a.render() == "loading"
    check msSince(start) < 200
    check jsIoInFlight() == 1
    check pumpUntil(proc(): bool = jsBackgroundPending() == 0)
    check a.render() == "200 POST sunny"
    var rendered = false
    while true:
      let (ok, message) = eventChannel.tryRecv()
      if not ok: break
      rendered = rendered or message[1] == "render"
    check rendered

  test "fetches from several apps are in flight at once":
    var apps: seq[tuple[runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext]]
    for i in 0 ..< 4:
      apps.add app("""
        let got = "-"
        export async function background() {
          got = (await frameos.fetch("https://slow.test/?ms=300")).body
        }
        export function get() { return got }
      """, "slow" & $i)
    let start = getMonoTime()
    for a in apps:
      check a.render() == "-"
    check pumpUntil(proc(): bool = jsBackgroundPending() == 0)
    # Four answers of 300 ms each, together: one after the other would be 1.2 s.
    check msSince(start) < 900
    for a in apps:
      check a.render() == "GET "

  test "a failed fetch is an answer, and a throw in background() is the app's log line":
    let a = app("""
      let seen = ""
      export async function background() {
        const r = await frameos.fetch("https://down.test/fail")
        seen = `${r.status}:${r.error}`
        throw new Error("boom")
      }
      export function get() { return seen }
    """, "failing")
    discard a.render()
    check pumpUntil(proc(): bool = jsBackgroundPending() == 0)
    check a.render() == "0:connection refused"
    check logged.anyIt("background() failed: boom" in it)

  test "a stretch without an await is stopped, and the others go on":
    jsBackgroundSliceMs = 200
    defer: jsBackgroundSliceMs = 0
    let spinner = app("""
      export async function background() {
        await frameos.sleep(0)
        while (true) {}
      }
      export function get() { return "spinning" }
    """, "spinner")
    let ticker = app("""
      let n = 0
      export async function background() { for (;;) { n++; await frameos.sleep(0.01) } }
      export function get() { return String(n) }
    """, "ticker")
    discard spinner.render()
    discard ticker.render()
    let start = getMonoTime()
    check pumpUntil(proc(): bool = logged.anyIt("without an await" in it or "background() failed" in it))
    check msSince(start) < 1500
    let before = parseInt(ticker.render())
    check pumpUntil(proc(): bool = parseInt(ticker.render()) > before + 2)

  test "an interpreter that goes takes its waits with it":
    let a = app("""
      export async function background() {
        frameos.fetch("https://slow.test/?ms=150")
        await frameos.sleep(0.05)
        frameos.setState("woke", true)
      }
      export function get() { return "x" }
    """, "going")
    discard a.render()
    check jsBackgroundPending() >= 2
    releaseIdleJsAppRuntimes()
    sleep(250)
    check pumpJsBackground() == 0
    check jsBackgroundPending() == 0
    check a.owner.scene.state{"woke"}.isNil

  test "frameos.fetch and frameos.sleep are promises, and get() may start one":
    let a = app("""
      let kinds = ""
      export function get() {
        const p = frameos.sleep(0)
        kinds = `${p instanceof Promise}:${frameos.fetch("https://x.test/?ms=1") instanceof Promise}`
        return kinds
      }
    """, "promises")
    check a.render() == "true:true"
    check pumpUntil(proc(): bool = jsBackgroundPending() == 0)

stopJsIo()
