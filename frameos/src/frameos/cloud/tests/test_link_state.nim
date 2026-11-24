## Pure helpers behind the cloud link's scope rules. These decide whether a
## device-flow poll may put the frame into cloud-managed mode, so they are
## worth testing without a provider, a server or a state file.

import std/[json, strutils, unittest]

import ../link_state

suite "link scope helpers":
  test "scopes union keeps order and drops duplicates":
    check unionScopeString("frame:link frame:managed", "frame:managed") ==
      "frame:link frame:managed"
    check unionScopeString("frame:link auth:login", "frame:managed") ==
      "frame:link auth:login frame:managed"
    check unionScopeString("", "frame:managed") == "frame:managed"
    check unionScopeString("frame:link", "") == "frame:link"
    check unionScopeString("frame:link  frame:link", "") == "frame:link"

  test "managed mode needs the scope to be both requested and granted":
    # The happy path: the admin ticked "manage this frame" and got it.
    check managedEnrollmentRequested(%*{
      "requested_scope": "frame:link frame:managed",
      "scope": "frame:link frame:managed"})

  test "a provider cannot grant a scope this frame never asked for":
    # Linked for backups only; the provider answers the poll with the managed
    # scope anyway. Managed mode must NOT be entered on its say-so.
    check not managedEnrollmentRequested(%*{
      "requested_scope": "frame:link backup:assets",
      "scope": "frame:link backup:assets frame:managed"})
    # Requested but not granted stays off too.
    check not managedEnrollmentRequested(%*{
      "requested_scope": "frame:link frame:managed",
      "scope": "frame:link"})
    # Links minted before requested_scope existed never auto-enroll.
    check not managedEnrollmentRequested(%*{"scope": "frame:managed"})

  test "a provider's word adds only what was asked for, or what managing the frame already implies":
    # Linked for cloud login and nothing else; the provider answers with more.
    let asked = %*{"requested_scope": "frame:link auth:login", "scope": "frame:link auth:login"}
    check scopesTakenFromProvider(asked, ["frame:link", "auth:login", "frame:managed", "telemetry:logs"],
      managed = false) == @["frame:link", "auth:login"]
    # Fewer than asked for is the provider's to decide.
    check scopesTakenFromProvider(asked, ["frame:link"], managed = false) == @["frame:link"]
    # A managed frame (claim-token enrollment: no request on record) learns of
    # service keys and telemetry from its hub. It does not learn that the
    # provider's account may now sign in as its admin.
    let managed = %*{"status": "connected", "mode": "managed", "scope": "frame:managed"}
    check scopesTakenFromProvider(managed,
      ["frame:managed", "settings:services", "telemetry:logs", "telemetry:metrics", "auth:login", "remote:access"],
      managed = true) == @["frame:managed", "settings:services", "telemetry:logs", "telemetry:metrics"]
    # What the link holds already is not taken away by being announced again.
    let held = %*{"scope": "frame:managed auth:login"}
    check scopesTakenFromProvider(held, ["auth:login", "auth:login", ""], managed = true) == @["auth:login"]

  test "resetting a link forgets the requested scopes":
    let state = %*{"provider_url": "https://cloud.frameos.net",
                   "status": "connected",
                   "scope": "frame:link frame:managed",
                   "requested_scope": "frame:link frame:managed"}
    resetLinkState(state)
    check not state.hasKey("requested_scope")
    check not state.hasKey("scope")
    check not managedEnrollmentRequested(state)

suite "what may carry a cloud link":
  test "https anywhere, plain http only where nobody is on the path":
    for url in ["https://cloud.frameos.net", "https://203.0.113.9:8443", "HTTPS://cloud.example",
                "http://localhost:3000", "http://frameos.local", "http://dev.localhost:3000",
                "http://127.0.0.1:3000", "http://10.4.0.16:3000", "http://172.16.0.1", "http://172.31.255.1",
                "http://192.168.1.20:8989", "http://169.254.1.1", "http://100.64.0.1", "http://100.127.9.9:3000",
                "http://[::1]:3000", "http://[fe80::1]", "http://[fd12:3456::1]:3000"]:
      check providerTransportProblem(url) == ""
    for url in ["http://cloud.frameos.net", "http://example.com:3000", "http://203.0.113.9",
                "http://172.32.0.1", "http://100.128.0.1", "http://192.169.1.1", "http://1.2.3",
                "http://[2001:db8::1]", "http://localhost@evil.example", "http://10.0.0.1@evil.example/",
                "http://local", "http://127.0.0.1.evil.example", "http://999.1.1.1", "ftp://localhost", ""]:
      check providerTransportProblem(url) != ""
    expect ValueError:
      requireProviderTransport("http://cloud.example")
    requireProviderTransport("https://cloud.example")

