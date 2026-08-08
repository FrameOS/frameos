import std/[json, unittest]

import ../apps
import ../types

proc makeConfig(width: int, height: int, rotate: int, saveAssets: JsonNode): FrameConfig =
  FrameConfig(
    width: width,
    height: height,
    rotate: rotate,
    saveAssets: saveAssets,
    assetsPath: "",
  )

suite "frameos app helpers":
  test "render dimensions swap for 90/270 rotations":
    let base = makeConfig(800, 480, 0, %*true)
    check renderWidth(base) == 800
    check renderHeight(base) == 480

    let rotate90 = makeConfig(800, 480, 90, %*true)
    check renderWidth(rotate90) == 480
    check renderHeight(rotate90) == 800

    let rotate180 = makeConfig(800, 480, 180, %*true)
    check renderWidth(rotate180) == 800
    check renderHeight(rotate180) == 480

    let rotate270 = makeConfig(800, 480, 270, %*true)
    check renderWidth(rotate270) == 480
    check renderHeight(rotate270) == 800

  test "maxHttpResponseBytes uses configured frame limit with default fallback":
    check maxHttpResponseBytes(FrameConfig(maxHttpResponseBytes: 1234)) == 1234
    check maxHttpResponseBytes(FrameConfig(maxHttpResponseBytes: 0)) == DefaultMaxHttpResponseBytes
    check maxHttpResponseBytes(AppRoot(frameConfig: FrameConfig(maxHttpResponseBytes: 5678))) == 5678
    check maxHttpResponseBytes(AppRoot()) == DefaultMaxHttpResponseBytes
    when defined(frameosEmbedded):
      check maxImageResponseBytes(FrameConfig(maxHttpResponseBytes: 1234)) == EmbeddedMinImageResponseBytes
      check maxImageResponseBytes(FrameConfig(maxHttpResponseBytes: EmbeddedMinImageResponseBytes + 1)) == EmbeddedMinImageResponseBytes + 1
    else:
      check maxImageResponseBytes(FrameConfig(maxHttpResponseBytes: 1234)) == 1234

  test "cleanFilename strips invalid chars and collapses spaces":
    check cleanFilename("hello   world") == "hello world"
    check cleanFilename("a/b:c*d?e\"f<g>h|i") == "abcdefghi"
    check cleanFilename("My   -   file___name") == "My - file___name"

  test "applyServiceSettings replaces present groups and deletes absent ones":
    let config = FrameConfig(settings: %*{
      "openAI": {"apiKey": "old-openai"},
      "unsplash": {"accessKey": "old-unsplash"},
      "local": {"keep": "me"},
    })
    check config.applyServiceSettings(%*{
      "openAI": {"apiKey": "new-openai"},
      "homeAssistant": {"url": "https://ha.local", "accessToken": "token"},
    })
    check config.settings["openAI"]["apiKey"].getStr == "new-openai"
    check config.settings["homeAssistant"]["accessToken"].getStr == "token"
    # absent from the pull → deleted, even though it was set before
    check config.settings{"unsplash"} == nil
    # not a cloud-owned group → untouched
    check config.settings["local"]["keep"].getStr == "me"
    # an identical pull changes nothing
    check config.applyServiceSettings(%*{
      "openAI": {"apiKey": "new-openai"},
      "homeAssistant": {"url": "https://ha.local", "accessToken": "token"},
    }) == false

  test "applyServiceSettings drops unknown and empty fields":
    let config = FrameConfig(settings: %*{})
    check config.applyServiceSettings(%*{
      "unsplash": {"accessKey": "key", "secretKey": "nope"},
      "immich": {"url": "", "apiKey": ""},
      "notAGroup": {"apiKey": "nope"},
    })
    check config.settings["unsplash"] == %*{"accessKey": "key"}
    # every field empty → nothing usable, the group is not stored at all
    check config.settings{"immich"} == nil
    check config.settings{"notAGroup"} == nil

  test "applyServiceSettings clears every cloud-owned group on nil or {}":
    let config = FrameConfig(settings: %*{
      "openAI": {"apiKey": "k"}, "github": {"api_key": "k"}, "local": {"a": "b"},
    })
    check config.applyServiceSettings(nil)
    check config.settings{"openAI"} == nil
    check config.settings{"github"} == nil
    check config.settings["local"]["a"].getStr == "b"
    check config.applyServiceSettings(nil) == false

    let other = FrameConfig(settings: %*{"immich": {"apiKey": "k"}})
    check other.applyServiceSettings("{}")
    check other.settings{"immich"} == nil

  test "applyServiceSettings ignores an unparseable payload":
    let config = FrameConfig(settings: %*{"openAI": {"apiKey": "keep"}})
    check config.applyServiceSettings("{\"openAI\": ") == false
    check config.applyServiceSettings("") == false
    check config.applyServiceSettings("[]") == false
    check config.settings["openAI"]["apiKey"].getStr == "keep"
    check config.applyServiceSettings("{\"openAI\":{\"apiKey\":\"fresh\"}}")
    check config.settings["openAI"]["apiKey"].getStr == "fresh"

  test "saveAsset returns early when auto-save is disabled":
    let asBool = AppRoot(
      nodeName: "data/test",
      frameConfig: makeConfig(10, 10, 0, %*false)
    )
    check saveAsset(asBool, "file", ".txt", "hello", true) == ""

    let asObject = AppRoot(
      nodeName: "data/test",
      frameConfig: makeConfig(10, 10, 0, %*{"data/test": false})
    )
    check saveAsset(asObject, "file", ".txt", "hello", true) == ""

    let asInvalid = AppRoot(
      nodeName: "data/test",
      frameConfig: makeConfig(10, 10, 0, %*"invalid")
    )
    check saveAsset(asInvalid, "file", ".txt", "hello", true) == ""
