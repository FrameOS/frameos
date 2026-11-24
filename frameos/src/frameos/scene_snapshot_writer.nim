## A scene's snapshot written off the runner thread: the PNG every switch saves
## (`.frameos/scene_images/`, what the workspace, the cloud and the status
## screen show of the scene) and the scene switcher's small copy beside it
## (scene_switcher_linux.nim, `.frameos/scene_thumbs/`).
##
## The PNG encode is most of a second for a UI on a Pi Zero and three for a
## photo; on the runner it held every tap, switch and render that came in the
## meantime (the switcher opened in 3.4 s for a 121 ms render, the hardware
## bench, 2026-11-24). Here the runner only copies the picture's pixels (a few
## ms) and goes on. The writer runs below the runner's priority, so on a
## one-core board it takes what the runner leaves.
##
## Values only cross: the job is strings, ints and a seq of pixels, moved in
## under the lock and out on the writer. No ref of the runner's is ever held
## here (AGENTS.md, "Refs do not cross threads"). A newer picture of a scene
## replaces one still waiting, and `snapshotPending` lets the runner skip a
## copy while one is.

import std/[json, locks, os]
import pixie
import pixie/fileformats/png
import frameos/channels
import frameos/scenes
import frameos/scene_switcher_linux

type
  SnapshotJob = object
    assetsPath: string
    sceneId: string
    width, height: int
    pixels: seq[ColorRGBX]

var
  jobsLock: Lock
  jobsCond: Cond
  jobs {.guard: jobsLock.}: seq[SnapshotJob]
  writing {.guard: jobsLock.}: string ## the scene being written now, "" for none
  writerStarted {.guard: jobsLock.}: bool
  writerThread: Thread[void]

initLock(jobsLock)
initCond(jobsCond)

proc writeAtomically(path, body: string) =
  ## rename(2) over the old file: a reader (the switcher, `GET …/scene_images`)
  ## gets the old picture or the new one, never half of one.
  let dir = path.parentDir
  if dir.len > 0 and not dirExists(dir):
    createDir(dir)
  let temp = path & "." & $getThreadId() & ".tmp"
  writeFile(temp, body)
  moveFile(temp, path)

proc writeSceneSnapshot*(assetsPath, sceneId: string, image: Image): int =
  ## Writes `image` as `sceneId`'s snapshot and its switcher copy; the PNG's
  ## size. The writer thread's work, and a test's.
  let png = encodePng(image)
  writeAtomically(sceneImagePath(assetsPath, sceneId), png)
  try:
    writeAtomically(sceneThumbPath(assetsPath, sceneId), encodeImage(thumbnailSource(image), QoiFormat))
  except CatchableError:
    discard # the switcher decodes the snapshot instead
  png.len

var sysGettid {.importc: "SYS_gettid", header: "<sys/syscall.h>".}: clong
proc syscall(number: clong): clong {.importc, header: "<unistd.h>", varargs.}
proc setpriority(which: cint, who: cuint, prio: cint): cint {.importc, header: "<sys/resource.h>".}
var prioProcess {.importc: "PRIO_PROCESS", header: "<sys/resource.h>".}: cint

proc lowerWriterPriority() =
  ## nice 10 for this thread alone (Linux: PRIO_PROCESS with a thread id).
  discard setpriority(prioProcess, cuint(syscall(sysGettid)), 10)

proc writerLoop() {.thread.} =
  {.cast(gcsafe).}:
    lowerWriterPriority()
    while true:
      var job: SnapshotJob
      withLock jobsLock:
        while jobs.len == 0:
          wait(jobsCond, jobsLock)
        job = move(jobs[0])
        jobs.delete(0)
        writing = job.sceneId
      try:
        if job.pixels.len == job.width * job.height:
          let image = newImageFrom(job.width, job.height, move(job.pixels))
          let bytes = writeSceneSnapshot(job.assetsPath, job.sceneId, image)
          noteSceneImageSaved()
          log(%*{"event": "render:sceneImage:saved", "sceneId": job.sceneId,
            "publicSceneId": job.sceneId, "bytes": bytes})
      except CatchableError as e:
        log(%*{"event": "render:sceneImage:error", "sceneId": job.sceneId, "error": e.msg})
      withLock jobsLock:
        writing = ""
        broadcast(jobsCond)

proc snapshotPending*(sceneId: string): bool =
  ## A snapshot of this scene is waiting or being written.
  withLock jobsLock:
    if writing == sceneId:
      return true
    for job in jobs:
      if job.sceneId == sceneId:
        return true

proc queueSceneSnapshot*(assetsPath, sceneId: string): bool =
  ## The last picture (`setLastImage`'s, without the local access code) as
  ## `sceneId`'s snapshot. False before the first render.
  let (width, height, pixels) = lastImagePixels()
  if pixels.len == 0:
    return false
  var job = SnapshotJob(assetsPath: assetsPath, sceneId: sceneId, width: width, height: height,
    pixels: pixels)
  withLock jobsLock:
    if not writerStarted:
      createThread(writerThread, writerLoop)
      writerStarted = true
    var replaced = false
    for queued in jobs.mitems:
      if queued.sceneId == sceneId:
        queued = move(job)
        replaced = true
        break
    if not replaced:
      jobs.add(move(job))
    # The writer and a `waitSceneSnapshots` wait on the same condition.
    broadcast(jobsCond)
  true

proc waitSceneSnapshots*() =
  ## Until every queued snapshot is on disk (tests, a clean shutdown).
  withLock jobsLock:
    while jobs.len > 0 or writing.len > 0:
      wait(jobsCond, jobsLock)
