## Unattended FrameOS upgrades — the `autoUpdate` channel in frame.json.
##
## Three channels. `stable` (the default): once a day this thread asks
## GitHub for the latest release for this install's target and installs it
## once it has been the latest for AutoUpdateStableAgeSeconds (a day) — a
## fix published within that day replaces it as "latest" and resets the
## clock, so the release the fix was for is never installed. `latest`: every
## release as soon as it is published. `off`: never check.
##
## The check runs at 04:xx local — the minute is fixed per frame from its
## name, so a fleet does not all ask GitHub in the same second — and when a
## release qualifies it starts the SAME detached upgrade the admin panel's
## Upgrade button and the cloud's `notify_update_available` nudge start
## (frameos/upgrade.nim: download, minisign verify, stage, restart). Nothing
## here chooses what gets installed: the release channel and the signing key
## are the binary's own, and a provider can only pick the channel.
##
## A frame that cannot take a generic release skips with a logged reason and
## does not retry until the next day: a source build carrying compiled scenes
## (the release binary has none, so the upgrade would drop them), an
## unversioned dev binary, an OS target with no published release. The check
## is quiet — a release that does not qualify costs one bounded metadata GET
## and one log line, never a spawned upgrade process.
##
## The channel is re-read every pass, so a settings save (local admin, backend
## fast deploy, cloud set_settings) takes effect without a restart — the
## `reload` event copies the new frame.json into the shared FrameConfig ref
## (runner.nim), same as metricsInterval in metrics.nim.

import hashes
import json
import os
import strutils
import times

import frameos/channels
import frameos/types
import frameos/upgrade
import scenes/scenes as compiledScenes

const
  AutoUpdateHour* = 4
  ## How long a release must have been the latest before `stable` installs it.
  AutoUpdateStableAgeSeconds* = 24 * 60 * 60

var autoUpdaterThread: Thread[FrameOS]
var autoUpdaterStarted = false

proc autoUpdateMinute*(frameName: string): int =
  ## 0..59, the same every day for one frame name.
  (int(hash(frameName)) and 0x7fffffff) mod 60

proc shouldRunAutoUpdate*(dt: DateTime, lastRunDate: string, minute: int, hour = AutoUpdateHour): bool =
  ## Due once per calendar day, at or after hour:minute local time.
  let today = dt.format("yyyy-MM-dd")
  let currentMinute = dt.hour * 60 + dt.minute
  let dueHour = if hour >= 0 and hour <= 23: hour else: AutoUpdateHour
  let dueMinute = dueHour * 60 + (if minute >= 0 and minute <= 59: minute else: 0)
  result = currentMinute >= dueMinute and today != lastRunDate

proc compiledScenesBlockAutoUpdate*(sceneIds: openArray[string]): bool =
  ## A release binary compiles in exactly one scene, the repository's
  ## "default" boot scene; any other compiled-in id came from a source build
  ## with legacy compiled scenes, which a generic release would drop.
  for id in sceneIds:
    if id != "default":
      return true
  false

proc hasCompiledScenes(): bool =
  var ids: seq[string] = @[]
  for (id, _) in compiledScenes.sceneOptions:
    ids.add(id.string)
  compiledScenesBlockAutoUpdate(ids)

proc releaseAgeSeconds*(publishedAt: string, now: DateTime): int =
  ## Seconds since GitHub's `published_at` (ISO 8601 UTC); -1 when the stamp
  ## is missing or unreadable, so "unknown" can never pass as "old enough".
  let stamp = publishedAt.strip()
  if stamp.len == 0:
    return -1
  try:
    let published = parse(stamp, "yyyy-MM-dd'T'HH:mm:ss'Z'", utc())
    result = int((now.utc() - published).inSeconds)
  except CatchableError:
    result = -1

