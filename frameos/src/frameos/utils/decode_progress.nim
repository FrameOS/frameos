## What a streamed image decode says about itself while it runs, and when.
##
## A photographer's camera JPEG is tens of megabytes and tens of megapixels;
## an ESP32 decodes it straight off the socket in minutes, with nothing on
## the log in between (2026-10-14: a 17 MB, 60 MP photo took 430 s and the
## backend showed one silent gap). Two things fix that, both decided here so
## they can be tested without a socket or a decoder:
##
## * a line BEFORE a decode of a large body, saying how big it is and that
##   it will take a while (`startNote`), and a progress line every
##   `DecodeProgressIntervalMs` with what fraction of the source has been
##   consumed and the time that rate leaves (`advance`);
## * the moments the run's wall-clock deadline should be renewed
##   (`advance` returns `renew`), because a decode that keeps consuming its
##   source is honest work, not a tarpit (run_budget.renewRenderDeadline).
##
## Bytes consumed stand in for work done: the entropy-coded data is the bulk
## of a JPEG and is read in order, so the fraction of the body read is close
## to the fraction of the decode done. A rewind (a degrade rung, a strip of a
## progressive JPEG) starts a new pass; `restart` resets the count and the
## notes say which pass they are on.

import std/json
import std/strutils

const
  DecodeNoticeBytes* = 2 * 1024 * 1024
    ## A body this big gets a line before its decode starts.
  DecodeProgressIntervalMs* = 30_000
    ## How often a running decode reports.
  DecodeRenewIntervalMs* = 5_000
    ## How often a running decode asks for the deadline to be renewed.

type
  DecodeProgress* = object
    format*: string
    totalBytes*: int
    targetWidth*, targetHeight*: int
    startedMs*: int64      ## when the first pass began
    passStartedMs*: int64  ## when the current pass began
    bytes*: int64          ## consumed in the current pass
    pass*: int             ## 1 for the first read of the body
    lastNoteMs*: int64
    lastRenewMs*: int64

proc initDecodeProgress*(format: string, totalBytes, targetWidth, targetHeight: int,
    nowMs: int64): DecodeProgress =
  DecodeProgress(format: format, totalBytes: totalBytes, targetWidth: targetWidth,
                 targetHeight: targetHeight, startedMs: nowMs, passStartedMs: nowMs,
                 pass: 1, lastNoteMs: nowMs, lastRenewMs: nowMs)

proc megabytes(bytes: int64): string =
  formatFloat(bytes.float / (1024.0 * 1024.0), ffDecimal, 1) & " MB"

proc startNote*(progress: DecodeProgress): JsonNode =
  ## The line to log before the decode, or nil for a body too small to
  ## bother anyone with.
  if progress.totalBytes < DecodeNoticeBytes:
    return nil
  %*{
    "event": "image:decode:start",
    "format": progress.format,
    "bytes": progress.totalBytes,
    "width": progress.targetWidth,
    "height": progress.targetHeight,
    "message": "decoding a " & megabytes(progress.totalBytes) & " " & progress.format &
      " into " & $progress.targetWidth & "x" & $progress.targetHeight &
      "; a file this large takes a while on a frame, progress follows every " &
      $(DecodeProgressIntervalMs div 1000) & " s",
  }

proc restart*(progress: var DecodeProgress, nowMs: int64) =
  ## The source was rewound: a degrade rung or the next strip of a
  ## progressive JPEG reads the body again.
  inc progress.pass
  progress.bytes = 0
  progress.passStartedMs = nowMs

proc progressNote(progress: DecodeProgress, nowMs: int64): JsonNode =
  let elapsed = nowMs - progress.startedMs
  let passElapsed = nowMs - progress.passStartedMs
  result = %*{
    "event": "image:decode:progress",
    "format": progress.format,
    "bytes": progress.bytes,
    "totalBytes": progress.totalBytes,
    "pass": progress.pass,
    "elapsedMs": elapsed,
  }
  if progress.totalBytes > 0 and progress.bytes > 0:
    let percent = int(progress.bytes * 100 div progress.totalBytes.int64)
    result["percent"] = %*percent
    # The rate of this pass, applied to what this pass has left.
    let remaining = max(0'i64, progress.totalBytes.int64 - progress.bytes)
    result["etaMs"] = %*(passElapsed * remaining div progress.bytes)

proc advance*(progress: var DecodeProgress, bytes: int, nowMs: int64):
    tuple[note: JsonNode, renew: bool] =
  ## `bytes` more of the source were just consumed. Returns the progress
  ## line to log (nil between intervals) and whether the run's deadline is
  ## due for a renewal.
  if bytes > 0:
    progress.bytes += bytes
  result.note = nil
  result.renew = false
  if nowMs - progress.lastRenewMs >= DecodeRenewIntervalMs:
    progress.lastRenewMs = nowMs
    result.renew = true
  if nowMs - progress.lastNoteMs >= DecodeProgressIntervalMs:
    progress.lastNoteMs = nowMs
    result.note = progress.progressNote(nowMs)
