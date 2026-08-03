import std/[algorithm, json, strutils]
import frameos/network/backend

## The non-NetworkManager network backend: wpa_supplicant for joining
## networks, hostapd + dnsmasq/udhcpd for the setup hotspot, iw/wpa_cli for
## scanning. This is what the armv6 buildroot image (Pi Zero W) has - see
## frameos/network/backend.nim for why.
##
## Everything here funnels through NetworkContext.run, which portal.nim wires
## to the bounded runners in frameos/utils/process.nim. Nothing may spawn a
## process directly.

const
  ## Persisted config lives on the state partition, mirroring how
  ## buildroot_image.py bind-mounts /srv/frameos/state/NetworkManager/
  ## system-connections onto /etc/NetworkManager/system-connections. The image
  ## does the same for /etc/wpa_supplicant, so writing the standard path both
  ## survives a reboot and is what wpa_supplicant@<iface>.service reads.
  supplicantConfDir* = "/etc/wpa_supplicant"
  supplicantStateConfDir* = "/srv/frameos/state/wpa_supplicant"
  ## Credentials baked into an SD image arrive as NetworkManager keyfiles
  ## (backend/app/tasks/buildroot_image.py writes /boot/frameos-wifi.nmconnection,
  ## and the first-boot script installs it below). Nothing on a non-NM image
  ## reads those, so this backend imports them into its own config - see
  ## importNmKeyfiles. Both locations are listed because the state dir is the
  ## bind-mount source for the /etc one and the mount may not be up yet.
  nmConnectionDirs* = [
    "/etc/NetworkManager/system-connections",
    "/srv/frameos/state/NetworkManager/system-connections",
  ]
  ## Generated daemon configs live on the state partition too. The image ships
  ## a 142 KB upstream sample as /etc/hostapd.conf; we never touch it.
  networkStateDir* = "/srv/frameos/state/network"
  hostapdConfPath* = networkStateDir & "/hostapd.conf"
  udhcpdConfPath* = networkStateDir & "/udhcpd.conf"
  ## Pid and lease files must NOT survive a reboot - a stale pid file would
  ## make "is the hotspot up?" answer yes about somebody else's process.
  networkRunDir* = "/run/frameos"
  hostapdPidPath* = networkRunDir & "/hostapd.pid"
  dnsmasqPidPath* = networkRunDir & "/dnsmasq.pid"
  udhcpdLeasePath* = networkRunDir & "/udhcpd.leases"
  udhcpdPidPath* = networkRunDir & "/udhcpd.pid"
  ## wpa_cli's compiled-in default. /var/run is a symlink to /run on both
  ## buildroot-systemd and Debian, so this one path works everywhere.
  wpaCtrlDir* = "/var/run/wpa_supplicant"
  ## busybox udhcpc's default lease handler; passed explicitly because a
  ## udhcpc without a script configures nothing.
  udhcpcScriptPath* = "/usr/share/udhcpc/default.script"
  ## Same address NetworkManager's `ipv4.method shared` hands out, so the
  ## captive setup portal keeps the address users may have bookmarked.
  hotspotAddress* = "10.42.0.1"
  hotspotCidr* = hotspotAddress & "/24"
  hotspotDhcpStart* = "10.42.0.10"
  hotspotDhcpEnd* = "10.42.0.200"
  hotspotNetmask* = "255.255.255.0"
  hotspotChannel* = 6
  ## `--wait 15` on the nmcli path; the association poll gets the same budget.
  associateAttempts* = 15
  associateDelayMs* = 1000
  scanSettleMs* = 2500

type
  ConfResult* = object
    conf*: string
    error*: string

  SupplicantOpResult* = object
    ok*: bool
    message*: string

  WifiStatus* = object
    connected*: bool
    ssid*: string
    ipAddress*: string
    state*: string

  NmWifiCredentials* = object
    ## One NetworkManager keyfile, reduced to what wpa_supplicant needs.
    id*: string
    ssid*: string
    psk*: string
    ## Lowercase NM spelling ("wpa-psk", "sae", "none", ...); "" when the
    ## keyfile has no [wifi-security] section at all, i.e. an open network.
    keyMgmt*: string
    usable*: bool
    ## Why an otherwise-parsed keyfile was not turned into a network block.
    ## Never contains the PSK.
    skipReason*: string

  ImportResult* = object
    ## Outcome of folding NetworkManager keyfiles into wpa_supplicant.conf.
    imported*: seq[string]
    skipped*: seq[string]
    changed*: bool
    path*: string
    error*: string

proc shq(s: string): string =
  ## Shell-safe single-quote wrapper (POSIX), same as portal.nim's.
  "'" & s.replace("'", "'\"'\"'") & "'"

# ---------------------------------------------------------------------------
# Pure parsing helpers
# ---------------------------------------------------------------------------

proc sortedUniqueSsids*(ssids: openArray[string]): seq[string] =
  ## Deduped and case-insensitively sorted. The nmcli path returns nmcli's own
  ## signal-ordered list; `iw scan` output order is essentially arbitrary, so
  ## we sort to give the portal UI (which sorts the same way) a stable list.
  for raw in ssids:
    let ssid = raw.strip()
    if ssid.len > 0 and ssid notin result:
      result.add(ssid)
  result.sort(proc(a, b: string): int = cmpIgnoreCase(a, b))

proc parseIwScanSsids*(output: string): seq[string] =
  ## Reads `iw dev <dev> scan`. Hidden networks show up as `SSID: ` or as
  ## escaped NUL bytes (`\x00`); both are dropped.
  var found: seq[string] = @[]
  for rawLine in output.splitLines():
    let line = rawLine.strip()
    if not line.startsWith("SSID:"):
      continue
    let ssid = line["SSID:".len .. ^1].strip()
    if ssid.len == 0 or ssid.replace("\\x00", "").strip().len == 0:
      continue
    found.add(ssid)
  sortedUniqueSsids(found)

proc parseWpaScanResults*(output: string): seq[string] =
  ## Reads `wpa_cli scan_results`: a header line followed by
  ## bssid / frequency / signal level / flags / ssid, tab separated.
  var found: seq[string] = @[]
  for rawLine in output.splitLines():
    let line = rawLine.strip(leading = false)
    if line.len == 0 or line.startsWith("bssid /") or line.startsWith("Selected interface"):
      continue
    let parts = line.split('\t')
    if parts.len < 5:
      continue
    found.add(parts[4])
  sortedUniqueSsids(found)

