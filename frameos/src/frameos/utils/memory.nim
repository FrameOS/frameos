## Runtime memory awareness for the render pipeline.
##
## `availableRenderBytes` estimates how much memory a render-path allocation
## can still take (live PSRAM headroom on embedded, MemAvailable on Linux),
## and `refreshDecodeBudget` feeds a share of that into pixie's per-decode
## budget so oversized decodes fail with catchable errors instead of
## exhausting the device.

import pixie/decodebudget

export decodebudget

when defined(frameosEmbedded):
  proc fos_psram_free_bytes(): csize_t {.importc, cdecl.}
  proc fos_psram_largest_free_block(): csize_t {.importc, cdecl.}

  const
    # Keep headroom for the packed framebuffer, preview snapshot and the
    # C-side HTTP/TLS buffers that also live in PSRAM. The same 1.5 MiB as
    # FOS_RENDER_PSRAM_RESERVE (frameos_display.c) and
    # EMBEDDED_RENDER_PSRAM_RESERVE_BYTES (backend): it was 1_536_000 here,
    # a decimal-MB slip 36 KB short of the other two.
    EmbeddedReserveBytes = 1536 * 1024
elif defined(frameosWasm):
  # The preview's simulated device ceiling (tools/wasm/fos_wasm_mem.c). With
  # no limit set these report 0 and the host defaults below apply, so an
  # ordinary browser preview behaves exactly as it always did.
  proc fosWasmMemoryLimit(): cuint {.
    importc: "frameos_wasm_memory_limit", header: "<fos_wasm_mem.h>", cdecl.}
  proc fosWasmMemoryUsed(): cuint {.
    importc: "frameos_wasm_memory_used", header: "<fos_wasm_mem.h>", cdecl.}
  proc fosWasmRenderHeadroom(): cuint {.
    importc: "frameos_wasm_memory_render_headroom", header: "<fos_wasm_mem.h>",
    cdecl.}

  proc simulatedRenderBytes(): int =
    ## Bytes the render pipeline may still plan for; 0 = no ceiling set.
    if fosWasmMemoryLimit().int <= 0:
      return 0
    max(0, fosWasmRenderHeadroom().int)

elif defined(linux) and not defined(frameosWasm):
  import std/[strutils, os]

  const
    # Leave room for the OS page cache and the non-render parts of frameos.
    LinuxReserveBytes = 48 * 1024 * 1024

  proc memAvailableBytes(): int =
    try:
      for line in lines("/proc/meminfo"):
        if line.startsWith("MemAvailable:"):
          let parts = line.splitWhitespace()
          if parts.len >= 2:
            return parseInt(parts[1]) * 1024
    except CatchableError:
      discard
    0

when defined(testing):
  # Lets tests simulate a memory-constrained device (e.g. ESP32 PSRAM
  # headroom) on a development host. 0 disables the override.
  var availableRenderBytesOverride* = 0

when defined(frameosWasm) or defined(testing):
  var simulatingEmbedded = false

  proc setSimulatedEmbedded*(enabled: bool) =
    ## The preview runs as an ESP32 (frameos_wasm_set_embedded: the device
    ## picker's ESP32 presets, or a preview of an ESP32 frame); tests use it
    ## to check both behaviours on one host.
    simulatingEmbedded = enabled

proc runsAsEmbedded*(): bool {.inline.} =
  ## An ESP32-class runtime: the firmware always, the editor's preview while
  ## it simulates one. What changes with it: a JS app's interpreter lasts one
  ## render (single_scene_host.renderScene), `app.frame.embedded` is true,
  ## and a download decodes into the canvas the way the device's does
  ## (utils/image.nim). Everything else keeps an interpreter for the
  ## scene's life, as a Pi does.
  when defined(frameosEmbedded):
    true
  elif defined(frameosWasm) or defined(testing):
    simulatingEmbedded
  else:
    false

