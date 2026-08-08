## Shared on-disk state for this frame's direct link to FrameOS Cloud.
##
## The link state lives in ./state/cloud_link.json (0600). It powers both the
## classic direct link (docs/cloud-link.md) and cloud-managed mode
## (docs/cloud-frames.md, `"mode": "managed"`). The helpers here are shared by
## the local HTTP routes (server/routes/cloud_api_routes.nim), enrollment
## (cloud/enrollment.nim), and the management hub client (cloud/hub_client.nim),
## so none of them need to import the HTTP server to read or write link state.
##
## Concurrency: every read-modify-write of the state file must hold
## `cloudLinkLock`. Writers must never hold the lock across network calls.
## `saveCloudLinkState` bumps `cloudLinkGeneration` so long-lived readers (the
## hub client thread) can notice changes without re-parsing the file each tick.

import json
import locks
import os
import std/atomics
import strutils
import times

const
  CLOUD_LINK_STATE_PATH* = "./state/cloud_link.json"
  DEFAULT_CLOUD_PROVIDER_URL* = "https://cloud.frameos.net"

# Scopes a frame link may request; must stay in sync with docs/cloud-link.md
# and docs/cloud-frames.md.
const KNOWN_FRAME_SCOPES* = [
  "frame:link",
  "frame:managed",
  "auth:login",
  "backup:assets",
  "remote:access",
  # Lets the provider serve this frame the account's service API keys
  # (docs/cloud-frames.md, "Service settings"). Granted per frame on the
  # provider; a managed frame usually learns it from the `ready` scope list
  # rather than asking for it here.
  "settings:services",
  "telemetry:logs",
  "telemetry:metrics",
]
const DEFAULT_FRAME_SCOPES* = @["frame:link"]

var cloudLinkLock*: Lock
initLock(cloudLinkLock)

## Bumped on every saveCloudLinkState so background threads can cheaply detect
## that the link state changed (enrollment, disconnect, scope updates).
var cloudLinkGeneration*: Atomic[int]

proc currentCloudLinkGeneration*(): int {.gcsafe.} =
  {.gcsafe.}:
    cloudLinkGeneration.load(moRelaxed)

proc isoTimestamp*(epoch: int64): string =
  format(fromUnix(epoch), "yyyy-MM-dd'T'HH:mm:ss'Z'", utc())

proc loadCloudLinkState*(): JsonNode {.gcsafe.} =
  if fileExists(CLOUD_LINK_STATE_PATH):
    try:
      let parsed = parseJson(readFile(CLOUD_LINK_STATE_PATH))
      if parsed.kind == JObject:
        return parsed
    except CatchableError:
      discard
  %*{"status": "disconnected"}

proc saveCloudLinkState*(state: JsonNode) {.gcsafe.} =
  ## This file holds the link bearer token, so its bytes must never be readable
  ## by another local account — not even for the window between writing the
  ## content and chmod'ing it, which is what the previous order left open at
  ## whatever the process umask happened to be.
  let dir = splitFile(CLOUD_LINK_STATE_PATH).dir
  if dir.len > 0 and not dirExists(dir):
    createDir(dir)
  if dir.len > 0:
    try:
      setFilePermissions(dir, {fpUserRead, fpUserWrite, fpUserExec})
    except CatchableError:
      discard
  let tempPath = CLOUD_LINK_STATE_PATH & ".tmp"
  let handle = open(tempPath, fmWrite)
  try:
    setFilePermissions(tempPath, {fpUserRead, fpUserWrite})
    handle.write(pretty(state, indent = 2) & "\n")
  finally:
    handle.close()
  # Rename straight over the target: an interrupted replace then leaves the
  # previous state intact instead of no state at all.
  moveFile(tempPath, CLOUD_LINK_STATE_PATH)
  {.gcsafe.}:
    atomicInc(cloudLinkGeneration)

