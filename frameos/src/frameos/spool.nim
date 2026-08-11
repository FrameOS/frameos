## A string value that does not have to be in memory.
##
## The byte side of the value pipeline is a **fold, not a stream-through**: an
## ICS feed or an RSS document can be several MB on the way in, while what the
## graph actually wants out of it is a small JSON array. Materializing the
## input whole is what costs, and on a device with a few MB of usable PSRAM it
## is what fails.
##
## A `Spool` is the tier ladder for those bytes (docs/value-pipeline.md,
## principle 3):
##
## * **in memory** below a threshold — indistinguishable from today's `string`;
## * **backed by a file** above it, with only a window resident;
## * and `materialize` as the floor, which every consumer can always fall back
##   to and which raises rather than lying when the bytes will not fit.
##
## Consumers that can work incrementally iterate `lines` or `windows` and never
## hold more than the window. Consumers that cannot call `materialize` and
## behave exactly as they did before.

import std/[os, strutils]

const
  DefaultWindowBytes* = 8 * 1024
    ## Window size for incremental reads. Small enough to be nothing on a
    ## constrained device, large enough that a line-oriented parser is not
    ## doing a syscall per line.

type
  SpoolKind* = enum
    skMemory, skFile

  SpoolObj = object
    case kind: SpoolKind
    of skMemory:
      data: string
    of skFile:
      path: string
      size: int
      owned: bool ## delete the file when this spool dies

  Spool* = ref SpoolObj

proc `=destroy`(spool: SpoolObj) =
  ## A spilled body is a single-use temp file. Tying its lifetime to the value
  ## that refers to it means a scene that drops the value mid-render does not
  ## leave the file behind — boot sweeps exist for crashes, not for the normal
  ## path.
  if spool.kind == skFile and spool.owned and spool.path.len > 0:
    try:
      removeFile(spool.path)
    except CatchableError, OSError:
      discard

proc newMemorySpool*(data: sink string): Spool =
  Spool(kind: skMemory, data: data)

proc newFileSpool*(path: string, size: int, owned = true): Spool =
  ## `owned` transfers deletion to the spool. Pass false for a file the caller
  ## keeps (an asset on the SD card, say) rather than a spilled body.
  Spool(kind: skFile, path: path, size: size, owned: owned)

proc kind*(spool: Spool): SpoolKind =
  if spool.isNil: skMemory else: spool.kind

proc isFileBacked*(spool: Spool): bool =
  not spool.isNil and spool.kind == skFile

proc path*(spool: Spool): string =
  if spool.isFileBacked(): spool.path else: ""

proc len*(spool: Spool): int =
  if spool.isNil: return 0
  case spool.kind
  of skMemory: spool.data.len
  of skFile: spool.size

proc disown*(spool: Spool) =
  ## Give up responsibility for deleting the backing file. For handing the
  ## path to something that will consume and remove it itself.
  if spool.isFileBacked():
    spool.owned = false

iterator windows*(spool: Spool, windowBytes = DefaultWindowBytes): string =
  ## Successive chunks of the bytes. Never holds more than one window for a
  ## file-backed spool; yields the whole string in one go when in memory,
  ## since there is nothing to save by slicing it.
  if not spool.isNil:
    case spool.kind
    of skMemory:
      if spool.data.len > 0:
        yield spool.data
    of skFile:
      var file: File
      if not file.open(spool.path):
        raise newException(IOError, "Cannot open spooled body: " & spool.path)
      try:
        var buffer = newString(max(1, windowBytes))
        while true:
          let got = file.readBuffer(addr buffer[0], buffer.len)
          if got <= 0:
            break
          yield buffer[0 ..< got]
      finally:
        file.close()

iterator lines*(spool: Spool, windowBytes = DefaultWindowBytes): string =
  ## Line-oriented view, for the formats that are (ICS, RSS-ish text, CSV).
  ## Carries at most one window plus the partial line across reads, so a 4MB
  ## calendar costs the window, not 4MB.
  ##
  ## `\r\n` and `\n` both terminate a line; a trailing line without a newline
  ## is yielded too.
  var pending = ""
  for window in spool.windows(windowBytes):
    pending.add(window)
    var start = 0
    while true:
      let idx = pending.find('\n', start)
      if idx < 0:
        break
      var stop = idx
      if stop > start and pending[stop - 1] == '\r':
        dec stop
      yield pending[start ..< stop]
      start = idx + 1
    if start > 0:
      pending = pending[start .. ^1]
  if pending.len > 0:
    if pending.endsWith("\r"):
      pending.setLen(pending.len - 1)
    yield pending

