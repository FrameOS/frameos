import std/[json, strutils]

## Backend-independent plumbing for every network command FrameOS issues.
##
## Why this exists: the armv6 (Pi Zero W) buildroot image ships without
## NetworkManager - its Kconfig dependencies do not resolve on ARM1176, so
## Buildroot silently dropped the package. `nmcli` is therefore missing and the
## frame could neither join Wi-Fi nor raise its setup hotspot. Rather than
## force NetworkManager onto armv6 we pick a backend at runtime: NetworkManager
## where it exists (every 64-bit frame in the field), wpa_supplicant + hostapd
## everywhere else.

type
  NetCmdResult* = tuple[output: string, rc: int]

  NetworkContext* = ref object
    ## Every side effect the backends perform, injected so tests can stub the
    ## daemons and assert on the exact commands. Mirrors the CloudVerbContext
    ## pattern in frameos/cloud/hub_client.nim.
    ##
    ## `run` must be bounded (see frameos/utils/process.nim): raw osproc has
    ## deadlocked frames before, so nothing here may spawn a process directly.
    run*: proc(cmd: string, loggedCmd: string): NetCmdResult {.gcsafe.}
    sleep*: proc(ms: int) {.gcsafe.}
    log*: proc(ev: string, extra: JsonNode) {.gcsafe.}
    writeFile*: proc(path, content: string, mode: int): bool {.gcsafe.}
    readFile*: proc(path: string): string {.gcsafe.}
    pathExists*: proc(path: string): bool {.gcsafe.}

  NetworkBackendKind* = enum
    nbUnknown = "unknown"
    nbNetworkManager = "networkManager"
    nbSupplicant = "supplicant"

  NetworkToolProbe* = object
    ## Which of the small daemons/CLIs are actually installed on this image.
    hasNmcli*: bool
    nmRunning*: bool
    hasWpaSupplicant*: bool
    hasWpaCli*: bool
    hasWpaPassphrase*: bool
    hasHostapd*: bool
    hasIw*: bool
    hasDnsmasq*: bool
    hasUdhcpd*: bool
    dhcpClients*: seq[string]

  NetworkBackendChoice* = object
    kind*: NetworkBackendKind
    reason*: string
    ## Non-empty when the choice is unusable or an override asked for a
    ## backend whose tooling is missing. Actionable on purpose: a bare
    ## "sh: nmcli: not found" tells nobody what to install.
    error*: string

const
  ## Probed in one shell round-trip; keep in sync with parseToolProbe.
  networkToolNames* = [
    "nmcli", "wpa_supplicant", "wpa_cli", "wpa_passphrase", "hostapd", "iw",
    "dnsmasq", "udhcpd", "udhcpc", "dhcpcd", "dhclient",
  ]
  ## Preference order: udhcpc is what busybox images have, dhcpcd is the
  ## Raspberry Pi OS default, dhclient is the Debian fallback.
  dhcpClientPreference* = ["udhcpc", "dhcpcd", "dhclient"]

proc toolProbeCommand*(): string =
  ## One `command -v` sweep instead of one process per tool.
  var checks: seq[string] = @[]
  for tool in networkToolNames:
    checks.add("command -v " & tool & " >/dev/null 2>&1 && echo " & tool)
  checks.join("; ") & "; true"

proc parseToolProbe*(output: string): NetworkToolProbe =
  ## Reads the tool names echoed by toolProbeCommand(). Unknown lines are
  ## ignored so a noisy shell profile cannot break detection.
  for rawLine in output.splitLines():
    case rawLine.strip()
    of "nmcli": result.hasNmcli = true
    of "wpa_supplicant": result.hasWpaSupplicant = true
    of "wpa_cli": result.hasWpaCli = true
    of "wpa_passphrase": result.hasWpaPassphrase = true
    of "hostapd": result.hasHostapd = true
    of "iw": result.hasIw = true
    of "dnsmasq": result.hasDnsmasq = true
    of "udhcpd": result.hasUdhcpd = true
    of "udhcpc", "dhcpcd", "dhclient":
      let name = rawLine.strip()
      if name notin result.dhcpClients:
        result.dhcpClients.add(name)
    else: discard

proc parseNmRunning*(output: string): bool =
  ## `nmcli -t -f RUNNING general status` prints exactly "running" when the
  ## daemon answers. Matching whole lines matters: the failure message
  ## ("Error: NetworkManager is not running.") also contains the word.
  for line in output.splitLines():
    if line.strip() == "running":
      return true
  false

proc pickDhcpClient*(available: openArray[string]): string =
  ## Detect, never assume: buildroot gives us busybox udhcpc, Raspberry Pi OS
  ## gives dhcpcd, plain Debian gives dhclient.
  for candidate in dhcpClientPreference:
    for name in available:
      if name == candidate:
        return candidate
  ""

