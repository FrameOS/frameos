proc reclaimRenderMemory*() =
  ## Large image decodes can leave sizeable temporary allocations behind.
  ## Collect unreachable Nim objects first, then ask glibc malloc to return
  ## free heap pages to the OS on Linux frame targets.
  GC_fullCollect()

  when defined(linux):
    proc malloc_trim(pad: csize_t): cint {.importc: "malloc_trim", header: "<malloc.h>".}
    discard malloc_trim(0.csize_t)
