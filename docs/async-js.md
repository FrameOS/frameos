# Async JavaScript

**Status: experimental, on a Pi and on an ESP32 that stays awake.** It is not
in the scene guide or `appTypeDeclarations.ts` yet, so no AI writes it and the
editor does not type it; putting it there (and running the AI evals) is what
makes it public. The Scene store sample is its first user (`<img src>` and
`fetch`).

A JS app can wait without holding the frame: a request, a picture, a timer.
A render never waits for any of it, and a tap is answered while a picture
downloads.

## The API

Three ways in. **`<img src="https://…">`** for pictures: the runtime fetches
them, at the size they are drawn, off the render. **`frameos.useFetch`** for
data `get()` draws: what is there now, the rest when it lands. **Promises**
for code that can wait: an async `init()`, timers, handlers.

```tsx
// get() draws what it has; the scene renders again as the rest lands.
export function get(app) {
  const forecast = frameos.useFetch(`https://api.example.com/forecast?q=${app.config.city}`, { maxAge: 600 })
  return (
    <div className="flex">
      <img src={app.config.photoUrl} className="w-[400px] h-[300px] object-cover bg-gray-800" />
      <span>{forecast.data ? `${forecast.data.temp}°` : forecast.error || 'Loading…'}</span>
    </div>
  )
}
```

```tsx
// Promises: an async init() keeps working between renders.
let forecast = null

export async function init(app) {
  for (;;) {
    // app.config is read anew each time: a field changed since is seen.
    const r = await fetch(`https://api.example.com/forecast?q=${app.config.city}`,
      { signal: AbortSignal.timeout(10_000) })
    if (r.ok) {
      forecast = await r.json()
      frameos.dispatch('render') // this scene again, also in a window or a split
    }
    await frameos.sleep(600)
  }
}

export function get() {
  return forecast ? <Forecast data={forecast} /> : <div>Loading…</div>
}
```

### `<img src="https://…">`

A URL as an `<img>`'s `src` is a picture the runtime fetches for the app.
Give the `<img>` its size (`w-[…] h-[…]`, or one of them and `aspect-…`): the
picture is decoded at exactly the size the layout gives it, in panel pixels
and the canvas's format, so drawing it is a copy; `object-cover`,
`object-contain` or the default fill say how it fits. Until it is in, nothing
is drawn there: the `<img>`'s own background, or what is under it, shows (the
Scene store puts the scene's initial under each cover).

- **Where it waits is the runtime's call, not the app's.** An LCD, an HDMI
  screen and a Pi's fetch every picture of a pass at once, off the render,
  and render the scene once more however many land together. E-paper, a
  board that deep-sleeps and every wasm runtime fetch it in the render
  (e-paper: one refresh with every picture; a plane's render for a board:
  every picture in that render; the browser preview, which shows each frame
  as it comes: one picture a render and the next render soon, turned on by
  its worker with `frameos_wasm_set_pictures_one_a_render`).
- The picture is a kept picture (`fetchImage` `keep`: 48 small ones,
  `docs/jsx-ui.md` "Photos that stay"): the same url at the same size is
  one picture while the interpreter lives. At a new size (the box changed)
  the old one stands in until the new one is in.
- A failure is the app's log line `<img> https://host: why` and is asked
  again after 30 s; a picture that loses its memory within 10 s of coming
  (the app shows more than fits) waits 30 s too, so two pictures cannot push
  each other out for ever. A `data:` URL is decoded at once, everywhere.
- Not for headers or a color profile: that is `frameos.fetchImage`.

### `frameos.useFetch` (for `get()`)

- **`frameos.useFetch(url, init)`** → `{data, error, loading, status, ok}`.
  `init` is `fetch`'s, plus `as: "text"` (JSON otherwise) and `maxAge`
  (seconds: older than that, it is fetched again while the old `data` still
  shows; without it, once per interpreter). A render is asked for when it
  lands. 32 urls kept per app.

Why these and not React's `useState` / `useEffect`: a module variable already
is a `useState` that lasts (and `frameos.remember` one that outlives the
interpreter), a handler already re-renders, and what hooks are really for on
a frame is data that arrives later. `useFetch` is keyed by url and options,
not by call order, so it may sit in a condition or a loop.

### Promises

- **`fetch(url, init)`**: the web's, as far as a frame goes. `init.method`,
  `headers`, `body` (a string, or an object sent as JSON), `signal`, plus
  `timeoutMs` (the request's own limit, 15 s by default).
  It resolves with a `Response`: `ok`, `status`, `url`, `headers.get(name)`
  (a Pi's; an ESP32's glue keeps none), `text()`, `json()`. A 404 is an
  answer; a network error rejects with a `TypeError`. The scene's response
  ceiling applies; the render deadline does not (no render waits).
- **`setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`**: as on the
  web (an interval is 10 ms at the least). **`frameos.sleep(seconds)`**: a
  promise, a day at most.
- **`AbortController`, `AbortSignal`** (`abort()`, `timeout(ms)`,
  `any([...])`, `aborted`, `reason`, `addEventListener("abort")`): a `fetch`
  whose signal aborts rejects at once, with the signal's reason (an
  `AbortError`, or a `TimeoutError` from `AbortSignal.timeout`), and its
  answer is dropped when it comes. **`queueMicrotask`**, and the whole of
  `Promise` (`all`, `race`, `allSettled`, `any`, `finally`), async functions
  and generators are QuickJS's own.
