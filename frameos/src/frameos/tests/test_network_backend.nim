import std/[strutils, unittest]

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
