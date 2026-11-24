## A video playing on a Linux frame (docs/video.md).
##
## Three parties, and no ref between them:
## - ffmpeg, a child process, decodes the source and scales it to the box the
##   video is drawn in, in the canvas's pixel format, at a constant rate, onto
##   a pipe (video/args.nim). Its threads are the other cores' work.
## - The reader, a thread of the player's own, probes the source, starts
##   ffmpeg (again after a seek, a new size, a loop), and reads its frames off
##   the pipe into a ring of a few. It blocks when the ring is full, and so
##   does ffmpeg: a video nobody looks at costs no CPU, and after IdleSeconds
##   its ffmpeg is stopped and its ring let go.
## - The render thread takes the frame that is due into the player's image
##   (one copy), asks for a new launch when the size or place changed, and
##   says when the next frame is due (`nextFrameIn`): the scene's next render.
##
## What they share is `Shared` (allocShared0): numbers, flags and the ring's
## bytes, under its lock. The source's strings travel to the thread as its
## argument. A player that is closed is joined only once its thread said it
## exited (`reapClosedPlayers`): the render thread never waits for ffmpeg.

import std/[locks, math, monotimes, os, osproc, posix, streams, strutils]
import pixie
import frameos/utils/process
import frameos/utils/canvas_log
import frameos/utils/redacted_url
import frameos/video/args
import frameos/video/planes

export args, planes

const
  MaxSlots = 8
  MinSlots = 2
  RingBudgetBytes = 32 * 1024 * 1024
    ## What a player's ring may hold: 8 frames of a 1280x720 RGBA box, 3 of a
    ## 1920x1080 one.
  PollMs = 50
  IdleSeconds* = 6.0
    ## A player whose frames nobody took for this long (a paused video, a
    ## scene switched away from) stops its ffmpeg and lets its ring go; the
    ## next take starts it again where it was.
  GapSeconds = 1.0
    ## A render this much later than the last one that drew the video was not
    ## a late frame but a time it did not show (a list over it, another
    ## scene): the clock waits, as for a pause, and nothing is skipped.
  ResyncSeconds = 1.5
    ## Frames this far behind the clock (a source the Pi cannot decode in real
    ## time) move the clock to them, so the time shown stays honest.
  MessageKeep = 400
  ProbeTimeoutMs = 15_000
  FileProbeTimeoutMs = 8_000
  SlowAfterFrames = 12
    ## Frames a launch makes before its pace says the decoder is behind.
  SlowPace = 1.2
    ## Behind: a frame takes this many frame times to make (makeSeconds).
  DecoderKeep = 32
  PlaneBuffers = 3
    ## A plane's frames in flight: one on the glass, one the reader fills, one
    ## spare for a vblank late.
  PlaneCopySeconds* = 1.0
    ## A video on a plane is copied into the canvas this often, and when it
    ## pauses or ends: what a snapshot or `GET /image` shows of it, and what
    ## the canvas holds the moment the plane goes. Also how often the scene
    ## renders for it: nothing of the video is drawn by a render.

type
  Shared = object
    lock: Lock
    cond: Cond
    # Asked for by the render thread.
    stop: bool
    gen: int               ## one more for every launch the render thread asks for
    width, height: int
    fit: VideoFit
    pixels: VideoPixels
    startAt: float
    loop: bool
    maxFps: float
    lastTake: float        ## monotonic seconds of the render thread's last take
    # Told by the reader.
    probed: bool
    probeOk: bool
    duration: float
    srcWidth, srcHeight: int
    srcFps: float
    fps: float             ## the running launch's frames a second
    runGen: int            ## the launch the ring's frames are from
    ended: bool            ## its ffmpeg ended and every frame it made is in the ring
    failed: bool           ## ... without a frame
    retrying: bool         ## failed, and opened again in retrySeconds (loop)
    idle: bool             ## ffmpeg stopped for want of a take (IdleSeconds)
    message: array[MessageKeep, char]
    messageLen: int
    exited: bool
    arrivedAt: float       ## monotonic seconds the run's last frame came in (0: none yet)
    makeSeconds: float     ## how long ffmpeg takes to make a frame once there is room (an average)
    decoder: array[DecoderKeep, char] ## what decodes the running launch (decodeName)
    decoderLen: int
    fast: bool             ## ... with a slow decoder's shortcuts (VideoDecode.fast)
    fallbacks: int         ## hardware launches that gave way to ffmpeg's own; the last one's:
    fallbackFrom: array[DecoderKeep, char] ## ... decoder
    fallbackFromLen: int
    fallbackWhy: array[MessageKeep, char]  ## ... ffmpeg's reason
    fallbackWhyLen: int
    fallbackBusy: bool     ## ... the hardware busy (hardwareBusy), so it stays on
    # A display plane (video/planes.nim). Asked for by the render thread:
    planeWanted: bool      ## the next launch shows its frames on `plane`
    plane: int
    paused: bool           ## the render thread's pause, which a plane's reader keeps
    # Told by a plane's reader:
    planeLaunch: bool      ## the running launch (runGen) is a plane's
    planeFailed: bool      ## the plane would not show this video: the canvas draws it
    planeShown: bool       ## a frame is on the glass, `shownBuf`
    shownBuf: PlaneBuffer  ## ... its memory, which the render thread copies into the canvas
    shownGen: int          ## ... its launch, number and time in the video
    shownSeq: int64
    shownMedia: float
    shownCount: int        ## frames a plane showed so far, every launch
    # The ring: `count` frames from `head`, oldest first, each `frameWidth` x
    # `frameHeight` (frameSize: a contained picture's own size, else the box).
    buf: ptr UncheckedArray[byte]
    frameBytes: int
    frameWidth, frameHeight: int
    slots: int
    head, count: int
    slotSeq: array[MaxSlots, int64]   ## the frame's number since its launch began (loops go on counting)
    slotMedia: array[MaxSlots, float] ## its time in the video, seconds

  ReaderArg = object
    shared: ptr Shared
    source: VideoSource
    shownSource: string    ## the source as an error may name it (redacted)
    threads: int

  VideoPlayer* = ref object
    shared: ptr Shared
    thread: Thread[ReaderArg]
    running: bool
    image*: Image          ## the frame on show, at the size drawn; nil before the first
    placeholder*: Image    ## what an `<img>` draws until then (black, the source's shape)
    gen: int
    width, height: int
    fit: VideoFit
    pixels: VideoPixels
    paused: bool
    loop: bool
    maxFps: float
    # The clock: frame `clockSeq` of launch `clockGen` is due at `clockStart`.
    clockGen: int
    clockSeq: int64
    clockStart: float
    clockFps: float
    shownGen: int
    shownSeq: int64
    shownMedia: float
    hasFrame: bool
    framed: Rect           ## where in `image` the last frame went (a contained picture's middle)
    planeSlot: int         ## its display plane (video/planes.nim), -1 for none
    planeMode: bool        ## its launch shows frames on the plane
    planeFailed: bool      ## the plane would not show it: the canvas, from now on
    copiedCount: int       ## the plane frame last copied into `image` (shownCount)
    copiedAt: float
    lastDraw: float
    pausedAt: float        ## media time it was paused at
    late: float            ## how much later than asked renders come (an average)
    askedAt, askedWait: float
    lastUse*: float        ## monotonic seconds the app last asked for it
    endTold: int           ## the launch whose end a render was asked for
    error: string

  VideoPlaneSpot* = object
    ## Where a video's `<img>` is on the panel when it can be a display plane
    ## (js_video.nim): a clean hole of the panel's own canvas.
    ok*: bool
    x*, y*: int

  PlaneRun = object
    ## A reader's plane buffers (video/planes.nim), kept across its launches
    ## of one size: a seek's launch shows its first frame where the last
    ## one's stayed, nothing between them.
    bufs: array[PlaneBuffers, PlaneBuffer]
    count: int
    width, height: int
    shown: int             ## the one on the glass, -1 for none

