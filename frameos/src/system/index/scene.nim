{.warning[UnusedImport]: off.}
import pixie, json, strformat, strutils, sequtils, options, os, tables, algorithm
import std/monotimes
import std/times
import std/uri
import zippy

import frameos/values
import frameos/types
import frameos/channels
import frameos/cloud/link_state
import frameos/utils/url
import frameos/utils/time
import frameos/utils/local_time
import frameos/utils/status_screen
import frameos/render_stats
import frameos/version
import scenes/scenes as compiledScenes
import system/options as sceneOptions

# Sockets exist on the device runtimes only — the wasm/embedded builds render
# this scene too, and there the address lines just say "unknown".
when not defined(frameosWasm) and not defined(frameosEmbedded):
  import std/net as system_net

const DEBUG = true
let PUBLIC_STATE_FIELDS*: seq[StateField] = @[]
let PERSISTED_STATE_KEYS*: seq[string] = @[]

const
  # HDMI: the mark's three squares cycle the brand colours while this screen
  # is up — the frame is alive, it just has nothing to show. Paced by how long
  # a frame takes on this board (render_stats), never by a fixed frame rate.
  animatedMarkDevices = ["framebuffer"]
  # Plain framebuffer / LCD writes: cheap enough to redraw once a minute for
  # the clock. Everything else (e-ink) keeps the 5-minute refresh and shows
  # the time without seconds — a panel flash a minute is not worth a clock.
  cheapRedrawDevices = ["framebuffer", "inkyHyperPixel2r", "inkyHyperPixel2rLegacyFb"]
  markCycleSeconds = 6.0
  staticRefreshSeconds = 300.0

type Scene* = ref object of FrameScene

proc loadInterpretedSceneOptions(): seq[(SceneId, string)] =
  var data = ""
  let envPath = getEnv("FRAMEOS_SCENES_JSON")
  if envPath.len > 0:
    try:
      if envPath.endsWith(".gz") and fileExists(envPath):
        data = uncompress(readFile(envPath))
      elif fileExists(envPath):
        data = readFile(envPath)
    except CatchableError:
      data = ""
  if data.len == 0:
    try:
      if fileExists("./scenes.json.gz"):
        data = uncompress(readFile("./scenes.json.gz"))
      elif fileExists("./scenes.json"):
        data = readFile("./scenes.json")
    except CatchableError:
      data = ""
  if data.len == 0:
    return @[]
  try:
    let parsed = parseJson(data)
    if parsed.kind == JArray:
      for scene in parsed.items:
        if scene.kind != JObject or not scene.hasKey("id"):
          continue
        let idStr = scene["id"].getStr()
        if idStr.len == 0:
          continue
        let nameStr = if scene.hasKey("name"): scene["name"].getStr() else: idStr
        result.add((SceneId(idStr), nameStr))
  except JsonParsingError, CatchableError:
    discard

proc buildSceneList*(self: Scene): seq[(string, string)] =
  var entries = initOrderedTable[string, string]()
  for (sceneId, sceneName) in compiledScenes.sceneOptions:
    entries[sceneId.string] = sceneName
  for (sceneId, sceneName) in loadInterpretedSceneOptions():
    if not entries.hasKey(sceneId.string):
      entries[sceneId.string] = sceneName
  for (sceneId, sceneName) in sceneOptions.sceneOptions:
    if sceneId.string.startsWith("system/"):
      continue
    entries[sceneId.string] = sceneName
  var ordered: seq[(string, string)] = @[]
  for key, value in entries:
    ordered.add((key, value))
  ordered.sort(proc(a, b: (string, string)): int = cmpIgnoreCase(a[1], b[1]))
  return ordered

proc defaultRouteInterface*(): string =
  ## The interface carrying the default route ("wlan0", "eth0"), from
  ## /proc/net/route — Linux only, empty anywhere else. Pure file read, no
  ## child processes.
  try:
    if fileExists("/proc/net/route"):
      for line in readFile("/proc/net/route").splitLines():
        let cols = line.splitWhitespace()
        if cols.len >= 2 and cols[1] == "00000000":
          return cols[0]
  except CatchableError:
    discard
  ""

