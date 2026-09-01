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

  test "networkDiagnosticsCommand covers the resolver, not just the interface":
    # What the network check logs when it fails: on a resolved-only image the
    # interface can look perfectly healthy while nothing resolves.
    let cmd = networkDiagnosticsCommand()
    for needle in ["/etc/resolv.conf", "nsswitch.conf", "resolvectl status", "ip -4 route",
                   "/run/frameos/udhcpc-*.lease", "head -c 4000"]:
      check cmd.contains(needle)
    check cmd.contains("command -v resolvectl >/dev/null 2>&1 && resolvectl status")

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
    check dhcpClientCommand("udhcpc", "wlan0", stockUdhcpcScriptPath) ==
          "sudo udhcpc -i 'wlan0' -f -n -q -t 5 -T 3 -A 2 -s '/usr/share/udhcpc/default.script'"
    check dhcpClientCommand("udhcpc", "wlan0", udhcpcScriptPath) ==
          "sudo udhcpc -i 'wlan0' -f -n -q -t 5 -T 3 -A 2 -s '/srv/frameos/state/network/udhcpc.script'"
    check dhcpClientCommand("dhcpcd", "wlan0") == "sudo dhcpcd -w -t 15 'wlan0'"
    check dhcpClientCommand("dhclient", "wlan0") == "sudo dhclient -1 -v 'wlan0'"
    check dhcpClientCommand("nope", "wlan0") == ""

  test "udhcpc announces the hostname; dhcpcd and dhclient do that on their own":
    # busybox sends no DHCP option 12 unless asked, which is why a Pi Zero W
    # showed up in the router's table as a bare MAC while a Pi 4 (whose lease
    # NetworkManager takes) showed its name.
    check dhcpClientCommand("udhcpc", "wlan0", udhcpcScriptPath, "frame-kitchen") ==
          "sudo udhcpc -i 'wlan0' -f -n -q -t 5 -T 3 -A 2 -s '/srv/frameos/state/network/udhcpc.script'" &
          " -x hostname:'frame-kitchen'"
    check dhcpRenewCommand("udhcpc", "wlan0", udhcpcScriptPath, "frame-kitchen") ==
          "sudo udhcpc -i 'wlan0' -t 5 -T 3 -A 20 -s '/srv/frameos/state/network/udhcpc.script'" &
          " -x hostname:'frame-kitchen'"
    check dhcpClientCommand("dhcpcd", "wlan0", "", "frame-kitchen") == "sudo dhcpcd -w -t 15 'wlan0'"
    check dhcpClientCommand("dhclient", "wlan0", "", "frame-kitchen") == "sudo dhclient -1 -v 'wlan0'"
    # Anything a router would reject - or that could break out of the
    # command line - is dropped rather than quoted.
    for bad in ["", "-frame", "frame-", "frame kitchen", "frame;rm", "frame.local", "a".repeat(64)]:
      check not validDhcpHostname(bad)
      check dhcpClientCommand("udhcpc", "wlan0", "", bad) == "sudo udhcpc -i 'wlan0' -f -n -q -t 5 -T 3 -A 2"
    check validDhcpHostname("frame-1")
    check validDhcpHostname("a".repeat(63))

  test "only udhcpc needs a second daemon to keep renewing the lease":
    # busybox udhcpc exits once bound (-q), so without this the frame loses
    # its address when the lease expires; dhcpcd/dhclient daemonise already.
    check dhcpRenewCommand("udhcpc", "wlan0", stockUdhcpcScriptPath) ==
          "sudo udhcpc -i 'wlan0' -t 5 -T 3 -A 20 -s '/usr/share/udhcpc/default.script'"
    check dhcpRenewCommand("dhcpcd", "wlan0") == ""
    check dhcpRenewCommand("dhclient", "wlan0") == ""

  test "the FrameOS lease handler feeds systemd-resolved and falls back to resolv.conf":
    # The whole point of shipping our own script (see udhcpcScript's doc
    # comment): busybox's default.script only appends to /etc/resolv.conf,
    # which nss-resolve never reads, so a Pi Zero W got an address and a
    # route but "Temporary failure in name resolution" on every lookup.
    check udhcpcScript.startsWith("#!/bin/sh\n")
    check udhcpcScript.contains("resolvectl dns \"$interface\" $dns")
    check udhcpcScript.contains("resolvectl domain \"$interface\" $search_list")
    check udhcpcScript.contains("resolvectl revert \"$interface\"")
    check udhcpcScript.contains("nameserver $i # $interface")
    # The stock script's bashism-free contract, kept: never run without an
    # action, and the resolv.conf symlink is followed, not overwritten.
    check udhcpcScript.contains("should be called from udhcpc")
    check udhcpcScript.contains("readlink -f \"$RESOLV_CONF\"")
    check udhcpcScript.contains("LEASE_INFO=\"$LEASE_DIR/udhcpc-$interface.lease\"")
    for action in ["deconfig)", "leasefail|nak)", "renew|bound)"]:
      check udhcpcScript.contains(action)

  test "parseLeaseInfo reads what the lease handler wrote":
    let info = parseLeaseInfo("""action=bound
ip=192.168.1.50
mask=24
router=192.168.1.1
dns=192.168.1.1 1.1.1.1
domain=lan
resolver=resolved
""")
    check info.ip == "192.168.1.50"
    check info.router == "192.168.1.1"
    check info.dns == @["192.168.1.1", "1.1.1.1"]
    check info.domain == "lan"
    check info.resolver == "resolved"
    check leaseInfoJson(info)["dns"].len == 2
    let empty = parseLeaseInfo("")
    check empty.ip == ""
    check empty.dns.len == 0
    check leaseInfoPath("wlan0") == "/run/frameos/udhcpc-wlan0.lease"

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

  test "ensureUdhcpcScript installs an executable handler on the state partition":
    let stub = newStubNetwork()
    let ctx = stubContext(stub)
    check ensureUdhcpcScript(ctx) == udhcpcScriptPath
    check stub.files[udhcpcScriptPath] == udhcpcScript
    # udhcpc execs the script, so it must be executable - the only non-0600
    # file this backend writes.
    check stub.modes[udhcpcScriptPath] == 0o755
    # Both directories are created through the runner (sudo install -d), the
    # state dir for the script and /run/frameos for the lease summary.
    check stub.commands.anyIt(it.contains("install -d -m 700 '/srv/frameos/state/network'"))
    check stub.commands.anyIt(it.contains("install -d -m 700 '/run/frameos'"))
    # Rewriting an identical script every boot would be churn on the SD card.
    let writes = stub.files.len
    check ensureUdhcpcScript(ctx) == udhcpcScriptPath
    check stub.files.len == writes

  test "ensureUdhcpcScript falls back to the stock script when the write fails":
    let stub = newStubNetwork()
    var ctx = stubContext(stub)
    ctx.writeFile = proc(path, content: string, mode: int): bool {.gcsafe.} = false
    stub.files[stockUdhcpcScriptPath] = "#!/bin/sh\n"
    check ensureUdhcpcScript(ctx) == stockUdhcpcScriptPath
    check "portal:supplicant:dhcpScript:writeFailed" in stub.events
    stub.files.del(stockUdhcpcScriptPath)
    check ensureUdhcpcScript(ctx) == ""

  test "dhcpHostname reads /etc/hostname, then the hostname command, and validates":
    let stub = newStubNetwork()
    let ctx = stubContext(stub)
    stub.files["/etc/hostname"] = "frame-kitchen\n"
    check dhcpHostname(ctx) == "frame-kitchen"
    stub.files["/etc/hostname"] = "not a hostname\n"
    check dhcpHostname(ctx) == ""
    stub.files.del("/etc/hostname")
    var hostCtx = stubContext(stub)
    hostCtx.run = proc(cmd, loggedCmd: string): NetCmdResult {.gcsafe.} =
      if cmd.startsWith("hostname"): (output: "frame7\n", rc: 0) else: (output: "", rc: 0)
    check dhcpHostname(hostCtx) == "frame7"

  test "ensureStation still reports nothing to join when no keyfile exists":
    # The setup hotspot is the user's only way back in; it must stay reachable.
    let stub = newStubNetwork()
    let ctx = stubContext(stub)
    let probe = parseToolProbe("wpa_supplicant\nwpa_cli\nhostapd\niw\ndnsmasq\nudhcpc\n")
    let res = ensureStation(ctx, "wlan0", probe)
    check not res.ok
    check res.message == "no saved Wi-Fi configuration"
    check not anyWifiConfigured(ctx, "wlan0")

