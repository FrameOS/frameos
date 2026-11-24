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

export args

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
    # The ring: `count` frames from `head`, oldest first.
    buf: ptr UncheckedArray[byte]
    frameBytes: int
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
    lastDraw: float
    pausedAt: float        ## media time it was paused at
    late: float            ## how much later than asked renders come (an average)
    askedAt, askedWait: float
    lastUse*: float        ## monotonic seconds the app last asked for it
    endTold: int           ## the launch whose end a render was asked for
    error: string

var closing {.threadvar.}: seq[VideoPlayer]
var retrySeconds* = 10.0
  ## A source that loops (a camera, a stream) and failed is opened again this
  ## often, its error shown meanwhile. A plain value the readers read; tests
  ## shorten it.

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

type LaunchEnd = enum leSuperseded, leEof, leFailed, leIdle

proc runLaunch(arg: ReaderArg, gen: int, width, height: int, fit: VideoFit, pixels: VideoPixels,
    startAt, fps: float, loopFile: bool, firstSeq: int64, made: var int64): LaunchEnd =
  ## One ffmpeg, its frames into the ring until it ends, is told to stop or
  ## nobody takes them. `made`: frames it put in the ring.
  let s = arg.shared
  let args = decodeArgs(arg.source, width, height, fit, pixels, startAt, fps, loopFile, arg.threads)
  let fb = frameBytes(width, height, pixels)
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
          if (fds[0].revents and (POLLIN or POLLHUP or POLLERR)) != 0:
            let n = posix.read(outFd, addr dst[got], fb - got)
            if n > 0:
              got += n
            elif n == 0:
              break frames
            elif osLastError().int32 notin [EAGAIN, EWOULDBLOCK, EINTR]:
              break frames
        withLock s.lock:
          if s.stop or s.gen != gen:
            result = leSuperseded
            break frames
          let slot = (s.head + s.count) mod s.slots
          s.slotSeq[slot] = seqNo
          var media = startAt + float(seqNo - firstSeq) * frameTime
          if s.duration > 0 and loopFile:
            media = media mod s.duration
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
        inc seqNo
        inc made
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
    p.close()
    if result == leEof and made == 0:
      result = leFailed
    if result == leFailed or (result == leEof and code != 0 and code != -1 and made == 0):
      let why = cleaned(errText, arg.shownSource, arg.source.input)
      withLock s.lock:
        s.setMessage(if why.len > 0: why else: "ffmpeg could not play it (exit code " & $code & ")")

proc readerMain(arg: ReaderArg) {.thread.} =
  let s = arg.shared
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
    while true:
      var
        gen, width, height: int
        fit: VideoFit
        pixels: VideoPixels
        startAt, maxFps: float
        loop: bool
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
        let fb = frameBytes(width, height, pixels)
        let slots = clamp(RingBudgetBytes div max(fb, 1), MinSlots, MaxSlots)
        if fb != s.frameBytes or slots != s.slots or s.buf.isNil:
          if not s.buf.isNil:
            deallocShared(s.buf)
          s.buf = cast[ptr UncheckedArray[byte]](allocShared(fb * slots))
          s.frameBytes = fb
          s.slots = slots
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
      let fps = outputFps(probe.fps, maxFps)
      # A file plays again from its start inside one ffmpeg; anything else
      # is started again here.
      let loopFile = loop and arg.source.scheme.len == 0 and probe.duration > 0
      var launchAt = startAt
      while true:
        var made: int64 = 0
        let ended = runLaunch(arg, gen, width, height, fit, pixels, launchAt, fps, loopFile, seqNo, made)
        seqNo += made
        if ended == leSuperseded:
          break
        if ended == leIdle:
          withLock s.lock:
            s.idle = true
            s.count = 0
            if not s.buf.isNil:
              deallocShared(s.buf)
              s.buf = nil
              s.frameBytes = 0
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
        launchAt = 0
  except CatchableError as e:
    withLock s.lock:
      s.failed = true
      s.ended = true
      s.setMessage(e.msg)
  finally:
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
  result = VideoPlayer(shared: s, loop: loop, maxFps: maxFps, lastUse: nowSeconds(), late: 0.004,
    shownMedia: max(startAt, 0), pausedAt: max(startAt, 0))
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
  if paused:
    player.pausedAt = player.mediaNow()
  # Unpaused, the clock starts at the next frame taken.
  player.clockStart = 0

proc copyFrame(image: Image, src: ptr UncheckedArray[byte], bytes: int) =
  case image.format
  of pfRgbx: copyMem(image.data[0].addr, src, bytes)
  of pfRgb565: copyMem(image.data16[0].addr, src, bytes)
  of pfGray8: copyMem(image.data8[0].addr, src, bytes)
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

proc take*(player: VideoPlayer, width, height: int, fit: VideoFit, like: Image): bool =
  ## The render thread draws the video at `width` x `height`: the frame due
  ## now goes into `player.image` (true when it changed). The first take, a
  ## new size or fit, or one after the player went idle starts ffmpeg (again)
  ## where it was.
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
  withLock s.lock:
    s.lastTake = now
    if w != player.width or h != player.height or fit != player.fit or pixels != player.pixels or
        player.gen == 0 or s.idle:
      player.width = w
      player.height = h
      player.fit = fit
      player.pixels = pixels
      player.relaunch(if player.gen == 0: s.startAt else: player.mediaNow())
    if s.failed:
      player.error = s.messageOf()
      return false
    player.error = ""
    if s.runGen != player.gen or s.count == 0 or s.frameBytes != frameBytes(w, h, pixels):
      return false
    # Paused, the picture stays: the first frame of a launch is still shown
    # (a video that starts paused, a seek while paused).
    if player.paused and player.shownGen == player.gen and player.hasFrame:
      return false
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
      return false
    let slot = (s.head + pick) mod s.slots
    if player.image.isNil or player.image.width != w or player.image.height != h or
        pixelsFor(player.image) != pixels:
      if not player.image.isNil:
        unregisterCanvas(player.image)
      player.image = if like.isNil or pixels == vpRgba: newImage(w, h) else: newImageLike(like, w, h)
    copyFrame(player.image, cast[ptr UncheckedArray[byte]](addr s.buf[slot * s.frameBytes]), s.frameBytes)
    player.shownGen = player.gen
    player.shownSeq = s.slotSeq[slot]
    player.shownMedia = s.slotMedia[slot]
    player.hasFrame = true
    s.head = (s.head + pick + 1) mod s.slots
    s.count -= pick + 1
    broadcast(s.cond)
  registerCanvas(player.image).drew(rect(0, 0, player.image.width.float32, player.image.height.float32))
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
    if result.state == "error":
      let text = s.messageOf()
      result.error = if text.len > 0: text else: "the video could not be played"
  if result.state == "ended" and result.duration > 0:
    result.time = result.duration

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
    copyFrame(result, cast[ptr UncheckedArray[byte]](run.output[0].unsafeAddr), bytes)
  except OSError:
    error = "ffmpeg is not installed on this frame"
    result = nil
  except CatchableError as e:
    error = e.msg
    result = nil

proc shownName*(input: string): string =
  ## A source as a message may name it: a URL by its origin.
  if input.contains("://"): redactedUrl(input) else: input.extractFilename()
