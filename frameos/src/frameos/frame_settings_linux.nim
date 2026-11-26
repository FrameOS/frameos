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

import std/[algorithm, json, locks, os, osproc, strutils, times]
import frameos/types
import frameos/channels
import frameos/config
import frameos/events_gen
import frameos/portal as netportal
import frameos/frame_settings_lock
import frameos/cloud/link_state
import frameos/local_access
from frameos/cloud/device_flow import activeLinkCode, writePendingLinkCode, pendingLinkCodeQueued,
  clearPendingLinkCode, loadPendingLinkCode, dropPanelLinkAtStart, PANEL_LINK_SECONDS, cloudRequest
from frameos/cloud/hub_client import refreshLocalNetworkPolicy
from frameos/cloud/enrollment import otherControlPlaneActive, loadPendingEnrollment
import frameos/server/api
import frameos/frame_service_keys
from frameos/utils/system import readFileNoFollow, writePrivateFile
from frameos/upgrade import installedFrameOSVersion
import frameos/about_linux
import system/sceneSettings/scene as sceneSettings

const
  MaxNetworks = 64 ## as many as the ESP32 lists
  ServiceKeysPath* = "./state/service_keys.json"
    ## The service keys typed on the frame page (frame_service_keys.nim): under state/,
    ## which no deploy rewrites, as the frame's own and no plane's.
  ScanFreshSeconds = 30.0 ## a scan when the page comes up, unless one is this fresh

type
  JobKind = enum jkStatus, jkScan, jkJoin, jkUnlink
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
  liveConfig: pointer
    ## The runtime's FrameConfig, uncounted (portal.nim's RuntimeHandle says
    ## why): it lives as long as the process, and only the runner writes it.

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

proc unlink() {.gcsafe.} =
  ## The frame page's Unlink, asked twice there (docs/scene-settings.md
  ## "Unlinking"), on the worker: the plane being left hears it first, then
  ## the frame forgets it, as the admin page's Disconnect (the cloud) and a
  ## Save that clears the server (a backend) do. The scenes stay.
  # Nothing shared: each read is its own parse, and the config is a private copy.
  {.cast(gcsafe).}:
    var
      cloudLinked = false
      providerUrl = ""
      accessToken = ""
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      if isManagedLink(state) or state{"status"}.getStr() == "connected":
        cloudLinked = true
        providerUrl = providerUrlFromState(state)
        accessToken = state{"access_token"}.getStr()
    if cloudLinked:
      if accessToken.len > 0:
        try:
          discard cloudRequest(providerUrl, "/api/backends/unlink", accessToken = accessToken, body = %*{})
        except CatchableError:
          discard # it leaves while the cloud is down too
      withLock cloudLinkLock:
        let state = loadCloudLinkState()
        resetLinkState(state)
        saveCloudLinkState(state)
      clearPendingLinkCode()
      refreshLocalNetworkPolicy(requestFrameConfig())
      log(%*{"event": "settings:frame:unlink", "origin": "panel", "plane": "cloud"})
      sendEvent(evRender, newJObject(), eoSystem)
      return
    let payload = %*{"server_host": ""}
    let preview = previewFrameApiUpdate(payload)
    if preview.existing{"serverHost"}.getStr().len == 0:
      return
    let notice = backendChangeNotice(preview.existing, preview.next)
    if notice != nil:
      log(notice)
      discard notifyPreviousBackend(preview.existing, notice)
    persistFrameApiUpdate(payload)
    log(%*{"event": "settings:frame:unlink", "origin": "panel", "plane": "backend"})
    sendEvent(evRestart, newJObject(), eoSystem)

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
    of jkUnlink:
      try:
        unlink()
      except Exception as error:
        log(%*{"event": "settings:frame:unlink:error", "origin": "panel", "error": error.msg})
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

proc cloudLinkFacts(): tuple[managed, connecting, connected: bool, providerUrl: string] =
  ## The cloud link as the page needs it: enrolled, a device flow under way,
  ## linked at all (a direct link that manages nothing still holds the
  ## frame's one link), and the provider a new link goes to.
  try:
    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      result.managed = isManagedLink(state)
      result.connecting = state{"status"}.getStr() == "connecting"
      result.connected = state{"status"}.getStr() == "connected"
      result.providerUrl = providerUrlFromState(state)
  except CatchableError:
    result.providerUrl = DEFAULT_CLOUD_PROVIDER_URL