var closing {.threadvar.}: seq[VideoPlayer]
var retrySeconds* = 10.0
  ## A source that loops (a camera, a stream) and failed is opened again this
  ## often, its error shown meanwhile. A plain value the readers read; tests
  ## shorten it.
var hardwareFirstFrameSeconds* = 20.0
  ## A hardware launch with no frame by then is stopped and gives way to
  ## ffmpeg's own: a VideoCore decoder that got some of its buffers and not
  ## the rest waited on its device for ever (a Pi Zero W, four 1080p videos
  ## at once, 2026-11-24). A file's exact start decodes up to a keyframe
  ## interval first, 6 s of a 1080p one there. A plain value; tests shorten it.

# What the machine decodes in hardware, read once, and the codecs whose
# hardware decoder failed here: values every reader reads under `capsLock`
# (copies handed out), never a ref.
var capsLock: Lock
var capsRead: bool
var caps: DecodeCaps
var hwFailedCodecs: seq[string]
initLock(capsLock)

proc nowSeconds*(): float =
  getMonoTime().ticks.float / 1e9

proc ffmpegCommand*(): string =
  ## FFMPEG_PATH for tests and odd installs; else ffmpeg on the PATH.
  result = getEnv("FRAMEOS_FFMPEG")
  if result.len == 0:
    result = "ffmpeg"

proc ffprobeCommand*(): string =
  result = getEnv("FRAMEOS_FFPROBE")
  if result.len == 0:
    result = "ffprobe"

proc videoAvailable*(): bool =
  ## Whether this frame has an ffmpeg to play with (Buildroot images do; a
  ## Raspberry Pi OS frame after `apt install ffmpeg`).
  let command = ffmpegCommand()
  if command.contains('/'): fileExists(command) else: findExe(command).len > 0

# ------------------------------------------------------- hardware decoding

proc ffmpegSays(args: openArray[string]): string =
  try:
    let run = runProcessPiped(ffmpegCommand(), @args, timeoutMs = 5000, maxOutputBytes = 256 * 1024,
      maxErrorBytes = 4096)
    if run.exitCode == 0: run.output else: ""
  except CatchableError:
    ""

proc ffmpegRuns(args: openArray[string]): bool =
  try:
    runProcessPiped(ffmpegCommand(), @args, timeoutMs = 5000, maxOutputBytes = 4096,
      maxErrorBytes = 4096).exitCode == 0
  except CatchableError:
    false

proc v4l2DecoderDevice(): bool =
  ## A V4L2 mem2mem decoder (a Pi 0 to 4's VideoCore: "bcm2835-codec-decode",
  ## /dev/video10). ffmpeg finds which device takes the codec itself.
  try:
    for dir in walkDirs("/sys/class/video4linux/video*"):
      let name = readFile(dir / "name").strip().toLowerAscii()
      if "decode" in name or "vdec" in name:
        return true
  except CatchableError:
    discard

proc vaDriverThere(): bool =
  ## A VA-API driver for the render node (Intel's iHD or i965, AMD's radeonsi):
  ## without one `-hwaccel vaapi` fails, as it would on a Pi's vc4.
  if getEnv("LIBVA_DRIVERS_PATH").len > 0:
    return true
  for dir in ["/usr/lib/x86_64-linux-gnu/dri", "/usr/lib/aarch64-linux-gnu/dri", "/usr/lib/dri",
      "/usr/lib64/dri", "/usr/local/lib/dri"]:
    try:
      for _ in walkFiles(dir / "*_drv_video.so"):
        return true
    except CatchableError:
      discard

proc readDecodeCaps(): DecodeCaps =
  if getEnv("FRAMEOS_VIDEO_HARDWARE") == "0":
    return
  if v4l2DecoderDevice():
    result.v4l2Decoders = parseDecoderList(ffmpegSays(["-hide_banner", "-decoders"]))
  var renderNode = false
  try:
    for _ in walkFiles("/dev/dri/renderD*"):
      renderNode = true
      break
  except CatchableError:
    discard
  if renderNode and vaDriverThere() and "vaapi" in parseHwaccels(ffmpegSays(["-hide_banner", "-hwaccels"])):
    # A driver on disk is not one for this GPU (Mesa's beside an NVIDIA
    # card's): ffmpeg opens the device once, as a decode would.
    result.vaapi = ffmpegRuns(["-hide_banner", "-loglevel", "error", "-nostdin", "-init_hw_device",
      "vaapi=va", "-f", "lavfi", "-i", "color=size=16x16:duration=0.04", "-frames:v", "1", "-f", "null", "-"])

proc decodeCaps*(): DecodeCaps =
  ## What this machine decodes in hardware (docs/video.md "Hardware"), read on
  ## first use by a reader thread. A copy: values only, under the lock.
  {.cast(gcsafe).}:
    withLock capsLock:
      if capsRead:
        return caps
    let read = readDecodeCaps()
    withLock capsLock:
      if not capsRead:
        caps = read
        capsRead = true
      result = caps

proc setDecodeCapsForTest*(value: DecodeCaps) =
  {.cast(gcsafe).}:
    withLock capsLock:
      caps = value
      capsRead = true
      hwFailedCodecs.setLen(0)

proc hardwareFailed*(codec: string): bool =
  ## Its hardware decoder failed here while ffmpeg's own played it.
  {.cast(gcsafe).}:
    withLock capsLock:
      result = codec in hwFailedCodecs

proc markHardwareFailed(codec: string) =
  {.cast(gcsafe).}:
    withLock capsLock:
      if codec notin hwFailedCodecs:
        hwFailedCodecs.add codec

var startFastForTest* = false
  ## Tests: a player starts with the slow decoder's shortcuts, as on one core.

proc slowMachine(): bool =
  ## One core (a Pi Zero, a Pi 1): the shortcuts from the first frame, not
  ## after a relaunch that costs it seconds.
  countProcessors() <= 1 or startFastForTest

# ------------------------------------------------------------- the reader

proc setMessage(s: ptr Shared, text: string) =
  ## Under the lock.
  let n = min(text.len, MessageKeep)
  for i in 0 ..< n:
    s.message[i] = text[i]
  s.messageLen = n

proc messageOf(s: ptr Shared): string =
  ## Under the lock.
  result = newString(s.messageLen)
  for i in 0 ..< s.messageLen:
    result[i] = s.message[i]

proc noteFallback(s: ptr Shared, decoder, why: string, busy: bool) =
  ## A hardware launch gave way to ffmpeg's own. Under the lock.
  let d = min(decoder.len, DecoderKeep)
  for i in 0 ..< d:
    s.fallbackFrom[i] = decoder[i]
  s.fallbackFromLen = d
  let w = min(why.len, MessageKeep)
  for i in 0 ..< w:
    s.fallbackWhy[i] = why[i]
  s.fallbackWhyLen = w
  s.fallbackBusy = busy
  inc s.fallbacks

proc pthreadCondTimedwait(cond: pointer, lock: pointer, abstime: ptr Timespec): cint {.
  importc: "pthread_cond_timedwait", header: "<pthread.h>".}
proc c_setpriority(which: cint, who: cuint, prio: cint): cint {.importc: "setpriority", header: "<sys/resource.h>".}

proc waitFor(s: ptr Shared, ms: int) =
  ## The cond for at most `ms`. Under the lock.
  var ts: Timespec
  discard clock_gettime(CLOCK_REALTIME, ts)
  var nanos = ts.tv_nsec.int + (ms mod 1000) * 1_000_000
  var secs = ts.tv_sec.int + ms div 1000 + nanos div 1_000_000_000
  nanos = nanos mod 1_000_000_000
  ts.tv_sec = posix.Time(secs)
  ts.tv_nsec = nanos.clong
  discard pthreadCondTimedwait(addr s.cond, addr s.lock, addr ts)

