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
##   "time_zone": "Europe/Brussels",   // optional (IANA name)
##   "expires_epoch": 1770000000       // optional; defaults to 24h after the
## }                                    //   first attempt
##
## `name` and `time_zone` are the card's personalization; on a successful
## enrollment the hub thread writes them into frame.json (see
## pendingPersonalization) — the name used to reach the provider only, so the
## panel kept saying "FrameOS Setup" and the clock stayed on UTC.
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
import std/atomics
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
  # RTC-less boards (Pi Zero) boot with the clock in the past until NTP
  # syncs. Any wall-clock deadline read or stamped before that moment is
  # garbage — a real device stamped "now + 24h" seconds after boot, NTP then
  # jumped the clock a year forward, and the very next pass declared the
  # claim token expired and deleted the pending enrollment without a single
  # request ever leaving the frame.
  PENDING_ENROLL_CLOCK_SANITY_EPOCH* = 1735689600'i64 # 2025-01-01

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
  ## Loopback hosts don't count: generic SD images have shipped frame.json with
  ## the placeholder serverHost "localhost", and a backend at the frame's own
  ## loopback cannot be a real control plane — treating it as one made every
  ## boot-time claim-token enrollment fail permanently (409 backend_managed)
  ## and shred the token before a single request left the device.
  if frameConfig == nil:
    return false
  let host = frameConfig.serverHost.strip().toLowerAscii()
  host.len > 0 and host notin ["localhost", "127.0.0.1", "::1", "[::1]"]

const DEVICE_TREE_COMPATIBLE_PATH* = "/proc/device-tree/compatible"

proc boardForCompatible*(compatible: string, cpu: string): string =
  ## Map the device tree's `compatible` list onto the Buildroot platform key
  ## whose SD image this board runs (the keys in
  ## backend/app/tasks/buildroot_platforms.py). The cloud has no other way to
  ## learn the board: `hardware.platform` is frame.json's deployment mode
  ## ("buildroot"), and nothing on the card records which defconfig built it —
  ## so "write another SD card" opened on "Pick a board…" for every frame.
  ##
  ## `compatible` is NUL-separated ("raspberrypi,5-model-b\0brcm,bcm2712"),
  ## which `contains` does not care about. BCM2712 is the one SoC with its own
  ## image (raspberry-pi-5); every other Pi is told apart by the architecture
  ## the running binary was built for, which is exactly what picks the image:
  ## ARMv6 boards (Zero/Zero W/1/CM1) run raspberry-pi-32, 64-bit boards
  ## (Zero 2 W / 3 / 4) run raspberry-pi-64.
  ##
  ## Anything that is not a Raspberry Pi reports nothing rather than a guess —
  ## a wrong board is the one field the setup portal cannot recover from,
  ## because a card for the wrong SoC does not boot far enough to say so.
  let lower = compatible.toLowerAscii()
  if "bcm2712" in lower:
    return "raspberry-pi-5"
  if "raspberrypi" notin lower and "brcm,bcm2" notin lower:
    return ""
  case cpu
  of "arm64", "aarch64":
    "raspberry-pi-64"
  of "arm", "armv6":
    "raspberry-pi-32"
  else:
    ""

proc detectBoard*(): string =
  ## Best effort, and silent when it cannot tell: an absent `board` leaves the
  ## SD-card form exactly as it was before this existed.
  try:
    if not fileExists(DEVICE_TREE_COMPATIBLE_PATH):
      return ""
    boardForCompatible(readFile(DEVICE_TREE_COMPATIBLE_PATH), hostCPU)
  except CatchableError:
    ""

proc hardwarePayload*(frameConfig: FrameConfig): JsonNode =
  result = %*{
    "platform": if frameConfig != nil: frameConfig.mode else: "",
    "device": if frameConfig != nil: frameConfig.device else: "",
    "width": if frameConfig != nil: frameConfig.width else: 0,
    "height": if frameConfig != nil: frameConfig.height else: 0,
  }
  # The board this frame runs on, when it is one FrameOS publishes an image
  # for. Omitted otherwise — providers drop unknown/missing optional fields,
  # and an absent key is honest about not knowing.
  let board = detectBoard()
  if board.len > 0:
    result["board"] = %board
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

