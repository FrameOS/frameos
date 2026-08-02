## Enrollment of this frame with a cloud provider (docs/cloud-frames.md).
##
## Two flows mint the same managed link:
##
## * Flow A — claim token: `enrollManagedFrame(providerUrl, claimToken, ...)`
##   POSTs `{provider}/api/frames/enroll` unauthenticated with the single-use
##   claim token plus the device-generated Ed25519 public key. The response's
##   `access_token`/`frame_id`/`ws_path` land in ./state/cloud_link.json with
##   `"mode": "managed"`.
## * Flow B — device-flow Bearer token: after the RFC 8628 poll completes with
##   the `frame:managed` scope, the same endpoint is called with the Bearer
##   token instead of a claim token to register the public key and fetch
##   `frame_id`/`ws_path`.
##
## Claim-token boot handoff (SD image personalization / flasher / portal):
## whatever provisions the device writes ./state/cloud_enroll_pending.json
## (0600) with:
##
## ```json
## {
##   "claim_token": "FRCT-…",
##   "provider_url": "https://cloud.frameos.net",
##   "name": "Kitchen frame",          // optional
##   "expires_epoch": 1770000000       // optional; defaults to 24h after the
## }                                    //   first attempt
## ```
##
## At startup the cloud hub thread calls `processPendingCloudEnrollment` with
## backoff until the token is exchanged, rejected, or expired; the file is
## deleted once resolved (`enrollWithClaimTokenFromBoot` is the direct entry
## point when the personalization values arrive by other means).
##
## One control plane at a time: enrollment is refused while
## `frameConfig.serverHost` names a self-hosted backend. Leaving managed mode
## is POST /api/cloud/disconnect on the local admin — no provider verb exists
## for either transition.

import json
import locks
import os
import strutils
import times
import httpcore
import std/httpclient

import frameos/types
import frameos/upgrade
from frameos/config import getConfigFilename
import frameos/utils/http_client
import ./identity
import ./link_state

const
  CLOUD_ENROLL_PENDING_PATH = "./state/cloud_enroll_pending.json"
  DEFAULT_MANAGED_WS_PATH* = "/api/frames/ws"
  ENROLL_REQUEST_TIMEOUT_MS = 15000
  ENROLL_REQUEST_MAX_SECONDS = 20.0
  PENDING_ENROLL_DEFAULT_TTL_SECONDS = 24 * 60 * 60

type
  EnrollOutcome* = object
    ok*: bool
    status*: int      ## HTTP status (0 on transport failure)
    error*: string    ## provider error code or transport message
    retryable*: bool  ## true for network errors / 5xx / 429

proc pendingEnrollmentPath*(): string =
  let override = getEnv("FRAMEOS_CLOUD_ENROLL_PENDING_PATH")
  if override.len > 0: override else: CLOUD_ENROLL_PENDING_PATH

proc otherControlPlaneActive*(frameConfig: FrameConfig): bool =
  ## True when a self-hosted backend manages this frame (frame.json serverHost).
  frameConfig != nil and frameConfig.serverHost.strip().len > 0

proc hardwarePayload*(frameConfig: FrameConfig): JsonNode =
  result = %*{
    "platform": if frameConfig != nil: frameConfig.mode else: "",
    "device": if frameConfig != nil: frameConfig.device else: "",
    "width": if frameConfig != nil: frameConfig.width else: 0,
    "height": if frameConfig != nil: frameConfig.height else: 0,
  }
  # "color" only lives in raw frame.json (device color variant); include it
  # when present, drop it otherwise — providers must drop unknown/missing
  # optional fields anyway.
  try:
    let configJson = parseFile(getConfigFilename())
    if configJson.kind == JObject and configJson{"color"} != nil and
        configJson{"color"}.kind == JString and configJson{"color"}.getStr() != "":
      result["color"] = configJson["color"]
  except CatchableError:
    discard

proc enrollRequest(providerUrl: string, accessToken: string,
                   body: JsonNode): (int, JsonNode) =
  var headers = newHttpHeaders({"Accept": "application/json",
                                "Content-Type": "application/json"})
  if accessToken.len > 0:
    headers["Authorization"] = "Bearer " & accessToken
  let response = boundedRequest(
    providerUrl & "/api/frames/enroll",
    httpMethod = HttpPost,
    body = $body,
    headers = headers,
    timeoutMs = ENROLL_REQUEST_TIMEOUT_MS,
    maxSeconds = ENROLL_REQUEST_MAX_SECONDS,
    maxRedirects = 1,
  )
  var payload: JsonNode = nil
  try:
    payload = parseJson(response.body)
  except CatchableError:
    discard
  if payload == nil or payload.kind != JObject:
    payload = %*{}
  (response.code, payload)