const fullProbeTools = "wpa_supplicant\nwpa_cli\nhostapd\niw\ndnsmasq\nudhcpc\n"

proc ranCommand(stub: StubNetwork, fragment: string): bool =
  for cmd in stub.commands:
    if cmd.contains(fragment):
      return true
  false

proc saeRefusingContext(stub: StubNetwork, starts: ref int): NetworkContext =
  ## A wpa_supplicant built without CONFIG_SAE: every start against a config
  ## that still carries the SAE token fails the way the real daemon does.
  let base = stubContext(stub)
  NetworkContext(
    run: proc(cmd, loggedCmd: string): NetCmdResult {.gcsafe.} =
      if cmd.contains("wpa_supplicant -B"):
        inc starts[]
        if stub.files[importedConfPath].contains("SAE"):
          return (output: "Line 8: Invalid configuration line 'key_mgmt=WPA-PSK SAE'.", rc: 255)
        return (output: "", rc: 0)
      base.run(cmd, loggedCmd),
    sleep: base.sleep, log: base.log, writeFile: base.writeFile,
    readFile: base.readFile, pathExists: base.pathExists)

proc associatedWithoutLeaseContext(stub: StubNetwork, leaseRequests: ref int): NetworkContext =
  ## A running, associated supplicant whose DHCP never ran: the address only
  ## appears after a lease request.
  let base = stubContext(stub)
  NetworkContext(
    run: proc(cmd, loggedCmd: string): NetCmdResult {.gcsafe.} =
      if cmd.contains("wpa_cli") and cmd.contains(" ping"):
        return (output: "PONG\n", rc: 0)
      if cmd.contains("wpa_cli") and cmd.contains(" status"):
        return (output: "wpa_state=COMPLETED\nssid=Home\n", rc: 0)
      if cmd.contains("udhcpc -i 'wlan0' -f -n -q"):
        inc leaseRequests[]
        return (output: "", rc: 0)
      if cmd.contains("ip -4 addr show"):
        if leaseRequests[] > 0:
          return (output: "    inet 192.168.1.20/24 brd 192.168.1.255 scope global wlan0\n", rc: 0)
        return (output: "", rc: 0)
      base.run(cmd, loggedCmd),
    sleep: base.sleep, log: base.log, writeFile: base.writeFile,
    readFile: base.readFile, pathExists: base.pathExists)