proc parseWpaStatus*(output: string): WifiStatus =
  ## Reads `wpa_cli status` key=value lines.
  for rawLine in output.splitLines():
    let line = rawLine.strip()
    let idx = line.find('=')
    if idx <= 0:
      continue
    let key = line[0 ..< idx]
    let value = line[idx + 1 .. ^1]
    case key
    of "wpa_state": result.state = value
    of "ssid": result.ssid = value
    of "ip_address": result.ipAddress = value
    else: discard
  result.connected = result.state == "COMPLETED"

proc parseIwLink*(output: string): WifiStatus =
  ## Fallback for images built without wpa_cli: `iw dev <dev> link` prints
  ## "Connected to <bssid> (on wlan0)" plus an "SSID: x" line, or
  ## "Not connected.".
  for rawLine in output.splitLines():
    let line = rawLine.strip()
    if line.startsWith("Connected to"):
      result.connected = true
      result.state = "COMPLETED"
    elif line.startsWith("Not connected"):
      result.state = "DISCONNECTED"
    elif line.startsWith("SSID:"):
      result.ssid = line["SSID:".len .. ^1].strip()

proc parseIwDevInterfaces*(output: string): seq[string] =
  ## Reads `iw dev`, which lists `Interface wlan0` under each phy.
  for rawLine in output.splitLines():
    let line = rawLine.strip()
    if line.startsWith("Interface "):
      let name = line["Interface ".len .. ^1].strip()
      if name.len > 0 and name notin result:
        result.add(name)

proc parseIpv4Address*(output: string): string =
  ## Reads `ip -4 addr show dev <dev>`: `inet 192.168.1.5/24 brd ...`.
  for rawLine in output.splitLines():
    let line = rawLine.strip()
    if not line.startsWith("inet "):
      continue
    let rest = line["inet ".len .. ^1].strip()
    let address = rest.split({' ', '\t'})[0]
    if address.len > 0:
      return address.split('/')[0]
  ""

# ---------------------------------------------------------------------------
# NetworkManager keyfile parsing
#
# Why: an SD image flashed with Wi-Fi credentials only ever gets them as a
# NetworkManager keyfile - buildroot_image.py bakes
# /boot/frameos-wifi.nmconnection and setup_json_reset.py's first-boot script
# installs it into /etc/NetworkManager/system-connections. On a board without
# NetworkManager (armv6 / Pi Zero W) nothing reads that file, so the frame
# booted with credentials it could not see. These helpers turn a keyfile into
# the wpa_supplicant network block it describes.
# ---------------------------------------------------------------------------

proc unescapeNmKeyfileValue*(raw: string): string =
  ## Reverse of the escaping in buildroot_image.py's `_nm_keyfile_value` and
  ## setup_json_reset.py's `nm_keyfile_escape` (both double backslashes), plus
  ## the rest of GKeyFile's escapes, which a keyfile written by NetworkManager
  ## itself can contain. Leading whitespace after `=` is not part of the value
  ## (GKeyFile skips it); a trailing CR from a CRLF file is dropped.
  var value = raw
  while value.len > 0 and (value[0] == ' ' or value[0] == '\t'):
    value = value[1 .. ^1]
  if value.len > 0 and value[^1] == '\r':
    value = value[0 ..< ^1]
  var i = 0
  while i < value.len:
    if value[i] != '\\' or i == value.high:
      result.add(value[i])
      inc i
      continue
    let escaped = value[i + 1]
    case escaped
    of '\\': result.add('\\')
    of 'n': result.add('\n')
    of 't': result.add('\t')
    of 'r': result.add('\r')
    of 's': result.add(' ')
    # Anything else keeps the escaped character verbatim, which is what
    # GKeyFile does for e.g. "\;".
    else: result.add(escaped)
    i += 2

proc parseNmWifiKeyfile*(content: string): NmWifiCredentials =
  ## Reads one .nmconnection file. `usable` is false (with a `skipReason`) for
  ## anything this backend cannot express: non-Wi-Fi profiles, hotspot (AP)
  ## profiles, enterprise auth, and PSK profiles whose secret is not stored in
  ## the file. `skipReason` never contains the PSK.
  var section = ""
  var connType = ""
  var mode = ""
  var hasSecuritySection = false
  var pskFlags = ""
  for rawLine in content.splitLines():
    let line = rawLine.strip()
    if line.len == 0 or line.startsWith("#") or line.startsWith(";"):
      continue
    if line.startsWith("["):
      let close = line.find(']')
      section = if close > 0: line[1 ..< close].strip().toLowerAscii() else: ""
      if section in ["wifi-security", "802-11-wireless-security"]:
        hasSecuritySection = true
      continue
    let idx = line.find('=')
    if idx <= 0:
      continue
    let key = line[0 ..< idx].strip().toLowerAscii()
    let value = unescapeNmKeyfileValue(line[idx + 1 .. ^1])
    case section
    of "connection":
      case key
      of "type": connType = value.strip().toLowerAscii()
      of "id": result.id = value
      else: discard
    of "wifi", "802-11-wireless":
      case key
      of "ssid": result.ssid = value
      of "mode": mode = value.strip().toLowerAscii()
      else: discard
    of "wifi-security", "802-11-wireless-security":
      case key
      of "psk": result.psk = value
      of "key-mgmt": result.keyMgmt = value.strip().toLowerAscii()
      of "psk-flags": pskFlags = value.strip()
      else: discard
    else: discard

  if connType.len > 0 and connType notin ["wifi", "802-11-wireless"]:
    result.skipReason = "not a Wi-Fi connection"
    return
  if result.ssid.len == 0:
    result.skipReason = "no SSID"
    return
  if mode.len > 0 and mode != "infrastructure":
    # "ap" / "adhoc": a hotspot profile is not a credential we can join.
    result.skipReason = "mode " & mode
    return
  if result.keyMgmt in ["wpa-eap", "ieee8021x", "wpa-eap-suite-b-192"]:
    result.skipReason = "enterprise key management (" & result.keyMgmt & ")"
    return
  if result.psk.len == 0:
    # An open network omits [wifi-security] entirely (that is what
    # setup_json_reset.py writes). A PSK profile with no stored secret is a
    # different thing: NetworkManager would prompt an agent for it, and
    # pretending it is an open network would both fail to associate and
    # suppress the setup hotspot, which is the user's only way back in.
    if hasSecuritySection and result.keyMgmt.len > 0 and result.keyMgmt != "none":
      result.skipReason =
        if pskFlags.len > 0 and pskFlags != "0": "PSK is not stored in the keyfile (psk-flags=" & pskFlags & ")"
        else: "no PSK for key-mgmt " & result.keyMgmt
      return
    result.keyMgmt = "none"
  result.usable = true