when defined(memProbe):
  proc c_printf(fmt: cstring) {.importc: "printf", varargs, cdecl.}
  when defined(frameosEmbedded):
    proc esp_timer_get_time(): int64 {.importc, cdecl.}
  proc memProbe*(where: string) =
    when defined(frameosEmbedded):
      let free = fos_psram_free_bytes().int
      let largest = fos_psram_largest_free_block().int
      # Timestamped: the same trace then answers "where did the memory go" and
      # "where did the seconds go", which are usually the same question.
      c_printf("MEMPROBE %8dms %s psramFree=%d largest=%d\n",
        (esp_timer_get_time() div 1000).cint, where.cstring, free.cint, largest.cint)

proc renderMemoryInUse*(): tuple[known: bool, bytes: int] =
  ## A number that goes UP as memory is consumed, for the per-node memory
  ## profile the interpreter logs in debug mode. **Only differences between two
  ## samples are meaningful**: on embedded there is no total-PSRAM figure to
  ## subtract from, so this is free space negated; on Linux it is the process
  ## RSS. Hosts without a cheap probe report `known = false`.
  when defined(frameosEmbedded):
    (true, -fos_psram_free_bytes().int)
  elif defined(frameosWasm):
    (fosWasmMemoryLimit().int > 0, fosWasmMemoryUsed().int)
  elif defined(linux) and not defined(frameosWasm):
    try:
      # /proc/self/statm: "size resident shared ..." in pages.
      let fields = readFile("/proc/self/statm").splitWhitespace()
      if fields.len >= 2:
        # 4K pages on every Linux frame target we ship (armv6/armhf/arm64/amd64).
        return (true, parseInt(fields[1]) * 4096)
    except CatchableError:
      discard
    (false, 0)
  else:
    (false, 0)

proc availableRenderBytes*(): int =
  ## Best-effort estimate of memory currently available for image-sized
  ## render allocations. 0 means "unknown"; callers treat that as unlimited.
  when defined(testing):
    if availableRenderBytesOverride > 0:
      return availableRenderBytesOverride
  when defined(frameosEmbedded):
    let largest = fos_psram_largest_free_block().int
    let free = fos_psram_free_bytes().int
    # Image buffers need one contiguous block; fragmented PSRAM can have
    # plenty free but no block large enough.
    max(0, min(largest, free - EmbeddedReserveBytes))
  elif defined(frameosWasm):
    let simulated = simulatedRenderBytes()
    if simulated > 0: simulated else: 1024 * 1024 * 1024
  elif defined(linux) and not defined(frameosWasm):
    let available = memAvailableBytes()
    if available <= 0:
      0
    else:
      max(0, available - LinuxReserveBytes)
  else:
    # Development hosts: plenty of memory, keep decodes bounded anyway.
    1024 * 1024 * 1024

proc availableRenderHeadroomBytes*(): int =
  ## Total free render memory minus the reserve, ignoring fragmentation —
  ## the answer to "can these allocations coexist", where the pieces need
  ## not be contiguous. `availableRenderBytes` stays the answer for a single
  ## image-sized allocation; measured on the 7.3" bench frame, the largest
  ## contiguous block sits near 1.7MB while over 5MB is free, and a headroom
  ## question asked against the block answer refuses everything.
  when defined(testing):
    if availableRenderBytesOverride > 0:
      return availableRenderBytesOverride
  when defined(frameosEmbedded):
    max(0, fos_psram_free_bytes().int - EmbeddedReserveBytes)
  elif defined(frameosWasm):
    let simulated = simulatedRenderBytes()
    if simulated > 0: simulated else: 1024 * 1024 * 1024
  elif defined(linux) and not defined(frameosWasm):
    let available = memAvailableBytes()
    if available <= 0:
      0
    else:
      max(0, available - LinuxReserveBytes)
  else:
    # Development hosts: plenty of memory, keep decodes bounded anyway.
    1024 * 1024 * 1024

proc decodeHeadroomBytes(): int =
  ## The headroom a decoder may plan for. On the device that is free PSRAM
  ## less EmbeddedReserveBytes, which also covers what a decode allocates
  ## outside its plan. The preview's ESP32 presets leave that reserve out of
  ## the ceiling, because the planner then declined to fuse a panel the
  ## device fuses (frameos/wasm/src/devices.ts), so it is kept here, for the
  ## decoders alone. Without it a 1920 px photo on a 13.3" panel planned
  ## right up to the ceiling and the next allocation was refused, where the
  ## device plans 1.5 MB smaller and renders it.
  result = availableRenderHeadroomBytes()
  when defined(frameosWasm):
    const SimulatedDecodeReserveBytes = 1536 * 1024
    if runsAsEmbedded() and simulatedRenderBytes() > 0:
      result = max(0, result - SimulatedDecodeReserveBytes)