const FfmpegAfterwords = ["Nothing was written into output file", "Error opening input file",
  "Error opening output file", "Conversion failed", "Exiting normally", "Error while filtering"]
  ## What ffmpeg says after the reason, never the reason.

proc cleaned*(text, shown, input: string): string =
  ## ffmpeg's reason, the source named as `shown` (its password redacted):
  ## the last line that is not one of its afterwords, without the
  ## "[demuxer @ 0x55…] " it starts a line with.
  var all = text.strip()
  if input.len > 0:
    all = all.replace(input, shown)
  var fallback = ""
  let lines = all.splitLines()
  for i in countdown(lines.high, 0):
    var line = lines[i].strip()
    if line.startsWith("[") and line.find("] ") > 0:
      line = line[line.find("] ") + 2 .. ^1].strip()
    if line.len == 0:
      continue
    if fallback.len == 0:
      fallback = line
    var afterword = false
    for words in FfmpegAfterwords:
      if line.startsWith(words):
        afterword = true
    if not afterword:
      return line
  fallback

proc probeSource(arg: ReaderArg): ProbeResult =
  let timeout = if arg.source.scheme.len == 0: FileProbeTimeoutMs else: ProbeTimeoutMs
  try:
    let run = runProcessPiped(ffprobeCommand(), probeArgs(arg.source), timeoutMs = timeout,
      maxOutputBytes = 256 * 1024, maxErrorBytes = 4096)
    if run.timedOut:
      return ProbeResult(duration: -1, error: "the video did not answer in time")
    if run.exitCode != 0:
      let why = cleaned(run.errorOutput, arg.shownSource, arg.source.input)
      return ProbeResult(duration: -1, error: if why.len > 0: why else: "the video could not be read")
    result = parseProbe(run.output)
  except OSError:
    result = ProbeResult(duration: -1, error: "ffprobe is not installed")
  except CatchableError as e:
    result = ProbeResult(duration: -1, error: e.msg)

proc keyframeBefore(arg: ReaderArg, at: float): float =
  ## The keyframe at or before `at` in a file (a few tens of milliseconds).
  try:
    let run = runProcessPiped(ffprobeCommand(), keyframeArgs(arg.source, at), timeoutMs = FileProbeTimeoutMs,
      maxOutputBytes = 4096, maxErrorBytes = 4096)
    if run.exitCode == 0: parseKeyframe(run.output, at) else: at
  except CatchableError:
    at

type LaunchEnd = enum
  leSuperseded, leEof, leFailed, leIdle
  leSlow ## a decoder without the shortcuts fell behind: again with them

proc runLaunch(arg: ReaderArg, gen: int, width, height: int, fit: VideoFit, pixels: VideoPixels,
    srcWidth, srcHeight: int, startAt, fps: float, loopFile: bool, firstSeq: int64, decode: VideoDecode,
    made: var int64, exitCode: var int, why: var string, busy: var bool, run: ptr PlaneRun = nil,
    plane = -1): LaunchEnd =
  ## One ffmpeg, its frames into the ring until it ends, is told to stop or
  ## nobody takes them. `made`: frames it put in the ring; `exitCode`
  ## ffmpeg's, -1 when it was stopped; `why` its reason when it failed or
  ## exited with an error, and `busy` whether it said the hardware could not
  ## take the video now (hardwareBusy).
  ##
  ## With `run` its frames go to display plane `plane` instead (video/planes.nim):
  ## YUV420 at the source's size, each read straight into one of the run's
  ## buffers and shown when it is due by the clock this launch keeps, held
  ## while the player is paused or the plane may not show (no render pass
  ## drew the video, something over the panel), which the clock waits out.
  let s = arg.shared
  let onPlane = not run.isNil
  let args = decodeArgs(arg.source, width, height, fit, pixels, startAt, fps, loopFile, arg.threads, decode,
    srcWidth, srcHeight, plane = onPlane)
  let shownDecoder = decodeName(decode)
  withLock s.lock:
    let n = min(shownDecoder.len, DecoderKeep)
    for i in 0 ..< n:
      s.decoder[i] = shownDecoder[i]
    s.decoderLen = n
    s.fast = decode.fast
  let (frameWidth, frameHeight) = frameSize(width, height, fit, srcWidth, srcHeight)
  let fb = if onPlane: yuv420Bytes(run.width, run.height) else: frameBytes(frameWidth, frameHeight, pixels)
  # A plane buffer whose rows are longer than the frame's (the device's
  # pitch) takes each frame through this, a row at a time.
  var staging: seq[byte]
  if onPlane and run.bufs[0].pitch != run.width:
    staging = newSeq[byte](fb)
  var p: Process
  try:
    p = startProcessSerialized(ffmpegCommand(), args, options = {poUsePath})
  except CatchableError:
    withLock s.lock:
      s.setMessage("ffmpeg is not installed on this frame")
    return leFailed
  var errText = ""
  result = leEof
  try:
    # Decoding is the frame's background work: the render thread and the
    # web server come first.
    discard c_setpriority(0, p.processID.cuint, 5)
    try:
      p.inputStream().close()
    except CatchableError:
      discard
    let
      outFd = cint(p.outputHandle())
      errFd = cint(p.errorHandle())
    discard fcntl(outFd, F_SETFL, fcntl(outFd, F_GETFL) or O_NONBLOCK)
    discard fcntl(errFd, F_SETFL, fcntl(errFd, F_GETFL) or O_NONBLOCK)
    var
      errOpen = true
      seqNo = firstSeq
      errBuf: array[2048, char]
    let frameTime = 1.0 / fps
    let launchedAt = nowSeconds()
    let hardware = decode.decoder.len > 0 or decode.hwaccel.len > 0
    # A plane's clock: frame `clockSeq` was shown at `clockStart`.
    var clockStart = 0.0
    var clockSeq: int64 = 0
    template drainErr() =
      if errOpen:
        while true:
          let n = posix.read(errFd, addr errBuf[0], errBuf.len)
          if n > 0:
            for i in 0 ..< n:
              errText.add errBuf[i]
            if errText.len > 8192:
              errText = errText[^4096 .. ^1]
          elif n == 0:
            errOpen = false
            break
          else:
            break
    block frames:
      while true:
        # A free slot, unless the render thread wants something else.
        var dst: ptr UncheckedArray[byte]
        var fill = -1
        if onPlane:
          # A plane buffer that is not on the glass.
          fill = (if run.shown < 0: 0 else: run.shown + 1) mod run.count
          withLock s.lock:
            if s.stop or s.gen != gen:
              result = leSuperseded
              break frames
          dst = if staging.len > 0: cast[ptr UncheckedArray[byte]](addr staging[0]) else: run.bufs[fill].map
        else:
          withLock s.lock:
            while true:
              if s.stop or s.gen != gen:
                result = leSuperseded
                break frames
              if s.count < s.slots:
                break
              if nowSeconds() - s.lastTake > IdleSeconds:
                result = leIdle
                break frames
              s.waitFor(200)
            let slot = (s.head + s.count) mod s.slots
            dst = cast[ptr UncheckedArray[byte]](addr s.buf[slot * fb])
        # One frame into it: the slot is in no one's ring until it is counted.
        # From here to its last byte is how long ffmpeg takes to make one
        # when it is the slow side (its pipe holds 64 KB, not a frame).
        let roomAt = nowSeconds()
        var got = 0
        while got < fb:
          var fds = [TPollfd(fd: outFd, events: POLLIN), TPollfd(fd: errFd, events: POLLIN)]
          let ready = posix.poll(addr fds[0], (if errOpen: 2 else: 1).Tnfds, PollMs)
          if ready < 0 and osLastError().int32 != EINTR:
            result = leFailed
            break frames
          withLock s.lock:
            if s.stop or s.gen != gen:
              result = leSuperseded
              break frames
          drainErr()
          if hardware and made == 0 and nowSeconds() - launchedAt > hardwareFirstFrameSeconds:
            errText.add "\nthe hardware decoder made no frame in " & $hardwareFirstFrameSeconds & " s\n"
            result = leFailed
            break frames
          if (fds[0].revents and (POLLIN or POLLHUP or POLLERR)) != 0:
            let n = posix.read(outFd, addr dst[got], fb - got)
            if n > 0:
              got += n
            elif n == 0:
              break frames
            elif osLastError().int32 notin [EAGAIN, EWOULDBLOCK, EINTR]:
              break frames
        var behind = false
        var media = startAt + float(seqNo - firstSeq) * frameTime
        if onPlane and staging.len > 0:
          # The rows into the buffer's: Y, then U and V at half.
          let b = run.bufs[fill]
          let (cw, ch) = ((run.width + 1) div 2, (run.height + 1) div 2)
          let cp = (b.pitch + 1) div 2
          for r in 0 ..< run.height:
            copyMem(b.map[r * b.pitch].addr, staging[r * run.width].addr, run.width)
          let u = run.width * run.height
          for r in 0 ..< ch:
            copyMem(b.map[b.uOffset + r * cp].addr, staging[u + r * cw].addr, cw)
            copyMem(b.map[b.vOffset + r * cp].addr, staging[u + cw * ch + r * cw].addr, cw)
        withLock s.lock:
          if s.stop or s.gen != gen:
            result = leSuperseded
            break frames
          if s.duration > 0 and loopFile:
            media = media mod s.duration
          if not onPlane:
            let slot = (s.head + s.count) mod s.slots
            s.slotSeq[slot] = seqNo
            s.slotMedia[slot] = media
            inc s.count
          let arrived = nowSeconds()
          if s.arrivedAt > 0:
            # Not the first: its wait was ffmpeg starting and seeking.
            let took = arrived - roomAt
            s.makeSeconds = if s.makeSeconds == 0: took else: s.makeSeconds * 0.8 + took * 0.2
          s.arrivedAt = arrived
          if s.failed:
            # A source that loops came back.
            s.failed = false
            s.retrying = false
            s.messageLen = 0
          behind = not decode.fast and made + 1 >= SlowAfterFrames and
            s.makeSeconds > frameTime * SlowPace
        if onPlane:
          # On the glass when it is due.
          let live = s.duration <= 0
          while true:
            var paused, idle = false
            withLock s.lock:
              if s.stop or s.gen != gen:
                result = leSuperseded
                break frames
              paused = s.paused
              idle = nowSeconds() - s.lastTake > IdleSeconds
            if idle:
              result = leIdle
              break frames
            let now = nowSeconds()
            if paused:
              # Unpaused, the clock starts again at this frame.
              clockStart = 0
              withLock s.lock:
                s.waitFor(50)
              continue
            if clockStart > 0 and not live:
              let due = clockStart + float(seqNo - clockSeq) * frameTime
              if due - now > 0.003:
                withLock s.lock:
                  s.waitFor(max(1, int(min(due - now, 0.05) * 1000)))
                continue
              if now - due > ResyncSeconds:
                # Behind and not catching up: the clock comes to the frames.
                clockStart = 0
            var onGlass = false
            if presentPlane(plane, cast[pointer](s), run.bufs[fill].id, onGlass):
              if clockStart <= 0:
                clockStart = nowSeconds()
                clockSeq = seqNo
              run.shown = fill
              withLock s.lock:
                s.shownBuf = run.bufs[fill]
                s.shownGen = gen
                s.shownSeq = seqNo
                s.shownMedia = media
                s.planeShown = true
                inc s.shownCount
                broadcast(s.cond)
              break
            if onGlass:
              # The display would not show it (a size its scaler refuses):
              # the player draws it in the canvas from now on.
              withLock s.lock:
                s.planeFailed = true
                broadcast(s.cond)
              result = leSuperseded
              break frames
            # Not on the glass now: held, and the clock waits as for a pause.
            clockStart = 0
            withLock s.lock:
              s.waitFor(50)
        inc seqNo
        inc made
        if behind:
          result = leSlow
          break frames
  finally:
    if p.peekExitCode() == -1:
      p.stopProcess()
    # What it said before it went: the reason it failed.
    try:
      let errFd = cint(p.errorHandle())
      var tail: array[2048, char]
      while true:
        let n = posix.read(errFd, addr tail[0], tail.len)
        if n <= 0: break
        for i in 0 ..< n:
          errText.add tail[i]
        if errText.len > 16384: break
    except CatchableError:
      discard
    let code = p.peekExitCode()
    exitCode = code
    p.close()
    if result == leEof and made == 0:
      result = leFailed
    busy = hardwareBusy(errText)
    if result == leFailed or (result == leEof and code != 0 and code != -1):
      var said = cleaned(errText, arg.shownSource, arg.source.input)
      if busy:
        # The line that says so, not the errors that follow from it.
        for line in errText.splitLines():
          if hardwareBusy(line):
            said = cleaned(line, arg.shownSource, arg.source.input)
            break
      why = if said.len > 0: said else: "ffmpeg could not play it (exit code " & $code & ")"
      if result == leFailed:
        withLock s.lock:
          s.setMessage(why)