# ---------------------------------------------------------------------------
# Pure config generation
# ---------------------------------------------------------------------------

proc isHexString(value: string): bool =
  if value.len == 0:
    return false
  for c in value:
    if c notin {'0'..'9', 'a'..'f', 'A'..'F'}:
      return false
  true

proc isPrintableAscii(value: string): bool =
  for c in value:
    if c < ' ' or c > '~':
      return false
  true

proc toHex(value: string): string =
  const digits = "0123456789abcdef"
  for c in value:
    let b = uint8(c)
    result.add(digits[int(b shr 4)])
    result.add(digits[int(b and 0x0f)])

proc wpaQuote*(value: string): string =
  ## wpa_supplicant quoted strings escape backslash and double quote.
  result = "\""
  for c in value:
    if c == '\\' or c == '"':
      result.add('\\')
    result.add(c)
  result.add('"')

proc wpaSsidValue*(ssid: string): string =
  ## Printable SSIDs stay readable in the config; anything else (UTF-8,
  ## control bytes) becomes an unquoted hex string, which wpa_supplicant
  ## accepts and which cannot be mis-escaped.
  if isPrintableAscii(ssid): wpaQuote(ssid) else: toHex(ssid)

proc wpaSupplicantHeader*(countryCode = "", withCtrlInterface = true): string =
  ## withCtrlInterface is off when wpa_cli is absent: a wpa_supplicant built
  ## without CONFIG_CTRL_IFACE (which is how the current armv6 image ships)
  ## rejects the whole config file over an unknown ctrl_interface field, and
  ## then the frame has no Wi-Fi at all.
  result = "# Generated by FrameOS. Edits are overwritten on the next Wi-Fi setup.\n"
  if withCtrlInterface:
    result.add("ctrl_interface=" & wpaCtrlDir & "\n")
    result.add("ctrl_interface_group=0\n")
  result.add("update_config=1\n")
  let country = countryCode.strip().toUpperAscii()
  if country.len == 2:
    result.add("country=" & country & "\n")

proc buildWpaNetworkBlock*(ssid, password: string): ConfResult =
  ## One `network={ ... }` block. Split out of buildWpaSupplicantConf so
  ## imported NetworkManager keyfiles produce byte-identical blocks.
  if ssid.len == 0:
    return ConfResult(error: "Wi-Fi SSID is empty.")
  if ssid.len > 32:
    return ConfResult(error: "Wi-Fi SSID is longer than 32 bytes.")
  if ssid.contains('\n') or ssid.contains('\r'):
    return ConfResult(error: "Wi-Fi SSID contains a line break.")

  var netBlock = "network={\n    ssid=" & wpaSsidValue(ssid) & "\n    scan_ssid=1\n"
  if password.len == 0:
    # Open network: no key management at all, otherwise wpa_supplicant waits
    # forever for a handshake that never comes.
    netBlock.add("    key_mgmt=NONE\n")
  else:
    if password.contains('\n') or password.contains('\r'):
      return ConfResult(error: "Wi-Fi password contains a line break.")
    netBlock.add("    key_mgmt=WPA-PSK\n")
    if password.len == 64 and isHexString(password):
      netBlock.add("    psk=" & password.toLowerAscii() & "\n")
    elif password.len < 8 or password.len > 63:
      return ConfResult(error: "Wi-Fi password must be 8-63 characters (or a 64 character hex PSK).")
    else:
      netBlock.add("    psk=" & wpaQuote(password) & "\n")
  netBlock.add("}\n")
  ConfResult(conf: netBlock)

proc buildWpaSupplicantConf*(ssid, password: string, countryCode = "",
                            withCtrlInterface = true): ConfResult =
  ## Generates the whole wpa_supplicant.conf for a single network. Used when
  ## `wpa_passphrase` is unavailable, and as the open-network path.
  result = buildWpaNetworkBlock(ssid, password)
  if result.error.len > 0:
    return
  result.conf = wpaSupplicantHeader(countryCode, withCtrlInterface) & result.conf

proc unquoteWpaValue(value: string): string =
  ## Reverse of wpaQuote for a `"..."` value.
  var i = 1
  while i < value.high:
    if value[i] == '\\' and i + 1 < value.high:
      result.add(value[i + 1])
      i += 2
    else:
      result.add(value[i])
      inc i

proc fromHex(value: string): string =
  for i in countup(0, value.len - 2, 2):
    var byte = 0
    for j in 0 .. 1:
      let c = value[i + j]
      let digit =
        if c in {'0'..'9'}: int(c) - int('0')
        elif c in {'a'..'f'}: int(c) - int('a') + 10
        else: int(c) - int('A') + 10
      byte = byte * 16 + digit
    result.add(char(byte))

proc parseWpaConfSsids*(conf: string): seq[string] =
  ## Every SSID already present in a wpa_supplicant.conf, decoded from both
  ## the quoted and the hex form. This is what makes re-importing idempotent.
  for rawLine in conf.splitLines():
    let line = rawLine.strip()
    if not line.startsWith("ssid="):
      continue
    let value = line["ssid=".len .. ^1].strip()
    if value.len == 0:
      continue
    let decoded =
      if value.len >= 2 and value[0] == '"' and value[^1] == '"': unquoteWpaValue(value)
      elif value.len mod 2 == 0 and isHexString(value): fromHex(value)
      else: value
    if decoded.len > 0 and decoded notin result:
      result.add(decoded)

