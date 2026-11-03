# The Nim runner of docs/server-address-fixtures.json: the one reading of a
# frame's backend address (types.nim splitServerAddress / serverSchemeFromPort /
# normalizeServerScheme), shared with the backend
# (backend/app/utils/tests/test_server_address.py) and the SPA
# (cloud/apps/auth-web/src/test/shared-spa/backend-address.test.ts).
import std/[json, os, unittest]
import frameos/types

const fixturesPath = currentSourcePath().parentDir / ".." / ".." / ".." / ".." / "docs" / "server-address-fixtures.json"
let fixtures = parseFile(fixturesPath)

suite "server address fixtures":
  test "schemeFromPort":
    for c in fixtures["schemeFromPort"]["cases"]:
      check serverSchemeFromPort(c["port"].getInt()) == c["scheme"].getStr()

  test "normalizeScheme":
    for c in fixtures["normalizeScheme"]["cases"]:
      checkpoint $c
      check normalizeServerScheme(c["scheme"].getStr(), c["port"].getInt()) == c["expected"].getStr()

  test "splitAddress":
    for c in fixtures["splitAddress"]["cases"]:
      checkpoint $c
      let got = splitServerAddress(c["input"].getStr())
      check got.scheme == c["scheme"].getStr()
      check got.host == c["host"].getStr()
      check got.port == (if c["port"].kind == JNull: 0 else: c["port"].getInt())

  test "normalizeServerAddressFields moves what the host says into its own fields":
    var host = "https://backend.local:8443/"
    var port = 8989
    var scheme = "http"
    normalizeServerAddressFields(host, port, scheme)
    check (host, port, scheme) == ("backend.local", 8443, "https")
    # A bare host leaves the siblings alone.
    host = "backend.local"
    normalizeServerAddressFields(host, port, scheme)
    check (host, port, scheme) == ("backend.local", 8443, "https")
    # A port alone changes the port alone.
    host = "backend.local:9000"
    normalizeServerAddressFields(host, port, scheme)
    check (host, port, scheme) == ("backend.local", 9000, "https")
    # Something the host check must see whole stays whole.
    host = "user:pw@backend.local"
    normalizeServerAddressFields(host, port, scheme)
    check (host, port, scheme) == ("user:pw@backend.local", 9000, "https")
