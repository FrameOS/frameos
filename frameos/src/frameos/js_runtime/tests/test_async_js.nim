## Async JavaScript (docs/async-js.md): `fetch`, the timers, `frameos.sleep`,
## `frameos.loadImage`, the hooks (`frameos.useImage`, `frameos.useFetch`) and
## an app's `background()`. The runner's loop is played here by
## `pumpJsAsync`; the network by `jsIoHook`, on the workers.

import std/[base64, json, monotimes, os, sequtils, strutils, tables, times, unittest]
import pixie

import frameos/channels
import frameos/js_runtime/app_runtime
import frameos/js_runtime/js_io
import frameos/types
import frameos/values
import frameos/utils/http_client

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

let pngBytes = block:
  let image = newImage(8, 6)
  image.fill(rgba(255, 0, 0, 255))
  image.encodeImage(PngFormat)

# The network: `?ms=N` answers after N ms, `/fail` does not answer at all,
# `/missing` is a 404, `.png` is an 8x6 picture, `/json` a JSON body.
jsIoHook = proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.} =
  let at = request.url.find("ms=")
  if at >= 0:
    var digits = ""
    for ch in request.url[at + 3 .. ^1]:
      if ch in {'0'..'9'}: digits.add ch else: break
    sleep(parseInt(digits))
  if "/fail" in request.url:
    return JsIoResult(error: "connection refused")
  if "/missing" in request.url:
    return JsIoResult(code: 404, body: "not here")
  if ".png" in request.url:
    {.cast(gcsafe).}:
      return JsIoResult(code: 200, body: pngBytes, headers: @[("Content-Type", "image/png")])
  if "/json" in request.url:
    return JsIoResult(code: 200, body: """{"temp": 21}""", headers: @[("Content-Type", "application/json")])
  var header = ""
  for (name, value) in request.headers:
    if name == "x-test": header = value
  JsIoResult(code: 200, body: request.httpMethod & " " & header & " " & request.body,
    headers: @[("X-Server", "test")])

let config = testConfig()

type TestApp = tuple[runtime: JsAppRuntime, owner: AppRoot, context: ExecutionContext]

proc app(source: string, name = "bg"): TestApp =
  let scene = FrameScene(id: ("tests/" & name).SceneId, frameConfig: config, state: %*{},
    logger: testLogger(config))
  result.owner = AppRoot(nodeId: 1.NodeId, nodeName: name, scene: scene, frameConfig: config)
  result.context = ExecutionContext(scene: scene, event: "render", payload: %*{}, hasImage: false,
    loopIndex: 0, loopKey: ".", nextSleep: -1)
  result.runtime = newJsAppRuntime(category = "data", outputType = "text", source = source)

proc render(a: TestApp): string =
  a.runtime.get(a.owner, %*{}, a.context).asString()

proc pumpUntil(done: proc(): bool, ms = 3000): bool =
  let start = getMonoTime()
  while (getMonoTime() - start).inMilliseconds < ms:
    discard pumpJsAsync()
    if done():
      return true
    sleep(2)
  done()

proc msSince(start: MonoTime): int64 = (getMonoTime() - start).inMilliseconds

proc drainRenders(): int =
  ## The `render` events the scenes asked for since the last call.
  while true:
    let (ok, message) = eventChannel.tryRecv()
    if not ok: break
    if message[1] == "render": inc result