const
  RenderMemoryShortBytes* = 2 * 1024 * 1024
    ## Render memory under which a decode lets go of what a render can
    ## rebuild (renderMemoryReleaseHook), and under which another JS node
    ## about to be built evicts the idle ones (js_runtime/app_runtime.nim).
  KeepInterpretersBytes* = 1024 * 1024
    ## The headroom a frame keeps its idle JS interpreters down to between
    ## renders that decode nothing (keepIdleInterpreters). Such a render
    ## allocates a few hundred KB at most (a UI's layout, its parse, pixie's
    ## paint strips), on top of the reserve that headroom already leaves.

var
  renderMemoryReleaseHook*: proc(): bool {.nimcall, raises: [].}
    ## Lets go of what a render can rebuild: the idle JS interpreters an ESP32
    ## that does not deep-sleep keeps between renders (js_runtime/app_runtime.nim).
    ## Whether anything went. Called for a decode when render memory is short,
    ## so that a kept interpreter never costs a photo its resolution: when free
    ## memory is (refreshDecodeBudget) and when the largest free block is (the
    ## first time a decode asks for it); and by a fill pixie refused
    ## (releaseRenderMemory). Not before every render: a JSX UI just over the
    ## line lost its interpreter, its memo and its laid-out tree every frame.
  decodedSinceSettle: bool
    ## A decode ran since the interpreters were last settled.

proc releaseRenderMemoryIfShort() =
  if not renderMemoryReleaseHook.isNil:
    let headroom = availableRenderHeadroomBytes()
    if headroom > 0 and headroom < RenderMemoryShortBytes:
      discard renderMemoryReleaseHook()

proc releaseRenderMemory*(): bool =
  ## Lets go of what a render can rebuild, whatever the headroom: a fill or a
  ## decode was just refused. Whether anything went (then try it again).
  not renderMemoryReleaseHook.isNil and renderMemoryReleaseHook()

proc keepIdleInterpreters*(): bool =
  ## Whether the idle JS interpreters may stay for the next render: while the
  ## headroom holds RenderMemoryShortBytes after a render that decoded
  ## something (the next may decode again, at full resolution), and
  ## KeepInterpretersBytes after one that decoded nothing. A decode releases
  ## them first when it is short either way. Settles the decode flag.
  let headroom = availableRenderHeadroomBytes()
  let floor = if decodedSinceSettle: RenderMemoryShortBytes else: KeepInterpretersBytes
  decodedSinceSettle = false
  headroom <= 0 or headroom >= floor

when defined(frameosEmbedded):
  proc largestDecodeBlock(): int {.nimcall, raises: [].} =
    ## The contiguous decode budget, measured when a decode first asks for it.
    result = fos_psram_largest_free_block().int
    if result < RenderMemoryShortBytes and not renderMemoryReleaseHook.isNil and
        renderMemoryReleaseHook():
      result = fos_psram_largest_free_block().int

proc refreshDecodeContiguousBudget() =
  ## The headroom budget answers whether a decode's buffers can coexist;
  ## this one bounds the largest SINGLE buffer by the largest free block.
  ## Both are needed: the 13.3E6 passed a 5.8MB streamed-JPEG plan with
  ## 8.6MB free, then died allocating its 3.75MB luma channel in a heap
  ## whose largest block had fragmented below that (2026-08-23). With the
  ## limit set, pixie clamps the sampling resolution to what fits instead.
  ## On the device the block is measured when a decode first asks: finding
  ## it walks the whole PSRAM heap, half a millisecond, and an animation
  ## refreshes the budget several times a frame to decode nothing. Hosts
  ## report "plenty" and effectively leave it unlimited.
  when defined(frameosEmbedded):
    setDecodeContiguousBudgetProvider(largestDecodeBlock)
  else:
    setDecodeContiguousBudgetBytes(0)

