import std/[json, sequtils, strutils, tables, unittest]

import ../network/backend
import ../network/supplicant

proc probeWith(tools: varargs[string]): NetworkToolProbe =
  var lines: seq[string] = @[]
  for tool in tools:
    lines.add(tool)
  parseToolProbe(lines.join("\n"))

suite "network backend selection":
  test "parseToolProbe reads the command -v sweep and ignores noise":
    let probe = parseToolProbe("""
motd: welcome
nmcli
wpa_supplicant
hostapd
iw
udhcpc
dhcpcd
""")
    check probe.hasNmcli
    check probe.hasWpaSupplicant
    check probe.hasHostapd
    check probe.hasIw
    check not probe.hasDnsmasq
    check probe.dhcpClients == @["udhcpc", "dhcpcd"]

  test "toolProbeCommand covers every tool the backends shell out to":
    let cmd = toolProbeCommand()
    for tool in networkToolNames:
      check cmd.contains("command -v " & tool & " ")

  test "parseNmRunning only accepts the bare running line":
    check parseNmRunning("running\n")
    check not parseNmRunning("Error: NetworkManager is not running.\n")
    check not parseNmRunning("")

  test "pickDhcpClient prefers udhcpc, then dhcpcd, then dhclient":
    check pickDhcpClient(["dhclient", "udhcpc", "dhcpcd"]) == "udhcpc"
    check pickDhcpClient(["dhclient", "dhcpcd"]) == "dhcpcd"
    check pickDhcpClient(["dhclient"]) == "dhclient"
    check pickDhcpClient([]) == ""

  test "auto-detection prefers a running NetworkManager":
    var probe = probeWith("nmcli", "wpa_supplicant", "hostapd", "iw", "dnsmasq", "udhcpc")
    probe.nmRunning = true
    let choice = chooseNetworkBackend("auto", probe)
    check choice.kind == nbNetworkManager
    check choice.error == ""

  test "auto-detection falls back to wpa_supplicant when nmcli is missing":
    # This is the armv6 buildroot image: no NetworkManager package at all.
    let probe = probeWith("wpa_supplicant", "wpa_cli", "hostapd", "iw", "dnsmasq", "udhcpc")
    let choice = chooseNetworkBackend("", probe)
    check choice.kind == nbSupplicant
    check choice.error == ""
    check choice.reason.contains("nmcli not installed")

  test "auto-detection uses wpa_supplicant when NetworkManager is installed but dead":
    var probe = probeWith("nmcli", "wpa_supplicant", "hostapd", "iw", "dnsmasq", "udhcpc")
    probe.nmRunning = false
    check chooseNetworkBackend("auto", probe).kind == nbSupplicant

  test "NetworkManager stays the last resort when nothing else can drive the radio":
    var probe = probeWith("nmcli")
    probe.nmRunning = false
    let choice = chooseNetworkBackend("auto", probe)
    check choice.kind == nbNetworkManager
    check choice.reason.contains("no alternative")

  test "no tooling at all fails with an actionable message":
    let choice = chooseNetworkBackend("auto", NetworkToolProbe())
    check choice.kind == nbUnknown
    check choice.error.contains("wpa_supplicant")
    check choice.error.contains("Install")

  test "supplicant selection reports which helper packages are missing":
    let probe = probeWith("wpa_supplicant", "iw")
    let choice = chooseNetworkBackend("auto", probe)
    check choice.kind == nbSupplicant
    check choice.error.contains("hostapd")
    check choice.error.contains("dnsmasq or udhcpd")
    check choice.error.contains("udhcpc, dhcpcd or dhclient")

  test "explicit overrides win over detection":
    var probe = probeWith("nmcli", "wpa_supplicant", "hostapd", "iw", "dnsmasq", "udhcpc")
    probe.nmRunning = true
    check chooseNetworkBackend("supplicant", probe).kind == nbSupplicant
    check chooseNetworkBackend("wpa_supplicant", probe).kind == nbSupplicant
    check chooseNetworkBackend("NetworkManager", probe).kind == nbNetworkManager
    check chooseNetworkBackend("nm", probe).kind == nbNetworkManager
    check chooseNetworkBackend("supplicant", probe).reason == "override"

  test "an override for a missing backend is honoured but flagged":
    let probe = probeWith("wpa_supplicant", "hostapd", "iw", "dnsmasq", "udhcpc")
    let choice = chooseNetworkBackend("networkManager", probe)
    check choice.kind == nbNetworkManager
    check choice.error.contains("nmcli is not installed")

  test "an unknown override falls back to auto-detection and says so":
    var probe = probeWith("nmcli")
    probe.nmRunning = true
    let choice = chooseNetworkBackend("wifi-please", probe)
    check choice.kind == nbNetworkManager
    check choice.error.contains("Unknown network backend 'wifi-please'")

  test "normalizeBackendOverride accepts the spellings humans type":
    check normalizeBackendOverride("") == "auto"
    check normalizeBackendOverride(" AUTO ") == "auto"
    check normalizeBackendOverride("network-manager") == "networkManager"
    check normalizeBackendOverride("wpa_supplicant") == "supplicant"
    check normalizeBackendOverride("nonsense") == ""