proc mergeImportedNetworks*(existingConf: string, credentials: openArray[NmWifiCredentials],
                            countryCode = "", withCtrlInterface = true):
                            tuple[conf: string, imported: seq[string], skipped: seq[string], changed: bool] =
  ## Appends a network block for every importable keyfile whose SSID is not in
  ## `existingConf` yet. Existing blocks are never rewritten: a config the
  ## portal wrote (possibly with a hashed PSK) outranks a baked-in keyfile,
  ## and re-running this is a no-op.
  var conf = existingConf
  var known = parseWpaConfSsids(existingConf)
  for cred in credentials:
    if not cred.usable:
      if cred.skipReason.len > 0:
        result.skipped.add((if cred.ssid.len > 0: cred.ssid else: cred.id) & ": " & cred.skipReason)
      continue
    if cred.ssid in known:
      continue
    let generated = buildWpaNetworkBlock(cred.ssid, cred.psk)
    if generated.error.len > 0:
      result.skipped.add(cred.ssid & ": " & generated.error)
      continue
    if conf.strip().len == 0:
      conf = wpaSupplicantHeader(countryCode, withCtrlInterface)
    elif not conf.endsWith("\n"):
      conf.add("\n")
    conf.add(generated.conf)
    known.add(cred.ssid)
    result.imported.add(cred.ssid)
  result.conf = conf
  result.changed = result.imported.len > 0

proc mergeWpaPassphraseOutput*(output: string, countryCode = "",
                              withCtrlInterface = true): ConfResult =
  ## `wpa_passphrase` prints a ready network block plus a `#psk="plaintext"`
  ## comment. Keep the block, drop every comment: the whole point of hashing
  ## the passphrase is not leaving it on disk.
  var kept: seq[string] = @[]
  var sawNetwork = false
  for rawLine in output.splitLines():
    let line = rawLine.strip(leading = false)
    if line.strip().startsWith("#"):
      continue
    if line.strip().len == 0:
      continue
    if line.strip().startsWith("network={"):
      sawNetwork = true
    kept.add(line)
  if not sawNetwork:
    return ConfResult(error: "wpa_passphrase produced no network block.")
  ConfResult(conf: wpaSupplicantHeader(countryCode, withCtrlInterface) & kept.join("\n") & "\n")

proc buildHostapdConf*(iface, ssid, password: string, channel = hotspotChannel): ConfResult =
  ## Same observable hotspot as nmcli's `802-11-wireless.mode ap` +
  ## `band bg` + `key-mgmt wpa-psk` + `ap-isolation 1`.
  if iface.len == 0:
    return ConfResult(error: "No wireless interface for the hotspot.")
  if ssid.len == 0 or ssid.len > 32:
    return ConfResult(error: "Hotspot SSID must be 1-32 bytes.")
  if ssid.contains('\n') or ssid.contains('\r'):
    return ConfResult(error: "Hotspot SSID contains a line break.")

  var lines = @[
    "# Generated by FrameOS. Regenerated on every hotspot start.",
    "interface=" & iface,
    "driver=nl80211",
  ]
  # hostapd reads everything after '=' verbatim, so an SSID with spaces is
  # fine, but anything non-printable has to go through the hex form.
  if isPrintableAscii(ssid) and ssid == ssid.strip():
    lines.add("ssid=" & ssid)
  else:
    lines.add("ssid2=" & toHex(ssid))
  lines.add("hw_mode=g")
  lines.add("channel=" & $channel)
  lines.add("auth_algs=1")
  lines.add("wmm_enabled=0")
  lines.add("ignore_broadcast_ssid=0")
  # Mirrors nmcli's 802-11-wireless.ap-isolation 1: setup clients never need
  # to talk to each other.
  lines.add("ap_isolate=1")

  if password.len > 0:
    if password.contains('\n') or password.contains('\r'):
      return ConfResult(error: "Hotspot password contains a line break.")
    lines.add("wpa=2")
    lines.add("wpa_key_mgmt=WPA-PSK")
    lines.add("rsn_pairwise=CCMP")
    if password.len == 64 and isHexString(password):
      lines.add("wpa_psk=" & password.toLowerAscii())
    elif password.len < 8 or password.len > 63:
      return ConfResult(error: "Hotspot password must be 8-63 characters (or a 64 character hex PSK).")
    else:
      lines.add("wpa_passphrase=" & password)

  ConfResult(conf: lines.join("\n") & "\n")

proc buildUdhcpdConf*(iface: string): string =
  ## Fallback for images without dnsmasq (busybox always has udhcpd).
  @[
    "# Generated by FrameOS. Regenerated on every hotspot start.",
    "interface " & iface,
    "start " & hotspotDhcpStart,
    "end " & hotspotDhcpEnd,
    "lease_file " & udhcpdLeasePath,
    "pidfile " & udhcpdPidPath,
    "option subnet " & hotspotNetmask,
    "option router " & hotspotAddress,
    "option dns " & hotspotAddress,
    "option lease 43200",
  ].join("\n") & "\n"

proc dnsmasqCommand*(iface: string): string =
  ## --conf-file=/dev/null keeps a distro dnsmasq.conf from bleeding in.
  ## --address=/#/ points every lookup at the frame so phones pop the captive
  ## portal instead of silently giving up (NM's shared mode has no upstream
  ## resolver here either).
  "sudo dnsmasq --conf-file=/dev/null --interface=" & shq(iface) &
    " --bind-interfaces --except-interface=lo --no-resolv --no-hosts" &
    " --listen-address=" & hotspotAddress &
    " --dhcp-range=" & hotspotDhcpStart & "," & hotspotDhcpEnd & "," & hotspotNetmask & ",12h" &
    " --dhcp-option=3," & hotspotAddress &
    " --dhcp-option=6," & hotspotAddress &
    " --address=/#/" & hotspotAddress &
    " --pid-file=" & shq(dnsmasqPidPath)

