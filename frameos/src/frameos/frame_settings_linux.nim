## The settings panel's frame page on a Linux frame (system/sceneSettings,
## docs/scene-settings.md "The frame page"): the facts it shows and what it
## sets. The ESP32's twin is embedded/esp32/main/fos_frame_settings.c.
##
## - Wi-Fi goes through the portal's own code (portal.nim: NetworkManager or
##   wpa_supplicant, whichever the image runs), on a thread of its own: a
##   scan or a join takes seconds, and the runner draws the panel meanwhile.
## - The rotation and the scale go through the persist a cloud `set_settings`
##   takes (server/api.nim), then a reload or a restart, whichever the change
##   needs. One `settings:frame` line says what was set, for a backend to
##   adopt (app/utils/frame_settings_adopt.py); the cloud follows the hello's
##   hardware report (cloud/enrollment.nim hardwarePayload).
## - The page is offered while the frame's control plane leaves
##   `frameSettingsOnScreen` on, or an unlock file is on the boot partition
##   (frame_settings_lock.nim).
##
## Threads: the hooks run on the runner thread and read the config the hooks
## are handed at install (a value: the frame.json on disk, read again, is the
## truth). The worker gets the runtime by handle (portal.nim RuntimeHandle)
## and hands back plain values under `factsLock`. No ref crosses.

import std/[algorithm, json, locks, osproc, strutils, times]
import frameos/types
import frameos/channels
import frameos/config
import frameos/events_gen
import frameos/portal as netportal
import frameos/frame_settings_lock
import frameos/cloud/link_state
import frameos/server/api
from frameos/upgrade import installedFrameOSVersion
import system/sceneSettings/scene as sceneSettings

const
  MaxNetworks = 64 ## as many as the ESP32 lists
  ScanFreshSeconds = 30.0 ## a scan when the page comes up, unless one is this fresh

type
  JobKind = enum jkStatus, jkScan, jkJoin
  Job = object
    kind: JobKind
    ssid, password: string

  WifiFacts = object
    ## What the worker last found, as values.
    known: bool       ## a status has been read
    device: string    ## "" = no Wi-Fi to set here
    connected: bool
    hotspot: bool
    ssid, hotspotSsid, ip: string
    networks: seq[string]
    scannedAt: float
    scanning, joining: bool
    note: string      ## what the last join could not do

var
  factsLock: Lock
  facts: WifiFacts
  jobs: Channel[Job]
  worker: Thread[netportal.RuntimeHandle]
  workerStarted = false
  pageOpen = false ## guarded by factsLock: redraw on news only while it shows
  runtime: netportal.RuntimeHandle

initLock(factsLock)

proc nowSeconds(): float = epochTime()

proc byName(a, b: string): int = cmp(a.toLowerAscii(), b.toLowerAscii())

proc addressOf(device: string): string =
  ## The device's IPv4 address, from `ip` (iproute2 and busybox both).
  if device.len == 0:
    return ""
  try:
    let (output, rc) = execCmdEx("ip -4 addr show dev " & quoteShell(device))
    if rc != 0:
      return ""
    for line in output.splitLines():
      let parts = line.strip().splitWhitespace()
      if parts.len >= 2 and parts[0] == "inet":
        return parts[1].split('/')[0]
  except CatchableError:
    discard

proc news() =
  ## Something changed under the page: draw it again if it shows.
  var open = false
  withLock factsLock:
    open = pageOpen
  if open:
    sendEvent(evRender, newJObject(), eoSystem)