suite "supplicant scan parsing":
  test "iw scan output is deduped and sorted":
    let output = """
BSS 11:22:33:44:55:66(on wlan0)
	SSID: Home Wifi
	signal: -40.00 dBm
BSS 11:22:33:44:55:67(on wlan0)
	SSID: aardvark
BSS 11:22:33:44:55:68(on wlan0)
	SSID: Home Wifi
BSS 11:22:33:44:55:69(on wlan0)
	SSID:
BSS 11:22:33:44:55:70(on wlan0)
	SSID: \x00\x00
"""
    check parseIwScanSsids(output) == @["aardvark", "Home Wifi"]

  test "wpa_cli scan_results output is parsed off the tab columns":
    let output = "bssid / frequency / signal level / flags / ssid\n" &
      "11:22:33:44:55:66\t2412\t-40\t[WPA2-PSK-CCMP][ESS]\tHome Wifi\n" &
      "11:22:33:44:55:67\t2437\t-70\t[ESS]\tcafe\n" &
      "11:22:33:44:55:68\t2437\t-70\t[ESS]\t\n" &
      "11:22:33:44:55:69\t2437\t-70\t[ESS]\tHome Wifi\n"
    check parseWpaScanResults(output) == @["cafe", "Home Wifi"]

  test "wpa_cli status is read into the shared shape":
    let status = parseWpaStatus("""
bssid=11:22:33:44:55:66
ssid=Home Wifi
wpa_state=COMPLETED
ip_address=192.168.1.42
""")
    check status.connected
    check status.ssid == "Home Wifi"
    check status.ipAddress == "192.168.1.42"
    check status.state == "COMPLETED"

  test "a scanning supplicant is not reported as connected":
    let status = parseWpaStatus("wpa_state=SCANNING\n")
    check not status.connected
    check status.state == "SCANNING"

  test "iw link covers images built without wpa_cli":
    let connected = parseIwLink("Connected to 11:22:33:44:55:66 (on wlan0)\n\tSSID: home-wifi\n")
    check connected.connected
    check connected.ssid == "home-wifi"
    check connected.state == "COMPLETED"
    let idle = parseIwLink("Not connected.\n")
    check not idle.connected
    check idle.state == "DISCONNECTED"

  test "iw dev lists the wireless interfaces":
    check parseIwDevInterfaces("""
phy#0
	Interface wlan0
		ifindex 3
		type managed
""") == @["wlan0"]

  test "ip -4 addr show yields the bare address":
    check parseIpv4Address("    inet 192.168.1.42/24 brd 192.168.1.255 scope global wlan0\n") ==
          "192.168.1.42"
    check parseIpv4Address("") == ""

