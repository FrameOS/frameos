## The scene store's host in the browser preview (scene_store_preview.nim),
## with the store answered by a fake: the facts it hands the app, browsing,
## a preview loaded on the next pass and discarded back to the store, and
## installs refused.

import std/[json, strutils, unittest]
import ../types
import ../scene_store_hooks
import ../scene_store_preview

const
  Base = "https://store.example"
  StoreScene = "0f3a3e1e-1111-4222-8333-444455556666"
  OtherScene = "0f3a3e1e-1111-4222-8333-777788889999"

var asked: seq[string]

proc fakeStore(url: string): tuple[code: int, body: string] {.nimcall, gcsafe, raises: [].} =
  {.cast(gcsafe).}:
    asked.add(url)
    if url.contains("/api/store/device/scenes"):
      return (200, """{"scenes":[{"id":"""" & StoreScene & """","name":"Rain radar"}],"more":false}""")
    if url.endsWith("/api/store/scenes/" & StoreScene & "/scenes.json"):
      return (200, """[{"id":"radar","name":"Rain radar","nodes":[],"edges":[]},""" &
        """{"id":"radar-panel","name":"Radar panel","nodes":[],"edges":[]}]""")
    if url.endsWith("/api/store/scenes/" & OtherScene & "/scenes.json"):
      return (200, """[{"id":"clock","name":"Clock","nodes":[],"edges":[]}]""")
    (404, "")

proc facts(): JsonNode =
  parseJson(sceneStoreRead("scene-store"))

suite "the scene store in the browser preview":
  setup:
    resetStorePreviewForTests()
    asked = @[]

  test "answers nothing until the preview turns it on":
    check sceneStoreRead.isNil
    enableStorePreview(Base & "/", "2026.11.8", fakeStore)
    let f = facts()
    check f["url"].getStr() == Base
    check f["version"].getStr() == "2026.11.8"
    check f["previewOnly"].getBool()
    check f["listing"].kind == JNull
    check f["preview"].kind == JNull
    check f["installed"].len == 0

  test "browses the listing with the query the app hands over":
    enableStorePreview(Base, "2026.11.8", fakeStore)
    sceneStoreAction("scene-store", "browse", """{"params":"page=1&limit=6"}""")
    check asked == @[Base & "/api/store/device/scenes?version=2026.11.8&page=1&limit=6"]
    check facts()["listing"]["scenes"][0]["name"].getStr() == "Rain radar"
    check facts()["params"].getStr() == "page=1&limit=6"
    # Nothing that leaves a query goes out.
    sceneStoreAction("scene-store", "browse", """{"params":"x#y"}""")
    check asked.len == 1

  test "previews a store scene on the next pass, and discards back to the store":
    enableStorePreview(Base, "2026.11.8", fakeStore)
    sceneStoreAction("scene-store", "preview", """{"store":"""" & StoreScene & """","name":"Rain radar"}""")
    check facts()["done"].getStr() == "preview"
    check facts()["preview"]["store"].getStr() == StoreScene
    check facts()["preview"]["id"].getStr() == "radar"
    let show = takeStorePreviewChange()
    check show.kind == spcShow
    check show.scenes.len == 2
    check show.scenes[0].id.string == "radar"
    check show.dropIds.len == 0
    # Taken once.
    check takeStorePreviewChange().kind == spcNone

    sceneStoreAction("radar", "discard", "{}")
    let back = takeStorePreviewChange()
    check back.kind == spcDiscard
    check back.dropIds == @["radar", "radar-panel"]
    check back.back == "scene-store"
    check facts()["preview"].kind == JNull
    check facts()["done"].getStr() == "discard"

  test "a second preview replaces the first and still goes back to the store":
    enableStorePreview(Base, "2026.11.8", fakeStore)
    sceneStoreAction("scene-store", "preview", """{"store":"""" & StoreScene & """"}""")
    discard takeStorePreviewChange()
    sceneStoreAction("scene-store", "preview", """{"store":"""" & OtherScene & """"}""")
    let change = takeStorePreviewChange()
    check change.kind == spcShow
    check change.dropIds == @["radar", "radar-panel"]
    check change.scenes[0].id.string == "clock"
    sceneStoreAction("clock", "discard", "{}")
    check takeStorePreviewChange().back == "scene-store"

  test "refuses installs, store ids that are not one, and scenes the store does not have":
    enableStorePreview(Base, "2026.11.8", fakeStore)
    sceneStoreAction("scene-store", "install", """{"store":"""" & StoreScene & """"}""")
    check facts()["error"].getStr() == "preview_only"
    sceneStoreAction("scene-store", "preview", """{"store":"../../api/admin"}""")
    check facts()["error"].getStr() == "invalid_scene"
    check asked.len == 0
    sceneStoreAction("scene-store", "preview", """{"store":"0f3a3e1e-1111-4222-8333-000000000000"}""")
    check facts()["error"].getStr() == "invalid_scene"
    check takeStorePreviewChange().kind == spcNone