proc refreshDecodeBudget*(forDecode = true) =
  ## Updates pixie's per-decode budget from live memory. Decode
  ## intermediates may take roughly half of what is available, leaving the
  ## other half for the decoded output and the canvas. The intermediates are
  ## many separate buffers (channel bands, accumulator rows, block streams),
  ## so this is the headroom question — can the allocations coexist — not
  ## the contiguous-block one: with the render canvas allocated the 13.3E6
  ## sits at ~5.2MB free with a ~2.7MB largest block, and halving the block
  ## answer refused a 1.4MB streamed-JPEG working set the heap held with
  ## room to spare (spill bench, 2026-08). Single image-sized buffers keep
  ## checking availableRenderBytes at their own call sites.
  ##
  ## `forDecode`: an image is about to be decoded, so kept interpreters go
  ## first when memory is short. A render's start and an SVG frame pass
  ## false: they decode nothing of their own.
  if forDecode:
    decodedSinceSettle = true
    releaseRenderMemoryIfShort()
  let available = decodeHeadroomBytes()
  if available > 0:
    setDecodeBudgetBytes(available div 2)
  refreshDecodeContiguousBudget()

proc refreshDecodeBudgetInto*(forDecode = true) =
  ## refreshDecodeBudget for decodes that stream into an existing target
  ## (readImageIntoTarget, the spilled/chunked download paths): the decoded
  ## output already exists as the canvas, so no second half needs reserving
  ## and the whole headroom may hold the decode plan. The emergency reserve
  ## sits outside the headroom either way. On the 13.3E6 the halved budget
  ## refused a spilled 4.4MB JPEG whose ~1.8MB plan fit the heap twice over.
  if forDecode:
    decodedSinceSettle = true
    releaseRenderMemoryIfShort()
  let available = decodeHeadroomBytes()
  if available > 0:
    setDecodeBudgetBytes(available)
  refreshDecodeContiguousBudget()

proc ensureRenderAllocation*(bytes: int64, what: string) =
  ## Raises a catchable error when an allocation plan clearly exceeds the
  ## memory that is still available for rendering, kept interpreters let go
  ## first (an image's allocation comes before them, as a decode's does).
  var available = availableRenderBytes()
  if available > 0 and bytes > available.int64 and releaseRenderMemory():
    available = availableRenderBytes()
  if available > 0 and bytes > available.int64:
    raise newException(CatchableError,
      what & " needs " & $(bytes div 1024) & "K but only " &
      $(available div 1024) & "K is available for rendering")

proc setupRenderMemory*() =
  ## Configure the allocator once at startup so image-sized buffers return
  ## to the OS when freed. glibc's dynamic mmap threshold grows to 32MB
  ## after the first large frees, after which multi-MB decode buffers come
  ## from the sbrk arena and stay resident forever; pinning the threshold
  ## keeps them mmap'd (munmap on free) at negligible syscall cost.
  when defined(linux) and not defined(frameosEmbedded) and not defined(frameosWasm):
    proc mallopt(param: cint, value: cint): cint {.importc, header: "<malloc.h>".}
    const M_TRIM_THRESHOLD = cint(-1)
    const M_MMAP_THRESHOLD = cint(-3)
    const M_ARENA_MAX = cint(-8)
    discard mallopt(M_MMAP_THRESHOLD, cint(512 * 1024))
    discard mallopt(M_TRIM_THRESHOLD, cint(1024 * 1024))
    # Each glibc thread arena can retain up to 64MB of churn; the render,
    # server and logger threads each got one. Two arenas keep contention
    # low while capping retention on 512MB-class frames.
    discard mallopt(M_ARENA_MAX, cint(2))

proc reclaimRenderMemory*() =
  ## Large image decodes can leave sizeable temporary allocations behind.
  ## Collect unreachable Nim objects first, then ask glibc malloc to return
  ## free heap pages to the OS on Linux frame targets.
  GC_fullCollect()

  when defined(linux) and not defined(frameosEmbedded) and not defined(frameosWasm):
    proc malloc_trim(pad: csize_t): cint {.importc: "malloc_trim", header: "<malloc.h>".}
    discard malloc_trim(0.csize_t)