suite "supplicant config generation":
  test "WPA network quotes the SSID and passphrase":
    let generated = buildWpaSupplicantConf("Home Wifi", "hunter2hunter2")
    check generated.error == ""
    check generated.conf.contains("ssid=\"Home Wifi\"")
    check generated.conf.contains("psk=\"hunter2hunter2\"")
    check generated.conf.contains("key_mgmt=WPA-PSK")
    check generated.conf.contains("update_config=1")

  test "quotes and backslashes in SSID and passphrase are escaped":
    let generated = buildWpaSupplicantConf("say \"hi\"", "back\\slash\"quote")
    check generated.error == ""
    check generated.conf.contains("ssid=\"say \\\"hi\\\"\"")
    check generated.conf.contains("psk=\"back\\\\slash\\\"quote\"")

  test "non-ASCII SSIDs are hex encoded instead of quoted":
    let generated = buildWpaSupplicantConf("caf\xc3\xa9", "hunter2hunter2")
    check generated.error == ""
    check generated.conf.contains("ssid=636166c3a9")
    check not generated.conf.contains("ssid=\"")

  test "open networks use key_mgmt=NONE and carry no psk":
    let generated = buildWpaSupplicantConf("Open Net", "")
    check generated.error == ""
    check generated.conf.contains("key_mgmt=NONE")
    check not generated.conf.contains("psk")

  test "a 64 character hex PSK is written raw":
    let psk = "a".repeat(64)
    let generated = buildWpaSupplicantConf("Home", psk)
    check generated.conf.contains("psk=" & psk)
    check not generated.conf.contains("psk=\"")

  test "impossible credentials are rejected before any daemon sees them":
    check buildWpaSupplicantConf("", "hunter2hunter2").error.contains("empty")
    check buildWpaSupplicantConf("x".repeat(33), "hunter2hunter2").error.contains("32 bytes")
    check buildWpaSupplicantConf("Home", "short").error.contains("8-63")
    check buildWpaSupplicantConf("Home\nInject", "hunter2hunter2").error.contains("line break")
    check buildWpaSupplicantConf("Home", "pass\nword12").error.contains("line break")

  test "country code is only emitted when it is a two letter code":
    check buildWpaSupplicantConf("Home", "", "ee").conf.contains("country=EE")
    check not buildWpaSupplicantConf("Home", "", "").conf.contains("country=")
    check not buildWpaSupplicantConf("Home", "", "Estonia").conf.contains("country=")

  test "wpa_passphrase output keeps the hashed block and drops the plaintext comment":
    let merged = mergeWpaPassphraseOutput("""
network={
	ssid="Home Wifi"
	#psk="hunter2hunter2"
	psk=0123456789abcdef
}
""")
    check merged.error == ""
    check merged.conf.contains("psk=0123456789abcdef")
    check not merged.conf.contains("hunter2hunter2")
    check merged.conf.contains("ctrl_interface=")

  test "a wpa_passphrase failure is reported rather than written out":
    check mergeWpaPassphraseOutput("Passphrase must be 8..63 characters").error.len > 0

  test "hostapd config mirrors the nmcli hotspot settings":
    let generated = buildHostapdConf("wlan0", "FrameOS-Setup", "frame1234")
    check generated.error == ""
    check generated.conf.contains("interface=wlan0")
    check generated.conf.contains("ssid=FrameOS-Setup")
    check generated.conf.contains("hw_mode=g")
    check generated.conf.contains("wpa=2")
    check generated.conf.contains("wpa_key_mgmt=WPA-PSK")
    check generated.conf.contains("wpa_passphrase=frame1234")
    # nmcli sets 802-11-wireless.ap-isolation 1
    check generated.conf.contains("ap_isolate=1")

  test "hostapd keeps SSIDs with spaces verbatim but hex-encodes odd ones":
    check buildHostapdConf("wlan0", "My Frame", "frame1234").conf.contains("ssid=My Frame")
    let padded = buildHostapdConf("wlan0", " Frame ", "frame1234")
    check padded.conf.contains("ssid2=204672616d6520")
    check not padded.conf.contains("\nssid=")

  test "hostapd rejects unusable hotspot credentials":
    check buildHostapdConf("wlan0", "", "frame1234").error.contains("1-32")
    check buildHostapdConf("wlan0", "Frame", "short").error.contains("8-63")
    check buildHostapdConf("", "Frame", "frame1234").error.contains("interface")
    check buildHostapdConf("wlan0", "Frame\nssid2=evil", "frame1234").error.contains("line break")

  test "an open hotspot omits every wpa line":
    let generated = buildHostapdConf("wlan0", "FrameOS-Setup", "")
    check generated.error == ""
    check not generated.conf.contains("wpa")

  test "dnsmasq serves DHCP and captive DNS on the NetworkManager address":
    let cmd = dnsmasqCommand("wlan0")
    check cmd.contains("--interface='wlan0'")
    check cmd.contains("--dhcp-range=10.42.0.10,10.42.0.200,255.255.255.0,12h")
    check cmd.contains("--dhcp-option=3,10.42.0.1")
    check cmd.contains("--address=/#/10.42.0.1")
    check cmd.contains("--conf-file=/dev/null")
    # The default lease path lives on the read-only rootfs on buildroot images.
    check cmd.contains("--dhcp-leasefile='/run/frameos/dnsmasq.leases'")

  test "udhcpd config covers the same range as the dnsmasq path":
    let conf = buildUdhcpdConf("wlan0")
    check conf.contains("interface wlan0")
    check conf.contains("start 10.42.0.10")
    check conf.contains("end 10.42.0.200")
    check conf.contains("option router 10.42.0.1")

  test "every DHCP client is invoked with its own timeout budget":
    check dhcpClientCommand("udhcpc", "wlan0") == "sudo udhcpc -i 'wlan0' -f -n -q -t 5 -T 3 -A 2"
    check dhcpClientCommand("udhcpc", "wlan0", udhcpcScriptPath) ==
          "sudo udhcpc -i 'wlan0' -f -n -q -t 5 -T 3 -A 2 -s '/usr/share/udhcpc/default.script'"
    check dhcpClientCommand("dhcpcd", "wlan0") == "sudo dhcpcd -w -t 15 'wlan0'"
    check dhcpClientCommand("dhclient", "wlan0") == "sudo dhclient -1 -v 'wlan0'"
    check dhcpClientCommand("nope", "wlan0") == ""

  test "only udhcpc needs a second daemon to keep renewing the lease":
    # busybox udhcpc exits once bound (-q), so without this the frame loses
    # its address when the lease expires; dhcpcd/dhclient daemonise already.
    check dhcpRenewCommand("udhcpc", "wlan0", udhcpcScriptPath) ==
          "sudo udhcpc -i 'wlan0' -t 5 -T 3 -A 20 -s '/usr/share/udhcpc/default.script'"
    check dhcpRenewCommand("dhcpcd", "wlan0") == ""
    check dhcpRenewCommand("dhclient", "wlan0") == ""

  test "the wpa_supplicant config points at wpa_cli's default control socket":
    check buildWpaSupplicantConf("Home", "").conf.contains("ctrl_interface=/var/run/wpa_supplicant")

  test "no wpa_cli means no ctrl_interface line at all":
    # A wpa_supplicant built without CONFIG_CTRL_IFACE rejects the entire
    # config file over that field, which would leave the frame with no Wi-Fi.
    let generated = buildWpaSupplicantConf("Home", "hunter2hunter2", "", withCtrlInterface = false)
    check not generated.conf.contains("ctrl_interface")
    check generated.conf.contains("psk=\"hunter2hunter2\"")
    check mergeWpaPassphraseOutput("network={\n\tpsk=abc\n}\n", "", false).conf.contains("psk=abc")
    check not mergeWpaPassphraseOutput("network={\n\tpsk=abc\n}\n", "", false).conf.contains("ctrl_interface")

