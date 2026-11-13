# Background JavaScript

**Status: experimental, Raspberry Pi only.** It is not in the scene guide or
`appTypeDeclarations.ts` yet, so no AI writes it and the editor does not type
it; putting it there (and running the AI evals) is what makes it public.

A JS app can keep working between renders: fetch, wait, fetch again, and ask
for a render when it has something new. A render never waits for any of it.

```tsx
let forecast = null

export async function background(app) {
  for (;;) {
    const r = await frameos.fetch(`https://api.example.com/forecast?q=${app.config.city}`)
    if (r.status === 200) {
      forecast = JSON.parse(r.body)
      frameos.dispatch("render") // this scene is drawn again, in a window or a split too
    }
    await frameos.sleep(600)
  }
}

export function get(app) {
  return forecast ? <Forecast data={forecast} /> : <div>Loading…</div>
}
```

## The API

- **`export async function background(app, context)`**: started when the app's
  interpreter is (its first render on a Pi, right after `init()`), and runs
  to its first `await` then. `context.event` is `"background"`. A throw (or a
  rejected promise nobody caught) is the app's log line
  `background() failed: …`. It ends when it returns or when its interpreter
  goes.
- **`frameos.fetch(url, options)`**: `frameos.httpRequest` as a promise, with the
  same options and the same answer (`{status, body | bodyBase64 | found,
  error}`). A network error resolves with `status: 0` and `error`, as
  httpRequest returns it; it never rejects for one. The scene's response
  ceiling applies; the render deadline does not (no render waits), the
  request's own `timeoutMs` does.
- **`frameos.sleep(seconds)`**: a promise that resolves after that long (a day at
  most).
- **`frameos.dispatch("render")`**: already there; from background code it marks
  the scene due (`rhythmMarkDue`, so a scene in a window or a split runs
  instead of putting back its last picture) and asks for a render.
- Both can be called from `get()`, `run()` and handlers too: the promise
  settles later, between renders.

Limits:

| | |
|---|---|
| fetches and sleeps pending, per app | 16 (one more is refused: its promise rejects, the log says why) |
| one stretch of background code, from an await to the next | 2 s (`JsBackgroundSliceMs`): stopped there, its promise chain rejects, logged |
| requests in flight, the frame over | 4 (`JsIoWorkers`); the fifth waits for a worker |

Background code runs on the runner thread, between renders: a stretch that
computes for a second holds the frame for that second. Await often.

## Where it runs

Everywhere a Pi's runner keeps an interpreter, which is every scene it has
shown, for that scene's life: the scene on the screen, the scenes in a
desktop layout's windows (`docs/scene-layouts.md` "Windows"), and the scenes
visited before. A scene that is not on the screen keeps fetching. An upload or
a reload of the scenes drops them all, and the new interpreters start their
`background()` again at their first render.

Not on an ESP32, not in the wasm runtime (the editor's preview, a plane's
render for a board): `frameos.fetch` and `frameos.sleep` are `undefined` there,
and `background()` is never called. See "The ESP32" below.

## How it works

```
 runner thread                                    js_io workers (4)
 ─────────────                                    ─────────────────
 render loop ─┐  (both loops: one thread)
 message loop ┤
   pumpJsBackground ◄── answers (values) ◄──────── boundedRequestWithHeaders
        │                     ▲ wakeRunner()                ▲
        ▼                     │                             │
  __frameosSettle(id, json)   └── requests (values) ────────┘
  runPendingJobs (≤ 2 s)          submitJsIo(url, method, headers, body…)