proc normalizeProviderUrl*(value: string): string =
  ## Empty string means "invalid"; callers fall back or reject.
  var url = value.strip()
  if url.len == 0:
    return ""
  if not (url.startsWith("http://") or url.startsWith("https://")):
    return ""
  while url.endsWith("/"):
    url = url[0 ..< url.len - 1]
  url

proc providerUrlFromState*(state: JsonNode): string =
  let stored = normalizeProviderUrl(state{"provider_url"}.getStr(""))
  if stored.len > 0: stored else: DEFAULT_CLOUD_PROVIDER_URL

proc resetLinkState*(state: JsonNode, pollError: string = "") =
  let providerUrl = providerUrlFromState(state)
  for key in ["device_code", "user_code", "verification_uri", "verification_uri_complete",
              "expires_epoch", "access_token", "token_reference", "linked_client_id",
              "account_id", "account_email", "scope", "requested_scope",
              "poll_error", "local_origin",
              "connected_at", "last_inventory_sync_at", "login_states",
              # Cloud-managed mode (docs/cloud-frames.md): leaving managed mode
              # or resetting the link always clears these too.
              "mode", "frame_id", "ws_path", "scenes_checksum", "managed_enroll_error"]:
    if state.hasKey(key):
      state.delete(key)
  state["provider_url"] = %providerUrl
  state["status"] = %"disconnected"
  if pollError.len > 0:
    state["poll_error"] = %pollError

proc expireIfNeeded*(state: JsonNode): bool =
  if state{"status"}.getStr("") == "connecting" and
      state{"expires_epoch"}.getInt(0) > 0 and
      int64(state{"expires_epoch"}.getInt(0)) <= int64(epochTime()):
    resetLinkState(state, pollError = "expired")
    return true
  false

proc linkHasScope*(state: JsonNode, scope: string): bool =
  scope in state{"scope"}.getStr("").splitWhitespace()

proc linkScopes*(state: JsonNode): seq[string] =
  for scope in state{"scope"}.getStr("").splitWhitespace():
    result.add(scope)

proc requestedLinkScopes*(state: JsonNode): seq[string] =
  ## The scopes this frame asked for when the local admin started the link
  ## (persisted by POST /api/cloud/connect). Empty for links minted before this
  ## field existed, and for claim-token enrollments, which are a local ceremony
  ## with no device-flow request behind them.
  for scope in state{"requested_scope"}.getStr("").splitWhitespace():
    result.add(scope)

proc managedEnrollmentRequested*(state: JsonNode): bool =
  ## True only when `frame:managed` was BOTH asked for locally and granted by
  ## the provider. The granted half alone is the provider's word for it: a
  ## provider that simply returns `frame:managed` in its device-flow poll
  ## response must not be able to turn a backups-only link into full remote
  ## management behind the admin's back.
  ##
  ## Links with no recorded request (created before this field existed) never
  ## auto-enroll; the local admin can still enroll deliberately from the admin
  ## page, which is the ceremony this check exists to protect.
  "frame:managed" in requestedLinkScopes(state) and linkHasScope(state, "frame:managed")

proc unionScopeString*(existing, added: string): string =
  ## Whitespace-separated scope strings merged with existing order preserved
  ## and no duplicates. Used when a later step in a link's life reports the
  ## scopes it cares about (managed enrollment answers `frame:managed`): those
  ## must be added to what the link already holds, never replace it.
  var scopes: seq[string] = @[]
  for scope in existing.splitWhitespace():
    if scope notin scopes:
      scopes.add(scope)
  for scope in added.splitWhitespace():
    if scope notin scopes:
      scopes.add(scope)
  scopes.join(" ")

proc isManagedLink*(state: JsonNode): bool =
  ## True when this frame is cloud-managed and the link is live.
  state{"mode"}.getStr("") == "managed" and
    state{"status"}.getStr("") == "connected" and
    state{"access_token"}.getStr("") != ""