proc readStatus(handle: netportal.RuntimeHandle) {.gcsafe.} =
  {.cast(gcsafe).}:
    let frameOS {.cursor.} = cast[FrameOS](pointer(handle))
    let device = netportal.getWifiDevice()
    var status: JsonNode
    try:
      status = netportal.activeConnectionStatus(frameOS)
    except CatchableError:
      status = %*{}
    let hotspot = netportal.isHotspotActive(frameOS)
    let ssid = status{"ssid"}.getStr()
    let connected = status{"connected"}.getBool() and not hotspot
    let ip = if connected: addressOf(device) else: ""
    let hotspotSsid = block:
      let config = netportal.portalRequestConfig(frameOS)
      if config != nil and config.network != nil: config.network.wifiHotspotSsid else: ""
    withLock factsLock:
      facts.known = true
      facts.device = device
      facts.connected = connected
      facts.hotspot = hotspot
      if ssid.len > 0 or not connected:
        facts.ssid = ssid
      facts.hotspotSsid = hotspotSsid
      facts.ip = ip

proc scan(handle: netportal.RuntimeHandle) {.gcsafe.} =
  {.cast(gcsafe).}:
    let frameOS {.cursor.} = cast[FrameOS](pointer(handle))
    var names: seq[string]
    try:
      names = netportal.availableNetworks(frameOS)
    except CatchableError:
      names = @[]
    names.sort(byName)
    if names.len > MaxNetworks:
      names.setLen(MaxNetworks)
    withLock factsLock:
      facts.networks = names
      facts.scannedAt = nowSeconds()
      facts.scanning = false

proc join(handle: netportal.RuntimeHandle, ssid, password: string) {.gcsafe.} =
  {.cast(gcsafe).}:
    let frameOS {.cursor.} = cast[FrameOS](pointer(handle))
    var ok = false
    try:
      let config = netportal.portalRequestConfig(frameOS)
      # A frame on its setup hotspot lets it go first, as the portal's form
      # does, and raises it again when the join fails.
      let hotspot = netportal.isHotspotActive(frameOS)
      if hotspot:
        netportal.stopAp(frameOS)
      # The panel stays up: no switch to the first scene after the join.
      ok = netportal.attemptConnect(frameOS, config, ssid, password, showFirstScene = false)
      if not ok and hotspot:
        netportal.startAp(frameOS, config)
    except CatchableError:
      ok = false
    withLock factsLock:
      facts.joining = false
      facts.note = if ok: "" else: "Could not join \xe2\x80\x9c" & ssid & "\xe2\x80\x9d"
      if ok:
        facts.ssid = ssid
    log(%*{"event": "settings:frame:wifi", "origin": "panel", "ok": ok})

proc workerLoop(handle: netportal.RuntimeHandle) {.thread.} =
  while true:
    let job = jobs.recv()
    case job.kind
    of jkStatus: readStatus(handle)
    of jkScan:
      readStatus(handle)
      scan(handle)
    of jkJoin:
      join(handle, job.ssid, job.password)
      readStatus(handle)
    news()

proc queue(job: sink Job) =
  if not workerStarted:
    jobs.open()
    createThread(worker, workerLoop, runtime)
    workerStarted = true
  jobs.send(job)

# ------------------------------------------------------------------ the hooks

var
  hookConfig {.threadvar.}: FrameConfig
  hookGeneration {.threadvar.}: int

proc runnerConfig(): FrameConfig =
  ## The runner thread's own copy of frame.json (readConfig: nothing shared),
  ## read again whenever the live one moved (a save here, a deploy, a push).
  {.cast(gcsafe).}:
    let generation = currentFrameConfigGeneration()
    if hookConfig.isNil or generation != hookGeneration:
      try:
        hookConfig = readConfig()
        hookGeneration = generation
      except CatchableError:
        discard
    hookConfig

proc managedBy(config: FrameConfig): string =
  try:
    if isManagedLink(loadCloudLinkState()):
      return "FrameOS Cloud"
  except CatchableError:
    discard
  if config != nil and config.serverHost.len > 0 and config.serverApiKey.len > 0:
    return "FrameOS backend"

