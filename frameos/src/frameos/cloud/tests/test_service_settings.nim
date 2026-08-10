## Service settings: fetch semantics (docs/cloud-frames.md) and the frame.json
## apply that owns the six cloud-owned groups.

import std/[json, os, strutils, unittest]

import ../service_settings
import ../../server/api
import ../../server/state
import ../../types

# ---------------------------------------------------------------------------
# Fetch / decide
# ---------------------------------------------------------------------------

type Applied = ref object
  calls: seq[JsonNode] ## nil entries are "clear all six groups"
  changed: bool        ## what the apply callback reports back
  raises: bool

proc recordApply(applied: Applied): ServiceSettingsApply =
  proc(settings: JsonNode): bool {.gcsafe.} =
    applied.calls.add(if settings == nil: nil else: copy(settings))
    if applied.raises:
      raise newException(IOError, "read-only filesystem")
    applied.changed

proc fetcher(fetch: ServiceSettingsFetch): ServiceSettingsFetcher =
  proc(providerUrl, frameId, accessToken, etag: string): ServiceSettingsFetch {.gcsafe.} =
    fetch

proc sync(applied: Applied, fetch: ServiceSettingsFetch,
          currentEtag = "\"old\""): ServiceSettingsSync =
  syncServiceSettings("https://cloud.example.com", "frame-1", "tok", currentEtag,
                      recordApply(applied), fetcher(fetch))

suite "cloud service settings fetch semantics":
  test "200 with changed content applies and reports changed":
    let applied = Applied(changed: true)
    let outcome = applied.sync(ServiceSettingsFetch(
      status: 200, etag: "\"new\"",
      payload: %*{"unsplash": {"accessKey": "abc"}}))
    check outcome.changed
    check outcome.etag == "\"new\""
    check outcome.cleared == false
    check outcome.authFailed == false
    check outcome.retryLater == false
    check applied.calls.len == 1
    check applied.calls[0]{"unsplash"}{"accessKey"}.getStr("") == "abc"

  test "200 whose apply is a no-op reports no change":
    let applied = Applied(changed: false)
    let outcome = applied.sync(ServiceSettingsFetch(
      status: 200, etag: "\"same\"", payload: %*{"unsplash": {"accessKey": "abc"}}))
    check outcome.changed == false
    check outcome.etag == "\"same\""

  test "304 keeps the current copy and the ETag":
    let applied = Applied(changed: true)
    let outcome = applied.sync(ServiceSettingsFetch(status: 304, etag: "\"old\""))
    check outcome.changed == false
    check outcome.cleared == false
    check outcome.etag == "\"old\""
    # Nothing was applied at all: the copy on disk is already the right one.
    check applied.calls.len == 0

  test "403 insufficient_scope clears everything and forgets the ETag":
    let applied = Applied(changed: true)
    let outcome = applied.sync(ServiceSettingsFetch(
      status: 403, error: "insufficient_scope"))
    check outcome.cleared
    check outcome.changed
    check outcome.etag == ""
    check outcome.authFailed == false
    check applied.calls.len == 1
    # nil is the "delete all six groups" signal.
    check applied.calls[0] == nil

  test "403 frame_mismatch and 409 frame_not_active keep the copy":
    for fetch in [ServiceSettingsFetch(status: 403, error: "frame_mismatch"),
                  ServiceSettingsFetch(status: 409, error: "frame_not_active")]:
      let applied = Applied(changed: true)
      let outcome = applied.sync(fetch)
      check outcome.cleared == false
      check outcome.changed == false
      check outcome.authFailed == false
      check outcome.etag == "\"old\""
      check applied.calls.len == 0

  test "401 feeds the demotion path, 429 and 5xx never do":
    let unauthorized = Applied()
    let auth = unauthorized.sync(ServiceSettingsFetch(
      status: 401, error: "invalid_link_token"))
    check auth.authFailed
    check auth.retryLater == false
    check unauthorized.calls.len == 0

    for fetch in [ServiceSettingsFetch(status: 429, error: "rate_limited"),
                  ServiceSettingsFetch(status: 500),
                  ServiceSettingsFetch(status: 503),
                  ServiceSettingsFetch(status: 0, error: "network_error")]:
      let applied = Applied()
      let outcome = applied.sync(fetch)
      check outcome.retryLater
      check outcome.authFailed == false
      check outcome.cleared == false
      check outcome.etag == "\"old\""
      check applied.calls.len == 0

  test "a failing apply keeps the copy instead of tearing down the session":
    let applied = Applied(changed: true, raises: true)
    let outcome = applied.sync(ServiceSettingsFetch(
      status: 200, etag: "\"new\"", payload: %*{"openAI": {"apiKey": "sk"}}))
    check outcome.changed == false
    check outcome.retryLater
    check outcome.error == "apply_failed"
    # The ETag stays at the copy we still have, so the next pull re-fetches.
    check outcome.etag == "\"old\""