# ---------------------------------------------------------------------------
# NetworkManager keyfiles as a credential source.
#
# An SD image flashed with Wi-Fi credentials only ever delivers them as
# /etc/NetworkManager/system-connections/*.nmconnection (buildroot_image.py
# bakes the file, setup_json_reset.py installs it). Nothing on an image without
# NetworkManager reads those, so this backend imports them.
# ---------------------------------------------------------------------------

const wpaKeyfile = """
[connection]
id=frameos-wifi
type=wifi
autoconnect=true

[wifi]
mode=infrastructure
ssid=Home Wifi

[wifi-security]
key-mgmt=wpa-psk
psk=hunter2hunter2

[ipv4]
method=auto

[ipv6]
method=auto
"""

const openKeyfile = """
[connection]
id=frameos-cloud-wifi
type=wifi
autoconnect=true

[wifi]
mode=infrastructure
ssid=Cafe Open

[ipv4]
method=auto
"""

suite "NetworkManager keyfile parsing":
  test "a keyfile written by the image builder yields SSID and PSK":
    let credentials = parseNmWifiKeyfile(wpaKeyfile)
    check credentials.usable
    check credentials.id == "frameos-wifi"
    check credentials.ssid == "Home Wifi"
    check credentials.psk == "hunter2hunter2"
    check credentials.keyMgmt == "wpa-psk"
    check credentials.skipReason == ""

  test "keyfile values are unescaped the way the writers escaped them":
    # backend/app/tasks/buildroot_image.py `_nm_keyfile_value` and
    # setup_json_reset.py `nm_keyfile_escape` both double backslashes.
    check unescapeNmKeyfileValue("back\\\\slash") == "back\\slash"
    check unescapeNmKeyfileValue("  leading") == "leading"
    check unescapeNmKeyfileValue("trailing\r") == "trailing"
    # The rest of GKeyFile's escapes, which NetworkManager itself writes.
    check unescapeNmKeyfileValue("a\\sb") == "a b"
    check unescapeNmKeyfileValue("a\\tb") == "a\tb"
    check unescapeNmKeyfileValue("a\\nb") == "a\nb"
    check unescapeNmKeyfileValue("semi\\;colon") == "semi;colon"
    check unescapeNmKeyfileValue("trailing\\") == "trailing\\"

    let credentials = parseNmWifiKeyfile(
      "[connection]\ntype=wifi\n[wifi]\nssid=back\\\\slash\n" &
      "[wifi-security]\nkey-mgmt=wpa-psk\npsk=p\\\\ss\\sword\n")
    check credentials.usable
    check credentials.ssid == "back\\slash"
    check credentials.psk == "p\\ss word"

  test "a keyfile without [wifi-security] is an open network":
    let credentials = parseNmWifiKeyfile(openKeyfile)
    check credentials.usable
    check credentials.ssid == "Cafe Open"
    check credentials.psk == ""
    check credentials.keyMgmt == "none"

  test "an explicit key-mgmt=none is an open network too":
    let credentials = parseNmWifiKeyfile(
      "[connection]\ntype=wifi\n[wifi]\nssid=Open\n[wifi-security]\nkey-mgmt=none\n")
    check credentials.usable
    check credentials.psk == ""

  test "profiles this backend cannot join are skipped with a reason":
    # A PSK profile with no stored secret must NOT be read as an open network:
    # it would never associate and would suppress the setup hotspot.
    let agentOwned = parseNmWifiKeyfile(
      "[connection]\ntype=wifi\n[wifi]\nssid=Home\n" &
      "[wifi-security]\nkey-mgmt=wpa-psk\npsk-flags=1\n")
    check not agentOwned.usable
    check agentOwned.skipReason.contains("psk-flags=1")

    let hotspot = parseNmWifiKeyfile(
      "[connection]\ntype=wifi\n[wifi]\nmode=ap\nssid=FrameOS-Setup\n" &
      "[wifi-security]\nkey-mgmt=wpa-psk\npsk=frame1234\n")
    check not hotspot.usable
    check hotspot.skipReason.contains("mode ap")

    let wired = parseNmWifiKeyfile("[connection]\ntype=ethernet\nid=eth\n")
    check not wired.usable
    check wired.skipReason.contains("not a Wi-Fi")

    let enterprise = parseNmWifiKeyfile(
      "[connection]\ntype=wifi\n[wifi]\nssid=Campus\n[wifi-security]\nkey-mgmt=wpa-eap\n")
    check not enterprise.usable
    check enterprise.skipReason.contains("enterprise")

    let noSsid = parseNmWifiKeyfile("[connection]\ntype=wifi\n[wifi]\nmode=infrastructure\n")
    check not noSsid.usable
    check noSsid.skipReason.contains("no SSID")

  test "no skip reason ever carries the PSK":
    for content in [wpaKeyfile, openKeyfile,
                    "[connection]\ntype=wifi\n[wifi]\nmode=ap\nssid=X\n" &
                    "[wifi-security]\nkey-mgmt=wpa-psk\npsk=supersecret\n"]:
      check not parseNmWifiKeyfile(content).skipReason.contains("supersecret")