- **`export async function init(app, context)`**: `init()` runs once per
  interpreter, before the first `get()` / `run()`; an async one runs to its
  first `await` then and goes on between renders, as long as the interpreter
  lives (on an ESP32 one that is dropped for memory starts again with the
  next one). Async code reads **the newest config**: `app.config` is the
  node's fields as of the latest call into the app, public state included,
  so a loop reading it each time sees a field that changed (`app.state` is
  always the scene's own). To fetch again *when* a field changes, put the
  field in a `useFetch` url: a new url is a new request. `context.event` is
  `"async"` while async code runs. A throw (or a rejection nobody caught) is
  the app's log line `init() failed: …`.
- **`frameos.dispatch("render")`**: from async code it marks the scene due
  (`rhythmMarkDue`, so a scene in a window or a split runs instead of putting
  back its last picture) and asks for a render.

All of them can be called from `get()`, `run()` and handlers too; a promise
settles later, between renders. The callbacks of a promise a call settled run
at the end of that call (a microtask checkpoint after every `invoke`).

Limits:

| | |
|---|---|
| requests, timers and pictures pending, per app | 32 (one more is refused: its promise rejects; an `<img>` asks again at a later render) |
| one stretch of async code, from an await to the next | 2 s (`JsAsyncSliceMs`): stopped there, logged |
| requests in flight, the frame over | a Pi 4 (`JsIoWorkers`, the fifth waits); an ESP32 1 at a time, 32 queued |
| one pump between renders | ~40 ms (`PumpBudgetMs`) and at least one answer; the rest at the next. On an ESP32 answers wait while a tap or key is queued or came in the last 250 ms (`fos_client_input_pending`) |

Async code runs on the thread that renders, between renders: a stretch that
computes for a second holds the frame for that second. Await often.

## Where it runs

| Runtime | Promises | `useFetch`, `<img src>` |
|---|---|---|
| Raspberry Pi (the runner) | yes, for every scene it keeps (windows behind, scenes visited before) | async |
| ESP32 that stays awake (`keepJsRuntimes`), LCD | yes | async |
| ESP32 that stays awake, e-paper | yes | `useFetch` async, `<img>` in the render |
| ESP32 that deep-sleeps | `fetch` blocks and settles at once; timers never fire (an async `init()` stops at its first sleep) | in the render |
| wasm (the editor's preview, a plane's render for a board) | as a deep sleeper | in the render; the preview one `<img>` a render, the next soon |

A runtime nothing pumps has no promise that outlives a render, so it gives
the blocking answer instead: a scene written this way works everywhere, and
is only faster where it can be.

## How it works

```
 the thread that renders                           the I/O
 ───────────────────────                           ───────
 render ──┐                                        Pi: 4 worker threads
 wait  ───┤ pumpJsAsync ◄── answers (values) ◄──── ESP32: fos_js_io.c task
          │      │              ▲ wake                 ▲
          ▼      ▼              │                      │
   __frameosSettle(id, json)    └── requests (values) ─┘
   runPendingJobs (≤ 2 s)           submitJsIo(url, method, headers, body…)
   <img>: decode, keep, one render per scene
```

- **Every interpreter stays on the thread that renders.** QuickJS is not
  thread-safe and refs do not cross threads (AGENTS.md). What leaves the
  thread is a request made of strings and numbers; what comes back is a
  status, the headers and the body (`js_runtime/js_io.nim`).
  - **A Pi**: four worker threads with the HTTP client every app uses, its
    shared state (the DNS cache, the local network policy) behind its locks;
    a worker's answer wakes the runner (`wakeRunner`). The pump is in the
    runner's message loop, which also waits no longer than the next timer
    (`nextJsAsyncMs`).
  - **An ESP32**: one FreeRTOS task (`components/frameos_nim/fos_js_io.c`),
    made when there is work and gone when there is none, which also runs the
    scene store's work (`main/fos_store.c`, `fos_js_io_run`): one TLS session
    at a time, ~40 KB of internal RAM, which an ESP32-S3 runs short of first. It makes the request with the glue every
    Nim app uses (`fos_nim_http_request_chunked`: the private-network policy,
    the redirects, the body in PSRAM chunks) and wakes the render task's
    wait (`fos_client_wake_for_events`). The pump is `frameos_nim_tick`,
    which the idle wait and an animation's wait call on every slice; the
    idle wait's slice ends when a timer is due (`frameos_nim_next_async_ms`).
    What the settled code dispatched (a `render`) is delivered by the same
    tick (`single_scene_host.drainQueued`): nothing else sends while the
    firmware idles, and it waited in the queue for the next tap.
    A picture is decoded from the chunks on the render task, by the same
    code as a buffered download (`decodeBufferedImage`), into the size asked.
- **A promise is an id.** The prelude asks the bridge for one
  (`jsAsyncStart`) and keeps its resolver in a JS map under it. The pump
  settles each answer and each timer that is over (`__frameosSettle`), and
  the job queue runs, which is the awaiting code going on to its next await.
- **The bridge needs to know whose code it is running.** `frameos.setState`,
  `dispatch` and the rest find the app and scene through the environment of
  the call in progress; the pump builds one for each settle (the app, its
  scene, the newest config, a context of event `async`), with the same deadline guard as
  any call, and holds the runtime on the call stack so a decode short of
  memory cannot release the interpreter it decodes for.
- **An interpreter can go with promises pending** (a scene reload; on an
  ESP32 memory pressure). Each id remembers the context that asked; one torn
  down or rebuilt since is a different context, and its answer is dropped
  (and its chunks freed).

`src/frameos/js_runtime/js_async.nim` (included into `app_runtime.nim`),
`js_io.nim`, the JS half in the app prelude. Tests:
`js_runtime/tests/test_async_js.nim` (fetch's Response and rejection, timers,
four apps' requests in flight together, a spinning stretch stopped while the
others go on, a dropped interpreter dropping its waits, `<img src>` with one
render for a pass's pictures and a failure not asked again at once,
`useFetch`, the blocking answers where nothing pumps),
`tests/test_runner_async_js.nim` (through the real runner) and
`tests/test_scene_store_scene.nim` (the store's pages over `fetch` and its
covers from the network: the placeholders render in ~10 ms, a tap during the
downloads is answered at once, six 150 ms covers land together).

## What the investigation found

**Can QuickJS be multiplexed?** Only cooperatively. It has promises, async
functions and a job queue, but the host cannot pause running JavaScript and
resume it later: the interrupt handler can only abort. So code yields at its
`await`s, which is where it waits anyway (the network, a timer). A stretch
with no await cannot be interleaved, only stopped, which is the 2 s slice.

**What froze the Scene store** on a Pi and an ESP32 (2026-11-15): its covers
were a synchronous `fetchImage` each, one a pass, with `setNextSleep(0.05)`
for the next. So the render thread was nearly always inside a download (a
TLS handshake and a CDN round trip, then a decode), and a tap waited for the
pass in progress: two seconds and more, with no loading mark (the mark is for
scene switches and slow scenes, `docs/realtime-rendering.md`), and no way to
page. The drawing itself is cheap: the page renders in ~11 ms on a desktop,
covers or not. As `<img src>`s the covers download together off the render.

On a SenseCAP Indicator (2026-11-15, main's firmware, the Real time shelf from
a reboot): six renders in a row of 2.1–2.7 s, each `get()` blocking 1.8–2.4 s
on one cover, the page full after ~17 s. With async JavaScript no render took
more than 1.4 s and a tap during the downloads was answered in ~0.75 s, but
the covers came 24 s late, all at once, or only at the next tap. Two
reasons: answers waited for the input hold, which lasts 10 s after the last
tap or console event (they now wait only for a tap that is queued or 250 ms
old), and the `render` the app dispatched when they came sat in the host's
event queue, which only a firmware event or a render drained (the idle tick
drains it now). With both fixed, on the same board: the listing drawn ~3 s
after opening the store, each cover drawn as it lands (renders 0.3–1.6 s,
`get()` at most 0.4 s), the page full in ~15 s, a tap answered in ~1 s.

**What still blocks:** `fetchText`, `fetchJson`, `httpRequest` and
`fetchImage` in `get()` stay synchronous, as they must: `get()` returns the
picture. An app moves its waiting into `<img src>`, `useFetch` or
an async `init()` and draws what it has.

**Why not a thread per app?** An interpreter must stay on one thread, and so
must everything it touches through the bridge (the scene, its state, the
logger, the images). A thread per scene is possible on a Pi, with its own
interpreters and its window's picture handed over as a buffer; it is the
step that keeps an app that computes (not one that waits) from holding the
frame, and a bigger change to the runner.

## Next

1. Make it public: the declarations in `appTypeDeclarations.ts` (`fetch`,
   the timers, `frameos.sleep` / `useFetch`, `<img src>` in the JSX
   section), a section in `docs/scene-guide.md` and
   `docs/js-apps-and-code-nodes.md`, the AI evals.
2. The editor's preview: it could pump between its renders (the browser
   fetches for it) instead of blocking.
3. A picture's decode on a Pi's worker into plain bytes, made into an
   `Image` on the runner thread; on an ESP32 a decode that streams from the
   socket on the request task is the same idea, with less memory.
4. A policy for async work in scenes that are not shown (a Pi keeps running
   them now): a layout could pause the scenes it does not draw.
5. `AbortController` / `signal` for `fetch`, if an app needs to cancel.
