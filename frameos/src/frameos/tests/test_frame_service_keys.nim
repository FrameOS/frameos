import std/[json, unittest]
import frameos/frame_service_keys

# The service keys typed on the frame (frame_service_keys.nim, docs/scene-settings.md
# "Service keys"): read from the host once, typed and taken away field by
# field, kept as one JSON text, and over what a plane sent where an app reads.

var
  stored = ""
  saves: seq[string]
  refuse = false

proc load(): string {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}: stored

proc save(text: string): bool {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    saves.add text
    if not refuse:
      stored = text
    not refuse

suite "frame service keys":
  setup:
    serviceKeysLoad = load
    serviceKeysSave = save
    stored = ""
    saves.setLen(0)
    refuse = false
    forgetServiceKeys()

  test "none until typed, and what a plane sent as it was":
    check serviceKeysTyped() == newJObject()
    let sent = %*{"openAI": {"apiKey": "sk-plane"}}
    check withServiceKeys(sent, "openAI") == sent

  test "typed over what was sent, field by field":
    stored = """{"homeAssistant": {"accessToken": "typed"}}"""
    let sent = %*{"homeAssistant": {"url": "http://ha.local:8123", "accessToken": "plane"},
      "openAI": {"apiKey": "sk-plane"}}
    check withServiceKeys(sent, "homeAssistant") ==
      %*{"homeAssistant": {"url": "http://ha.local:8123", "accessToken": "typed"}}
    check withServiceKeys(sent, "openAI") == sent
    check withServiceKeys(nil, "homeAssistant") == %*{"homeAssistant": {"accessToken": "typed"}}
    check sent["homeAssistant"]["accessToken"].getStr() == "plane" # not changed in place

  test "an address typed here takes its group whole":
    # Somebody at the frame cannot send a plane's token to an address of theirs.
    stored = """{"homeAssistant": {"url": "http://elsewhere"}, "immich": {"apiKey": "typed"}}"""
    let sent = %*{"homeAssistant": {"url": "http://ha.local:8123", "accessToken": "plane"},
      "immich": {"url": "https://photos.example", "apiKey": "plane"}}
    check withServiceKeys(sent, "homeAssistant") == %*{"homeAssistant": {"url": "http://elsewhere"}}
    # A key typed for the plane's address goes there.
    check withServiceKeys(sent, "immich") == %*{"immich": {"url": "https://photos.example", "apiKey": "typed"}}

  test "typed, kept and taken away":
    typeServiceKey("openAI", "apiKey", "sk-1")
    typeServiceKey("immich", "url", "https://photos.example")
    check keepServiceKeys()
    check parseJson(stored) == %*{"openAI": {"apiKey": "sk-1"}, "immich": {"url": "https://photos.example"}}
    typeServiceKey("openAI", "apiKey", "")
    typeServiceKey("github", "api_key", "") # nothing there: nothing to take
    check keepServiceKeys()
    check parseJson(stored) == %*{"immich": {"url": "https://photos.example"}}
    forgetServiceKeys()
    check serviceKeysTyped() == %*{"immich": {"url": "https://photos.example"}}

  test "what the host would not keep is not used":
    stored = """{"openAI": {"apiKey": "sk-kept"}}"""
    typeServiceKey("openAI", "apiKey", "sk-new")
    refuse = true
    check not keepServiceKeys()
    check serviceKeysTyped(){"openAI", "apiKey"}.getStr() == "sk-kept"
    refuse = false
    typeServiceKey("openAI", "apiKey", newString(MaxServiceKeysBytes))
    check not keepServiceKeys()
    check saves.len == 1 # too much never reaches the host

  test "a host that keeps none":
    serviceKeysLoad = nil
    serviceKeysSave = nil
    typeServiceKey("openAI", "apiKey", "sk-1")
    check not keepServiceKeys()
    check serviceKeysTyped() == newJObject()

  test "what is no object is no keys":
    stored = "[1, 2]"
    check serviceKeysTyped() == newJObject()
    forgetServiceKeys()
    stored = "{not json"
    check serviceKeysTyped() == newJObject()