proc stuckScanningContext(stub: StubNetwork, alive: ref bool): NetworkContext =
  ## A running supplicant that never gets past SCANNING; `terminate` kills it.
  let base = stubContext(stub)
  NetworkContext(
    run: proc(cmd, loggedCmd: string): NetCmdResult {.gcsafe.} =
      if cmd.contains("wpa_cli") and cmd.contains(" ping"):
        return (output: (if alive[]: "PONG\n" else: ""), rc: 0)
      if cmd.contains("wpa_cli") and cmd.contains(" status"):
        return (output: "wpa_state=SCANNING\n", rc: 0)
      if cmd.contains("wpa_cli") and cmd.contains(" terminate"):
        alive[] = false
        return (output: "", rc: 0)
      base.run(cmd, loggedCmd),
    sleep: base.sleep, log: base.log, writeFile: base.writeFile,
    readFile: base.readFile, pathExists: base.pathExists)

suite "regulatory domain and WPA3":
  test "normalizeCountryCode accepts exactly two ASCII letters":
    check normalizeCountryCode("fr") == "FR"
    check normalizeCountryCode(" ee ") == "EE"
    check normalizeCountryCode("") == ""
    check normalizeCountryCode("Estonia") == ""
    check normalizeCountryCode("F1") == ""
    check normalizeCountryCode("ée") == ""

  test "withCountry inserts a missing country line before the first network block":
    let conf = wpaSupplicantHeader() & buildWpaNetworkBlock("Home", "").conf
    let updated = withCountry(conf, "fr")
    check updated.contains("update_config=1\ncountry=FR\nnetwork={")
    check parseWpaConfCountry(updated) == "FR"
    # Idempotent, and a different code replaces in place.
    check withCountry(updated, "FR") == updated
    check withCountry(updated, "ee").contains("country=EE\n")
    check not withCountry(updated, "ee").contains("country=FR")
    # No valid code: untouched.
    check withCountry(conf, "") == conf
    check withCountry(conf, "Estonia") == conf

  test "withCountry handles a config with no network block yet":
    let header = wpaSupplicantHeader()
    let updated = withCountry(header, "de")
    check updated.endsWith("update_config=1\ncountry=DE\n")

  test "a passphrase network offers WPA2-PSK and WPA3-SAE with optional PMF":
    let generated = buildWpaNetworkBlock("Home", "hunter2hunter2")
    check generated.error == ""
    check generated.conf.contains("key_mgmt=WPA-PSK SAE\n")
    check generated.conf.contains("ieee80211w=1\n")
    check generated.conf.contains("psk=\"hunter2hunter2\"\n")

  test "a raw hex PSK cannot do SAE and stays WPA-PSK only":
    let hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    let generated = buildWpaNetworkBlock("Home", hex)
    check generated.conf.contains("key_mgmt=WPA-PSK\n")
    check not generated.conf.contains("SAE")
    check not generated.conf.contains("ieee80211w")

  test "stripSae downgrades every block for a daemon built without CONFIG_SAE":
    let conf = wpaSupplicantHeader("FR") & buildWpaNetworkBlock("Home", "hunter2hunter2").conf &
               buildWpaNetworkBlock("Open", "").conf
    let downgraded = stripSae(conf)
    check downgraded.contains("    key_mgmt=WPA-PSK\n")
    check not downgraded.contains("SAE")
    check not downgraded.contains("ieee80211w")
    check downgraded.contains("key_mgmt=NONE")
    check downgraded.contains("country=FR")
    check downgraded.contains("psk=\"hunter2hunter2\"")
    # Already plain: unchanged.
    check stripSae(downgraded) == downgraded

  test "an SAE-refusing wpa_supplicant gets a WPA-PSK config and a third start":
    let stub = newStubNetwork()
    stub.files["/etc/NetworkManager/system-connections/frameos-wifi.nmconnection"] = wpaKeyfile
    var starts = new int
    let ctx = saeRefusingContext(stub, starts)
    let res = ensureStation(ctx, "wlan0", parseToolProbe(fullProbeTools))
    check starts[] == 3
    check "portal:supplicant:saeFallback" in stub.events
    check not stub.files[importedConfPath].contains("SAE")
    check stub.files[importedConfPath].contains("key_mgmt=WPA-PSK\n")
    # The daemon is up now; the stub just never associates.
    check res.message == "not associated"

  test "ensureStation stamps frame.json's country into an imported config and sets the domain":
    let stub = newStubNetwork()
    stub.files["/etc/NetworkManager/system-connections/frameos-wifi.nmconnection"] = wpaKeyfile
    let ctx = stubContext(stub)
    discard ensureStation(ctx, "wlan0", parseToolProbe(fullProbeTools), "fr")
    check stub.files[importedConfPath].contains("country=FR\n")
    check ranCommand(stub, "iw reg set FR")
    check "portal:supplicant:regdom" in stub.events

  test "ensureStation keeps the first-boot country when frame.json has none":
    let stub = newStubNetwork()
    stub.files[importedConfPath] = "update_config=1\ncountry=EE\nnetwork={\n    ssid=\"Home\"\n    key_mgmt=NONE\n}\n"
    let ctx = stubContext(stub)
    discard ensureStation(ctx, "wlan0", parseToolProbe(fullProbeTools), "")
    check stub.files[importedConfPath].contains("country=EE\n")
    check ranCommand(stub, "iw reg set EE")

  test "no country means no country line and no iw reg set":
    let stub = newStubNetwork()
    stub.files["/etc/NetworkManager/system-connections/frameos-wifi.nmconnection"] = wpaKeyfile
    let ctx = stubContext(stub)
    discard ensureStation(ctx, "wlan0", parseToolProbe(fullProbeTools))
    check not stub.files[importedConfPath].contains("country=")
    check not ranCommand(stub, "iw reg set")