proc dhcpClientCommand*(client, iface: string, scriptPath = ""): string =
  ## Bounded, foreground lease acquisition: every variant gets its own
  ## retry/timeout budget so none of them can sit on the portal thread until
  ## the outer process timeout fires.
  case client
  of "udhcpc":
    # busybox: -f foreground, -q quit once bound, -n give up instead of
    # backgrounding, -t/-T retry budget. Without -s it configures nothing.
    "sudo udhcpc -i " & shq(iface) & " -f -n -q -t 5 -T 3 -A 2" &
      (if scriptPath.len > 0: " -s " & shq(scriptPath) else: "")
  of "dhcpcd":
    "sudo dhcpcd -w -t 15 " & shq(iface)
  of "dhclient":
    "sudo dhclient -1 -v " & shq(iface)
  else:
    ""

proc dhcpRenewCommand*(client, iface: string, scriptPath = ""): string =
  ## The acquisition above exits as soon as it is bound, so for udhcpc a
  ## second, daemonised client has to stay behind to renew - otherwise the
  ## frame silently loses its address when the lease expires. dhcpcd and
  ## dhclient already daemonise themselves.
  if client != "udhcpc":
    return ""
  "sudo udhcpc -i " & shq(iface) & " -t 5 -T 3 -A 20" &
    (if scriptPath.len > 0: " -s " & shq(scriptPath) else: "")

# ---------------------------------------------------------------------------
# Operations (all side effects go through NetworkContext)
# ---------------------------------------------------------------------------

proc confFileName(device: string): string =
  "wpa_supplicant-" & (if device.len > 0: device else: "wlan0") & ".conf"

proc supplicantConfPath*(ctx: NetworkContext, device: string): string =
  ## /etc/wpa_supplicant is the standard location (and is bind-mounted to the
  ## state partition on FrameOS images). If it does not exist we fall back to
  ## the state dir directly, because a config written into a wiped-on-upgrade
  ## location is worse than useless.
  if ctx.pathExists(supplicantConfDir):
    supplicantConfDir & "/" & confFileName(device)
  else:
    supplicantStateConfDir & "/" & confFileName(device)

proc scanCachePath*(): string =
  supplicantStateConfDir & "/last-scan.txt"

proc ensureDir(ctx: NetworkContext, dir: string) =
  discard ctx.run("sudo install -d -m 700 " & shq(dir) & " 2>/dev/null || true", "")

# ---------------------------------------------------------------------------
# Importing NetworkManager keyfiles as a credential source
# ---------------------------------------------------------------------------

proc nmKeyfileListCommand*(): string =
  ## Lists *.nmconnection in every directory an image may have dropped them
  ## in. A glob that matches nothing expands to itself, which the -f test
  ## rejects, so the output only ever holds real files.
  var parts: seq[string] = @[]
  for dir in nmConnectionDirs:
    parts.add("for f in " & shq(dir) & "/*.nmconnection; do [ -f \"$f\" ] && echo \"$f\"; done")
  "{ " & parts.join("; ") & "; } 2>/dev/null || true"

proc readNmWifiCredentials*(ctx: NetworkContext): seq[NmWifiCredentials] =
  ## Every NetworkManager keyfile on the image, parsed. Files are deduplicated
  ## by name because /etc/NetworkManager/system-connections is a bind mount of
  ## the state directory on FrameOS images, so both paths list the same files.
  let (output, _) = ctx.run(nmKeyfileListCommand(), "")
  var seenNames: seq[string] = @[]
  for rawLine in output.splitLines():
    let path = rawLine.strip()
    if path.len == 0 or not path.endsWith(".nmconnection"):
      continue
    let name = path[path.rfind('/') + 1 .. ^1]
    if name in seenNames:
      continue
    seenNames.add(name)
    var content = ctx.readFile(path)
    if content.len == 0:
      # Keyfiles are 0600 and root-owned; fall back to a privileged read for
      # the (Debian) case where FrameOS does not run as root.
      let (catOutput, _) = ctx.run("sudo cat " & shq(path) & " 2>/dev/null || true", "")
      content = catOutput
    if content.strip().len == 0:
      continue
    var credentials = parseNmWifiKeyfile(content)
    if credentials.id.len == 0:
      credentials.id = name
    if not credentials.usable and credentials.skipReason.len == 0:
      continue
    result.add(credentials)

proc anyImportableWifi*(ctx: NetworkContext): bool =
  for credentials in readNmWifiCredentials(ctx):
    if credentials.usable:
      return true
  false

proc importNmKeyfiles*(ctx: NetworkContext, device: string, countryCode = "",
                       withCtrlInterface = true): ImportResult =
  ## Folds every importable keyfile into this backend's own
  ## wpa_supplicant-<iface>.conf on the state partition, so credentials baked
  ## into an SD image survive the reboot exactly like portal-entered ones.
  ## Idempotent: SSIDs already in the config are left alone, so the second run
  ## writes nothing and logs nothing.
  result.path = supplicantConfPath(ctx, device)
  let credentials = readNmWifiCredentials(ctx)
  if credentials.len == 0:
    return
  let existing = if ctx.pathExists(result.path): ctx.readFile(result.path) else: ""
  let merged = mergeImportedNetworks(existing, credentials, countryCode, withCtrlInterface)
  result.imported = merged.imported
  result.skipped = merged.skipped
  if not merged.changed:
    if result.skipped.len > 0 and result.imported.len == 0:
      ctx.log("portal:supplicant:nmImport:skipped", %*{"skipped": result.skipped})
    return
  ensureDir(ctx, result.path[0 ..< result.path.rfind('/')])
  if not ctx.writeFile(result.path, merged.conf, 0o600):
    result.error = "Could not write " & result.path & "."
    ctx.log("portal:supplicant:nmImport:error", %*{"path": result.path, "error": result.error})
    return
  result.changed = true
  # Once: the SSIDs are in the config now, so the next call is a no-op. The
  # payload deliberately carries SSIDs only - never the PSK.
  ctx.log("portal:supplicant:nmImport", %*{
    "path": result.path,
    "ssids": result.imported,
    "skipped": result.skipped,
  })