proc mdnsHostname*(): string =
  ## `<hostname>.local` for the name the system actually carries (first boot
  ## writes /etc/hostname from the card's frame name); empty for the image
  ## default `frame`, so callers fall back to whatever frame.json says.
  when defined(frameosWasm) or defined(frameosEmbedded):
    ""
  else:
    var name = ""
    try:
      if fileExists("/etc/hostname"):
        name = readFile("/etc/hostname").strip()
    except CatchableError:
      discard
    if name.len == 0 or name == "frame" or name == "localhost" or name.contains('.'):
      return ""
    name & ".local"

proc primaryIpAddress*(): string =
  ## The local address the kernel would route external traffic through:
  ## "connect" a UDP socket to a public address (no packet is sent) and read
  ## the socket's own address back. Empty when there is no usable network.
  when defined(frameosWasm) or defined(frameosEmbedded):
    ""
  else:
    try:
      let socket = system_net.newSocket(system_net.Domain.AF_INET,
        system_net.SockType.SOCK_DGRAM, system_net.Protocol.IPPROTO_UDP)
      defer: socket.close()
      socket.connect("1.1.1.1", system_net.Port(53))
      let (address, _) = socket.getLocalAddr()
      if address.len > 0 and address != "0.0.0.0":
        return address
      ""
    except CatchableError:
      ""

proc cloudProviderHostname(state: JsonNode): string =
  let providerUrl = providerUrlFromState(state)
  try:
    let parsed = parseUri(providerUrl)
    if parsed.hostname.len > 0:
      return parsed.hostname
  except CatchableError:
    discard
  providerUrl

proc managementLine*(frameConfig: FrameConfig): string =
  ## Who controls this frame: FrameOS Cloud (managed enrollment), a
  ## self-hosted backend, or nobody (standalone). The old "Server:
  ## not configured:8989" line lied on cloud-managed frames, whose
  ## server_host is deliberately empty.
  let linkState = loadCloudLinkState()
  if linkState{"mode"}.getStr("") == "managed":
    let host = cloudProviderHostname(linkState)
    let status = linkState{"status"}.getStr("disconnected")
    return &"Managed via: FrameOS Cloud ({host}, {status})"
  let serverHost = frameConfig.serverHost
  if serverHost.len > 0 and serverHost notin ["localhost", "127.0.0.1", "::1"]:
    let serverPort = if frameConfig.serverPort > 0: $frameConfig.serverPort else: "?"
    return &"Managed via: self-hosted backend ({serverHost}:{serverPort})"
  "Managed via: standalone (no server configured)"

proc remoteControlSecurityLine*(frameConfig: FrameConfig): string =
  ## Transport truth for the "Remote control" line: over what kind of link
  ## remote commands actually reach this frame. Cloud-managed frames dial the
  ## provider over the enrollment URL (https everywhere outside dev setups);
  ## backend-managed frames run the frameos-remote agent, which speaks TLS
  ## exactly when the port says so (443/8443/… — the agent's own dial rule).
  ## Empty when remote control is off.
  let linkState = loadCloudLinkState()
  if linkState{"mode"}.getStr("") == "managed":
    let providerUrl = providerUrlFromState(linkState)
    let host = cloudProviderHostname(linkState)
    if providerUrl.startsWith("https://"):
      return &"  over an encrypted HTTPS connection to {host}"
    return &"  over an UNENCRYPTED http connection to {host} — fine on a trusted local network, not beyond it"
  if frameConfig.agent != nil and frameConfig.agent.agentEnabled:
    let serverHost = if frameConfig.serverHost.len > 0: frameConfig.serverHost else: "?"
    let port = if frameConfig.serverPort <= 0: 443 else: frameConfig.serverPort
    if port mod 1000 == 443:
      return &"  over an encrypted TLS connection to {serverHost}:{port}"
    return &"  over an UNENCRYPTED connection to {serverHost}:{port} — commands are signed, but traffic is readable on the network"
  ""

proc animatesMark*(frameConfig: FrameConfig): bool =
  ## Whether the mark animates here: HDMI on a device build. The browser
  ## preview and the ESP32 (e-ink, hashed refreshes) draw the static logo.
  when defined(frameosWasm) or defined(frameosEmbedded):
    false
  else:
    frameConfig.device in animatedMarkDevices