suite "the local cloud-login switch":
  let granted = %*{"status": "connected", "scope": "frame:link auth:login"}

  test "the switch defaults to on and only ever narrows the grant":
    check cloudLoginGranted(granted)
    check cloudLoginPossible(granted)
    # Off: the grant is untouched, the frame simply stops offering it.
    let off = %*{"status": "connected", "scope": "frame:link auth:login",
                 "cloud_login_enabled": false}
    check cloudLoginGranted(off)
    check not cloudLoginPossible(off)
    # And a switch left on cannot conjure a grant that was never made.
    check not cloudLoginPossible(%*{"status": "connected", "scope": "frame:link",
                                    "cloud_login_enabled": true})

  test "switching cloud login off puts the admin password back":
    # The password is only ever off while the cloud can take over, so the two
    # switches can never both end up closed.
    let both = %*{"status": "connected", "scope": "frame:link auth:login",
                  "local_fallback_enabled": false, "cloud_login_enabled": false}
    check localAdminLoginEnabled(both)

  test "resetting a link restores both login switches":
    let state = %*{"status": "connected", "scope": "frame:link auth:login",
                   "cloud_login_enabled": false, "local_fallback_enabled": false}
    resetLinkState(state)
    check not state.hasKey("cloud_login_enabled")
    check localAdminLoginEnabled(state)

suite "leaving cloud-managed mode":
  test "demoting keeps the link and drops only the managed fields":
    let state = %*{"status": "connected", "provider_url": "https://cloud.example.com",
                   "access_token": "tok", "scope": "frame:link frame:managed",
                   "mode": "managed", "frame_id": "frm_1", "ws_path": "/api/frames/ws",
                   "scenes_checksum": "abc", "managed_enroll_error": "boom"}
    check clearManagedMode(state)
    check not isManagedLink(state)
    check state{"status"}.getStr("") == "connected"
    check state{"access_token"}.getStr("") == "tok"
    # The grant stays, so the switch can be turned back on without a new
    # approval on the provider.
    check "frame:managed" in state{"scope"}.getStr("")
    for key in ["mode", "frame_id", "ws_path", "scenes_checksum", "managed_enroll_error"]:
      check not state.hasKey(key)
    # Idempotent: a second call has nothing to remove.
    check not clearManagedMode(state)

suite "exporting link state":
  test "redaction strips every secret-bearing key and nothing else":
    let state = %*{"provider_url": "https://cloud.frameos.net",
                   "status": "connected",
                   "mode": "managed",
                   "frame_id": "frm_1",
                   "access_token": "FRCT_super-secret",
                   "token_reference": "tok_ref",
                   "device_code": "dc_pending",
                   "login_states": {"abc": {"expires_epoch": 1}},
                   "scope": "frame:link frame:managed"}
    let exported = redactedCloudLinkState(state)
    # Presence survives, the bytes do not.
    check exported["access_token"].getStr("") == "[redacted]"
    check exported["token_reference"].getStr("") == "[redacted]"
    check exported["device_code"].getStr("") == "[redacted]"
    check exported["login_states"].getStr("") == "[redacted]"
    check ($exported).find("super-secret") == -1
    check ($exported).find("dc_pending") == -1
    # Everything that is not a secret is untouched.
    check exported["frame_id"].getStr("") == "frm_1"
    check exported["scope"].getStr("") == "frame:link frame:managed"
    check exported["status"].getStr("") == "connected"
    # The original is not mutated: the live link still works.
    check state["access_token"].getStr("") == "FRCT_super-secret"

  test "empty secrets are dropped rather than marked redacted":
    let exported = redactedCloudLinkState(%*{"status": "disconnected",
                                              "access_token": "",
                                              "login_states": {}})
    check not exported.hasKey("access_token")
    check not exported.hasKey("login_states")
    check exported["status"].getStr("") == "disconnected"
    check redactedCloudLinkState(nil).len == 0
    check redactedCloudLinkState(%"not an object").len == 0