proc dropPlaneRun(s: ptr Shared, run: var PlaneRun) =
  ## A reader's plane buffers go (a canvas launch, a new size, its end):
  ## first out of the render thread's reach, then off the device. One a plane
  ## shows goes off the glass with it.
  if run.count == 0:
    return
  withLock s.lock:
    for i in 0 ..< run.count:
      if s.shownBuf.id == run.bufs[i].id:
        s.shownBuf = PlaneBuffer()
        s.planeShown = false
  for i in 0 ..< run.count:
    freePlaneBuffer(run.bufs[i])
  run = PlaneRun(shown: -1)

proc makePlaneRun(run: var PlaneRun, width, height: int): bool =
  ## Buffers for `width` x `height` frames; false when the device has no
  ## room (its CMA). Kept when they are that size already.
  if run.count == PlaneBuffers and run.width == width and run.height == height:
    return true
  for i in 0 ..< PlaneBuffers:
    if not newPlaneBuffer(width, height, run.bufs[i]):
      for j in 0 ..< i:
        freePlaneBuffer(run.bufs[j])
      run = PlaneRun(shown: -1)
      return false
  run.count = PlaneBuffers
  run.width = width
  run.height = height
  run.shown = -1
  true

proc readerMain(arg: ReaderArg) {.thread.} =
  let s = arg.shared
  var run = PlaneRun(shown: -1)
  try:
    let probe = probeSource(arg)
    withLock s.lock:
      s.probed = true
      s.probeOk = probe.ok
      s.duration = probe.duration
      s.srcWidth = probe.width
      s.srcHeight = probe.height
      s.srcFps = probe.fps
      if not probe.ok:
        s.setMessage(probe.error)
      broadcast(s.cond)
    var lastGen = 0
    var seqNo: int64 = 0
    # Hardware where there is some, and the shortcuts once the decoder is
    # behind (from the start on one core): docs/video.md "Hardware".
    let caps = decodeCaps()
    var fast = slowMachine()
    var software = false ## the hardware failed this player: ffmpeg's own
    var suspect = false  ## ... and it is the hardware's fault once ffmpeg's own plays it
    while true:
      var
        gen, width, height: int
        fit: VideoFit
        pixels: VideoPixels
        startAt, maxFps: float
        loop: bool
        onPlane = false
        plane = -1
      withLock s.lock:
        while not s.stop and (s.gen == lastGen or s.width <= 0 or s.height <= 0):
          s.waitFor(500)
        if s.stop:
          break
        gen = s.gen
        width = s.width
        height = s.height
        fit = s.fit
        pixels = s.pixels
        startAt = s.startAt
        loop = s.loop
        maxFps = s.maxFps
        # On a display plane when the render thread asks and the size is known.
        onPlane = s.planeWanted and s.plane >= 0 and not s.planeFailed and probe.ok
        plane = s.plane
        if s.planeWanted and not onPlane:
          s.planeFailed = true
        s.planeLaunch = onPlane
        if onPlane:
          # No ring: the frames go to the plane's buffers.
          if not s.buf.isNil:
            deallocShared(s.buf)
            s.buf = nil
          s.frameBytes = 0
          s.frameWidth = 0
          s.frameHeight = 0
        else:
          let (frameWidth, frameHeight) = frameSize(width, height, fit, probe.width, probe.height)
          let fb = frameBytes(frameWidth, frameHeight, pixels)
          let slots = clamp(RingBudgetBytes div max(fb, 1), MinSlots, MaxSlots)
          if fb != s.frameBytes or slots != s.slots or s.buf.isNil:
            if not s.buf.isNil:
              deallocShared(s.buf)
            s.buf = cast[ptr UncheckedArray[byte]](allocShared(fb * slots))
            s.frameBytes = fb
            s.slots = slots
          s.frameWidth = frameWidth
          s.frameHeight = frameHeight
        s.head = 0
        s.count = 0
        s.runGen = gen
        s.ended = false
        s.failed = false
        s.idle = false
        s.messageLen = 0
        s.arrivedAt = 0
        s.makeSeconds = 0
        s.fps = outputFps(s.srcFps, maxFps)
        s.lastTake = nowSeconds()
      lastGen = gen
      seqNo = 0
      if onPlane:
        let (pw, ph) = planeFrameSize(probe.width, probe.height)
        if run.count > 0 and (run.width != pw or run.height != ph):
          dropPlaneRun(s, run)
        if not makePlaneRun(run, pw, ph):
          # No room for its buffers: the canvas draws it.
          withLock s.lock:
            s.planeFailed = true
            s.planeLaunch = false
            broadcast(s.cond)
          continue
      elif run.count > 0:
        dropPlaneRun(s, run)
      let fps = outputFps(probe.fps, maxFps)
      # A file plays again from its start inside one ffmpeg; anything else
      # is started again here.
      let loopFile = loop and arg.source.scheme.len == 0 and probe.duration > 0
      var launchAt = startAt
      while true:
        let decode = pickDecode(probe.codec, caps, fast, software or hardwareFailed(probe.codec))
        let hardware = decode.decoder.len > 0 or decode.hwaccel.len > 0
        if decode.fast and arg.source.scheme.len == 0 and launchAt > 0.5:
          # A slow decoder starts at the keyframe before: an exact start makes
          # it decode every frame from there first (x264's keyframes are 8 s
          # apart, two minutes of a Pi Zero's 1080p), and the fps filter drops
          # what -noaccurate_seek would have shown. The clock says where.
          launchAt = keyframeBefore(arg, launchAt)
        var made: int64 = 0
        var code = 0
        var why = ""
        var busy = false
        let ended = runLaunch(arg, gen, width, height, fit, pixels, probe.width, probe.height, launchAt, fps,
          loopFile, seqNo, decode, made, code, why, busy, (if onPlane: addr run else: nil), plane)
        seqNo += made
        if suspect and not hardware and made > 0:
          # ffmpeg's own played what the hardware would not: the hardware's
          # fault, not the source's, so no player here tries it for this codec.
          markHardwareFailed(probe.codec)
          suspect = false
        if ended == leSuperseded:
          break
        # Where a launch that goes on from here starts.
        var reached = launchAt + float(made) / fps
        if loopFile and probe.duration > 0:
          reached = reached mod probe.duration
        let atEnd = not loopFile and probe.duration > 0 and reached >= probe.duration - 1.0
        if ended == leSlow:
          fast = true
          launchAt = reached
          continue
        if hardware and not atEnd and
            (ended == leFailed or (ended == leEof and code != 0 and code != -1)):
          # The hardware would not (a codec or profile it lacks, a stream it
          # chokes on): ffmpeg's own, from where it got to. One that could
          # not take it now (no buffers: a VideoCore's are CMA, which the
          # other players and the display share; or a VideoCore busy with
          # other videos) is no fault of the hardware's: this player goes on
          # in software and the next one tries the hardware again.
          software = true
          suspect = not busy
          withLock s.lock:
            s.messageLen = 0
            s.noteFallback(decodeName(decode), why, busy)
          launchAt = reached
          continue
        if ended == leIdle:
          withLock s.lock:
            s.idle = true
            s.count = 0
            if not s.buf.isNil:
              deallocShared(s.buf)
              s.buf = nil
              s.frameBytes = 0
          # A plane that shows a paused video keeps its frame there; one that
          # does not lets its buffers go.
          if onPlane and not planeOnGlass(plane, cast[pointer](s)):
            dropPlaneRun(s, run)
          break
        var again, retry = false
        withLock s.lock:
          if s.loop and not s.stop and s.gen == gen and (ended == leEof or ended == leFailed):
            # A stream or a URL that ended: from its start again, the frames
            # numbered on. One that failed (a camera not there yet): again
            # in a while, its error shown meanwhile.
            again = true
            retry = ended == leFailed
            if retry:
              s.failed = true
              s.retrying = true
          else:
            s.ended = true
            s.failed = ended == leFailed and seqNo == 0
            broadcast(s.cond)
        if not again:
          break
        if retry:
          var superseded = false
          withLock s.lock:
            let until = nowSeconds() + retrySeconds
            while not s.stop and s.gen == gen and nowSeconds() < until:
              s.waitFor(500)
            superseded = s.stop or s.gen != gen
          if superseded:
            break
          # A source that was not there (a camera off): its hardware is
          # tried again with it.
          software = false
          suspect = false
        launchAt = 0
  except CatchableError as e:
    withLock s.lock:
      s.failed = true
      s.ended = true
      s.setMessage(e.msg)
  finally:
    dropPlaneRun(s, run)
    withLock s.lock:
      if not s.buf.isNil:
        deallocShared(s.buf)
        s.buf = nil
      s.exited = true