suite "importing keyfiles into wpa_supplicant.conf":
  test "SSIDs already in a config are recognised in both encodings":
    let conf = buildWpaSupplicantConf("Home Wifi", "hunter2hunter2").conf &
               buildWpaNetworkBlock("caf\xc3\xa9", "").conf &
               buildWpaNetworkBlock("say \"hi\"", "").conf
    let ssids = parseWpaConfSsids(conf)
    check "Home Wifi" in ssids
    check "caf\xc3\xa9" in ssids  # hex encoded in the file
    check "say \"hi\"" in ssids

  test "an empty config gets a header plus one block per keyfile":
    let merged = mergeImportedNetworks(
      "", [parseNmWifiKeyfile(wpaKeyfile), parseNmWifiKeyfile(openKeyfile)])
    check merged.changed
    check merged.imported == @["Home Wifi", "Cafe Open"]
    check merged.conf.contains("update_config=1")
    check merged.conf.contains("ssid=\"Home Wifi\"")
    check merged.conf.contains("psk=\"hunter2hunter2\"")
    check merged.conf.contains("ssid=\"Cafe Open\"")
    check merged.conf.contains("key_mgmt=NONE")
    check merged.conf.count("network={") == 2

  test "re-importing the same keyfiles changes nothing":
    let first = mergeImportedNetworks(
      "", [parseNmWifiKeyfile(wpaKeyfile), parseNmWifiKeyfile(openKeyfile)])
    let second = mergeImportedNetworks(
      first.conf, [parseNmWifiKeyfile(wpaKeyfile), parseNmWifiKeyfile(openKeyfile)])
    check not second.changed
    check second.imported.len == 0
    check second.conf == first.conf
    check second.conf.count("network={") == 2

  test "a config the portal wrote keeps its own block and gains the new one":
    # The portal may have stored a hashed PSK; an imported keyfile must not
    # overwrite it.
    let existing = mergeWpaPassphraseOutput(
      "network={\n\tssid=\"Home Wifi\"\n\tpsk=deadbeef\n}\n").conf
    let merged = mergeImportedNetworks(
      existing, [parseNmWifiKeyfile(wpaKeyfile), parseNmWifiKeyfile(openKeyfile)])
    check merged.imported == @["Cafe Open"]
    check merged.conf.contains("psk=deadbeef")
    check not merged.conf.contains("hunter2hunter2")

  test "unusable keyfiles are reported, not written":
    let merged = mergeImportedNetworks("", [
      parseNmWifiKeyfile("[connection]\ntype=wifi\nid=campus\n[wifi]\nssid=Campus\n" &
                         "[wifi-security]\nkey-mgmt=wpa-eap\n")])
    check not merged.changed
    check merged.conf == ""
    check merged.skipped.len == 1
    check merged.skipped[0].contains("Campus")

  test "the ctrl_interface line follows the wpa_cli probe":
    let withCli = mergeImportedNetworks("", [parseNmWifiKeyfile(wpaKeyfile)])
    check withCli.conf.contains("ctrl_interface=")
    let withoutCli = mergeImportedNetworks(
      "", [parseNmWifiKeyfile(wpaKeyfile)], "ee", withCtrlInterface = false)
    check not withoutCli.conf.contains("ctrl_interface")
    check withoutCli.conf.contains("country=EE")