suite "async JavaScript":
  setup:
    logged = @[]
    discard drainRenders()

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
    check nextJsAsyncMs() in 0 .. 20
    check pumpUntil(proc(): bool = a.owner.scene.state{"done"}.getBool())
    check a.owner.scene.state{"ticks"}.getInt() == 3
    check a.render() == "ticks:3"
    check jsAsyncPending() == 0

  test "fetch answers a Response, and a render never waits for it":
    let a = app("""
      let weather = "loading"
      export async function background() {
        const r = await fetch("https://weather.test/now?ms=300", {
          method: "post", headers: { "x-test": "sunny" }, body: { city: "Tartu" } })
        weather = [r.ok, r.status, r.headers.get("x-server"), r.headers.get("nope"), await r.text()].join("|")
        frameos.dispatch("render")
      }
      export function get() { return weather }
    """, "weather")
    let start = getMonoTime()
    check a.render() == "loading"
    check msSince(start) < 200
    check jsIoInFlight() == 1
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    check a.render() == """true|200|test||POST sunny {"city":"Tartu"}"""
    check drainRenders() >= 1

  test "response.json(), a 404 is an answer, a network error rejects":
    let a = app("""
      let seen = []
      export async function background() {
        seen.push((await (await fetch("https://api.test/json")).json()).temp)
        const missing = await fetch("https://api.test/missing")
        seen.push(`${missing.ok}:${missing.status}`)
        try { await fetch("https://down.test/fail") } catch (e) { seen.push(e instanceof TypeError ? "TypeError" : "other") }
      }
      export function get() { return seen.join(",") }
    """, "fetchsemantics")
    discard a.render()
    check pumpUntil(proc(): bool = jsAsyncPending() == 0 and a.render().count(',') == 2)
    check a.render() == "21,false:404,TypeError"

  test "fetches from several apps are in flight at once":
    var apps: seq[TestApp]
    for i in 0 ..< 4:
      apps.add app("""
        let got = "-"
        export async function background() {
          got = await (await fetch("https://slow.test/?ms=300")).text()
        }
        export function get() { return got }
      """, "slow" & $i)
    let start = getMonoTime()
    for a in apps:
      check a.render() == "-"
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    # Four answers of 300 ms each, together: one after the other would be 1.2 s.
    check msSince(start) < 900
    for a in apps:
      check a.render() == "GET  "

  test "setTimeout, setInterval and their clears":
    let a = app("""
      let log = []
      export function init() {
        setTimeout((x) => log.push("once:" + x), 10, "a")
        const dropped = setTimeout(() => log.push("never"), 5)
        clearTimeout(dropped)
        let n = 0
        const every = setInterval(() => { log.push("tick"); if (++n === 3) clearInterval(every) }, 10)
      }
      export function get() { return log.join(",") }
    """, "timers")
    discard a.render()
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    let seen = a.render().split(",")
    check "once:a" in seen
    check "never" notin seen
    check seen.countIt(it == "tick") == 3

  test "a throw in background() is the app's log line":
    let a = app("""
      export async function background() {
        await frameos.sleep(0)
        throw new Error("boom")
      }
      export function get() { return "x" }
    """, "failing")
    discard a.render()
    check pumpUntil(proc(): bool = logged.anyIt("background() failed: boom" in it))

  test "a stretch without an await is stopped, and the others go on":
    jsAsyncSliceMs = 200
    defer: jsAsyncSliceMs = 0
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
    releaseIdleJsAppRuntimes()

  test "an interpreter that goes takes its waits with it":
    let a = app("""
      export async function background() {
        fetch("https://slow.test/?ms=150")
        await frameos.sleep(0.05)
        frameos.setState("woke", true)
      }
      export function get() { return "x" }
    """, "going")
    discard a.render()
    check jsAsyncPending() >= 2
    releaseIdleJsAppRuntimes()
    sleep(250)
    check pumpJsAsync() == 0
    check jsAsyncPending() == 0
    check a.owner.scene.state{"woke"}.isNil

  test "frameos.loadImage settles with a kept picture, or rejects":
    let a = app("""
      let seen = "-"
      export async function background() {
        const r = await frameos.loadImage("https://img.test/a.png?ms=50", { width: 4, height: 3 })
        let failed = ""
        try { await frameos.loadImage("https://img.test/missing") } catch (e) { failed = "rejected" }
        seen = `${r.image.__frameosType}:${r.width}x${r.height}:${failed}`
      }
      export function get() { return seen }
    """, "loadimage")
    discard a.render()
    check pumpUntil(proc(): bool = jsAsyncPending() == 0 and a.render() != "-")
    # A Pi decodes at the picture's own size (the consumer scales).
    check a.render() == "imageRef:8x6:rejected"

  test "useImage: loading first, the picture after, one render for the pictures of a pass":
    let a = app("""
      export function get() {
        const urls = ["https://img.test/1.png?ms=80", "https://img.test/2.png?ms=80", "https://img.test/3.png?ms=80"]
        return urls.map((u) => {
          const r = frameos.useImage(u, { width: 4, height: 3 })
          return r.image ? `${r.width}x${r.height}` : r.loading ? "loading" : "error:" + r.error
        }).join(",")
      }
    """, "useimage")
    let start = getMonoTime()
    check a.render() == "loading,loading,loading"
    check msSince(start) < 60
    check a.render() == "loading,loading,loading"
    check jsIoInFlight() == 3
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    check a.render() == "8x6,8x6,8x6"
    let renders = drainRenders()
    check renders >= 1
    check renders <= 3
    # Kept: the next render asks nothing of the network.
    check a.render() == "8x6,8x6,8x6"
    check jsIoInFlight() == 0
    check jsAsyncPending() == 0

  test "useImage of a failed picture says why, and a data: URL is there at once":
    let dataUrl = "data:image/png;base64," & encode(pngBytes)
    let a = app("""
      export function get(app) {
        const bad = frameos.useImage("https://img.test/missing")
        const inline = frameos.useImage(app.config.dataUrl)
        return `${bad.image ? "image" : bad.loading ? "loading" : "error"}|${inline.image ? inline.width : "none"}`
      }
    """, "useimagefail")
    check a.runtime.get(a.owner, %*{"dataUrl": dataUrl}, a.context).asString() == "loading|8"
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    check a.runtime.get(a.owner, %*{"dataUrl": dataUrl}, a.context).asString() == "error|8"

  test "useFetch: loading first, the data after, and a render asked for":
    let a = app("""
      export function get() {
        const r = frameos.useFetch("https://api.test/json?ms=50")
        const t = frameos.useFetch("https://api.test/hello", { as: "text", method: "PUT" })
        return `${r.loading}:${r.data ? r.data.temp : "-"}:${t.data || "-"}`
      }
    """, "usefetch")
    check a.render() == "true:-:-"
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    check drainRenders() >= 1
    check a.render() == "false:21:PUT  "

  test "where nothing pumps, fetch and useFetch block and answer at once":
    asyncPumped = false
    defer: asyncPumped = true
    jsHttpRequestHook = proc(url, httpMethod, body: string, headers: seq[SimpleHttpHeader]): tuple[code: int, body: string] =
      (200, """{"temp": 5}""")
    defer: jsHttpRequestHook = nil
    let a = app("""
      let viaFetch = "-"
      export function get() {
        fetch("https://api.test/x").then((r) => r.json()).then((j) => { viaFetch = String(j.temp) })
        const r = frameos.useFetch("https://api.test/y")
        return `${r.loading}:${r.data.temp}:${viaFetch}`
      }
    """, "blocking")
    check a.render() == "false:5:-"
    check a.render() == "false:5:5"
    check jsAsyncPending() == 0
    check jsIoInFlight() == 0

  test "fetch, the timers and loadImage are promises and functions, and get() may start one":
    let a = app("""
      export function get() {
        return [frameos.sleep(0) instanceof Promise, fetch("https://x.test/?ms=1") instanceof Promise,
          typeof setTimeout, typeof clearInterval, typeof frameos.useImage].join(":")
      }
    """, "promises")
    check a.render() == "true:true:function:function:function"
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)

stopJsIo()