proc normalizeBackendOverride*(raw: string): string =
  ## Accepts the spellings a human would type into frameos.json or the
  ## FRAMEOS_NETWORK_BACKEND env var. Returns "auto", "networkManager",
  ## "supplicant" or "" for an unrecognised value.
  let value = raw.strip().toLowerAscii().replace("-", "").replace("_", "")
  case value
  of "", "auto", "detect": "auto"
  of "networkmanager", "nm", "nmcli": $nbNetworkManager
  of "supplicant", "wpasupplicant", "wpa", "hostapd": $nbSupplicant
  else: ""

proc missingToolsMessage*(probe: NetworkToolProbe): string =
  var missing: seq[string] = @[]
  if not probe.hasWpaSupplicant: missing.add("wpa_supplicant")
  if not probe.hasHostapd: missing.add("hostapd")
  if not probe.hasIw and not probe.hasWpaCli: missing.add("iw or wpa_cli")
  if not probe.hasDnsmasq and not probe.hasUdhcpd: missing.add("dnsmasq or udhcpd")
  if probe.dhcpClients.len == 0: missing.add("udhcpc, dhcpcd or dhclient")
  missing.join(", ")

proc chooseNetworkBackend*(override: string, probe: NetworkToolProbe): NetworkBackendChoice =
  ## Pure so the selection rules are testable without touching a real system.
  let normalized = normalizeBackendOverride(override)

  if normalized == $nbNetworkManager:
    result = NetworkBackendChoice(kind: nbNetworkManager, reason: "override")
    if not probe.hasNmcli:
      result.error = "Network backend override requested NetworkManager, but nmcli is not installed."
    return

  if normalized == $nbSupplicant:
    result = NetworkBackendChoice(kind: nbSupplicant, reason: "override")
    if not probe.hasWpaSupplicant:
      result.error = "Network backend override requested wpa_supplicant, but it is not installed."
    elif missingToolsMessage(probe).len > 0:
      result.error = "wpa_supplicant backend is missing: " & missingToolsMessage(probe)
    return

  if normalized.len == 0:
    # Unknown override value: fall through to auto-detection, but say so.
    result.error = "Unknown network backend '" & override.strip() & "', falling back to auto-detection."

  if probe.hasNmcli and probe.nmRunning:
    result.kind = nbNetworkManager
    result.reason = "nmcli present and NetworkManager running"
    return

  if probe.hasWpaSupplicant:
    result.kind = nbSupplicant
    result.reason =
      if probe.hasNmcli: "NetworkManager installed but not running; using wpa_supplicant"
      else: "nmcli not installed; using wpa_supplicant"
    let missing = missingToolsMessage(probe)
    if missing.len > 0:
      result.error = "wpa_supplicant backend is missing: " & missing
    return

  if probe.hasNmcli:
    # NM is installed but not answering (yet). Nothing else can drive the
    # radio, so keep the historical behaviour instead of failing hard.
    result.kind = nbNetworkManager
    result.reason = "nmcli present but NetworkManager not running; no alternative available"
    return

  result.kind = nbUnknown
  result.reason = "no supported tooling found"
  result.error =
    "No usable network backend: neither nmcli (NetworkManager) nor wpa_supplicant is installed. " &
    "Install NetworkManager, or wpa_supplicant plus hostapd, iw and dnsmasq/udhcpd."

proc networkDiagnosticsCommand*(): string =
  ## One bounded shell round-trip that answers "the interface is up, so why
  ## does nothing resolve?": where /etc/resolv.conf points and what is in it,
  ## what systemd-resolved thinks (the resolver glibc actually asks on
  ## buildroot images), the nsswitch order, addresses, routes and the last
  ## DHCP lease summary. Every step tolerates its tool being absent; the
  ## output is capped so a log line cannot balloon.
  [
    "echo '## resolv.conf'; ls -l /etc/resolv.conf 2>&1; cat /etc/resolv.conf 2>&1",
    "echo '## nsswitch'; grep '^hosts:' /etc/nsswitch.conf 2>/dev/null",
    "echo '## resolvectl'; command -v resolvectl >/dev/null 2>&1 && resolvectl status 2>&1",
    "echo '## addr'; ip -4 -br addr 2>&1",
    "echo '## route'; ip -4 route 2>&1",
    "echo '## dhcp lease'; cat /run/frameos/udhcpc-*.lease 2>/dev/null",
    "true",
  ].join("; ") & " 2>&1 | head -c 4000"

proc probeNetworkTools*(ctx: NetworkContext): NetworkToolProbe =
  ## Runs the bounded probe commands through the injected runner.
  let (output, _) = ctx.run(toolProbeCommand(), "")
  result = parseToolProbe(output)
  if result.hasNmcli:
    # `general status` is a D-Bus property read NetworkManager allows every
    # user, so try it plainly first: the Buildroot runtime is not root and
    # has no sudo, and a probe that silently failed there used to send an
    # NM image down the wpa_supplicant path.
    let (nmOutput, _) = ctx.run(
      "(nmcli -t -f RUNNING general status 2>/dev/null || sudo -n nmcli -t -f RUNNING general status 2>/dev/null) || true", "")
    result.nmRunning = parseNmRunning(nmOutput)