proc enrollManagedFrame*(providerUrl, claimToken, bearerToken, name: string,
                         frameConfig: FrameConfig): EnrollOutcome {.gcsafe.} =
  ## Enrolls this frame as cloud-managed. Exactly one of claimToken (flow A)
  ## or bearerToken (flow B) must be non-empty. On success the managed link
  ## fields are persisted into cloud_link.json under cloudLinkLock.
  {.gcsafe.}:
    let normalizedUrl = normalizeProviderUrl(providerUrl)
    if normalizedUrl.len == 0:
      return EnrollOutcome(ok: false, status: 0, error: "invalid_provider_url", retryable: false)
    if claimToken.len == 0 and bearerToken.len == 0:
      return EnrollOutcome(ok: false, status: 0, error: "missing_credentials", retryable: false)
    if otherControlPlaneActive(frameConfig):
      return EnrollOutcome(ok: false, status: 409, error: "backend_managed", retryable: false)

    let publicKey =
      try:
        ensureDeviceKeypair().publicKeyBase64
      except CloudIdentityError as error:
        return EnrollOutcome(ok: false, status: 0, error: "keypair: " & error.msg, retryable: false)

    var body = %*{
      "public_key": publicKey,
      "hardware": hardwarePayload(frameConfig),
      "frameos_version": installedFrameOSVersion(),
    }
    if claimToken.len > 0:
      body["claim_token"] = %claimToken
    var frameName = name
    if frameName.len == 0 and frameConfig != nil:
      frameName = frameConfig.name
    if frameName.len > 0:
      body["name"] = %frameName

    var code = 0
    var response: JsonNode = %*{}
    try:
      (code, response) = enrollRequest(normalizedUrl, bearerToken, body)
    except CatchableError as error:
      return EnrollOutcome(ok: false, status: 0, error: "network_error: " & error.msg, retryable: true)

    if code != 200:
      let providerError = response{"error"}.getStr("")
      return EnrollOutcome(
        ok: false,
        status: code,
        error: if providerError.len > 0: providerError else: "unexpected status " & $code,
        retryable: code == 429 or code >= 500,
      )

    let frameId = response{"frame_id"}
    let wsPath = response{"ws_path"}.getStr(DEFAULT_MANAGED_WS_PATH)
    let scope = response{"scope"}.getStr("frame:managed")
    let accessToken = response{"access_token"}.getStr("")
    if claimToken.len > 0 and accessToken.len == 0:
      return EnrollOutcome(ok: false, status: code, error: "missing_access_token", retryable: false)

    withLock cloudLinkLock:
      let state = loadCloudLinkState()
      if claimToken.len > 0:
        # Flow A starts a fresh link owned by the enrolling provider.
        resetLinkState(state)
        state["provider_url"] = %normalizedUrl
        state["status"] = %"connected"
        state["access_token"] = %accessToken
        state["scope"] = %scope
        state["connected_at"] = %isoTimestamp(int64(epochTime()))
        if response{"token_reference"} != nil:
          state["token_reference"] = response["token_reference"]
        if response{"linked_client_id"} != nil:
          state["linked_client_id"] = response["linked_client_id"]
      else:
        # Flow B upgrades the existing device-flow link in place.
        if state{"status"}.getStr("") != "connected":
          return EnrollOutcome(ok: false, status: 409, error: "not_connected", retryable: false)
        if response{"scope"}.getStr("") != "":
          # The enroll response only ever reports the managed scope, so it is
          # additive: replacing the link's scope string here would silently
          # drop everything else the device-flow grant carried (auth:login,
          # telemetry:logs, backup:assets …).
          state["scope"] = %unionScopeString(state{"scope"}.getStr(""),
                                             response{"scope"}.getStr(""))
      state["mode"] = %"managed"
      if frameId != nil and frameId.kind != JNull:
        state["frame_id"] = frameId
      state["ws_path"] = %wsPath
      if state.hasKey("managed_enroll_error"):
        state.delete("managed_enroll_error")
      saveCloudLinkState(state)

    EnrollOutcome(ok: true, status: code, error: "", retryable: false)

proc enrollWithClaimTokenFromBoot*(claimToken, providerUrl, name: string,
                                   frameConfig: FrameConfig): EnrollOutcome {.gcsafe.} =
  ## Entry point for boot-time provisioning (buildroot personalization file,
  ## ESP32 flasher, setup portal). Same as flow A; exists so callers outside
  ## this module have a stable name to call with the three personalization
  ## values.
  enrollManagedFrame(providerUrl, claimToken, "", name, frameConfig)

proc shredFile(path: string) =
  ## Overwrite a secret-bearing file in place. Boot personalization files land
  ## on SD cards whose freed blocks are trivially recoverable, and a claim
  ## token stays usable until the provider expires it — so every path that
  ## retires one overwrites the bytes first, matching how the rest of this
  ## branch (and setup_json_reset.sh) treats boot secrets. Best effort by
  ## nature: a copy-on-write or wear-levelling filesystem may still keep the
  ## old blocks.
  if not fileExists(path):
    return
  let size = int(getFileSize(path))
  if size <= 0:
    return
  let handle = open(path, fmReadWriteExisting)
  try:
    handle.setFilePos(0)
    handle.write(repeat('\0', size))
    handle.flushFile()
  finally:
    handle.close()