proc linkFacts(config: FrameConfig, f: WifiFacts, result: JsonNode) =
  ## Connecting a control plane from the frame page (docs/scene-settings.md
  ## "Connecting the frame"): offered to a frame no plane holds and that has a
  ## panel to show the code on (it is a presence code: the runner keeps no
  ## picture while one shows, so a frame that is only a picture could never
  ## show it), and, while one is under way, its code, where it is entered and
  ## what the page's QR code says: the cloud's page with the code in it, or
  ## the frame's address and code, which the backend's Adopt frame form takes
  ## pasted.
  let
    cloud = cloudLinkFacts()
    code = activeLinkCode()
    adoptCode = if pendingLocalAccessScope() == LocalAccessScopeAdopt: activeLocalAccessCode() else: ""
    linking = code.active or cloud.connecting or pendingLinkCodeQueued()
  if adoptCode.len > 0:
    let
      host = if f.connected and f.ip.len > 0: f.ip else: config.frameHost
      where = if config.framePort in [0, 80]: host else: host & ":" & $config.framePort
    result["link"] = %*{"to": "backend", "code": adoptCode, "where": where, "qr": where & " " & adoptCode}
  elif linking:
    var where = code.verificationUri
    if where.len == 0: where = code.verificationUriComplete.split('?')[0]
    let scheme = where.find("://")
    if scheme >= 0: where = where[scheme + 3 .. ^1]
    result["link"] = %*{"to": "cloud", "code": code.userCode, "where": where,
      "qr": if code.verificationUriComplete.len > 0: code.verificationUriComplete else: code.verificationUri}
    # Where it goes, which the page shows and lets be changed, and why the
    # queued link has no code if it stopped or has had no answer
    # (device_flow.nim deviceFlowTick).
    let pending = loadPendingLinkCode()
    var server = cloud.providerUrl
    if pending != nil:
      let queued = normalizeProviderUrl(pending{"provider_url"}.getStr())
      if queued.len > 0: server = queued
      if not code.active and pending{"failed"}.getStr().len > 0:
        result["link"]["failed"] = pending{"failed"}
        result["link"]["detail"] = %pending{"detail"}.getStr()
    result["link"]["server"] = %server
  if not linking and adoptCode.len == 0 and (cloud.managed or cloud.connected or managedBy(config).len > 0):
    # Leaving the plane that manages it (the page asks twice).
    result["actions"].add %"unlink"
  if linking or adoptCode.len > 0 or cloud.managed or cloud.connected or f.hotspot or
      managedBy(config).len > 0 or loadPendingEnrollment() != nil or not localAccessPanelDevice(config.device):
    return
  # A serverHost alone is a frame waiting to be adopted (the setup portal's
  # "backend" mode), which only the backend's adoption finishes; the cloud
  # refuses to enroll it (enrollment.nim otherControlPlaneActive).
  if not otherControlPlaneActive(config):
    result["actions"].add %"linkCloud"
  result["actions"].add %"adopt"

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
      # What the frame is (about_linux.nim), and where the plane that
      # manages it is.
      var about = linuxAboutFacts(f.device)
      if manager == "FrameOS backend":
        about["server"] = %(normalizeServerScheme(config.serverScheme, config.serverPort) & "://" &
          config.serverHost & ":" & $config.serverPort)
      elif manager.len > 0:
        about["server"] = %cloudLinkFacts().providerUrl
      result["about"] = about
      linkFacts(config, f, result)
    except Exception:
      result = nil

proc endPendingLinks() =
  ## A link under way ends: a device flow still waiting for its code to be
  ## entered (or one queued, or stopped), and an adoption code. Never a link
  ## made, never a local network access code.
  clearPendingLinkCode()
  withLock cloudLinkLock:
    let state = loadCloudLinkState()
    if state{"status"}.getStr() == "connecting" and not isManagedLink(state):
      resetLinkState(state)
      saveCloudLinkState(state)
  clearLocalAccessChallenge(LocalAccessScopeAdopt)

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
        # Left the page, however (Back, the scene's settings, another scene,
        # a window beside it): a pairing code lives only while its page is up
        # (docs/scene-settings.md "Connecting the frame").
        endPendingLinks()
      of "unlink":
        queue(Job(kind: jkUnlink))
      of "linkCloud", "adopt", "cancelLink":
        # Connecting a control plane (docs/scene-settings.md "Connecting the
        # frame"): whatever was under way ends (a device flow still waiting
        # for its code to be approved, an adoption code; never a link made or
        # a local network access code), and the one asked for starts. The hub
        # thread runs the device flow (device_flow.nim deviceFlowTick): no
        # network on the runner. The page shows either code.
        endPendingLinks()
        let config = runnerConfig()
        let cloud = cloudLinkFacts()
        if action != "cancelLink" and config != nil and localAccessPanelDevice(config.device) and
            not cloud.managed:
          if action == "adopt":
            discard startLocalAccessChallenge(LocalAccessScopeAdopt)
          elif otherControlPlaneActive(config) or
              not writePendingLinkCode(cloud.providerUrl, epochTime() + PANEL_LINK_SECONDS.float):
            return
          log(%*{"event": "settings:frame:" & action, "origin": "panel"})
        sendEvent(evRender, newJObject(), eoSystem)
      else:
        discard
    except Exception:
      discard