proc pendingPersonalization*(pending: JsonNode): JsonNode =
  ## The frame.json-bound fields of a pending enrollment, in the local admin
  ## API's spelling (name, timezone) so persistFrameApiUpdate can take them
  ## as-is. Empty object when there is nothing to apply.
  result = newJObject()
  if pending == nil or pending.kind != JObject:
    return
  let name = pending{"name"}.getStr("").strip()
  if name.len > 0:
    result["name"] = %name
  let timeZone = pending{"time_zone"}.getStr("").strip()
  if timeZone.len > 0:
    result["timezone"] = %timeZone
  # Not an admin-API key: `network` is replaced wholesale by
  # persistFrameApiUpdate, so the caller folds this into the stored network
  # object rather than sending a one-key replacement (hub_client.nim).
  let wifiCountry = pending{"wifi_country"}.getStr("").strip().toUpperAscii()
  if wifiCountry.len == 2 and wifiCountry[0] in {'A'..'Z'} and wifiCountry[1] in {'A'..'Z'}:
    result["wifiCountry"] = %wifiCountry

proc writePendingEnrollment*(claimToken, providerUrl, name: string): bool {.gcsafe.} =
  ## Queues a claim-token enrollment for the hub thread to redeem. Entry point
  ## for provisioning that happens after boot (the setup portal's claim-code
  ## field); the boot handoff writes the same file from /boot/frameos-cloud.txt.
  {.gcsafe.}:
    let token = claimToken.strip()
    if token.len == 0:
      return false
    var url = normalizeProviderUrl(providerUrl)
    if url.len == 0:
      url = DEFAULT_CLOUD_PROVIDER_URL
    var pending = %*{"claim_token": token, "provider_url": url}
    if name.strip().len > 0:
      pending["name"] = %name.strip()
    try:
      savePendingEnrollment(pending)
      true
    except CatchableError:
      false

var enrollmentNudge: Atomic[bool]

proc requestEnrollmentNudge*() {.gcsafe.} =
  ## Asks the hub thread to retry a pending enrollment right away instead of
  ## waiting out its backoff — the portal calls this once Wi-Fi is up, since
  ## every pre-network attempt failed with a network error and pushed the next
  ## try up to HubEnrollBackoffMaxSeconds away.
  enrollmentNudge.store(true, moRelaxed)

proc takeEnrollmentNudge*(): bool {.gcsafe.} =
  enrollmentNudge.exchange(false, moRelaxed)

proc processPendingCloudEnrollment*(frameConfig: FrameConfig):
    tuple[resolved: bool, attempted: bool, outcome: EnrollOutcome, personalization: JsonNode] {.gcsafe.} =
  ## Runs one enrollment attempt from ./state/cloud_enroll_pending.json.
  ## Returns resolved=true when the pending file is finished with (success,
  ## permanent rejection, or expiry) and has been deleted; resolved=false
  ## means "retry later with backoff" (network errors, 429/5xx).
  ## `personalization` carries the card's name / time zone (see
  ## pendingPersonalization) for the caller to write into frame.json once
  ## `outcome.ok` — the pending file is gone by then.
  {.gcsafe.}:
    result.personalization = newJObject()
    # "Resolved" must mean the file is really gone. Reporting resolved while it
    # is still on disk makes the hub thread reset its enrollment backoff and
    # come straight back (hub_client.nim), which on a full or read-only state
    # directory is a ~2s hot loop for the life of the process.
    let pendingGone = proc(): bool = not fileExists(pendingEnrollmentPath())

    var pending = loadPendingEnrollment()
    if pending == nil:
      return (resolved: pendingGone(), attempted: false, outcome: EnrollOutcome(),
              personalization: newJObject())
    let personalization = pendingPersonalization(pending)

    let now = int64(epochTime())
    let clockSynced = now >= PENDING_ENROLL_CLOCK_SANITY_EPOCH
    var expiresEpoch = int64(pending{"expires_epoch"}.getInt(0))
    if expiresEpoch > 0 and expiresEpoch < PENDING_ENROLL_CLOCK_SANITY_EPOCH:
      # Stamped by a pre-NTP clock: discard the bogus deadline instead of
      # abandoning a perfectly good claim token when the clock corrects.
      expiresEpoch = 0
    if expiresEpoch <= 0 and clockSynced:
      # Claim tokens are short-lived (cloud.frameos.net: 24 h); without an
      # explicit expiry, stop retrying 24h after the first attempt. Never
      # stamped from an unsynced clock — the enrollment simply keeps
      # retrying until NTP gives us a real "now" to count from.
      expiresEpoch = now + PENDING_ENROLL_DEFAULT_TTL_SECONDS
      pending["expires_epoch"] = %expiresEpoch
      try:
        savePendingEnrollment(pending)
      except CatchableError:
        discard
    if expiresEpoch > 0 and expiresEpoch <= now:
      discard clearPendingEnrollment()
      return (resolved: pendingGone(), attempted: false,
              outcome: EnrollOutcome(ok: false, error: "claim_token_expired"),
              personalization: newJObject())

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
      return (resolved: pendingGone(), attempted: true, outcome: outcome,
              personalization: personalization)
    (resolved: false, attempted: true, outcome: outcome, personalization: personalization)