# ------------------------------------------------------- the render thread

proc newVideoPlayer*(source: VideoSource, shownSource: string, loop: bool, maxFps, startAt: float,
    threads = 0): VideoPlayer =
  ## A player of `source`, its probe already on its way. Nothing plays until
  ## a take says the size (`take`).
  let s = cast[ptr Shared](allocShared0(sizeof(Shared)))
  initLock(s.lock)
  initCond(s.cond)
  s.duration = -1
  s.loop = loop
  s.maxFps = maxFps
  s.startAt = max(startAt, 0)
  s.lastTake = nowSeconds()
  s.plane = -1
  result = VideoPlayer(shared: s, loop: loop, maxFps: maxFps, lastUse: nowSeconds(), late: 0.004,
    shownMedia: max(startAt, 0), pausedAt: max(startAt, 0), planeSlot: -1)
  result.placeholder = newImage(16, 9)
  result.placeholder.fill(rgbx(0, 0, 0, 255))
  let cores = countProcessors()
  let arg = ReaderArg(shared: s, source: source, shownSource: shownSource,
    threads: if threads > 0: threads elif cores > 1: cores - 1 else: 1)
  createThread(result.thread, readerMain, arg)
  result.running = true

proc reapClosedPlayers*() =
  ## Join the readers of closed players that have finished, and free what
  ## they shared. Never waits: one still stopping its ffmpeg is left for the
  ## next call.
  var i = 0
  while i < closing.len:
    let player = closing[i]
    var exited = false
    withLock player.shared.lock:
      exited = player.shared.exited
    if exited:
      joinThread(player.thread)
      deinitCond(player.shared.cond)
      deinitLock(player.shared.lock)
      deallocShared(player.shared)
      player.shared = nil
      player.running = false
      closing.del(i)
    else:
      inc i