# ---------------------------------------------------------------------------
# The same import through NetworkContext: every command, read and write is
# stubbed, so nothing here spawns a process or touches the filesystem.
# ---------------------------------------------------------------------------

type StubNetwork = ref object
  files: Table[string, string]
  modes: Table[string, int]
  dirs: seq[string]
  commands: seq[string]
  events: seq[string]

proc newStubNetwork(): StubNetwork =
  StubNetwork(files: initTable[string, string](), modes: initTable[string, int](),
              dirs: @["/etc/wpa_supplicant"])

proc stubContext(stub: StubNetwork): NetworkContext =
  NetworkContext(
    run: proc(cmd, loggedCmd: string): NetCmdResult {.gcsafe.} =
      stub.commands.add(cmd)
      if cmd.contains(".nmconnection"):
        var found: seq[string] = @[]
        for path in stub.files.keys:
          if path.endsWith(".nmconnection"):
            found.add(path)
        # Deterministic order: the shell glob is sorted too.
        for i in 0 ..< found.len:
          for j in i + 1 ..< found.len:
            if found[j] < found[i]:
              swap(found[i], found[j])
        return (output: found.join("\n") & "\n", rc: 0)
      if cmd.contains("pkill -0") or cmd.contains("kill -0"):
        return (output: "", rc: 1)
      (output: "", rc: 0),
    sleep: proc(ms: int) {.gcsafe.} = discard,
    log: proc(ev: string, extra: JsonNode) {.gcsafe.} = stub.events.add(ev),
    writeFile: proc(path, content: string, mode: int): bool {.gcsafe.} =
      stub.files[path] = content
      stub.modes[path] = mode
      true,
    readFile: proc(path: string): string {.gcsafe.} =
      stub.files.getOrDefault(path, ""),
    pathExists: proc(path: string): bool {.gcsafe.} =
      path in stub.dirs or stub.files.hasKey(path),
  )