proc linuxFrameSettingsRead*(): JsonNode {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      let config = runnerConfig()
      if config == nil or not framePageOffered(config):
        return nil
      var f: WifiFacts
      withLock factsLock:
        f = facts
      result = %*{"rotate": config.rotate, "renderScale": config.renderScale,
        "version": installedFrameOSVersion(), "actions": ["restart"]}
      let manager = managedBy(config)
      if manager.len > 0:
        result["managedBy"] = %manager
      if f.note.len > 0:
        result["note"] = %f.note
      if not f.known or f.device.len > 0:
        let state =
          if f.joining: "connecting"
          elif f.hotspot: "hotspot"
          elif f.connected: "connected"
          elif f.ssid.len == 0: "unset"
          else: "off"
        var wifi = %*{"state": state, "ssid": f.ssid, "scanning": f.scanning,
          # The runtime never holds the password (NetworkManager or the
          # supplicant does): an empty one is an open network.
          "password": false, "networks": f.networks}
        if f.hotspot:
          wifi["hotspot"] = %f.hotspotSsid
        if f.connected and f.ip.len > 0:
          wifi["ip"] = %f.ip
        result["wifi"] = wifi
    except Exception:
      result = nil

proc linuxFrameSettingsAction*(action: string) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      case action
      of "open":
        var fresh = false
        withLock factsLock:
          pageOpen = true
          fresh = facts.scanning or nowSeconds() - facts.scannedAt < ScanFreshSeconds
          if not fresh:
            facts.scanning = true
        queue(Job(kind: if fresh: jkStatus else: jkScan))
      of "scan":
        withLock factsLock:
          facts.scanning = true
        queue(Job(kind: jkScan))
      of "close":
        withLock factsLock:
          pageOpen = false
      else:
        discard
    except Exception:
      discard

proc linuxFrameSettingsApply*(changes: JsonNode) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      let ssid = changes{"wifiSsid"}
      if not ssid.isNil and ssid.kind == JString and ssid.getStr().len > 0:
        var same = false
        withLock factsLock:
          same = facts.connected and facts.ssid == ssid.getStr() and changes{"wifiPassword"}.getStr().len == 0
          if not same:
            facts.joining = true
            facts.note = ""
        if not same:
          queue(Job(kind: jkJoin, ssid: ssid.getStr(), password: changes{"wifiPassword"}.getStr()))
      # The rotation and the scale, through the persist a cloud push takes.
      var payload = newJObject()
      let rotate = changes{"rotate"}
      if not rotate.isNil and rotate.kind == JInt and rotate.getInt() in [0, 90, 180, 270]:
        payload["rotate"] = rotate
      let scale = changes{"renderScale"}
      if not scale.isNil and scale.kind in {JInt, JFloat} and scale.getFloat() >= 0 and scale.getFloat() <= 4:
        payload["render_scale"] = %scale.getFloat()
      if payload.len == 0:
        return
      let preview = previewFrameApiUpdate(payload)
      if not preview.change.any:
        return
      persistFrameApiUpdate(payload)
      var line = %*{"event": "settings:frame", "source": "linux", "origin": "panel"}
      if payload.hasKey("rotate"):
        line["rotate"] = payload["rotate"]
      if payload.hasKey("render_scale"):
        line["renderScale"] = payload["render_scale"]
      log(line)
      # The runtime's own consequence of new settings, as after a cloud push.
      sendEvent(if preview.change.restart: evRestart else: evReload, newJObject(), eoSystem)
    except Exception as error:
      log(%*{"event": "settings:frame:error", "origin": "panel", "error": error.msg})

proc installFrameSettingsHooks*(frameOS: FrameOS) =
  ## Once, at startup, before the runner draws anything. The runtime's one
  ## FrameOS outlives every thread, so the worker takes it by handle.
  runtime = netportal.runtimeHandle(frameOS)
  sceneSettings.frameSettingsRead = linuxFrameSettingsRead
  sceneSettings.frameSettingsApply = linuxFrameSettingsApply
  sceneSettings.frameSettingsAction = linuxFrameSettingsAction
