## What an on-device settings save has to do beyond reloading the runtime's
## own config.
##
## `frameos setup` (run by a backend deploy and by the on-device upgrade)
## applies the parts of frame.json the operating system has to know about:
## the time zone into /etc/localtime, Samba mountpoints into /etc/fstab, the
## display driver's overlays and boot config. The local admin page saves the
## same fields, and used to leave them in frame.json only — a mountpoint
## edited on the frame never mounted, a time zone never reached libc. The
## save now queues the matching step here, on a worker thread of its own:
## `mount -a` and an apt install can take minutes, and neither a mummy
## worker (the save's HTTP response) nor the runner (the panel) should wait
## for them. Outcomes are log events (`settings:*`), which the admin page
## streams live.
import std/[json, locks, os, strutils]
import frameos/channels
import frameos/config
import frameos/device_setup
import frameos/privileged
import frameos/samba_mounts
import frameos/setup as frameSetup
import frameos/types
import ./api

type
  SettingsJobKind* = enum
    sjTimezone = "timezone"
    sjMounts = "mounts"
    sjDriverSetup = "driver_setup"

  SettingsJob* = object
    kind*: SettingsJobKind
    ## The merged frame.json the job applies, as text: a JsonNode must not
    ## cross to the worker thread.
    configJson*: string

  SettingsJobRunner* = proc(job: SettingsJob) {.gcsafe.}

proc settingsJobsFor*(change: FrameConfigChange, mode: string): seq[SettingsJobKind] =
  ## Which system steps a change needs on a frame of this `mode`. A step the
  ## platform has no way to apply is not queued: Samba mounts need apt and
  ## a writable /etc/fstab (Raspberry Pi OS), Buildroot images ship none of
  ## it and `frameos setup` skips them there too.
  let hostOs = mode in ["rpios", "buildroot"]
  if change.timezone and hostOs:
    result.add(sjTimezone)
  if change.mounts and mode == "rpios":
    result.add(sjMounts)
  if change.device and hostOs:
    result.add(sjDriverSetup)

proc settingsJobNames*(kinds: seq[SettingsJobKind]): JsonNode =
  result = newJArray()
  for kind in kinds:
    result.add(%($kind))

proc runDriverSetup(): tuple[ok: bool, output: string] =
  ## The portal's display-setup step (portal.nim runDriverSetupFromSavedConfig):
  ## the privileged door on a hardened Buildroot frame, `sudo` elsewhere.
  ## `--reboot-if-required` lets a new overlay reboot the frame; otherwise
  ## the caller restarts the runtime so the driver re-inits.
  if privilegedDoorAvailable():
    let res = requestPrivileged(pvApplyDriverSetup, %*{"rebootIfRequired": true}, timeoutMs = 15 * 60 * 1000)
    return (res.ok, if res.ok: res.output else: res.error)
  let binary = getAppFilename()
  let appDir = getAppDir()
  if binary.len == 0 or appDir.len == 0:
    return (false, "runtime path not available")
  let res = runSetupCommand(
    "cd " & shellQuote(appDir) & " && " & privilegedCommand(shellQuote(binary) & " driver-setup --reboot-if-required"),
    raiseOnError = false,
  )
  (res.exitCode == 0, res.output.strip())

proc runSettingsJob(job: SettingsJob) {.gcsafe.} =
  # The setup steps run shell commands through device_setup's injectable
  # runner (a global, for the tests); the worker is the only thread here.
  {.cast(gcsafe).}:
    var frameConfig: FrameConfig
    try:
      frameConfig = parseFrameConfig(job.configJson)
    except CatchableError as e:
      log(%*{"event": "settings:" & $job.kind & ":error", "error": "could not parse the saved config: " & e.msg})
      return
    case job.kind
    of sjTimezone:
      let zone = frameConfig.timeZone.strip()
      log(%*{"event": "settings:timezone", "timeZone": zone, "message": "Applying the time zone to the system clock"})
      try:
        # setupTimezone refuses anything that is not an IANA zone name before
        # it touches /etc/localtime; through the door it is validated again.
        discard frameSetup.setupTimezone(zone)
        log(%*{"event": "settings:timezone:done", "timeZone": zone})
      except CatchableError as e:
        log(%*{"event": "settings:timezone:error", "timeZone": zone, "error": e.msg})
    of sjMounts:
      log(%*{"event": "settings:mounts", "message": "Applying Samba mountpoints (/etc/fstab, mount -a)"})
      try:
        discard setupSambaMounts(frameConfig.mountpoints)
        log(%*{"event": "settings:mounts:done"})
      except CatchableError as e:
        log(%*{"event": "settings:mounts:error", "error": e.msg})
    of sjDriverSetup:
      log(%*{"event": "settings:driver_setup", "device": frameConfig.device,
        "message": "Running display driver setup, then restarting FrameOS"})
      let (ok, output) = runDriverSetup()
      if ok:
        log(%*{"event": "settings:driver_setup:done", "device": frameConfig.device})
      else:
        log(%*{"event": "settings:driver_setup:error", "device": frameConfig.device, "error": output})
      # The driver reads its config at init; the config is saved either way.
      # If setup scheduled a reboot this restart is moot, and harmless.
      sendEvent("restart", %*{})

var jobRunner: SettingsJobRunner = runSettingsJob
var jobChannel: Channel[SettingsJob]
jobChannel.open(64)
var workerThread: Thread[void]
var workerLock: Lock
initLock(workerLock)
var workerStarted = false

proc setSettingsJobRunnerForTest*(runner: SettingsJobRunner) =
  withLock workerLock:
    if runner == nil:
      jobRunner = runSettingsJob
    else:
      jobRunner = runner

proc settingsWorker() {.thread.} =
  while true:
    let job = jobChannel.recv()
    var runner: SettingsJobRunner
    withLock workerLock:
      {.cast(gcsafe).}:
        runner = jobRunner
    try:
      runner(job)
    except CatchableError as e:
      {.cast(gcsafe).}:
        log(%*{"event": "settings:" & $job.kind & ":error", "error": e.msg})

proc queueSettingsJobs*(kinds: seq[SettingsJobKind], configJson: string) {.gcsafe.} =
  ## Hands the steps to the worker, in order, starting it on first use.
  ## Never blocks: a full queue (64 saves in flight) drops with a log line.
  if kinds.len == 0:
    return
  withLock workerLock:
    {.cast(gcsafe).}:
      if not workerStarted:
        createThread(workerThread, settingsWorker)
        workerStarted = true
  for kind in kinds:
    {.cast(gcsafe).}:
      if not jobChannel.trySend(SettingsJob(kind: kind, configJson: configJson)):
        log(%*{"event": "settings:" & $kind & ":error", "error": "settings worker queue is full"})