const importedConfPath = "/etc/wpa_supplicant/wpa_supplicant-wlan0.conf"

suite "supplicant credential import through NetworkContext":
  test "a baked-in keyfile becomes a persisted wpa_supplicant config":
    let stub = newStubNetwork()
    stub.files["/etc/NetworkManager/system-connections/frameos-wifi.nmconnection"] = wpaKeyfile
    let ctx = stubContext(stub)

    let res = importNmKeyfiles(ctx, "wlan0")
    check res.changed
    check res.imported == @["Home Wifi"]
    check res.error == ""
    check res.path == importedConfPath
    check stub.files[importedConfPath].contains("ssid=\"Home Wifi\"")
    check stub.files[importedConfPath].contains("psk=\"hunter2hunter2\"")
    # 0600 on the state partition, same as everything else this backend writes.
    check stub.modes[importedConfPath] == 0o600
    # Logged once, and never with the PSK in it.
    check stub.events.count("portal:supplicant:nmImport") == 1

    # Second run: nothing to do, nothing written, nothing logged again.
    let again = importNmKeyfiles(ctx, "wlan0")
    check not again.changed
    check again.imported.len == 0
    check stub.events.count("portal:supplicant:nmImport") == 1

  test "several keyfiles all end up in one config":
    let stub = newStubNetwork()
    stub.files["/etc/NetworkManager/system-connections/a-frameos-wifi.nmconnection"] = wpaKeyfile
    stub.files["/etc/NetworkManager/system-connections/b-frameos-cloud-wifi.nmconnection"] = openKeyfile
    let ctx = stubContext(stub)

    let res = importNmKeyfiles(ctx, "wlan0")
    check res.imported == @["Home Wifi", "Cafe Open"]
    check stub.files[importedConfPath].count("network={") == 2

  test "the same keyfile seen through the bind mount is imported once":
    # /etc/NetworkManager/system-connections is a bind mount of the state
    # directory on FrameOS images, so both paths list the same file.
    let stub = newStubNetwork()
    stub.files["/etc/NetworkManager/system-connections/frameos-wifi.nmconnection"] = wpaKeyfile
    stub.files["/srv/frameos/state/NetworkManager/system-connections/frameos-wifi.nmconnection"] = wpaKeyfile
    let ctx = stubContext(stub)

    check importNmKeyfiles(ctx, "wlan0").imported == @["Home Wifi"]
    check stub.files[importedConfPath].count("network={") == 1

  test "anyWifiConfigured sees credentials that are only in a keyfile":
    let stub = newStubNetwork()
    let ctx = stubContext(stub)
    # Nothing at all: the frame must raise its setup hotspot.
    check not anyWifiConfigured(ctx, "wlan0")

    stub.files["/etc/NetworkManager/system-connections/frameos-wifi.nmconnection"] = wpaKeyfile
    # This is the bug the Pi Zero W hit: credentials on the card, but the
    # frame reported "no Wi-Fi configured" and gave up on them.
    check anyWifiConfigured(ctx, "wlan0")

  test "an unusable keyfile does not fake a configured network":
    let stub = newStubNetwork()
    stub.files["/etc/NetworkManager/system-connections/hotspot.nmconnection"] =
      "[connection]\ntype=wifi\nid=hotspot\n[wifi]\nmode=ap\nssid=FrameOS-Setup\n"
    let ctx = stubContext(stub)
    check not anyWifiConfigured(ctx, "wlan0")
    let res = importNmKeyfiles(ctx, "wlan0")
    check not res.changed
    check res.skipped.len == 1
    check "portal:supplicant:nmImport:skipped" in stub.events

  test "ensureStation imports before deciding there is nothing to join":
    let stub = newStubNetwork()
    stub.files["/etc/NetworkManager/system-connections/frameos-wifi.nmconnection"] = wpaKeyfile
    let ctx = stubContext(stub)
    let probe = parseToolProbe("wpa_supplicant\nwpa_cli\nhostapd\niw\ndnsmasq\nudhcpc\n")

    let res = ensureStation(ctx, "wlan0", probe)
    check stub.files.hasKey(importedConfPath)
    var startedSupplicant = false
    for cmd in stub.commands:
      if cmd.contains("wpa_supplicant -B -i 'wlan0' -c '" & importedConfPath & "'"):
        startedSupplicant = true
    check startedSupplicant
    # No association in the stub, so it stops there - but it did try.
    check not res.ok
    check res.message == "not associated"

  test "ensureStation still reports nothing to join when no keyfile exists":
    # The setup hotspot is the user's only way back in; it must stay reachable.
    let stub = newStubNetwork()
    let ctx = stubContext(stub)
    let probe = parseToolProbe("wpa_supplicant\nwpa_cli\nhostapd\niw\ndnsmasq\nudhcpc\n")
    let res = ensureStation(ctx, "wlan0", probe)
    check not res.ok
    check res.message == "no saved Wi-Fi configuration"
    check not anyWifiConfigured(ctx, "wlan0")