proc redrawsCheaply*(frameConfig: FrameConfig): bool =
  frameConfig.device in cheapRedrawDevices

proc markPhaseAt*(epoch: float): float =
  ## Animation phase for wall-clock `epoch`: time-based, so a slow board that
  ## only manages a frame every 2 s steps through the same cycle a fast one
  ## glides through. Never exactly 0 while animating (0 = the static logo).
  let phase = (epoch mod markCycleSeconds) / markCycleSeconds
  if phase <= 0: 1.0 / markPhaseSteps.float else: phase

proc clockLine*(frameConfig: FrameConfig, epoch: float, withSeconds: bool): string =
  ## "14:32:05 · Tuesday, 26 August 2026" in the frame's configured zone.
  let local = frameLocalTime(frameConfig.timeZone, epoch)
  let clock = if withSeconds: local.format("HH:mm:ss") else: local.format("HH:mm")
  clock & " · " & local.format("dddd, d MMMM yyyy")

proc lastButtonLine*(self: Scene): string =
  ## "Last button: Next (GPIO 5) at 14:32:05" from the most recent GPIO press
  ## this scene saw; empty until one arrives.
  let last = self.state{"lastButton"}
  if last.isNil or last.kind != JObject:
    return ""
  let label = last{"label"}.getStr("")
  let pin = last{"pin"}.getInt(-1)
  let at = last{"at"}.getFloat(0)
  var what = if label.len > 0: label else: "button"
  if pin >= 0:
    what.add(&" (GPIO {pin})")
  let pressedAt = if at > 0: " at " & frameLocalTime(self.frameConfig.timeZone, at).format("HH:mm:ss") else: ""
  &"Last button: {what}{pressedAt}"