proc detectWifiDevice*(ctx: NetworkContext): string =
  ## `iw dev` first (it is the tool that definitely exists when this backend
  ## is chosen), then sysfs, then the historical wlan0 default.
  let (iwOutput, _) = ctx.run("sudo iw dev 2>/dev/null || true", "")
  let interfaces = parseIwDevInterfaces(iwOutput)
  if interfaces.len > 0:
    return interfaces[0]

  let (sysfsOutput, _) = ctx.run(
    "for dev in /sys/class/net/*; do [ -e \"$dev/wireless\" ] && basename \"$dev\"; done 2>/dev/null || true", "")
  for rawLine in sysfsOutput.splitLines():
    let name = rawLine.strip()
    if name.len > 0:
      return name
  "wlan0"

proc wpaCli(device, args: string): string =
  ## -p is explicit: the stock image runs wpa_supplicant D-Bus-only, so the
  ## control socket only exists because our own instance creates it there.
  "sudo wpa_cli -p " & wpaCtrlDir & " -i " & shq(device) & " " & args

proc wpaCliAlive(ctx: NetworkContext, device: string): bool =
  let (output, _) = ctx.run(wpaCli(device, "ping") & " 2>/dev/null || true", "")
  output.contains("PONG")

proc supplicantRunning(ctx: NetworkContext, device: string, probe: NetworkToolProbe): bool =
  if probe.hasWpaCli:
    return wpaCliAlive(ctx, device)
  let (_, rc) = ctx.run("sudo pkill -0 -f " & shq("wpa_supplicant.*" & device) & " 2>/dev/null", "")
  rc == 0

proc readStatus(ctx: NetworkContext, device: string, probe: NetworkToolProbe): WifiStatus =
  ## wpa_cli gives the richest answer; `iw link` covers images built without
  ## the wpa_supplicant CLI.
  if probe.hasWpaCli:
    let (output, _) = ctx.run(wpaCli(device, "status") & " 2>/dev/null || true", "")
    return parseWpaStatus(output)
  let (output, _) = ctx.run("sudo iw dev " & shq(device) & " link 2>/dev/null || true", "")
  parseIwLink(output)

proc readCachedSsids(ctx: NetworkContext): seq[string] =
  let path = scanCachePath()
  if not ctx.pathExists(path):
    return @[]
  sortedUniqueSsids(ctx.readFile(path).splitLines())

proc writeCachedSsids(ctx: NetworkContext, ssids: seq[string]) =
  if ssids.len == 0:
    return
  ensureDir(ctx, supplicantStateConfDir)
  discard ctx.writeFile(scanCachePath(), ssids.join("\n") & "\n", 0o600)

proc liveScan*(ctx: NetworkContext, device: string, probe: NetworkToolProbe): seq[string] =
  ## wpa_cli when the supplicant is running (it owns the radio and refuses a
  ## parallel `iw scan`), otherwise iw.
  if probe.hasWpaCli and wpaCliAlive(ctx, device):
    discard ctx.run(wpaCli(device, "scan") & " >/dev/null 2>&1 || true", "")
    ctx.sleep(scanSettleMs)
    let (output, _) = ctx.run(wpaCli(device, "scan_results") & " 2>/dev/null || true", "")
    result = parseWpaScanResults(output)
    if result.len > 0:
      return

  if probe.hasIw:
    discard ctx.run("sudo ip link set " & shq(device) & " up 2>/dev/null || true", "")
    let (output, rc) = ctx.run("sudo iw dev " & shq(device) & " scan 2>/dev/null || true", "")
    if rc == 0:
      result = parseIwScanSsids(output)

proc availableNetworks*(ctx: NetworkContext, device: string, probe: NetworkToolProbe): seq[string] =
  ## A single-radio adapter cannot scan while hostapd owns it, which is
  ## exactly when the setup portal asks for the list. NetworkManager answers
  ## from its own cache there; we keep the last successful scan on the state
  ## partition and serve that, so the SSID dropdown is populated even on the
  ## first boot straight into hotspot mode.
  result = liveScan(ctx, device, probe)
  if result.len > 0:
    writeCachedSsids(ctx, result)
    return
  return readCachedSsids(ctx)

proc stopStationMode(ctx: NetworkContext, device: string) =
  ## Release the radio without killing an unrelated wpa_supplicant: ask ours
  ## to terminate through its control socket first.
  discard ctx.run(wpaCli(device, "terminate") & " >/dev/null 2>&1 || true", "")
  discard ctx.run("sudo pkill -f " & shq("wpa_supplicant.*" & device) & " 2>/dev/null || true", "")
  discard ctx.run("sudo pkill -f " & shq("udhcpc.*" & device) & " 2>/dev/null || true", "")
  discard ctx.run("sudo ip addr flush dev " & shq(device) & " 2>/dev/null || true", "")

proc writeSupplicantConf(ctx: NetworkContext, device, ssid, password, countryCode: string,
                         probe: NetworkToolProbe): SupplicantOpResult =
  var generated =
    if password.len > 0 and probe.hasWpaPassphrase:
      # Feed the passphrase on stdin: an argv password shows up in `ps` and in
      # our own command logs.
      let cmd = "printf '%s' " & shq(password) & " | wpa_passphrase " & shq(ssid) & " 2>/dev/null || true"
      let logged = "printf '%s' '<password>' | wpa_passphrase " & shq(ssid)
      let (output, _) = ctx.run(cmd, logged)
      let merged = mergeWpaPassphraseOutput(output, countryCode, probe.hasWpaCli)
      if merged.error.len > 0:
        buildWpaSupplicantConf(ssid, password, countryCode, probe.hasWpaCli)
      else:
        merged
    else:
      # No wpa_passphrase: a quoted plaintext psk is equally valid, and the
      # file is 0600 on the state partition - the same exposure the
      # NetworkManager keyfiles have today.
      buildWpaSupplicantConf(ssid, password, countryCode, probe.hasWpaCli)

  if generated.error.len > 0:
    return SupplicantOpResult(ok: false, message: generated.error)

  let path = supplicantConfPath(ctx, device)
  ensureDir(ctx, path[0 ..< path.rfind('/')])
  if not ctx.writeFile(path, generated.conf, 0o600):
    return SupplicantOpResult(ok: false, message: "Could not write " & path & ".")
  SupplicantOpResult(ok: true, message: path)

