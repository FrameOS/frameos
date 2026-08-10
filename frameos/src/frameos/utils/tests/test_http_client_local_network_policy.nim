## The managed-frame private-network HTTP deny (docs/cloud-frames.md):
## classifier ranges, enforcement at the request chokepoint, and the
## provider-host exemption. Runs a local mummy server as the "private" target.

import std/[net, os, strutils, unittest]
import mummy
import mummy/routers

import ../http_client

const TestPort = 19472

var router: Router
router.get("/ok", proc(request: Request) {.gcsafe.} =
  request.respond(200, body = "hello from the LAN")
)
var server = newServer(router.toHandler(), workerThreads = 1)
var serverThread: Thread[(mummy.Server, Port)]
proc serveStub(args: (mummy.Server, Port)) {.thread.} =
  try:
    args[0].serve(args[1], "127.0.0.1")
  except CatchableError:
    discard
createThread(serverThread, serveStub, (server, Port(TestPort)))
sleep(200)

let localUrl = "http://127.0.0.1:" & $TestPort & "/ok"

suite "private network address classifier":
  test "blocked ranges classify as private":
    for address in [
      "0.0.0.0", "0.1.2.3",                       # 0.0.0.0/8 + unspecified
      "127.0.0.1", "127.255.255.255",             # loopback
      "10.0.0.1", "10.255.255.255",               # 10/8
      "172.16.0.1", "172.31.255.255",             # 172.16/12
      "192.168.0.1", "192.168.255.254",           # 192.168/16
      "169.254.0.1", "169.254.254.254",           # link-local
      "100.64.0.1", "100.127.255.254",            # CGNAT 100.64/10
      "255.255.255.255",                          # broadcast
      "::1", "::",                                # IPv6 loopback/unspecified
      "fc00::1", "fdab::1",                       # IPv6 ULA fc00::/7
      "fe80::1",                                  # IPv6 link-local
      "::ffff:192.168.1.10", "::ffff:10.0.0.1",   # IPv4-mapped private
      "::127.0.0.1", "::10.0.0.1", "::192.168.1.1", # IPv4-compatible (no ffff marker)
      "192.0.0.1", "192.0.0.171",                 # 192.0.0.0/24 protocol assignments
      "198.18.0.1", "198.19.255.254",             # 198.18/15 benchmarking
      "224.0.0.1", "239.255.255.250",             # 224/4 multicast (incl. SSDP)
      "240.0.0.1", "255.255.255.254",             # 240/4 reserved
      "ff02::1", "ff05::c",                       # IPv6 multicast
      "64:ff9b::127.0.0.1",                       # NAT64 wrapper around loopback
    ]:
      check isPrivateNetworkAddress(address)

  test "public addresses classify as public":
    for address in [
      "1.1.1.1", "8.8.8.8", "93.184.216.34", "104.18.0.1",
      "172.15.255.255", "172.32.0.1",             # edges around 172.16/12
      "100.63.255.255", "100.128.0.1",            # edges around 100.64/10
      "9.255.255.255", "11.0.0.0",                # edges around 10/8
      "192.167.255.255", "192.169.0.0",           # edges around 192.168/16
      "169.253.255.255", "169.255.0.0",           # edges around 169.254/16
      "126.255.255.255", "128.0.0.1",             # edges around 127/8
      "2606:4700::1111",                          # public IPv6
      "::ffff:8.8.8.8",                           # IPv4-mapped public
      "::8.8.8.8",                                # IPv4-compatible public
      "192.0.1.1",                                # edge above 192.0.0.0/24
      "198.17.255.255", "198.20.0.0",             # edges around 198.18/15
      "223.255.255.255",                          # edge below 224/4
      "223.255.255.250",                          # still unicast
      "64:ff9b::8.8.8.8",                         # NAT64 wrapper around a public IPv4
    ]:
      check not isPrivateNetworkAddress(address)

  test "garbage fails closed":
    check isPrivateNetworkAddress("")
    check isPrivateNetworkAddress("not-an-ip")
    check isPrivateNetworkAddress("999.1.1.1")

suite "local network policy enforcement":
  setup:
    setLocalNetworkPolicy(false)

  test "policy inactive: private targets are reachable":
    setLocalNetworkPolicy(false)
    check boundedGetContent(localUrl, timeoutMs = 3000) == "hello from the LAN"

  test "policy active: private targets are refused with a clear error":
    setLocalNetworkPolicy(true)
    var message = ""
    try:
      discard boundedGetContent(localUrl, timeoutMs = 3000)
      check false
    except IOError as error:
      message = error.msg
    check "local network access is blocked on cloud-managed frames" in message
    check "127.0.0.1" in message

  test "policy active: the exempt provider host:port stays reachable":
    setLocalNetworkPolicy(true, @["127.0.0.1:" & $TestPort])
    check boundedGetContent(localUrl, timeoutMs = 3000) == "hello from the LAN"
    # The exemption is exact — same host on another port is still blocked.
    setLocalNetworkPolicy(true, @["127.0.0.1:" & $(TestPort + 1)])
    expect IOError:
      discard boundedGetContent(localUrl, timeoutMs = 3000)

  test "snapshot reflects the configured policy":
    setLocalNetworkPolicy(true, @["Dev.Example.COM:8787"])
    let snapshot = localNetworkPolicySnapshot()
    check snapshot.active
    check snapshot.exemptHostPorts == @["dev.example.com:8787"]
    setLocalNetworkPolicy(false)
    check not localNetworkPolicySnapshot().active

setLocalNetworkPolicy(false)