suite "cloud service settings body parsing":
  test "an oversized body is refused before it is parsed":
    var group = ""
    while group.len <= ServiceSettingsMaxBytes:
      group &= "0123456789"
    let body = $(%*{"settings": {"unsplash": {"accessKey": group}}, "groups": []})
    check body.len > ServiceSettingsMaxBytes
    let (settings, error) = parseServiceSettingsBody(body)
    check settings == nil
    check error == "too_large"
    # And the refusal reaches the caller as "keep the current copy".
    let applied = Applied(changed: true)
    let outcome = applied.sync(ServiceSettingsFetch(
      status: 200, etag: "\"new\"", error: "too_large"))
    check outcome.changed == false
    check outcome.retryLater
    check outcome.etag == "\"old\""
    check applied.calls.len == 0

  test "malformed bodies are refused, an empty settings object is not":
    for body in ["", "not json", "[]", "\"nope\"", "{}", """{"settings": []}"""]:
      let (settings, error) = parseServiceSettingsBody(body)
      check settings == nil
      check error == "invalid_body"
    # "The account has nothing configured" is a legitimate answer that deletes
    # every group, not an error.
    let (empty, error) = parseServiceSettingsBody("""{"settings": {}, "groups": []}""")
    check error == ""
    check empty != nil and empty.len == 0

  test "the URL is the contract's path with an encoded frame id":
    check serviceSettingsUrl("https://cloud.example.com", "frame-1") ==
      "https://cloud.example.com/api/frames/frame-1/service-settings"
    check serviceSettingsUrl("https://cloud.example.com", "a/../b") ==
      "https://cloud.example.com/api/frames/a%2F..%2Fb/service-settings"

# ---------------------------------------------------------------------------
# Apply to frame.json
# ---------------------------------------------------------------------------

proc withTempConfig(body: proc(configPath: string)) =
  let hadEnv = existsEnv("FRAMEOS_CONFIG")
  let previous = if hadEnv: getEnv("FRAMEOS_CONFIG") else: ""
  let dir = getTempDir() / "frameos_service_settings_test"
  removeDir(dir)
  createDir(dir)
  let configPath = dir / "frame.json"
  putEnv("FRAMEOS_CONFIG", configPath)
  let previousConfig = globalFrameConfig
  globalFrameConfig = FrameConfig(name: "test", settings: %*{})
  try:
    body(configPath)
  finally:
    globalFrameConfig = previousConfig
    if hadEnv:
      putEnv("FRAMEOS_CONFIG", previous)
    else:
      delEnv("FRAMEOS_CONFIG")
    removeDir(dir)

proc writeConfig(configPath: string, settings: JsonNode) =
  writeFile(configPath, pretty(%*{
    "name": "Kitchen",
    "device": "web_only",
    "width": 800,
    "settings": settings,
  }, indent = 4))

proc readSettings(configPath: string): JsonNode =
  parseJson(readFile(configPath)){"settings"}