proc buildStatusScreen*(self: Scene, epoch = epochTime()): StatusScreen =
  ## The facts on the panel, as rows for frameos/utils/status_screen — the
  ## same screen the Pi boot sequence and the ESP32 fallback scene draw.
  let entries = self.buildSceneList()
  let frameConfig = self.frameConfig
  let animating = animatesMark(frameConfig)
  let deviceName = if frameConfig.name.len > 0: frameConfig.name else: "Unnamed frame"
  let deviceType = if frameConfig.device.len > 0: frameConfig.device else: "unknown device"
  var deviceLine = &"{deviceType} · {frameConfig.width}×{frameConfig.height}"
  if frameConfig.rotate != 0:
    deviceLine.add(&" · rotated {frameConfig.rotate}°")
  let ipAddress = primaryIpAddress()
  let networkInterface = defaultRouteInterface()
  let networkLine =
    if ipAddress.len > 0 and networkInterface.len > 0:
      &"{ipAddress} ({networkInterface})"
    elif ipAddress.len > 0:
      ipAddress
    else:
      "not connected"
  # 0.0.0.0 means "listening everywhere" — as a URL it helps nobody, so show
  # the address the network actually reaches this frame on when we know it.
  # The image default `frame.local` is just as useless once first boot has
  # given the card its own hostname (a cloud card is named after its frame,
  # `uus2w.local`, and two cards on one network cannot both be frame.local):
  # advertise the name the network really resolves.
  let configuredFrameHost = if frameConfig.frameHost.len > 0: frameConfig.frameHost else: "0.0.0.0"
  let mdnsHost = mdnsHostname()
  let frameHost =
    if configuredFrameHost == "0.0.0.0" and ipAddress.len > 0: ipAddress
    elif configuredFrameHost in ["0.0.0.0", "frame.local"] and mdnsHost.len > 0: mdnsHost
    else: configuredFrameHost
  let framePort = if publicPort(frameConfig) > 0: $publicPort(frameConfig) else: "?"
  let frameUrl = &"{publicScheme(frameConfig)}://{frameHost}:{framePort}"
  # A name that needs mDNS to resolve is not always enough (phones, VPNs,
  # Windows without Bonjour), so the "open this" hint also carries the plain
  # address when the two differ.
  let ipUrl =
    if ipAddress.len > 0 and frameHost != ipAddress: &"{publicScheme(frameConfig)}://{ipAddress}:{framePort}"
    else: ""
  # A private frame with no admin login answers that URL with a bare 401 and
  # nothing on the page says why: the only key that opens it is
  # frameAccessKey, which nothing ever shows the owner (2026-09-04, a cloud
  # card booted without a claim token). Decision: while the frame is still
  # unconfigured — nothing installed, nobody managing it — the panel prints
  # the `?k=` link. Whoever can read the display may set the frame up, which
  # is the same trust the setup hotspot extends; the moment an admin login
  # exists `/` redirects to it instead, so the key stays off the panel.
  let adminAuth = if frameConfig.frameAdminAuth == nil: newJObject() else: frameConfig.frameAdminAuth
  let adminPanel = adminAuth{"enabled"}.getBool(false) and
    adminAuth{"user"}.getStr("").len > 0 and adminAuth{"pass"}.getStr("").len > 0
  let accessQuery =
    if frameConfig.frameAccess == "private" and not adminPanel and frameConfig.frameAccessKey.len > 0:
      "/?k=" & frameConfig.frameAccessKey
    else: ""
  let openHint =
    if ipUrl.len > 0: &"{frameUrl}{accessQuery} (or {ipUrl}{accessQuery})"
    else: frameUrl & accessQuery
  # Cloud-managed frames take remote commands over the provider link even
  # when the self-hosted agent flag is off — "disabled" would be a lie there.
  let linkState = loadCloudLinkState()
  let cloudManaged = linkState{"mode"}.getStr("") == "managed"
  let cloudConnected = cloudManaged and linkState{"status"}.getStr("") == "connected"
  let remoteControl =
    if cloudManaged or (frameConfig.agent != nil and frameConfig.agent.agentEnabled): "enabled"
    else: "disabled"
  let remoteSecurity = remoteControlSecurityLine(frameConfig).strip()
  let remoteLine = if remoteSecurity.len > 0: remoteControl & " — " & remoteSecurity else: remoteControl
  let management = managementLine(frameConfig)
  let managedVia = management[("Managed via: ".len) .. ^1]

  result.dark = true
  result.markPhase = if animating: markPhaseAt(epoch) else: 0.0
  result.bar = self.lastButtonLine()
  result.rows = @[
    ("Name", deviceName),
    ("Device", deviceLine),
    # Seconds only where the screen is redrawn often enough for them to be
    # true (the animated HDMI screen); a minute clock elsewhere.
    ("Time", clockLine(frameConfig, epoch, withSeconds = animating)),
    ("Time zone", frameConfig.timeZone),
    ("Network", networkLine),
    ("Managed via", managedVia),
    ("Frame", frameUrl),
    ("Remote control", remoteLine),
  ]
  let version = publishedFrameOSVersion(compiledFrameOSVersion())
  result.footer = if version.len == 0 or version == "unknown": "FrameOS" else: "FrameOS v" & version
  if entries.len == 0:
    # What to do next depends on who is in charge of this frame.
    result.status =
      if cloudConnected: "Connected to FrameOS Cloud. Add a scene from the workspace to get started."
      elif cloudManaged: "Connecting to FrameOS Cloud…"
      elif managedVia.startsWith("self-hosted"): "Waiting for the backend to deploy a scene."
      else: &"No scenes installed yet. Open {openHint} to add one."
    result.notes = @["No scenes installed yet."]
  else:
    result.status =
      if entries.len == 1: "1 scene installed."
      else: &"{entries.len} scenes installed."
    result.notes = @["Installed scenes"]
    for idx, (sceneId, sceneName) in entries.pairs:
      result.notes.add(&"{idx + 1}. {sceneName}")

proc buildSceneListText*(self: Scene): string =
  ## The screen as text — what the tests and the admin API see.
  statusScreenText(self.buildStatusScreen())