proc clearPendingEnrollment*(): bool {.gcsafe, discardable.} =
  ## Shreds and removes the pending enrollment file. Returns whether it is gone
  ## — a failed removal must not be reported as "resolved" (see below).
  let path = pendingEnrollmentPath()
  try:
    if not fileExists(path):
      return true
    shredFile(path)
    removeFile(path)
  except CatchableError:
    discard
  not fileExists(path)

proc loadPendingEnrollment*(): JsonNode {.gcsafe.} =
  ## nil when there is no pending boot enrollment.
  let path = pendingEnrollmentPath()
  if not fileExists(path):
    return nil
  try:
    let parsed = parseJson(readFile(path))
    if parsed.kind == JObject and parsed{"claim_token"}.getStr("") != "":
      return parsed
  except CatchableError:
    discard
  # Unreadable/invalid pending file: drop it so boot never loops on junk. It
  # may still hold a readable claim token, so shred rather than unlink.
  discard clearPendingEnrollment()
  nil

proc savePendingEnrollment(pending: JsonNode) =
  let path = pendingEnrollmentPath()
  let dir = splitFile(path).dir
  if dir.len > 0 and not dirExists(dir):
    createDir(dir)
  if dir.len > 0:
    # Same discipline as identity.nim/link_state.nim: this file holds a live
    # claim token, so the directory must not be traversable by other accounts.
    try:
      setFilePermissions(dir, {fpUserRead, fpUserWrite, fpUserExec})
    except CatchableError:
      discard
  let tempPath = path & ".tmp"
  let handle = open(tempPath, fmWrite)
  try:
    setFilePermissions(tempPath, {fpUserRead, fpUserWrite})
    handle.write($pending & "\n")
  finally:
    handle.close()
  # The rename below orphans the previous file's blocks with the claim token
  # still in them; overwrite them first. This trades a sliver of the rename's
  # atomicity (a crash in between leaves a zeroed file, and the next boot drops
  # the enrollment instead of retrying it) for not leaving a live token in
  # unlinked SD-card blocks — the same call this branch makes everywhere else.
  try:
    shredFile(path)
  except CatchableError:
    discard
  moveFile(tempPath, path)

proc processPendingCloudEnrollment*(frameConfig: FrameConfig):
    tuple[resolved: bool, attempted: bool, outcome: EnrollOutcome] {.gcsafe.} =
  ## Runs one enrollment attempt from ./state/cloud_enroll_pending.json.
  ## Returns resolved=true when the pending file is finished with (success,
  ## permanent rejection, or expiry) and has been deleted; resolved=false
  ## means "retry later with backoff" (network errors, 429/5xx).
  {.gcsafe.}:
    # "Resolved" must mean the file is really gone. Reporting resolved while it
    # is still on disk makes the hub thread reset its enrollment backoff and
    # come straight back (hub_client.nim), which on a full or read-only state
    # directory is a ~2s hot loop for the life of the process.
    let pendingGone = proc(): bool = not fileExists(pendingEnrollmentPath())

    var pending = loadPendingEnrollment()
    if pending == nil:
      return (resolved: pendingGone(), attempted: false, outcome: EnrollOutcome())

    let now = int64(epochTime())
    var expiresEpoch = int64(pending{"expires_epoch"}.getInt(0))
    if expiresEpoch <= 0:
      # Claim tokens are short-lived (cloud.frameos.net: 24 h); without an
      # explicit expiry, stop retrying 24h after the first attempt.
      expiresEpoch = now + PENDING_ENROLL_DEFAULT_TTL_SECONDS
      pending["expires_epoch"] = %expiresEpoch
      try:
        savePendingEnrollment(pending)
      except CatchableError:
        discard
    if expiresEpoch <= now:
      discard clearPendingEnrollment()
      return (resolved: pendingGone(), attempted: false,
              outcome: EnrollOutcome(ok: false, error: "claim_token_expired"))

    let outcome = enrollWithClaimTokenFromBoot(
      pending{"claim_token"}.getStr(""),
      pending{"provider_url"}.getStr(DEFAULT_CLOUD_PROVIDER_URL),
      pending{"name"}.getStr(""),
      frameConfig,
    )
    if outcome.ok or not outcome.retryable:
      # Success — or the provider/config permanently rejected the token
      # (claim tokens die on first use either way, so retrying cannot help).
      discard clearPendingEnrollment()
      return (resolved: pendingGone(), attempted: true, outcome: outcome)
    (resolved: false, attempted: true, outcome: outcome)
