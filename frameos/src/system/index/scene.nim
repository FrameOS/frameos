{.warning[UnusedImport]: off.}
import pixie, json, strformat, strutils, sequtils, options, os, tables, algorithm
import std/monotimes
import std/uri
import zippy

import frameos/values
import frameos/types
import frameos/channels
import frameos/cloud/link_state
import frameos/utils/url
import frameos/utils/time
import frameos/utils/status_screen
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

proc buildStatusScreen*(self: Scene): StatusScreen =
  ## The facts on the panel, as rows for frameos/utils/status_screen — the
  ## same screen the Pi boot sequence and the ESP32 fallback scene draw.
  let entries = self.buildSceneList()
  let frameConfig = self.frameConfig
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
  let configuredFrameHost = if frameConfig.frameHost.len > 0: frameConfig.frameHost else: "0.0.0.0"
  let frameHost =
    if configuredFrameHost == "0.0.0.0" and ipAddress.len > 0: ipAddress
    else: configuredFrameHost
  let framePort = if publicPort(frameConfig) > 0: $publicPort(frameConfig) else: "?"
  let frameUrl = &"{publicScheme(frameConfig)}://{frameHost}:{framePort}"
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
  result.rows = @[
    ("Name", deviceName),
    ("Device", deviceLine),
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
      else: &"No scenes installed yet. Open {frameUrl} to add one."
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

proc runNode*(self: Scene, nodeId: NodeId, context: ExecutionContext) =
  let timer = getMonoTime()
  case nodeId:
  of 1.NodeId:
    if context.hasImage and not context.image.isNil:
      drawStatusScreen(context.image, self.buildStatusScreen())
  else:
    discard
  if DEBUG:
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
    refreshInterval: 300.0,
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