proc close*(player: VideoPlayer) =
  ## Stop it: its reader stops ffmpeg and ends, and is joined later.
  if player.isNil or not player.running or player.shared.isNil:
    return
  withLock player.shared.lock:
    player.shared.stop = true
    broadcast(player.shared.cond)
  if player.planeSlot >= 0:
    # Off the glass now: its reader shows nothing more on it (planes.nim's owner).
    releasePlane(player.planeSlot)
    player.planeSlot = -1
  if not player.image.isNil:
    unregisterCanvas(player.image)
  if player notin closing:
    closing.add player
  reapClosedPlayers()

proc closingPlayers*(): int =
  closing.len

proc relaunch(player: VideoPlayer, at: float) =
  ## A new ffmpeg from `at` seconds at the size and fit asked for last. Under
  ## the caller's lock.
  let s = player.shared
  inc player.gen
  s.gen = player.gen
  s.width = player.width
  s.height = player.height
  s.fit = player.fit
  s.pixels = player.pixels
  s.startAt = max(at, 0)
  s.loop = player.loop
  s.maxFps = player.maxFps
  s.lastTake = nowSeconds()
  player.clockStart = 0
  broadcast(s.cond)

proc mediaNow(player: VideoPlayer): float =
  ## Where the video is: the frame on show, or where it was asked to start.
  if player.hasFrame: player.shownMedia else: player.pausedAt

proc seek*(player: VideoPlayer, at: float) =
  if player.shared.isNil:
    return
  let s = player.shared
  withLock s.lock:
    var target = max(at, 0)
    if s.duration > 0:
      target = if player.loop: target mod s.duration else: min(target, max(s.duration - 0.05, 0))
    player.pausedAt = target
    player.shownMedia = target
    if player.width > 0 and player.height > 0:
      player.relaunch(target)
    else:
      s.startAt = target

proc setLoop*(player: VideoPlayer, loop: bool) =
  if player.loop != loop and not player.shared.isNil:
    player.loop = loop
    withLock player.shared.lock:
      player.shared.loop = loop

proc setMaxFps*(player: VideoPlayer, fps: float) =
  if abs(player.maxFps - fps) > 0.01 and not player.shared.isNil:
    player.maxFps = fps
    withLock player.shared.lock:
      if player.width > 0 and player.height > 0:
        player.relaunch(player.mediaNow())
      else:
        player.shared.maxFps = fps

proc setPaused*(player: VideoPlayer, paused: bool) =
  if player.paused == paused:
    return
  player.paused = paused
  if not player.shared.isNil:
    withLock player.shared.lock:
      player.shared.paused = paused
      broadcast(player.shared.cond)
  if paused:
    player.pausedAt = player.mediaNow()
  # Unpaused, the clock starts at the next frame taken.
  player.clockStart = 0

proc pixelsOf(image: Image): ptr UncheckedArray[byte] =
  case image.format
  of pfRgbx: cast[ptr UncheckedArray[byte]](image.data[0].addr)
  of pfRgb565: cast[ptr UncheckedArray[byte]](image.data16[0].addr)
  of pfGray8: cast[ptr UncheckedArray[byte]](image.data8[0].addr)
  else: nil

proc blacken(image: Image) =
  ## The bars around a contained picture: black, opaque, painted when the
  ## image is made or the picture moves, never a frame.
  case image.format
  of pfRgbx: image.fill(rgba(0, 0, 0, 255))
  of pfRgb565: zeroMem(pixelsOf(image), image.width * image.height * 2)
  of pfGray8: zeroMem(pixelsOf(image), image.width * image.height)
  else: discard

proc copyFrame(image: Image, src: ptr UncheckedArray[byte], width, height, x, y: int) =
  ## A `width` x `height` frame into `image` at (`x`, `y`): one copy when it
  ## is as wide as the image, else a row at a time.
  let dst = pixelsOf(image)
  if dst.isNil:
    return
  let
    bpp = case image.format
      of pfRgbx: 4
      of pfRgb565: 2
      else: 1
    row = width * bpp
    stride = image.width * bpp
  if width == image.width:
    copyMem(dst[y * stride].addr, src, row * height)
  else:
    for r in 0 ..< height:
      copyMem(dst[(y + r) * stride + x * bpp].addr, src[r * row].addr, row)

proc yuvInto*(image: Image, x, y, w, h: int, buf: PlaneBuffer, srcX, srcY, srcW, srcH: float) =
  ## A plane's YUV420 frame into `image`'s `w` x `h` at (`x`, `y`), the
  ## nearest pixel of its (`srcX`, `srcY`, `srcW`, `srcH`): the canvas's copy
  ## of a video on a plane, once a second (PlaneCopySeconds), not a frame.
  if buf.map.isNil or w <= 0 or h <= 0 or buf.width <= 0 or buf.height <= 0:
    return
  let cp = (buf.pitch + 1) div 2
  var xs = newSeq[int](w)
  for i in 0 ..< w:
    xs[i] = clamp(int(srcX + (i.float + 0.5) * srcW / w.float), 0, buf.width - 1)
  for row in 0 ..< h:
    let ty = y + row
    if ty < 0 or ty >= image.height:
      continue
    let
      sy = clamp(int(srcY + (row.float + 0.5) * srcH / h.float), 0, buf.height - 1)
      yRow = sy * buf.pitch
      cRow = (sy div 2) * cp
    for col in 0 ..< w:
      let tx = x + col
      if tx < 0 or tx >= image.width:
        continue
      let
        sx = xs[col]
        (r, g, b) = yuvToRgb(int(buf.map[yRow + sx]), int(buf.map[buf.uOffset + cRow + sx div 2]),
          int(buf.map[buf.vOffset + cRow + sx div 2]))
        at = ty * image.width + tx
      case image.format
      of pfRgb565: image.data16[at] = uint16(((r shr 3) shl 11) or ((g shr 2) shl 5) or (b shr 3))
      of pfRgbx: image.data[at] = rgbx(r.uint8, g.uint8, b.uint8, 255)
      of pfGray8: image.data8[at] = uint8((r * 77 + g * 150 + b * 29) shr 8)
      else: discard

proc pixelsFor*(like: Image): VideoPixels =
  ## The frames' format: the canvas's where a copy of them can be drawn as it
  ## is, RGBA where pixie converts it.
  if like.isNil: vpRgba
  else:
    case like.format
    of pfRgb565: vpRgb565
    of pfGray8: vpGray
    else: vpRgba

proc prepareImage(player: VideoPlayer, w, h: int, like: Image, pixels: VideoPixels, framed: Rect): Rect =
  ## `player.image` at the box's size and the canvas's format, black around
  ## where the picture goes (`framed`) when that is new: what a frame then
  ## repaints, the box or the picture alone.
  if player.image.isNil or player.image.width != w or player.image.height != h or
      pixelsFor(player.image) != pixels:
    if not player.image.isNil:
      unregisterCanvas(player.image)
    player.image = if like.isNil or pixels == vpRgba: newImage(w, h) else: newImageLike(like, w, h)
    player.framed = rect(0, 0, 0, 0)
  if framed != player.framed:
    player.image.blacken()
    player.framed = framed
    rect(0, 0, w.float32, h.float32)
  else:
    framed

proc copyPlaneFrame(player: VideoPlayer, s: ptr Shared, w, h: int, fit: VideoFit, like: Image,
    pixels: VideoPixels): Rect =
  ## The frame a plane shows into `player.image`, where the canvas would draw
  ## it (under the player's lock: its reader keeps the buffer meanwhile).
  let
    buf = s.shownBuf
    (fw, fh) = frameSize(w, h, fit, s.srcWidth, s.srcHeight)
    framed = rect(float32((w - fw) div 2), float32((h - fh) div 2), fw.float32, fh.float32)
  result = player.prepareImage(w, h, like, pixels, framed)
  let r = planeRect(0, 0, w, h, ord(fit), fw, fh, buf.width, buf.height)
  yuvInto(player.image, r.x, r.y, r.w, r.h, buf, r.srcX, r.srcY, r.srcW, r.srcH)
  player.shownGen = s.shownGen
  player.shownSeq = s.shownSeq
  player.shownMedia = s.shownMedia
  player.hasFrame = true

