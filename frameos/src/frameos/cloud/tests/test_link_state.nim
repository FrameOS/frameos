## Pure helpers behind the cloud link's scope rules. These decide whether a
## device-flow poll may put the frame into cloud-managed mode, so they are
## worth testing without a provider, a server or a state file.

import std/[json, unittest]

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