```

- **Every interpreter stays on the runner thread.** QuickJS is not thread-safe
  and refs do not cross threads (AGENTS.md). What leaves the thread is a
  request made of strings and numbers; what comes back is a status and a body
  (`js_runtime/js_io.nim`). The HTTP client is the one every app uses, its
  shared state (the DNS cache, the local network policy) behind its locks.
- **A promise is an id.** `frameos.fetch` asks the bridge for an id
  (`jsAsyncStart`) and keeps its resolver in a JS map under it. The runner's
  message loop calls `pumpJsBackground` on every pass: each answer that came
  back and each sleep that is over settles its promise (`__frameosSettle`), and
  the job queue runs, which is the awaiting code going on to its next await.
  A worker's answer wakes the loop (`wakeRunner`); a sleep shortens the loop's
  own wait (`nextJsBackgroundMs`).
- **The bridge needs to know whose code it is running.** `frameos.setState`,
  `dispatch` and the rest find the app and scene through the environment of
  the call in progress, which existed only inside `get()` / `run()`. The pump
  builds one for each settle (the app, its scene, a context of event
  `background`), with the same deadline guard as any call.
- **An interpreter can go with promises pending** (a scene reload; on an ESP32
  memory pressure). Each id remembers the context that asked; one torn down
  or rebuilt since is a different context, and its answer is dropped.
- **The prelude is untouched.** The JS half is a second script evaluated after
  it, on a Pi only: the prelude is also the firmware's bytecode, and the
  ESP32 image does not change (`jsBackgroundOn`).

`src/frameos/js_runtime/background_js.nim` (included into `app_runtime.nim`),
`js_io.nim`, the pump in `runner.nim`'s message loop. Tests:
`js_runtime/tests/test_background_js.nim` (four 300 ms fetches from four apps
finish together in ~300 ms, a render returns at once while one is pending,
a spinning stretch is stopped and the others go on, a dropped interpreter
drops its waits) and `tests/test_runner_background_js.nim` (through the real
runner: a scene with a ten-minute interval redraws on its app's requests).

## What the investigation found

**Can QuickJS be multiplexed?** Only cooperatively. It has promises, async
functions and a job queue, but the host cannot pause running JavaScript and
resume it later: the interrupt handler can only abort. So code yields at its
`await`s, which is where a background task waits anyway (the network, a
timer). A stretch with no await cannot be interleaved, only stopped, which is
the 2 s slice. Generators would let CPU-bound code yield by hand; nothing on a
frame needs that yet.

**Why not a thread per app?** An interpreter must stay on one thread, and so
must everything it touches through the bridge (the scene, its state, the
logger, the images). A thread per scene is possible on a Pi, with its own
interpreters and its window's picture handed over as a buffer, and it is the
step that keeps a slow app from holding the whole frame (an app that computes,
not one that waits). It is a bigger change to the runner. Background JS
removes the most common cause of a stuck frame, which is a render waiting on
the network. Today a `fetchJson` in `get()` holds the frame for up to its
timeout, and a stuck one for up to the render deadline (120 s on a Pi).

**What still blocks:** `fetchText`, `fetchJson`, `httpRequest` and
`fetchImage` in `get()` are still synchronous, as they must be: `get()`
returns the picture. An app moves its waiting into `background()` and draws
what it has.

## The ESP32

Not built. It could carry the same API on a board that stays awake:

- **Who owns the interpreters:** the render task, as the runner thread does
  on a Pi. The pump would run in its idle wait (`fos_client.c`'s loop), and
  answers would reach it the way HTTP and console events do
  (`fos_events_defer`), not from another task's stack.
- **The I/O:** a FreeRTOS task with `esp_http_client`, not worker threads. One
  request at a time: a TLS session is ~40–50 KB of internal RAM, which is what
  an ESP32-S3 runs short of first. A bigger chip (a P4 with 32 MB of PSRAM)
  could take two.
- **Interpreters must outlive renders.** A deep-sleeping board tears every
  interpreter down after each render, and an awake one does when memory runs
  short (`settleIdleJsAppRuntimes`). Background code is for awake boards only.
  An interpreter with a background task would be kept like one holding a UI's
  handlers: dropped only for an allocation that failed, and logged.
- **Flash:** the JS half is ~1 KB of prelude bytecode and the Nim half a few
  KB. Build it behind a flag and read the firmware-size comment.
- A board rendered on the server, and the editor's preview, start a process
  per render: no background there.

## Next

1. Make it public: `fetch?` / `sleep?` in `appTypeDeclarations.ts` (optional:
   absent on an ESP32), a section in `docs/scene-guide.md` and
   `docs/js-apps-and-code-nodes.md`, the AI evals.
2. Decide what the editor's preview does with `background()`. It runs no
   background, so an app that fills itself in from there shows its empty
   state. It could run one round per render, or fetch through the browser.
3. `fetchImage` as a promise: decode on a worker into plain bytes, made into
   an `Image` on the runner thread.
4. Decide on scenes that are not shown. They keep running now. A layout could
   pause the scenes it does not draw, or a frame could cap what background
   work it takes.
5. A thread per scene (the windowed-mode follow-up), with each scene's
   background running on its own thread.