proc paceRefresh*(self: Scene, drawSeconds: float, epoch = epochTime()) =
  ## Decides when this screen renders next. Animating: as often as the
  ## board affords at a ~20% duty cycle (drawing + the driver's push, the
  ## latter measured by the runner) — a Pi 5 glides, a Pi Zero steps, neither
  ## pegs a core showing a logo. Cheap redraw without animation: the top of
  ## the next minute, for the clock. E-ink: the plain 5-minute refresh.
  if animatesMark(self.frameConfig):
    self.refreshInterval = pacedRenderInterval(drawSeconds, lastDriverRenderSeconds())
  elif redrawsCheaply(self.frameConfig):
    self.refreshInterval = max(60.0 - (epoch mod 60.0), 1.0)
  else:
    self.refreshInterval = staticRefreshSeconds

proc runNode*(self: Scene, nodeId: NodeId, context: ExecutionContext) =
  let timer = getMonoTime()
  case nodeId:
  of 1.NodeId:
    if context.hasImage and not context.image.isNil:
      drawStatusScreen(context.image, self.buildStatusScreen())
      self.paceRefresh(durationToSeconds(getMonoTime() - timer))
  else:
    discard
  # The animated screen renders several times a second; its per-frame debug
  # line would drown the frame log.
  if DEBUG and self.refreshInterval >= 1:
    let elapsedMs = durationToMilliseconds(getMonoTime() - timer)
    self.logger.log(%*{"event": "debug:scene", "node": nodeId, "ms": elapsedMs})

proc runEvent*(self: Scene, context: ExecutionContext) =
  case context.event:
  of "render":
    try:
      self.runNode(1.NodeId, context)
    except CatchableError as e:
      self.logger.log(%*{"event": "render:error", "node": 1, "error": $e.msg,
        "stacktrace": e.getStackTrace()})
  of "setSceneState":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      let payload = context.payload["state"]
      for field in PUBLIC_STATE_FIELDS:
        let key = field.name
        if payload.hasKey(key) and payload[key] != self.state{key}:
          self.state[key] = copy(payload[key])
    if context.payload.hasKey("render"):
      sendEvent("render", %*{})
  of "setCurrentScene":
    if context.payload.hasKey("state") and context.payload["state"].kind == JObject:
      let payload = context.payload["state"]
      for field in PUBLIC_STATE_FIELDS:
        let key = field.name
        if payload.hasKey(key) and payload[key] != self.state{key}:
          self.state[key] = copy(payload[key])
  of "button":
    # A GPIO press (drivers/gpioButton, or the ESP32's fos_buttons): remember
    # it for the bottom bar and redraw now rather than at the next interval.
    self.state["lastButton"] = %*{
      "pin": context.payload{"pin"}.getInt(-1),
      "label": context.payload{"label"}.getStr(""),
      "level": context.payload{"level"}.getInt(-1),
      "at": epochTime(),
    }
    sendEvent("render", %*{})
  else:
    discard

proc runEvent*(self: FrameScene, context: ExecutionContext) =
  runEvent(Scene(self), context)

proc render*(self: FrameScene, context: ExecutionContext): Image =
  let self = Scene(self)
  context.image.fill(self.backgroundColor)
  runEvent(self, context)
  return context.image

proc init*(sceneId: SceneId, frameConfig: FrameConfig, logger: Logger, persistedState: JsonNode): FrameScene =
  var state = %*{}
  if persistedState.kind == JObject:
    for key in persistedState.keys:
      state[key] = persistedState[key]
  let scene = Scene(
    id: sceneId,
    frameConfig: frameConfig,
    state: state,
    logger: logger,
    refreshInterval: staticRefreshSeconds,
    backgroundColor: parseHtmlColor("#000000")
  )
  let self = scene
  result = scene
  var context = ExecutionContext(scene: scene, event: "init", payload: state, hasImage: false, loopIndex: 0, loopKey: ".")
  scene.execNode = (proc(nodeId: NodeId, context: ExecutionContext) = scene.runNode(nodeId, context))
  scene.getDataNode = (proc(nodeId: NodeId, context: ExecutionContext): Value = scene.getDataNode(nodeId, context))
  runEvent(self, context)

var exportedScene* = ExportedScene(
  publicStateFields: PUBLIC_STATE_FIELDS,
  persistedStateKeys: PERSISTED_STATE_KEYS,
  init: init,
  runEvent: runEvent,
  render: render
)