suite "cloud service settings apply":
  test "an absent group is deleted while unrelated settings survive":
    withTempConfig(proc(configPath: string) =
      writeConfig(configPath, %*{
        "unsplash": {"accessKey": "old-unsplash"},
        "openAI": {"apiKey": "old-openai"},
        "sentry": {"dsn": "https://sentry.example.com/1"},
      })
      # Only openAI comes back: unsplash is gone from the account (or from the
      # frame's scenes) and must leave the device.
      check persistCloudServiceSettingsUpdate(%*{"openAI": {"apiKey": "new-openai"}})
      let settings = readSettings(configPath)
      check settings{"openAI"}{"apiKey"}.getStr("") == "new-openai"
      check settings{"unsplash"} == nil
      # Untouched: not one of the six groups.
      check settings{"sentry"}{"dsn"}.getStr("") == "https://sentry.example.com/1"
      # The rest of frame.json is untouched too.
      let configJson = parseJson(readFile(configPath))
      check configJson{"name"}.getStr("") == "Kitchen"
      check configJson{"width"}.getInt(0) == 800
      # And the live config saw the same thing.
      check globalFrameConfig.settings{"openAI"}{"apiKey"}.getStr("") == "new-openai"
      check globalFrameConfig.settings{"unsplash"} == nil
    )

  test "an unchanged payload reports no change and rewrites nothing":
    withTempConfig(proc(configPath: string) =
      writeConfig(configPath, %*{"unsplash": {"accessKey": "same"}})
      let before = readFile(configPath)
      check persistCloudServiceSettingsUpdate(%*{"unsplash": {"accessKey": "same"}}) == false
      check readFile(configPath) == before
      # Field order in the payload is not a change either.
      check persistCloudServiceSettingsUpdate(%*{
        "homeAssistant": {"url": "http://ha", "accessToken": "t"},
        "unsplash": {"accessKey": "same"}})
      check persistCloudServiceSettingsUpdate(%*{
        "unsplash": {"accessKey": "same"},
        "homeAssistant": {"accessToken": "t", "url": "http://ha"}}) == false
    )

  test "a group is replaced wholesale, not merged":
    withTempConfig(proc(configPath: string) =
      writeConfig(configPath, %*{
        "homeAssistant": {"url": "http://ha.local", "accessToken": "old-token"}})
      check persistCloudServiceSettingsUpdate(%*{
        "homeAssistant": {"url": "http://ha.local"}})
      let settings = readSettings(configPath)
      check settings{"homeAssistant"}{"url"}.getStr("") == "http://ha.local"
      # The token the account removed does not survive as a leftover field.
      check settings{"homeAssistant"}{"accessToken"} == nil
    )

  test "nil clears all six groups and nothing else":
    withTempConfig(proc(configPath: string) =
      writeConfig(configPath, %*{
        "frameOS": {"apiKey": "a"},
        "github": {"api_key": "b"},
        "homeAssistant": {"url": "http://ha", "accessToken": "c"},
        "immich": {"url": "http://immich", "apiKey": "d"},
        "openAI": {"apiKey": "e"},
        "unsplash": {"accessKey": "f"},
        "myLocalThing": {"keep": "me"},
      })
      # This is what a 403 insufficient_scope does on the device.
      check persistCloudServiceSettingsUpdate(nil)
      let settings = readSettings(configPath)
      for group in ["frameOS", "github", "homeAssistant", "immich", "openAI", "unsplash"]:
        check settings{group} == nil
      check settings{"myLocalThing"}{"keep"}.getStr("") == "me"
      # Idempotent: a second revocation changes nothing.
      check persistCloudServiceSettingsUpdate(nil) == false
    )

  test "unknown fields, empty strings and non-strings never reach frame.json":
    withTempConfig(proc(configPath: string) =
      writeConfig(configPath, %*{})
      check persistCloudServiceSettingsUpdate(%*{
        "unsplash": {"accessKey": "real", "secretKey": "not-deliverable"},
        "openAI": {"apiKey": ""},
        "github": {"api_key": 42},
        "immich": {"url": "http://immich", "apiKey": "k"},
        "notAGroup": {"whatever": "x"},
      })
      let settings = readSettings(configPath)
      check settings{"unsplash"}{"accessKey"}.getStr("") == "real"
      check settings{"unsplash"}{"secretKey"} == nil
      # Empty string means "not configured"; so does a non-string value.
      check settings{"openAI"} == nil
      check settings{"github"} == nil
      check settings{"immich"}{"apiKey"}.getStr("") == "k"
      # A group outside the six is never created from a pull.
      check settings{"notAGroup"} == nil
    )

  test "the fetch decision and the real apply agree end to end":
    withTempConfig(proc(configPath: string) =
      writeConfig(configPath, %*{"unsplash": {"accessKey": "old"}, "local": {"a": "b"}})
      let apply = proc(settings: JsonNode): bool {.gcsafe.} =
        {.cast(gcsafe).}:
          persistCloudServiceSettingsUpdate(settings)
      let updated = syncServiceSettings(
        "https://cloud.example.com", "frame-1", "tok", "",
        apply, fetcher(ServiceSettingsFetch(
          status: 200, etag: "\"e1\"", payload: %*{"unsplash": {"accessKey": "new"}})))
      check updated.changed
      check readSettings(configPath){"unsplash"}{"accessKey"}.getStr("") == "new"

      let unchanged = syncServiceSettings(
        "https://cloud.example.com", "frame-1", "tok", updated.etag,
        apply, fetcher(ServiceSettingsFetch(status: 304, etag: "\"e1\"")))
      check unchanged.changed == false
      check readSettings(configPath){"unsplash"}{"accessKey"}.getStr("") == "new"

      let revoked = syncServiceSettings(
        "https://cloud.example.com", "frame-1", "tok", unchanged.etag,
        apply, fetcher(ServiceSettingsFetch(status: 403, error: "insufficient_scope")))
      check revoked.cleared
      check revoked.changed
      check revoked.etag == ""
      check readSettings(configPath){"unsplash"} == nil
      check readSettings(configPath){"local"}{"a"}.getStr("") == "b"
    )