suite "repairing the boot-time station":
  # The stub's `pkill -0` / `kill -0` answer "not running" and its wpa_cli
  # returns nothing, so the plain stub starts from "supplicant down".
  test "repairStation goes through the full join when nothing is running":
    let stub = newStubNetwork()
    stub.files["/etc/NetworkManager/system-connections/frameos-wifi.nmconnection"] = wpaKeyfile
    let ctx = stubContext(stub)
    let probe = parseToolProbe(fullProbeTools)
    check not stationUp(ctx, "wlan0", probe)
    let res = repairStation(ctx, "wlan0", probe, "fr")
    check ranCommand(stub, "wpa_supplicant -B -i 'wlan0'")
    check stub.files[importedConfPath].contains("country=FR")
    check res.message == "not associated"

  test "repairStation only asks for a lease when the station is associated without an address":
    let stub = newStubNetwork()
    stub.files[importedConfPath] = wpaSupplicantHeader() & buildWpaNetworkBlock("Home", "").conf
    var leaseRequests = new int
    let ctx = associatedWithoutLeaseContext(stub, leaseRequests)
    let probe = parseToolProbe(fullProbeTools)
    let res = repairStation(ctx, "wlan0", probe)
    check res.ok
    check res.message == "192.168.1.20"
    check leaseRequests[] == 1
    check not ranCommand(stub, "wpa_supplicant -B")
    # Now it is up: a second repair is a no-op.
    check stationUp(ctx, "wlan0", probe)
    check repairStation(ctx, "wlan0", probe).message == "up"
    check leaseRequests[] == 1

  test "repairStation restarts a supplicant that is stuck scanning":
    let stub = newStubNetwork()
    stub.files[importedConfPath] = wpaSupplicantHeader() & buildWpaNetworkBlock("Home", "").conf
    var alive = new bool
    alive[] = true
    let ctx = stuckScanningContext(stub, alive)
    let res = repairStation(ctx, "wlan0", parseToolProbe(fullProbeTools))
    check ranCommand(stub, "wpa_supplicant -B -i 'wlan0'")
    check res.message == "not associated"
