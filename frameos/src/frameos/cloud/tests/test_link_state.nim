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

  test "resetting a link forgets the requested scopes":
    let state = %*{"provider_url": "https://cloud.frameos.net",
                   "status": "connected",
                   "scope": "frame:link frame:managed",
                   "requested_scope": "frame:link frame:managed"}
    resetLinkState(state)
    check not state.hasKey("requested_scope")
    check not state.hasKey("scope")
    check not managedEnrollmentRequested(state)

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
