## Async JavaScript (docs/async-js.md): `fetch`, the timers, `frameos.sleep`,
## `frameos.useFetch`, AbortController, an async `init()` and `<img src="https://…">`. The runner's loop is played here by
## `pumpJsAsync`; the network by `jsIoHook`, on the workers.

import std/[atomics, base64, json, monotimes, os, sequtils, strutils, tables, times, unittest]
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
# `networkMost` is the most requests it has held at once (reset by a test).
var networkNow, networkMost: Atomic[int]

jsIoHook = proc(request: JsIoRequest): JsIoResult {.gcsafe, nimcall.} =
  let now = networkNow.fetchAdd(1) + 1
  defer: discard networkNow.fetchSub(1)
  var most = networkMost.load
  while now > most and not networkMost.compareExchange(most, now):
    discard
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

proc ui(source: string, name: string): TestApp =
  result = app(source, name)
  result.runtime = newJsAppRuntime(category = "data", outputType = "image", source = source,
    sourceName = "app.tsx")

proc draw(a: TestApp, config = %*{}): Image =
  a.runtime.get(a.owner, config, a.context).asImage()

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

  test "an async init() runs to its first await at the first render, and on after each sleep":
    let a = app("""
      let ticks = 0
      export async function init(app) {
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
      export async function init() {
        const r = await fetch("https://weather.test/now?ms=300", {
          method: "post", headers: { "x-test": "sunny" }, body: { city: "Tartu" } })
        weather = [r.ok, r.status, r.headers.get("x-server"), r.headers.get("nope"), await r.text()].join("|")
        frameos.dispatch("render")
      }
      export function get() { return weather }
    """, "weather")
    # "loading" with the request still in flight is the proof the render did not wait.
    check a.render() == "loading"
    check jsIoInFlight() == 1
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    check a.render() == """true|200|test||POST sunny {"city":"Tartu"}"""
    check drainRenders() >= 1

  test "response.json(), a 404 is an answer, a network error rejects":
    let a = app("""
      let seen = []
      export async function init() {
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
        export async function init() {
          got = await (await fetch("https://slow.test/?ms=300")).text()
        }
        export function get() { return got }
      """, "slow" & $i)
    networkMost.store(0)
    for a in apps:
      check a.render() == "-"
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    # Four answers of 300 ms each, together: the network held all four at once.
    check networkMost.load == min(4, JsIoWorkers)
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

  test "a throw in an async init() is the app's log line":
    let a = app("""
      export async function init() {
        await frameos.sleep(0)
        throw new Error("boom")
      }
      export function get() { return "x" }
    """, "failing")
    discard a.render()
    check pumpUntil(proc(): bool = logged.anyIt("init() failed: boom" in it))

  test "a stretch without an await is stopped, and the others go on":
    jsAsyncSliceMs = 200
    defer: jsAsyncSliceMs = 0
    let spinner = app("""
      export async function init() {
        await frameos.sleep(0)
        while (true) {}
      }
      export function get() { return "spinning" }
    """, "spinner")
    let ticker = app("""
      let n = 0
      export async function init() { for (;;) { n++; await frameos.sleep(0.01) } }
      export function get() { return String(n) }
    """, "ticker")
    discard spinner.render()
    discard ticker.render()
    let start = getMonoTime()
    check pumpUntil(proc(): bool = logged.anyIt("without an await" in it or "init() failed" in it))
    check msSince(start) < 1500
    let before = parseInt(ticker.render())
    check pumpUntil(proc(): bool = parseInt(ticker.render()) > before + 2)
    releaseIdleJsAppRuntimes()

  test "Promise.all, race, allSettled and any; then, finally and microtasks":
    let a = app("""
      let seen = "-"
      export async function init() {
        const text = (u) => fetch(u).then((r) => r.text())
        const all = await Promise.all([text("https://a.test/?ms=40"), text("https://b.test/?ms=10")])
        const first = await Promise.race([frameos.sleep(1).then(() => "slow"), text("https://c.test/?ms=5").then(() => "fast")])
        const settled = await Promise.allSettled([fetch("https://down.test/fail"), text("https://d.test/")])
        const any = await Promise.any([fetch("https://down.test/fail"), text("https://e.test/").then(() => "any")])
        let finallyRan = false
        await fetch("https://f.test/").finally(() => { finallyRan = true })
        const order = []
        queueMicrotask(() => order.push("micro"))
        await null
        order.push("after")
        seen = [all.length, first, settled.map((x) => x.status).join("+"), any, finallyRan, order.join(">")].join("|")
      }
      export function get() { return seen }
    """, "combinators")
    discard a.render()
    check pumpUntil(proc(): bool = a.render() != "-")
    check a.render() == "2|fast|rejected+fulfilled|any|true|micro>after"

  test "fetch with AbortSignal.timeout or an AbortController's abort rejects, and its answer is dropped":
    let a = app("""
      let seen = []
      export async function init() {
        try { await fetch("https://slow.test/?ms=400", { signal: AbortSignal.timeout(30) }) }
        catch (e) { seen.push(e.name) }
        const c = new AbortController()
        const pending = fetch("https://slow.test/?ms=400", { signal: c.signal })
        c.abort()
        try { await pending } catch (e) { seen.push(e.name) }
        try { await fetch("https://x.test/", { signal: AbortSignal.abort() }) } catch (e) { seen.push(e.name) }
        seen.push((await fetch("https://quick.test/?ms=5", { signal: AbortSignal.timeout(2000) })).status)
      }
      export function get() { return seen.join(",") }
    """, "abort")
    let start = getMonoTime()
    discard a.render()
    check pumpUntil(proc(): bool = a.render().count(',') == 3)
    check a.render() == "TimeoutError,AbortError,AbortError,200"
    check msSince(start) < 300 # neither 400 ms answer was waited for
    check pumpUntil(proc(): bool = jsIoInFlight() == 0)
    check pumpJsAsync() == 0 # the late answers go nowhere

  test "async code reads the newest config: a field changed after init() started is seen":
    let a = app("""
      export async function init(app) {
        for (;;) {
          frameos.setState("city", app.config.city)
          await frameos.sleep(0.01)
        }
      }
      export function get(app) { return app.config.city }
    """, "liveconfig")
    check a.runtime.get(a.owner, %*{"city": "Tartu"}, a.context).asString() == "Tartu"
    check a.owner.scene.state{"city"}.getStr() == "Tartu"
    check a.runtime.get(a.owner, %*{"city": "Tallinn"}, a.context).asString() == "Tallinn"
    check pumpUntil(proc(): bool = a.owner.scene.state{"city"}.getStr() == "Tallinn")
    releaseIdleJsAppRuntimes()

  test "an interpreter that goes takes its waits with it":
    let a = app("""
      export async function init() {
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

  test "<img src>: nothing drawn first, the pictures after, one render for a page's pictures":
    let u = ui("""
      export function get() {
        return (
          <div className="flex w-[6px] h-[4px] bg-black">
            <img src="https://img.test/1.png?ms=80" className="w-[2px] h-[4px] object-cover" />
            <img src="https://img.test/2.png?ms=80" className="w-[2px] h-[4px]" />
            <img src="https://img.test/3.png?ms=80" className="w-[2px] h-[4px] object-contain" />
          </div>
        )
      }
    """, "img")
    var picture = u.draw()
    # The black pixel and the three requests in flight are the proof the draw did not wait.
    check picture[0, 0] == rgbx(0, 0, 0, 255)
    check jsIoInFlight() == 3
    discard u.draw()
    check jsIoInFlight() == 3 # asked once
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    let renders = drainRenders()
    check renders >= 1
    check renders <= 3
    picture = u.draw()
    check picture[0, 0] == rgbx(255, 0, 0, 255)
    check picture[3, 1] == rgbx(255, 0, 0, 255)
    # Kept: the next render asks nothing of the network.
    discard u.draw()
    check jsIoInFlight() == 0
    check jsAsyncPending() == 0

  test "<img src>: a failure draws nothing and is not asked again at once, a data: URL is there at once":
    let dataUrl = "data:image/png;base64," & encode(pngBytes)
    let u = ui("""
      export function get(app) {
        return (
          <div className="flex w-[6px] h-[4px] bg-black">
            <img src="https://img.test/missing" className="w-[3px] h-[4px]" />
            <img src={app.config.dataUrl} className="w-[3px] h-[4px]" />
          </div>
        )
      }
    """, "imgfail")
    var picture = u.draw(%*{"dataUrl": dataUrl})
    check picture[0, 0] == rgbx(0, 0, 0, 255)
    check picture[4, 1] == rgbx(255, 0, 0, 255)
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    picture = u.draw(%*{"dataUrl": dataUrl})
    check picture[0, 0] == rgbx(0, 0, 0, 255)
    check jsIoInFlight() == 0
    check logged.anyIt("<img> https://img.test" in it)

  test "<img src>: a picture far down a box that scrolls is fetched when the box scrolls near it":
    let u = ui("""
      export function get(app) {
        return (
          <div className="flex flex-col w-[6px] h-[4px] overflow-y-auto bg-black" scrollTop={app.config.top}>
            <img src="https://img.test/near.png?ms=40" className="w-[6px] h-[2px] shrink-0" />
            <div className="h-[40px] shrink-0" />
            <img src="https://img.test/far.png?ms=40" className="w-[6px] h-[2px] shrink-0" />
          </div>
        )
      }
    """, "imglazy")
    discard u.draw(%*{"top": 0})
    check jsIoInFlight() == 1 # the one in sight
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    discard drainRenders()
    discard u.draw(%*{"top": 40})
    check jsIoInFlight() == 1 # the far one, now in sight
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    discard drainRenders()
    let picture = u.draw(%*{"top": 40})
    check not picture.isNil
    if picture.isNil:
      echo logged
    else:
      # Rows 2-3: the far picture, scrolled to 40 (shaded by the box's scroll bar).
      check picture[1, 3].r > 150 and picture[1, 3].g == 0
      check picture[1, 0] == rgbx(0, 0, 0, 255)

  test "<img src>: a list scrolled through keeps the pictures on the screen and loads the others again":
    # The Scene store's covers (2026-11-22): a list longer than the kept
    # pictures, scrolled. The picture beside it, drawn every render, is never
    # the one pushed out (the least lately drawn go first), and the list's
    # first pictures, pushed out while out of sight, load again when it is
    # scrolled back, rather than waiting out the churn hold as blanks.
    let u = ui("""
      export function get(app) {
        const rows = []
        for (let i = 0; i < 60; i++)
          rows.push(<img src={`https://img.test/row${i}.png?ms=1`} className="w-[6px] h-[2px] shrink-0" />)
        return (
          <div className="flex w-[8px] h-[4px] bg-black">
            <img src="https://img.test/beside.png?ms=1" className="w-[2px] h-[4px] shrink-0" />
            <div className="flex flex-col w-[6px] h-[4px] overflow-y-auto bg-black" scrollTop={app.config.top}>
              {rows}
            </div>
          </div>
        )
      }
    """, "imgscroll")
    var top = 0
    while top <= 116:
      discard u.draw(%*{"top": top})
      check pumpUntil(proc(): bool = jsAsyncPending() == 0)
      discard drainRenders()
      top += 4
    var picture = u.draw(%*{"top": 116})
    check jsIoInFlight() == 0
    check picture[0, 0] == rgbx(255, 0, 0, 255) # beside the list, kept throughout
    check not logged.anyIt("beside.png" in it)
    # Back to the top: its pictures went while out of sight, and come again.
    picture = u.draw(%*{"top": 0})
    check jsIoInFlight() >= 1
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)
    discard drainRenders()
    picture = u.draw(%*{"top": 0})
    check picture[4, 0].r > 150 and picture[4, 0].g == 0
    check picture[0, 0] == rgbx(255, 0, 0, 255)

  test "<img src>: more pictures near the screen than are kept: the ones on it all show":
    # A screenful of 24 covers and four rows of them either side: 72 near,
    # 48 kept. Fetched ahead only into room, the ones off the screen never
    # push out one on it.
    let u = ui("""
      export function get(app) {
        const cells = []
        for (let i = 0; i < 120; i++)
          cells.push(<img src={`https://img.test/cell${i}.png?ms=1`} className="w-[1px] h-[1px] shrink-0" />)
        return (
          <div className="flex flex-row flex-wrap content-start w-[6px] h-[4px] overflow-y-auto bg-black" scrollTop={app.config.top}>
            {cells}
          </div>
        )
      }
    """, "imgnear")
    for top in [0, 4, 8]:
      for i in 0 ..< 12:
        discard u.draw(%*{"top": top})
        if not pumpUntil(proc(): bool = jsAsyncPending() == 0):
          break
        discard drainRenders()
    let picture = u.draw(%*{"top": 8})
    var red = 0
    for y in 0 ..< 4:
      for x in 0 ..< 5: # the last column is under the scroll bar
        if picture[x, y].r > 150 and picture[x, y].g == 0:
          inc red
    check red == 20
    check jsIoInFlight() == 0

  test "where nothing pumps, an <img> is fetched in the render":
    asyncPumped = false
    defer: asyncPumped = true
    let u = ui("""
      export function get() {
        return <div className="flex w-[6px] h-[4px] bg-black"><img src="https://img.invalid/a.png" className="w-[6px] h-[4px]" /></div>
      }
    """, "imgblocking")
    discard u.draw()
    # Asked of the network in the render (img.invalid never answers), not later.
    check jsAsyncPending() == 0
    check jsIoInFlight() == 0
    check logged.anyIt("img.invalid" in it)

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

  test "fetch and the timers are promises and functions, and get() may start one":
    let a = app("""
      export function get() {
        return [frameos.sleep(0) instanceof Promise, fetch("https://x.test/?ms=1") instanceof Promise,
          typeof setTimeout, typeof clearInterval, typeof frameos.useImage].join(":")
      }
    """, "promises")
    check a.render() == "true:true:function:function:undefined"
    check pumpUntil(proc(): bool = jsAsyncPending() == 0)

stopJsIo()
