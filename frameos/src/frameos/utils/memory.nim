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
    # C-side HTTP/TLS buffers that also live in PSRAM.
    EmbeddedReserveBytes = 1_536_000
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
    except CatchableError, IOError, OSError:
      discard
    0

when defined(testing):
  # Lets tests simulate a memory-constrained device (e.g. ESP32 PSRAM
  # headroom) on a development host. 0 disables the override.
  var availableRenderBytesOverride* = 0

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
  elif defined(linux) and not defined(frameosWasm):
    let available = memAvailableBytes()
    if available <= 0:
      0
    else:
      max(0, available - LinuxReserveBytes)
  else:
    # Development hosts: plenty of memory, keep decodes bounded anyway.
    1024 * 1024 * 1024

proc refreshDecodeBudget*() =
  ## Updates pixie's per-decode budget from live memory. Decode
  ## intermediates may take roughly half of what is available, leaving the
  ## other half for the decoded output and the canvas.
  let available = availableRenderBytes()
  if available > 0:
    setDecodeBudgetBytes(available div 2)

proc ensureRenderAllocation*(bytes: int64, what: string) =
  ## Raises a catchable error when an allocation plan clearly exceeds the
  ## memory that is still available for rendering.
  let available = availableRenderBytes()
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