proc take*(player: VideoPlayer, width, height: int, fit: VideoFit, like: Image,
    spot = VideoPlaneSpot()): bool =
  ## The render thread draws the video at `width` x `height`: the frame due
  ## now goes into `player.image` (true when it changed). The first take, a
  ## new size or fit, or one after the player went idle starts ffmpeg (again)
  ## where it was.
  ##
  ## `spot`: the `<img>` can be a display plane, its box's corner on the
  ## panel there (js_video.nim). The player's frames then go to a plane
  ## (video/planes.nim), its reader showing each when it is due; a take says
  ## where the plane goes (claimPlane) and copies the frame it shows into
  ## `player.image` once a second (PlaneCopySeconds). A take without one puts
  ## the plane's frame into the image and goes back to the canvas.
  if player.shared.isNil or width <= 0 or height <= 0:
    return false
  reapClosedPlayers()
  let
    s = player.shared
    now = nowSeconds()
    w = min(width, MaxFrameEdge)
    h = min(height, MaxFrameEdge)
    pixels = pixelsFor(like)
  # A render that did not come for a while: the time it was not shown passes
  # as a pause would (GapSeconds).
  if player.lastDraw > 0 and now - player.lastDraw > GapSeconds and player.clockStart > 0:
    player.clockStart += now - player.lastDraw - 1.0 / max(player.clockFps, 1.0)
  if player.askedAt > 0:
    let lateBy = (now - player.askedAt) - player.askedWait
    player.late = clamp(player.late * 0.8 + lateBy * 0.2, 0, 0.05)
    player.askedAt = 0
  player.lastDraw = now
  player.lastUse = now
  if spot.ok and not player.planeFailed and player.planeSlot < 0:
    player.planeSlot = acquirePlane(cast[pointer](s))
  var drawn: Rect
  var claim = false
  var placed: PlaneRect
  var hd = false
  withLock s.lock:
    s.lastTake = now
    if player.planeMode and s.planeFailed:
      player.planeFailed = true
    let planeNow = spot.ok and not player.planeFailed and player.planeSlot >= 0
    let sized = w != player.width or h != player.height or fit != player.fit or pixels != player.pixels
    if planeNow != player.planeMode or player.gen == 0 or s.idle or (sized and not planeNow):
      if player.planeMode and not planeNow and s.planeShown and not s.shownBuf.map.isNil:
        # Back to the canvas: the frame on the glass into it first, so the
        # picture does not go back to an older one until ffmpeg's next.
        drawn = player.copyPlaneFrame(s, w, h, fit, like, pixels)
      player.width = w
      player.height = h
      player.fit = fit
      player.pixels = pixels
      player.planeMode = planeNow
      s.planeWanted = planeNow
      s.plane = player.planeSlot
      player.relaunch(if player.gen == 0: s.startAt else: player.mediaNow())
    elif sized:
      # A plane's box moved or changed size: the plane follows, its frames do not change.
      player.width = w
      player.height = h
      player.fit = fit
      player.pixels = pixels
    if s.failed:
      player.error = s.messageOf()
      return false
    player.error = ""
    if player.planeMode:
      if s.probed and s.srcWidth > 0 and s.srcHeight > 0:
        let (fw, fh) = frameSize(w, h, fit, s.srcWidth, s.srcHeight)
        let (pw, ph) = planeFrameSize(s.srcWidth, s.srcHeight)
        placed = planeRect(spot.x, spot.y, w, h, ord(fit), fw, fh, pw, ph)
        claim = true
        hd = s.srcHeight >= 720
      if s.planeShown and s.shownGen == player.gen:
        player.hasFrame = true
        player.shownGen = s.shownGen
        player.shownSeq = s.shownSeq
        player.shownMedia = s.shownMedia
      # The canvas's copy of it: once a second, and when it pauses or ends.
      if s.planeShown and not s.shownBuf.map.isNil and s.shownCount != player.copiedCount and
          (now - player.copiedAt >= PlaneCopySeconds or player.paused or s.ended):
        drawn = player.copyPlaneFrame(s, w, h, fit, like, pixels)
        player.copiedCount = s.shownCount
        player.copiedAt = now
    else:
      block canvas:
        if s.runGen != player.gen or s.count == 0 or s.frameWidth <= 0 or s.frameWidth > w or
            s.frameHeight > h or s.frameBytes != frameBytes(s.frameWidth, s.frameHeight, pixels):
          break canvas
        # Paused, the picture stays: the first frame of a launch is still shown
        # (a video that starts paused, a seek while paused).
        if player.paused and player.shownGen == player.gen and player.hasFrame:
          break canvas
        let fps = max(s.fps, 0.5)
        let live = s.duration <= 0
        # The newest frame that is due; older ones are dropped unseen.
        var pick = -1
        if player.paused:
          pick = 0
        elif player.clockStart <= 0 or player.clockGen != player.gen:
          pick = 0
          player.clockGen = player.gen
          player.clockSeq = s.slotSeq[s.head]
          player.clockStart = now
          player.clockFps = fps
        elif live:
          pick = s.count - 1
        else:
          for i in 0 ..< s.count:
            let slot = (s.head + i) mod s.slots
            let due = player.clockStart + float(s.slotSeq[slot] - player.clockSeq) / fps
            if due <= now + 0.25 / fps:
              pick = i
            else:
              break
          if pick >= 0:
            let slot = (s.head + pick) mod s.slots
            let due = player.clockStart + float(s.slotSeq[slot] - player.clockSeq) / fps
            if now - due > ResyncSeconds:
              # Behind and not catching up: the clock comes to the frames.
              player.clockSeq = s.slotSeq[slot]
              player.clockStart = now
        if pick < 0:
          break canvas
        let slot = (s.head + pick) mod s.slots
        # A contained picture goes in the middle of the box, on black.
        let framed = rect(float32((w - s.frameWidth) div 2), float32((h - s.frameHeight) div 2),
          s.frameWidth.float32, s.frameHeight.float32)
        drawn = player.prepareImage(w, h, like, pixels, framed)
        copyFrame(player.image, cast[ptr UncheckedArray[byte]](addr s.buf[slot * s.frameBytes]),
          s.frameWidth, s.frameHeight, framed.x.int, framed.y.int)
        player.shownGen = player.gen
        player.shownSeq = s.slotSeq[slot]
        player.shownMedia = s.slotMedia[slot]
        player.hasFrame = true
        s.head = (s.head + pick + 1) mod s.slots
        s.count -= pick + 1
        broadcast(s.cond)
  if claim:
    claimPlane(player.planeSlot, placed, hd)
  if drawn.w <= 0 or player.image.isNil:
    return false
  # A new frame repaints the picture, not its bars (utils/svg_frames.nim).
  registerCanvas(player.image).drew(drawn)
  true

proc renderWait*(dueIn, frameSeconds, late: float, decoded: bool, madeIn = 0.0): float =
  ## How long the scene sleeps before it renders for the video again.
  ## `decoded`: a frame is in the ring, due in `dueIn` seconds; the wait is
  ## that less how late renders have been coming (`late`), so it lands on
  ## time. Not decoded (a start, or a decoder behind the clock: a Pi Zero's
  ## core decoding 720p at 3 frames a second): when the decoder's next frame
  ## should be in (`madeIn`, a second at most) and a frame from now at
  ## least, nothing taken off. A render sooner shows nothing new, and on one
  ## core it takes the time the decoder needs: renders slower than a frame
  ## (`late` near a frame) once asked back to back, and ffmpeg got a fifth
  ## of the core.
  if decoded: max(dueIn - late, 0.002)
  else: max(max(frameSeconds, min(madeIn, 1.0)), 0.002)

