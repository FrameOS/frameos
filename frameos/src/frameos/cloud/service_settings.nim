## Service settings for cloud-managed frames (docs/cloud-frames.md,
## "Service settings").
##
## Scenes need third-party credentials to render — an Unsplash access key, an
## OpenAI API key, a Home Assistant URL and token. On a cloud-managed frame
## those belong to the owner's provider account and the device **fetches**
## them; they are never pushed. The provider's command queue is durable and
## never pruned, so a key that entered it would outlive its own deletion, would
## pass through the hub, and could be redelivered after revocation. The socket
## therefore carries only the zero-payload `refresh_service_settings` nudge and
## the keys ride a device-authed HTTPS request the device makes itself:
##
## ```http
## GET {provider}/api/frames/{frame_id}/service-settings
## Authorization: Bearer <access_token>
## If-None-Match: "<etag from the last fetch>"
## ```
##
## Native (Raspberry Pi / Linux) builds only: this route lives and dies by the
## `ETag`/`If-None-Match` pair, and only the native `BoundedHttpResponse`
## carries response headers — the embedded firmware does the equivalent fetch
## on its C side. Nothing in this module is reachable from the embedded build
## (only cloud/hub_client.nim imports it).
##
## Nothing here ever logs, formats or returns a response body or a settings
## value. Callers get a status, an ETag and flags; the payload goes straight to
## the apply callback.

import json
import httpcore
import strutils
import std/uri

import frameos/utils/http_client

const
  ServiceSettingsScope* = "settings:services"
    ## The scope the link must hold for the provider to answer this route at
    ## all. A frame's own scope list is additive and never forgets, so the
    ## provider's `403 insufficient_scope` — not the local list — is what a
    ## revocation actually means (see applyServiceSettingsFetch).
  ServiceSettingsMaxBytes* = 16 * 1024
    ## The whole deliverable set is six groups of at most two short string
    ## fields, so 16 KiB is orders of magnitude more than the contract needs.
    ## Enforced twice: once by the bounded transport, once on the body below,
    ## so an injected/edge-case reader cannot slip past the transport cap.
  ServiceSettingsTimeoutMs* = 10_000
  ServiceSettingsMaxSeconds* = 12.0

type
  ServiceSettingsFetch* = object
    ## One conditional fetch. `status` is the HTTP status, or 0 when the
    ## request never produced one (DNS, connect, TLS, timeout).
    status*: int
    etag*: string
    payload*: JsonNode ## the parsed 200 body; nil for every other status
    error*: string     ## provider error code, or a transport error label

  ServiceSettingsApply* = proc(settings: JsonNode): bool {.gcsafe.}
    ## Applies the `settings` object (group → field → value) to the device,
    ## deleting every cloud-owned group absent from it. `nil` means "delete all
    ## of them" — what a revocation looks like. Returns whether anything
    ## actually changed.

  ServiceSettingsFetcher* = proc(providerUrl, frameId, accessToken,
                                 etag: string): ServiceSettingsFetch {.gcsafe.}
    ## Injection seam: tests hand syncServiceSettings a canned response instead
    ## of standing up a provider.

  ServiceSettingsSync* = object
    ## What one pull did. Exactly one of these outcomes is interesting to the
    ## session loop at a time; the rest are for logging.
    status*: int
    changed*: bool     ## the device's copy changed → emit `reload`
    cleared*: bool     ## the six groups were deleted (403 insufficient_scope)
    etag*: string      ## the ETag to send as If-None-Match next time ("" = none)
    authFailed*: bool  ## 401 → feeds the existing demotion counter
    retryLater*: bool  ## 429/5xx/transport/apply failure → keep the current copy
    error*: string

proc serviceSettingsUrl*(providerUrl, frameId: string): string =
  ## The frame id is a provider-minted opaque identifier; encode it rather than
  ## trusting it to be path-safe.
  providerUrl & "/api/frames/" & encodeUrl(frameId, usePlus = false) &
    "/service-settings"

proc parseServiceSettingsBody*(body: string): tuple[settings: JsonNode, error: string] =
  ## Validates one 200 body. Returns the `settings` object (never nil on
  ## success — an empty object is a legitimate "nothing configured", which
  ## deletes every group) and an error label otherwise. The body itself is
  ## never echoed into the error.
  if body.len > ServiceSettingsMaxBytes:
    return (nil, "too_large")
  var parsed: JsonNode = nil
  try:
    parsed = parseJson(body)
  except CatchableError:
    return (nil, "invalid_body")
  if parsed == nil or parsed.kind != JObject:
    return (nil, "invalid_body")
  let settings = parsed{"settings"}
  if settings == nil or settings.kind != JObject:
    return (nil, "invalid_body")
  (settings, "")