proc startSupplicant(ctx: NetworkContext, device, confPath: string,
                     probe: NetworkToolProbe): bool =
  ## FrameOS runs its own wpa_supplicant instance rather than reconfiguring
  ## the stock unit: the image ships `wpa_supplicant.service` as
  ## `Type=dbus, ExecStart=/usr/sbin/wpa_supplicant -u` with no interface and
  ## no config file, so it never joins anything on its own. Our instance owns
  ## the interface, the config and the control socket, which keeps this code
  ## working on Debian frames too - no image-side unit is required.
  discard ctx.run("sudo rfkill unblock wifi 2>/dev/null || true", "")
  discard ctx.run("sudo ip link set " & shq(device) & " up 2>/dev/null || true", "")
  # nl80211 only: the shipped wpa_supplicant has no wext driver compiled in,
  # and naming a missing driver makes it exit instead of falling back.
  let startCmd = "sudo wpa_supplicant -B -i " & shq(device) & " -c " & shq(confPath) &
                 " -D nl80211" &
                 (if probe.hasWpaCli: " -O " & shq(wpaCtrlDir) else: "") & " 2>&1"
  let (output, rc) = ctx.run(startCmd, "")
  if rc == 0:
    return true

  # "could not connect to kernel driver" / EBUSY usually means the D-Bus
  # instance grabbed the interface first. Stand it down and try once more.
  ctx.log("portal:supplicant:startRetry", %*{"device": device, "output": output.strip()})
  discard ctx.run("sudo systemctl stop wpa_supplicant.service 2>/dev/null || true", "")
  discard ctx.run("sudo pkill -f " & shq("wpa_supplicant.*-u") & " 2>/dev/null || true", "")
  ctx.sleep(associateDelayMs)
  let (_, retryRc) = ctx.run(startCmd, "")
  retryRc == 0

proc waitForAssociation(ctx: NetworkContext, device: string,
                        probe: NetworkToolProbe): WifiStatus =
  ## Same budget nmcli gets with `--wait 15`.
  for attempt in 1 .. associateAttempts:
    result = readStatus(ctx, device, probe)
    if result.connected:
      return
    ctx.sleep(associateDelayMs)

proc requestDhcpLease(ctx: NetworkContext, device: string, probe: NetworkToolProbe): string =
  ## Returns the acquired IPv4 address, or "" when no lease arrived.
  let client = pickDhcpClient(probe.dhcpClients)
  if client.len == 0:
    return ""
  let script = if ctx.pathExists(udhcpcScriptPath): udhcpcScriptPath else: ""
  discard ctx.run(dhcpClientCommand(client, device, script) & " 2>&1 || true", "")
  let (output, _) = ctx.run("ip -4 addr show dev " & shq(device) & " 2>/dev/null || true", "")
  result = parseIpv4Address(output)
  if result.len == 0:
    return
  let renew = dhcpRenewCommand(client, device, script)
  if renew.len > 0:
    # Fire and forget: it daemonises immediately and keeps the lease alive.
    discard ctx.run(renew & " >/dev/null 2>&1 || true", "")

proc connect*(ctx: NetworkContext, device, ssid, password, countryCode: string,
              probe: NetworkToolProbe): SupplicantOpResult =
  ## Join `ssid`, persist the credentials, and get a DHCP lease.
  # Say what is missing instead of letting the shell answer "not found".
  if not probe.hasWpaSupplicant:
    return SupplicantOpResult(ok: false, message: "wpa_supplicant is not installed; cannot join a Wi-Fi network.")
  if probe.dhcpClients.len == 0:
    return SupplicantOpResult(
      ok: false, message: "No DHCP client (udhcpc, dhcpcd or dhclient) is installed; cannot get an address.")

  let written = writeSupplicantConf(ctx, device, ssid, password, countryCode, probe)
  if not written.ok:
    return written
  let confPath = written.message

  stopStationMode(ctx, device)
  if not startSupplicant(ctx, device, confPath, probe):
    return SupplicantOpResult(ok: false, message: "wpa_supplicant failed to start on " & device & ".")

  let status = waitForAssociation(ctx, device, probe)
  if not status.connected:
    return SupplicantOpResult(
      ok: false,
      message: "Wi-Fi association did not complete (state " &
               (if status.state.len > 0: status.state else: "unknown") & ").")

  let address = requestDhcpLease(ctx, device, probe)
  if address.len == 0:
    return SupplicantOpResult(ok: false, message: "Associated with " & ssid & " but no DHCP lease was offered.")
  SupplicantOpResult(ok: true, message: address)

proc status*(ctx: NetworkContext, device: string, probe: NetworkToolProbe): WifiStatus =
  result = readStatus(ctx, device, probe)
  if result.ipAddress.len == 0:
    let (ipOutput, _) = ctx.run("ip -4 addr show dev " & shq(device) & " 2>/dev/null || true", "")
    result.ipAddress = parseIpv4Address(ipOutput)

proc anyWifiConfigured*(ctx: NetworkContext, device: string): bool =
  ## Equivalent of the nmcli "any connection profile exists" check. A
  ## NetworkManager keyfile we have not imported yet counts: the frame does
  ## have credentials, so it must keep retrying rather than raise the setup
  ## hotspot as if it had been handed none.
  let path = supplicantConfPath(ctx, device)
  if ctx.pathExists(path) and ctx.readFile(path).contains("network={"):
    return true
  anyImportableWifi(ctx)

proc pidAlive(ctx: NetworkContext, pidPath: string): bool =
  let (_, rc) = ctx.run("sudo kill -0 \"$(cat " & shq(pidPath) & " 2>/dev/null)\" 2>/dev/null", "")
  rc == 0

proc hotspotRunning*(ctx: NetworkContext): bool =
  if pidAlive(ctx, hostapdPidPath):
    return true
  let (_, rc) = ctx.run("sudo pkill -0 -f " & shq("hostapd.*" & hostapdConfPath) & " 2>/dev/null", "")
  rc == 0