proc nextFrameIn*(player: VideoPlayer): float =
  ## Seconds until the scene should render for this video again, -1 for
  ## never: paused, ended, failed. Asked after a take.
  if player.shared.isNil or player.paused:
    return -1
  let s = player.shared
  let now = nowSeconds()
  var wait = -1.0
  if player.planeMode:
    # Its reader shows the frames: the scene renders to say where the plane
    # goes and to copy its frame into the canvas, about once a second, and
    # sooner until the plane shows the first (a render places it).
    withLock s.lock:
      if s.failed:
        return if s.retrying: retrySeconds / 2 else: -1
      if s.planeFailed:
        return 0.01
      if s.ended and s.runGen == player.gen and s.planeShown:
        if player.endTold == player.gen:
          return -1
        player.endTold = player.gen
        return 0.05
      if not s.probed or s.shownCount == 0:
        return 0.1
    return PlaneCopySeconds
  withLock s.lock:
    if s.failed:
      # Opened again in a while: a render now and then shows it back.
      return if s.retrying: retrySeconds / 2 else: -1
    if s.ended and s.count == 0 and s.runGen == player.gen:
      # Once more after the last frame, so the app's get() hears it ended.
      if player.endTold == player.gen:
        return -1
      player.endTold = player.gen
      return 1.0 / max(s.fps, 1.0)
    let fps = max(s.fps, 0.5)
    let decoded = s.runGen == player.gen and s.count > 0
    if decoded and player.clockStart > 0 and s.duration > 0:
      let due = player.clockStart + float(s.slotSeq[s.head] - player.clockSeq) / fps
      wait = renderWait(due - now, 1.0 / fps, player.late, decoded = true)
    elif decoded:
      # A live stream shows its newest frame: the next in a frame.
      wait = renderWait(1.0 / fps, 1.0 / fps, player.late, decoded = true)
    else:
      let madeIn =
        if s.runGen == player.gen and s.arrivedAt > 0 and s.makeSeconds > 0:
          s.arrivedAt + s.makeSeconds - now
        else: 0.0
      wait = renderWait(0, if s.probed: 1.0 / fps else: 0.05, player.late, decoded = false, madeIn)
  player.askedAt = now
  player.askedWait = wait
  wait

proc state*(player: VideoPlayer): string =
  if player.shared.isNil:
    return "error"
  let s = player.shared
  withLock s.lock:
    if s.failed:
      return "error"
    if player.paused:
      return "paused"
    if s.ended and s.count == 0 and s.runGen == player.gen and player.hasFrame and player.shownGen == player.gen:
      return "ended"
    if not player.hasFrame:
      return "loading"
  "playing"

type VideoStatus* = object
  state*: string
  time*: float
  duration*: float    ## -1 unknown (live)
  width*, height*: int ## the source's
  fps*: float
  error*: string
  probed*: bool
  decoder*: string    ## what decodes it: "software", "h264_v4l2m2m", "vaapi" (docs/video.md "Hardware")
  fast*: bool         ## with a slow decoder's shortcuts

proc status*(player: VideoPlayer): VideoStatus =
  result.state = player.state()
  result.time = player.mediaNow()
  result.duration = -1
  if player.shared.isNil:
    result.error = "stopped"
    return
  let s = player.shared
  withLock s.lock:
    result.duration = s.duration
    result.width = s.srcWidth
    result.height = s.srcHeight
    result.fps = if s.fps > 0: s.fps else: s.srcFps
    result.probed = s.probed
    result.decoder = newString(s.decoderLen)
    for i in 0 ..< s.decoderLen:
      result.decoder[i] = s.decoder[i]
    result.fast = s.fast
    if player.planeMode and s.planeShown and s.shownGen == player.gen:
      result.time = s.shownMedia
    if result.state == "error":
      let text = s.messageOf()
      result.error = if text.len > 0: text else: "the video could not be played"
  if result.state == "ended" and result.duration > 0:
    result.time = result.duration

type VideoFallback* = object
  ## The last hardware launch of a player that gave way to ffmpeg's own.
  count*: int         ## how many have, so far (0: none)
  decoder*: string    ## the hardware decoder that failed ("h264_v4l2m2m")
  reason*: string     ## ffmpeg's reason
  busy*: bool         ## the hardware could not take it now: it stays on for the next player

proc fallbacks*(player: VideoPlayer): int =
  ## Hardware launches of this player that gave way to ffmpeg's own: a number
  ## the render thread checks every frame, `lastFallback` when it moves.
  if player.shared.isNil:
    return 0
  withLock player.shared.lock:
    result = player.shared.fallbacks

proc lastFallback*(player: VideoPlayer): VideoFallback =
  if player.shared.isNil:
    return
  let s = player.shared
  withLock s.lock:
    result.count = s.fallbacks
    result.decoder = newString(s.fallbackFromLen)
    for i in 0 ..< s.fallbackFromLen:
      result.decoder[i] = s.fallbackFrom[i]
    result.reason = newString(s.fallbackWhyLen)
    for i in 0 ..< s.fallbackWhyLen:
      result.reason[i] = s.fallbackWhy[i]
    result.busy = s.fallbackBusy

proc shownImage*(player: VideoPlayer): Image =
  ## What an `<img>` of it draws now.
  if player.image.isNil: player.placeholder else: player.image

proc placeholderFor*(player: VideoPlayer): Image =
  ## A black picture of the source's shape, once the probe said it: what the
  ## layout sizes an `<img>` given one length by.
  if player.shared.isNil:
    return player.placeholder
  var w, h: int
  withLock player.shared.lock:
    w = player.shared.srcWidth
    h = player.shared.srcHeight
  if w > 0 and h > 0 and player.placeholder.width * h != player.placeholder.height * w:
    let scale = 160.0 / max(w, h).float
    player.placeholder = newImage(max(1, int(round(w.float * scale))), max(1, int(round(h.float * scale))))
    player.placeholder.fill(rgbx(0, 0, 0, 255))
  player.placeholder

# ------------------------------------------------------------- one-shots

proc probeVideo*(source: VideoSource, shownSource: string): ProbeResult =
  ## ffprobe's answer, on the caller's thread (bounded by its timeout).
  probeSource(ReaderArg(source: source, shownSource: shownSource))

proc videoStill*(source: VideoSource, shownSource: string, at: float, width, height: int,
    fit: VideoFit, like: Image, error: var string): Image =
  ## One frame `at` seconds in, at `width` x `height`, in `like`'s format;
  ## nil and `error` when there is none.
  let
    w = clamp(width, 1, MaxFrameEdge)
    h = clamp(height, 1, MaxFrameEdge)
    pixels = pixelsFor(like)
    bytes = frameBytes(w, h, pixels)
    timeout = if source.scheme.len == 0: FileProbeTimeoutMs else: ProbeTimeoutMs
  try:
    let run = runProcessPiped(ffmpegCommand(), stillArgs(source, at, w, h, fit, pixels),
      timeoutMs = timeout, maxOutputBytes = bytes, maxErrorBytes = 4096)
    if run.timedOut:
      error = "the video did not answer in time"
      return nil
    if run.output.len < bytes:
      let why = cleaned(run.errorOutput, shownSource, source.input)
      error = if why.len > 0: why elif run.output.len == 0: "no frame there" else: "the frame was cut short"
      return nil
    result = if like.isNil or pixels == vpRgba: newImage(w, h) else: newImageLike(like, w, h)
    # A still comes padded to its box (stillArgs): the whole image.
    copyFrame(result, cast[ptr UncheckedArray[byte]](run.output[0].unsafeAddr), w, h, 0, 0)
  except OSError:
    error = "ffmpeg is not installed on this frame"
    result = nil
  except CatchableError as e:
    error = e.msg
    result = nil

proc shownName*(input: string): string =
  ## A source as a message may name it: a URL by its origin.
  if input.contains("://"): redactedUrl(input) else: input.extractFilename()