proc startsWithBytes*(spool: Spool, prefix: string): bool =
  ## Prefix test that reads only as far as it has to. "Is this a URL rather
  ## than a document" is a question about the first few bytes, and answering it
  ## must not be the thing that pulls a 4MB body into memory.
  if spool.isNil or prefix.len == 0:
    return prefix.len == 0
  if spool.len < prefix.len:
    return false
  case spool.kind
  of skMemory:
    spool.data.startsWith(prefix)
  of skFile:
    for window in spool.windows(max(prefix.len, 64)):
      return window.len >= prefix.len and window[0 ..< prefix.len] == prefix
    false

proc materialize*(spool: Spool, maxBytes = 0): string =
  ## The tier floor: hand back the whole thing as a plain string.
  ##
  ## Raises past `maxBytes` rather than attempting the allocation, because the
  ## honest answer to "this does not fit" is an error a scene can show, not an
  ## OOM that takes the device with it.
  if spool.isNil:
    return ""
  if maxBytes > 0 and spool.len > maxBytes:
    raise newException(IOError,
      "Spooled value is " & $(spool.len div 1024) & "K, over the " &
      $(maxBytes div 1024) & "K limit for materializing it in memory")
  case spool.kind
  of skMemory:
    result = spool.data
  of skFile:
    result = newStringOfCap(spool.size)
    for window in spool.windows():
      result.add(window)

proc spoolScratchDir*(preferred = ""): string =
  ## Where a file-backed spool lives. `preferred` is the caller's storage of
  ## choice — the SD card's `.cache` on embedded — and is used only if it can
  ## actually be created; otherwise the platform temp dir, which on a host is
  ## always there and on embedded is the internal filesystem.
  if preferred.len > 0:
    try:
      createDir(preferred)
      return preferred
    except CatchableError, OSError:
      discard
  let fallback = getTempDir() / "frameos-spool"
  try:
    createDir(fallback)
    return fallback
  except CatchableError, OSError:
    discard
  ""

type SpoolWriter* = object
  ## Accumulates bytes and decides, as they arrive, whether they still fit in
  ## memory. Nothing touches storage until the threshold is crossed, so the
  ## common small response never pays for a file.
  buffer: string
  file: File
  path: string
  written: int
  threshold: int
  dir: string
  opened: bool
  probed: bool ## a failed storage probe is not retried for every later chunk

proc initSpoolWriter*(thresholdBytes: int, dir = ""): SpoolWriter =
  SpoolWriter(threshold: max(0, thresholdBytes), dir: dir)

proc spillNow(writer: var SpoolWriter, name: string): bool {.discardable.} =
  ## Tries to move to the storage tier. Returns false when there is nowhere to
  ## write — no SD card, a read-only or full filesystem — and the writer just
  ## keeps buffering in memory.
  ##
  ## Degrading rather than raising is the point of principle 3: the storage
  ## tier is a preference, and the tier below it is exactly what this code did
  ## before spooling existed. A frame with no card must not start failing
  ## downloads that used to work.
  if writer.opened:
    return true
  if writer.probed:
    return false
  writer.probed = true
  let dir = spoolScratchDir(writer.dir)
  if dir.len == 0:
    return false
  let path = dir / name
  if not writer.file.open(path, fmWrite):
    return false
  writer.path = path
  writer.opened = true
  if writer.buffer.len > 0:
    writer.file.write(writer.buffer)
    writer.buffer.setLen(0)
  true

proc add*(writer: var SpoolWriter, data: openArray[char], name = "body.tmp") =
  if data.len == 0:
    return
  writer.written += data.len
  if not writer.opened and writer.threshold > 0 and writer.written > writer.threshold:
    discard writer.spillNow(name)
  if writer.opened:
    discard writer.file.writeBuffer(unsafeAddr data[0], data.len)
  else:
    let start = writer.buffer.len
    writer.buffer.setLen(start + data.len)
    copyMem(addr writer.buffer[start], unsafeAddr data[0], data.len)

proc add*(writer: var SpoolWriter, data: string, name = "body.tmp") =
  writer.add(data.toOpenArray(0, data.high), name)

proc len*(writer: SpoolWriter): int = writer.written

proc spilled*(writer: SpoolWriter): bool = writer.path.len > 0
  ## Whether the storage tier was actually reached — false either because the
  ## body stayed under the threshold, or because the probe failed and it fell
  ## back to memory. Reads the same before and after `finish`, which closes the
  ## file but does not un-make the decision.

proc finish*(writer: var SpoolWriter): Spool =
  if writer.opened:
    writer.file.close()
    writer.opened = false
    newFileSpool(writer.path, writer.written)
  else:
    newMemorySpool(move(writer.buffer))
