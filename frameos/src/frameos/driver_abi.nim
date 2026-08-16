## The C ABI between the FrameOS host binary and a driver `.so`.
##
## THE RULE: nothing that crosses this boundary may be a Nim `ref` that the
## other side allocated, unless the receiver treats it as strictly borrowed.
##
## Every shared library links its own copy of the ORC runtime. A ref allocated
## by one runtime and incref'd/decref'd by the other is not merely leaked — if
## ORC considers the type cyclic, the non-final decref registers the object in
## the *caller's* cycle-root list while the owner's final decref tries to
## unregister it from a different list, and the process dies inside
## `unregisterCycle` with a stack trace that names nothing but `runner.nim`.
## That is what turned v2026.8.17-.23 into a crash loop on every
## HDMI/HyperPixel/Inky frame: a pixie fork added `root: Image`, which made
## `Image` cyclic overnight.
##
## So the payload types here are C types, not Nim ones:
##
## * Log and event payloads travel as `cstring` JSON — the driver serialises,
##   the host parses. A `JsonNode` is cyclic under ORC and used to cross this
##   boundary live, surviving only because the host happened never to keep the
##   ref. The strings are borrowed for the duration of the call and nothing
##   else: the caller owns the buffer and the callee must copy before it
##   returns.
## * `DriverContext` and `Image` still cross as raw `pointer`s, because they
##   carry too much structure to serialise per render. The receiving side must
##   bind them with `{.cursor.}` (a non-owning view: no incref, no destructor)
##   and must never store or copy the ref into anything that outlives the
##   call. `Image` is `{.acyclic.}` in the FrameOS pixie fork and the
##   driver-context types are `{.acyclic.}` here, so even a slip is a balanced
##   refcount rather than a cross-runtime cycle registration.

type
  ## JSON text, borrowed for the duration of the call.
  HostLogProc* = proc(event: cstring) {.cdecl, gcsafe.}
  ## `sceneId` is nil for "the current scene"; `payload` is JSON text.
  HostSendEventProc* = proc(sceneId: cstring, event: cstring,
                            payload: cstring) {.cdecl, gcsafe.}
  DriverSetupProc* = proc(driverContext: pointer): bool {.cdecl.}
  DriverInitProc* = proc(frameOS: pointer, logHook: HostLogProc, sendEventHook: HostSendEventProc): pointer {.cdecl.}
  DriverRenderProc* = proc(driver: pointer, image: pointer) {.cdecl.}
  ## Driver → host, the only value that travels back up: seconds until this
  ## driver would like another render pass, negative for "nothing to ask for"
  ## (`frameos/driver_render_hint`). A `cdouble` and not a struct on purpose —
  ## it is the whole return channel, and it copies rather than shares.
  ##
  ## OPTIONAL symbol. A `.so` built before this existed does not export it, and
  ## the host must treat a missing `frameos_driver_earlier_render_seconds` as
  ## "no request" rather than as a broken driver: release binaries and their
  ## driver libraries are versioned together, but a hand-copied `.so` is not.
  DriverEarlierRenderProc* = proc(driver: pointer): cdouble {.cdecl.}
  DriverToPngProc* = proc(driver: pointer, rotate: cint, flip: cstring, length: ptr int): pointer {.cdecl.}
  DriverActionProc* = proc(driver: pointer) {.cdecl.}