proc fetchServiceSettings*(providerUrl, frameId, accessToken,
                           etag: string): ServiceSettingsFetch {.gcsafe.} =
  ## GET the account's service settings for this frame, conditionally when we
  ## already hold an ETag. Bounded in time and size; one redirect at most (the
  ## provider's API answers directly), and `boundedRequest` drops the
  ## Authorization header on any cross-origin hop.
  {.gcsafe.}:
    result = ServiceSettingsFetch(status: 0)
    if providerUrl.len == 0 or frameId.len == 0 or accessToken.len == 0:
      result.error = "not_enrolled"
      return
    var headers = newHttpHeaders({
      "Accept": "application/json",
      "Authorization": "Bearer " & accessToken,
      # This body is the account's credentials: no on-device or intermediate
      # cache may hold it, matching the provider's own Cache-Control: no-store.
      "Cache-Control": "no-store",
    })
    if etag.len > 0:
      headers["If-None-Match"] = etag
    var response: BoundedHttpResponse
    try:
      response = boundedRequest(
        serviceSettingsUrl(providerUrl, frameId),
        httpMethod = HttpGet,
        headers = headers,
        timeoutMs = ServiceSettingsTimeoutMs,
        maxBytes = ServiceSettingsMaxBytes,
        maxSeconds = ServiceSettingsMaxSeconds,
        maxRedirects = 1,
      )
    except CatchableError as error:
      # The message can name the URL and the limits, never the body.
      result.error =
        if "exceeded" in error.msg: "too_large" else: "network_error"
      return
    result.status = response.code
    result.etag = headerValue(response.headers, "ETag")
    if response.code == 200:
      let (settings, error) = parseServiceSettingsBody(response.body)
      if error.len > 0:
        result.error = error
      else:
        result.payload = settings
    elif response.code != 304:
      # Error bodies carry a bare `{"error": "…"}` code and nothing else.
      try:
        let parsed = parseJson(response.body)
        if parsed != nil and parsed.kind == JObject:
          result.error = parsed{"error"}.getStr("")
      except CatchableError:
        discard

proc applyServiceSettingsFetch*(fetch: ServiceSettingsFetch, currentEtag: string,
                                apply: ServiceSettingsApply): ServiceSettingsSync {.gcsafe.} =
  ## Turns one fetch into one device-side decision. Pure apart from `apply`.
  ##
  ## * `200` — replace the cloud-owned groups with the payload; every group
  ##   absent from it is deleted.
  ## * `304` — the copy we have is the copy the provider would send. Keep it.
  ## * `403 insufficient_scope` — the link does not (or no longer does) hold
  ##   `settings:services`. This is the revocation boundary, so delete all six
  ##   groups and forget the ETag.
  ## * `403 frame_mismatch` / `409 frame_not_active` — the frame is not in a
  ##   state to receive keys; keep the current copy untouched.
  ## * `401` — the bearer is dead; the caller feeds its demotion counter.
  ## * `429` / `5xx` / transport failure — keep the current copy, retry later.
  ##   A rate limit is explicitly NOT a demotion signal.
  result = ServiceSettingsSync(status: fetch.status, etag: currentEtag,
                               error: fetch.error)
  case fetch.status
  of 200:
    if fetch.error.len > 0 or fetch.payload == nil:
      # An unparseable or oversized body from the provider: keep what we have.
      result.retryLater = true
      if result.error.len == 0:
        result.error = "invalid_body"
      return
    try:
      result.changed = if apply != nil: apply(fetch.payload) else: false
    except CatchableError:
      # A read-only or full state partition must not tear down the session;
      # the next pull tries again.
      result.retryLater = true
      result.error = "apply_failed"
      return
    if fetch.etag.len > 0:
      result.etag = fetch.etag
  of 304:
    # Keep the current copy, and the ETag that identifies it.
    if fetch.etag.len > 0:
      result.etag = fetch.etag
  of 401:
    result.authFailed = true
    if result.error.len == 0:
      result.error = "invalid_link_token"
  of 403:
    if fetch.error == "insufficient_scope":
      try:
        result.changed = if apply != nil: apply(nil) else: false
      except CatchableError:
        result.retryLater = true
        result.error = "apply_failed"
        return
      result.cleared = true
      result.etag = ""
  of 409:
    discard
  of 429:
    result.retryLater = true
  else:
    if fetch.status == 0 or fetch.status >= 500:
      result.retryLater = true

proc syncServiceSettings*(providerUrl, frameId, accessToken, currentEtag: string,
                          apply: ServiceSettingsApply,
                          fetch: ServiceSettingsFetcher = nil): ServiceSettingsSync {.gcsafe.} =
  ## Fetch + apply in one call. `fetch` defaults to the real bounded HTTPS
  ## request; tests pass their own.
  {.gcsafe.}:
    let fetcher = if fetch != nil: fetch else: ServiceSettingsFetcher(fetchServiceSettings)
    applyServiceSettingsFetch(fetcher(providerUrl, frameId, accessToken, currentEtag),
                              currentEtag, apply)