proc releaseQualifies*(channel: string, publishedAt: string, now: DateTime,
                       minAge = AutoUpdateStableAgeSeconds): tuple[ok: bool, reason: string] =
  ## Whether the latest release may be installed on `channel`. On `stable`
  ## the answer is "it has been the latest for at least minAge seconds";
  ## an unreadable publish time waits rather than installs.
  case channel
  of "latest":
    (true, "")
  of "stable":
    let age = releaseAgeSeconds(publishedAt, now)
    if age < 0:
      (false, "publish_time_unknown")
    elif age < minAge:
      (false, "waiting_for_stable")
    else:
      (true, "")
  else:
    (false, "disabled")

proc autoUpdateLog(payload: JsonNode) {.gcsafe.} =
  var line = payload
  line["event"] = %"frameos:auto_update"
  log(line)

proc runAutoUpdateOnce*(frameConfig: FrameConfig, now = now()): JsonNode {.gcsafe.} =
  ## One daily pass. Returns the line it logged (status: skipped / up_to_date
  ## / scheduled / error) so a caller can test the decision.
  {.gcsafe.}:
    let channel = if frameConfig == nil: "off" else: frameConfig.autoUpdate
    if channel notin ["stable", "latest"]:
      result = %*{"status": "skipped", "reason": "disabled", "channel": channel}
      autoUpdateLog(result)
      return
    if hasCompiledScenes():
      result = %*{"status": "skipped", "reason": "compiled_scenes", "channel": channel,
                  "message": "This binary carries compiled scenes a release build would drop; deploy from the backend instead."}
      autoUpdateLog(result)
      return
    if frameOSUpgradeInFlight():
      result = %*{"status": "skipped", "reason": "already_in_flight", "channel": channel}
      autoUpdateLog(result)
      return
    let currentVersion = installedFrameOSVersion()
    if currentVersion == "unknown":
      result = %*{"status": "skipped", "reason": "unversioned_build", "channel": channel,
                  "message": "This FrameOS binary carries no release version; automatic updates need an installed release."}
      autoUpdateLog(result)
      return
    try:
      let target = detectUpgradeTarget()
      let release = latestFrameOSRelease(target)
      if compareFrameOSVersions(currentVersion, release.version) >= 0:
        result = %*{"status": "up_to_date", "channel": channel, "current_version": currentVersion,
                    "latest_version": release.version, "target": target}
        autoUpdateLog(result)
        return
      let verdict = releaseQualifies(channel, release.publishedAt, now)
      if not verdict.ok:
        result = %*{"status": "skipped", "reason": verdict.reason, "channel": channel,
                    "current_version": currentVersion, "latest_version": release.version,
                    "published_at": release.publishedAt,
                    "age_seconds": releaseAgeSeconds(release.publishedAt, now),
                    "min_age_seconds": AutoUpdateStableAgeSeconds}
        autoUpdateLog(result)
        return
      discard scheduleFrameOSUpgrade()
      result = %*{"status": "scheduled", "channel": channel, "current_version": currentVersion,
                  "latest_version": release.version, "target": target}
      autoUpdateLog(result)
    except CatchableError as error:
      result = %*{"status": "error", "channel": channel, "current_version": currentVersion,
                  "message": error.msg}
      autoUpdateLog(result)

proc start(self: FrameOS) =
  var lastRunDate = ""
  while true:
    let dt = now()
    let config = self.frameConfig
    if config != nil and config.autoUpdate in ["stable", "latest"] and
        shouldRunAutoUpdate(dt, lastRunDate, autoUpdateMinute(config.name)):
      lastRunDate = dt.format("yyyy-MM-dd")
      try:
        discard runAutoUpdateOnce(config)
      except CatchableError as e:
        autoUpdateLog(%*{"status": "error", "message": e.msg})

    let now2 = now()
    if now2.minute == dt.minute:
      sleep((60 - now2.second) * 1000)
    else:
      sleep(1000)

proc createThreadRunner(frameOS: FrameOS) {.thread.} =
  frameOS.start()

proc startAutoUpdater*(frameOS: FrameOS) =
  if autoUpdaterStarted:
    return
  createThread(autoUpdaterThread, createThreadRunner, frameOS)
  autoUpdaterStarted = true