proc applyCloudUrl(typed: string) =
  ## The cloud's address from the Connect page (docs/scene-settings.md
  ## "Connecting the frame"): where a link goes from now on (the link
  ## state's provider_url, as the admin page's link sets it), "" for
  ## FrameOS Cloud's own. A link waiting for its code starts over against it;
  ## an established one is never moved.
  var url = typed.strip()
  if url.len > 0 and "://" notin url:
    url = "https://" & url
  url = if url.len == 0: DEFAULT_CLOUD_PROVIDER_URL else: normalizeProviderUrl(url)
  let problem = if url.len == 0: "The address must be an http(s) URL" else: providerTransportProblem(url)
  if problem.len > 0:
    withLock factsLock:
      facts.note = problem
    return
  var moved = false
  withLock cloudLinkLock:
    let state = loadCloudLinkState()
    if isManagedLink(state) or state{"status"}.getStr() == "connected":
      return
    if providerUrlFromState(state) != url:
      if state{"status"}.getStr() == "connecting":
        resetLinkState(state)
      state["provider_url"] = %url
      saveCloudLinkState(state)
      moved = true
  let pending = loadPendingLinkCode()
  if pending != nil and (moved or pending{"provider_url"}.getStr() != url):
    # Its clock keeps running: a new address is no new time for the code.
    discard writePendingLinkCode(url, pending{"until"}.getFloat(0))
  withLock factsLock:
    facts.note = ""
  log(%*{"event": "settings:frame:cloudUrl", "origin": "panel", "cloudUrl": url})
  sendEvent(evRender, newJObject(), eoSystem)

proc linuxFrameSettingsApply*(changes: JsonNode) {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      let cloudUrl = changes{"cloudUrl"}
      if not cloudUrl.isNil and cloudUrl.kind == JString:
        applyCloudUrl(cloudUrl.getStr())
      if not changes{"wifiSsid"}.isNil or not changes{"wifiPassword"}.isNil:
        # A password alone is for the saved network.
        var
          ssid = changes{"wifiSsid"}.getStr()
          same = false
        let password = changes{"wifiPassword"}.getStr()
        withLock factsLock:
          if ssid.len == 0:
            ssid = facts.ssid
          same = ssid.len == 0 or facts.connected and facts.ssid == ssid and password.len == 0
          if not same:
            facts.joining = true
            facts.note = ""
        if not same:
          queue(Job(kind: jkJoin, ssid: ssid, password: password))
      # The rotation and the scale that differ from the frame's, through the
      # persist a cloud push takes.
      let config = runnerConfig()
      var payload = newJObject()
      let rotate = changes{"rotate"}
      if not rotate.isNil and rotate.kind == JInt and rotate.getInt() in [0, 90, 180, 270] and
          (config.isNil or rotate.getInt() != config.rotate):
        payload["rotate"] = rotate
      let scale = changes{"renderScale"}
      if not scale.isNil and scale.kind in {JInt, JFloat} and scale.getFloat() >= 0 and scale.getFloat() <= 4 and
          (config.isNil or scale.getFloat() != config.renderScale):
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
      if not payload.hasKey("rotate") and not liveConfig.isNil:
        # The scale alone: every render reads it off the live config, so it is
        # set there and drawn now. A reload would rebuild every scene, this
        # page among them, which would come back empty.
        let live {.cursor.} = cast[FrameConfig](liveConfig)
        withLiveConfigLock:
          live.renderScale = payload["render_scale"].getFloat()
        noteFrameConfigChanged()
        sendEvent(evRender, newJObject(), eoSystem)
      else:
        # The runtime's own consequence of new settings, as after a cloud push.
        sendEvent(if preview.change.restart: evRestart else: evReload, newJObject(), eoSystem)
    except Exception as error:
      log(%*{"event": "settings:frame:error", "origin": "panel", "error": error.msg})

proc linuxServiceKeysLoad*(): string {.nimcall, gcsafe, raises: [].} =
  try:
    if fileExists(ServiceKeysPath):
      result = readFileNoFollow(ServiceKeysPath, 4 * MaxServiceKeysBytes)
  except Exception:
    result = ""

proc linuxServiceKeysSave*(text: string): bool {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    try:
      createDir(parentDir(ServiceKeysPath))
      writePrivateFile(ServiceKeysPath, text)
      result = true
    except Exception as error:
      try:
        log(%*{"event": "settings:frame:keys:error", "origin": "panel", "error": error.msg})
      except Exception:
        discard

proc setLiveConfigForTest*(config: FrameConfig) =
  liveConfig = cast[pointer](config)

proc installFrameSettingsHooks*(frameOS: FrameOS) =
  ## Once, at startup, before the runner draws anything. The runtime's one
  ## FrameOS outlives every thread, so the worker takes it by handle.
  runtime = netportal.runtimeHandle(frameOS)
  liveConfig = cast[pointer](frameOS.frameConfig)
  # The page is not up after a start: a link it asked for ends here.
  dropPanelLinkAtStart()
  sceneSettings.frameSettingsRead = linuxFrameSettingsRead
  sceneSettings.frameSettingsApply = linuxFrameSettingsApply
  sceneSettings.frameSettingsAction = linuxFrameSettingsAction
  serviceKeysLoad = linuxServiceKeysLoad
  serviceKeysSave = linuxServiceKeysSave