proc startDhcpServer(ctx: NetworkContext, device: string, probe: NetworkToolProbe): SupplicantOpResult =
  if probe.hasDnsmasq:
    let (_, rc) = ctx.run(dnsmasqCommand(device) & " 2>&1", "")
    if rc == 0:
      return SupplicantOpResult(ok: true, message: "dnsmasq")
    return SupplicantOpResult(ok: false, message: "dnsmasq failed to start.")
  if probe.hasUdhcpd:
    if not ctx.writeFile(udhcpdConfPath, buildUdhcpdConf(device), 0o644):
      return SupplicantOpResult(ok: false, message: "Could not write " & udhcpdConfPath & ".")
    discard ctx.run("sudo touch " & shq(udhcpdLeasePath) & " 2>/dev/null || true", "")
    let (_, rc) = ctx.run("sudo udhcpd " & shq(udhcpdConfPath) & " 2>&1", "")
    if rc == 0:
      return SupplicantOpResult(ok: true, message: "udhcpd")
    return SupplicantOpResult(ok: false, message: "udhcpd failed to start.")
  SupplicantOpResult(ok: false, message: "No DHCP server (dnsmasq or udhcpd) is installed.")

proc stopHotspot*(ctx: NetworkContext, device: string) =
  ## Full restore to station mode: a half-torn-down AP leaves the radio in a
  ## state where the next connect silently never associates.
  discard ctx.run("sudo kill \"$(cat " & shq(hostapdPidPath) & " 2>/dev/null)\" 2>/dev/null || true", "")
  discard ctx.run("sudo pkill -f " & shq("hostapd.*" & hostapdConfPath) & " 2>/dev/null || true", "")
  discard ctx.run("sudo kill \"$(cat " & shq(dnsmasqPidPath) & " 2>/dev/null)\" 2>/dev/null || true", "")
  discard ctx.run("sudo kill \"$(cat " & shq(udhcpdPidPath) & " 2>/dev/null)\" 2>/dev/null || true", "")
  discard ctx.run("sudo pkill -f " & shq("dnsmasq.*" & dnsmasqPidPath) & " 2>/dev/null || true", "")
  discard ctx.run("sudo pkill -f " & shq("udhcpd " & udhcpdConfPath) & " 2>/dev/null || true", "")
  discard ctx.run("sudo ip addr flush dev " & shq(device) & " 2>/dev/null || true", "")
  discard ctx.run("sudo ip link set " & shq(device) & " down 2>/dev/null || true", "")
  discard ctx.run("sudo ip link set " & shq(device) & " up 2>/dev/null || true", "")

proc startHotspot*(ctx: NetworkContext, device, ssid, password: string,
                   probe: NetworkToolProbe): SupplicantOpResult =
  if not probe.hasHostapd:
    return SupplicantOpResult(ok: false, message: "hostapd is not installed; cannot start the setup hotspot.")

  let generated = buildHostapdConf(device, ssid, password)
  if generated.error.len > 0:
    return SupplicantOpResult(ok: false, message: generated.error)

  # Scan before the radio flips to AP mode: once hostapd owns it we cannot
  # scan any more, and the setup portal needs an SSID list.
  let scanned = liveScan(ctx, device, probe)
  if scanned.len > 0:
    writeCachedSsids(ctx, scanned)

  stopHotspot(ctx, device)
  stopStationMode(ctx, device)

  ensureDir(ctx, networkRunDir)
  ensureDir(ctx, networkStateDir)
  if not ctx.writeFile(hostapdConfPath, generated.conf, 0o600):
    return SupplicantOpResult(ok: false, message: "Could not write " & hostapdConfPath & ".")

  discard ctx.run("sudo rfkill unblock wifi 2>/dev/null || true", "")
  discard ctx.run("sudo ip link set " & shq(device) & " up 2>/dev/null || true", "")

  let (hostapdOutput, hostapdRc) = ctx.run(
    "sudo hostapd -B -P " & shq(hostapdPidPath) & " " & shq(hostapdConfPath) & " 2>&1", "")
  if hostapdRc != 0:
    return SupplicantOpResult(ok: false, message: "hostapd failed to start: " & hostapdOutput.strip())

  discard ctx.run("sudo ip addr flush dev " & shq(device) & " 2>/dev/null || true", "")
  let (addrOutput, addrRc) = ctx.run(
    "sudo ip addr add " & hotspotCidr & " dev " & shq(device) & " 2>&1", "")
  if addrRc != 0:
    stopHotspot(ctx, device)
    return SupplicantOpResult(ok: false, message: "Could not assign " & hotspotCidr & ": " & addrOutput.strip())

  let dhcp = startDhcpServer(ctx, device, probe)
  if not dhcp.ok:
    stopHotspot(ctx, device)
    return dhcp

  SupplicantOpResult(ok: true, message: dhcp.message)

proc ensureStation*(ctx: NetworkContext, device: string, probe: NetworkToolProbe): SupplicantOpResult =
  ## Boot-time equivalent of NetworkManager autoconnect: if credentials were
  ## persisted and no supplicant owns the device yet, start one and take a
  ## lease. Cheap no-op when wpa_supplicant is already running.
  if hotspotRunning(ctx):
    return SupplicantOpResult(ok: true, message: "hotspot")
  if supplicantRunning(ctx, device, probe):
    return SupplicantOpResult(ok: true, message: "already running")
  # An SD image flashed with Wi-Fi credentials delivers them as a
  # NetworkManager keyfile, which nothing on a non-NetworkManager image reads.
  # Fold those in before deciding there is nothing to join.
  discard importNmKeyfiles(ctx, device, "", probe.hasWpaCli)
  let path = supplicantConfPath(ctx, device)
  # wpa_supplicant needs a real config file here, so this checks the file
  # rather than anyWifiConfigured (which also counts not-yet-imported
  # keyfiles).
  if not ctx.pathExists(path) or not ctx.readFile(path).contains("network={"):
    return SupplicantOpResult(ok: false, message: "no saved Wi-Fi configuration")
  if not startSupplicant(ctx, device, path, probe):
    return SupplicantOpResult(ok: false, message: "wpa_supplicant failed to start on " & device & ".")
  let associated = waitForAssociation(ctx, device, probe)
  if not associated.connected:
    return SupplicantOpResult(ok: false, message: "not associated")
  let address = requestDhcpLease(ctx, device, probe)
  SupplicantOpResult(ok: address.len > 0, message: address)

proc logJson*(status: WifiStatus): JsonNode =
  %*{"connected": status.connected, "ssid": status.ssid,
     "state": status.state, "ip": status.ipAddress}
